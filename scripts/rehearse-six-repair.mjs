#!/usr/bin/env node
// ============================================================================
// ENSAIO DA REPARAÇÃO DAS 6 — Postgres real, descartável
// ============================================================================
//
// 🔴 NÃO TOCA EM PRODUÇÃO. Levanta um Postgres num contentor, com dados
//    **inventados** — nenhum id, valor ou descrição real das seis entra aqui.
//    O contentor é destruído no fim.
//
// 🔴 O executor é corrido a sério, pelo CLI, com `--database-url`. Não se
//    reimplementa aqui o que ele faz: uma cópia do executor provaria a cópia.
//    Isto também exercita os guardas de alvo — o CLI tem de exigir
//    `--confirm-production ENSAIO-DESCARTAVEL`, literalmente, para escrever
//    numa base que não é Supabase.
//
// O que prova (§25):
//
//   · 6 saídas pendentes → repair → 6 pagamentos pendentes, os MESMOS 6
//     movimentos ligados, e a contagem de movimentos continua 6;
//   · marcar um pagamento como pago → continuam 6 movimentos, e é exactamente
//     aquele que fica confirmado (é aqui que a 079 entra);
//   · repetir → continuam 6;
//   · falha a meio do lote → prestate integral, zero linhas persistidas;
//   · rollback → prestate integral;
//   · rollback depois de um pagamento pago → RECUSA, sem tocar em nada.
// ============================================================================

import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import pg from "pg";

const ROOT = path.join(import.meta.dirname, "..");
const CONTENTOR = "escala-ensaio-six";
const PORTA = 55480;
const IMAGEM = "postgres:16-alpine";
const SENHA = "ensaio-descartavel-sem-valor";
const URL = `postgresql://postgres:${SENHA}@127.0.0.1:${PORTA}/ensaio`;

const EXECUTOR = path.join(ROOT, "scripts", "repairs", "six-pending-obligations.mjs");
const SAIDA = fs.mkdtempSync(path.join(os.tmpdir(), "six-ensaio-"));

const EMPRESA = "11111111-1111-1111-1111-111111111111";
const CATEGORIA = "33333333-3333-3333-3333-333333333333";

const resultados = [];
function verificar(nome, condicao, detalhe = "") {
  const ok = !!condicao;
  resultados.push({ nome, ok, detalhe });
  console.log(`  ${ok ? "✔" : "✘"} ${nome}${detalhe ? `  — ${detalhe}` : ""}`);
  return ok;
}

const docker = (args) => spawnSync("docker", args, { encoding: "utf8" });
const destruir = () => docker(["rm", "-f", CONTENTOR]);

function levantar() {
  destruir();
  const r = docker(["run", "-d", "--name", CONTENTOR,
    "-e", `POSTGRES_PASSWORD=${SENHA}`, "-e", "POSTGRES_DB=ensaio",
    "-p", `${PORTA}:5432`, IMAGEM]);
  if (r.status !== 0) throw new Error(`contentor: ${r.stderr || r.stdout}`);
}

const ligar = () => new pg.Client({ connectionString: URL, ssl: false });

async function esperarPronto() {
  const limite = Date.now() + 90_000;
  let ultimo = "";
  while (Date.now() < limite) {
    if (docker(["exec", CONTENTOR, "pg_isready", "-U", "postgres", "-d", "ensaio"]).status === 0) {
      const sonda = ligar();
      try { await sonda.connect(); await sonda.query("SELECT 1"); await sonda.end(); return; }
      catch (e) { ultimo = String(e?.message ?? e); try { await sonda.end(); } catch { /* morta */ } }
    }
    await new Promise((r) => setTimeout(r, 500));
  }
  throw new Error(`Postgres não ficou pronto. Último: ${ultimo}`);
}

/** Corre o executor a sério, como um humano o correria. */
function correrExecutor(args) {
  const r = spawnSync(process.execPath, [EXECUTOR, "--database-url", URL, ...args], {
    encoding: "utf8", cwd: ROOT,
  });
  return { status: r.status, saida: `${r.stdout ?? ""}${r.stderr ?? ""}` };
}

// ─── Base ────────────────────────────────────────────────────────────────────

const BASELINE = fs.readFileSync(path.join(ROOT, "scripts", "rehearse-079.mjs"), "utf8")
  .split("const BASELINE = `")[1].split("`;")[0];

const sqlMigracao = (n) => fs.readFileSync(path.join(ROOT, "supabase", "migrations", n), "utf8");

// As seis são inventadas: descrições genéricas, valores redondos, datas de dois
// meses civis diferentes para provar que a competência não vem toda do mesmo
// sítio. Nenhum dado real de fornecedor entra num ficheiro versionado.
const SEIS = [
  { desc: "Factura A", amount: "100.00", date: "2026-07-10", cat: null },
  { desc: "Factura B", amount: "200.50", date: "2026-07-22", cat: null },
  { desc: "Factura C", amount: "300.25", date: "2026-08-03", cat: CATEGORIA },
  { desc: "Factura D", amount: "400.00", date: "2026-08-07", cat: null },
  { desc: "Factura E", amount: "500.75", date: "2026-08-11", cat: null },
  { desc: "Factura F", amount: "600.00", date: "2026-08-19", cat: null },
];

async function semear(c) {
  await c.query(BASELINE);
  await c.query(`INSERT INTO public.companies (id, name) VALUES ($1, 'Ensaio')`, [EMPRESA]);
  await c.query(
    `INSERT INTO public.expense_categories (id, company_id, name, color)
     VALUES ($1, $2, 'Fornecedores', 'violet')`, [CATEGORIA, EMPRESA],
  );
  await c.query(sqlMigracao("073_payment_to_cashflow.sql"));
  await c.query(sqlMigracao("079_reuse_pending_cashflow_on_payment.sql"));

  for (const s of SEIS) {
    await c.query(
      `INSERT INTO public.cash_flow_entries
         (company_id, type, amount, description, category, date, status, expense_category_id, notes)
       VALUES ($1, 'saida', $2, $3, 'despesa', $4, 'pendente', $5, 'registo legado')`,
      [EMPRESA, s.amount, s.desc, s.date, s.cat],
    );
  }
  // Ruído: um movimento manual confirmado e uma entrada. Nenhum deles pode ser
  // apanhado pela reparação — se forem, a consulta de candidatos está larga.
  await c.query(
    `INSERT INTO public.cash_flow_entries (company_id, type, amount, description, category, date, status)
     VALUES ($1,'saida',77.00,'Despesa já paga','despesa','2026-08-05','confirmado'),
            ($1,'entrada',900.00,'Recebimento','faturacao','2026-08-06','pendente')`,
    [EMPRESA],
  );
}

// ─── Fotografias ─────────────────────────────────────────────────────────────

async function retrato(c) {
  const mov = (await c.query(
    `SELECT id::text AS id, type, amount::text AS amount, description, date::text AS date,
            status, reference_type, reference_id::text AS reference_id,
            expense_category_id::text AS cat, notes, created_at::text AS created_at
       FROM public.cash_flow_entries ORDER BY id`,
  )).rows;
  const pag = (await c.query(
    `SELECT id::text AS id, kind, description, amount::text AS amount, due_date::text AS due_date,
            status, recurring, period_year, period_month, notes, expense_category_id::text AS cat
       FROM public.fixed_variable_payments ORDER BY id`,
  )).rows;
  return { movimentos: mov, pagamentos: pag };
}

const impressao = (r) => createHash("sha256").update(JSON.stringify(r)).digest("hex");

// ─── Ensaio ──────────────────────────────────────────────────────────────────

async function main() {
  console.log("\n═══ ENSAIO — reparação das 6 obrigações pendentes (Postgres descartável) ═══\n");
  levantar();
  await esperarPronto();

  const c = ligar();
  await c.connect();
  const versao = (await c.query("SELECT version() AS v")).rows[0].v.split(" ").slice(0, 2).join(" ");
  console.log(`Motor: ${versao}   (contentor ${CONTENTOR})\n`);

  await semear(c);
  const PRESTATE = await retrato(c);
  const PRESTATE_FP = impressao(PRESTATE);

  // ── 1. Guardas do executor ─────────────────────────────────────────────
  console.log("── 1. O executor recusa escrever sem tudo o que precisa");
  {
    const semTudo = correrExecutor(["--apply"]);
    verificar("SIX01. --apply sem --confirm-production recusa",
      semTudo.status !== 0 && /ENSAIO-DESCARTAVEL/.test(semTudo.saida));

    const semManifesto = correrExecutor(["--apply", "--confirm-production", "ENSAIO-DESCARTAVEL"]);
    verificar("SIX02. --apply sem --manifest recusa",
      semManifesto.status !== 0 && /--manifest/.test(semManifesto.saida));

    verificar("SIX03. e nada foi escrito por nenhuma das tentativas",
      impressao(await retrato(c)) === PRESTATE_FP);
  }

  // ── 2. Dry-run ─────────────────────────────────────────────────────────
  console.log("\n── 2. Dry-run: lê, mostra, não escreve");
  const dry = correrExecutor(["--out", SAIDA]);
  verificar("SIX04. o dry-run corre até ao fim", dry.status === 0, dry.status === 0 ? "" : dry.saida.slice(0, 300));
  verificar("SIX05. encontra exactamente 6", /SIX_FRESH_COUNT = 6/.test(dry.saida));
  verificar("SIX06. e não escreveu nada", impressao(await retrato(c)) === PRESTATE_FP);
  verificar("SIX07. o movimento manual confirmado e a entrada não são candidatos",
    /SIX_FRESH_COUNT = 6/.test(dry.saida) && PRESTATE.movimentos.length === 8);

  const manifesto = JSON.parse(fs.readFileSync(path.join(SAIDA, "six-forward.json"), "utf8"));
  const rollbackM = JSON.parse(fs.readFileSync(path.join(SAIDA, "six-rollback.json"), "utf8"));
  verificar("SIX08. todos os alvos levam due_date nulo",
    manifesto.linhas.every((l) => l.target.due_date === null));
  verificar("SIX09. a competência é o mês civil do registo, e há dois meses diferentes",
    new Set(manifesto.linhas.map((l) => `${l.target.period_year}/${l.target.period_month}`)).size === 2);
  verificar("SIX10. kind = variavel, sem recorrência",
    manifesto.linhas.every((l) => l.target.kind === "variavel" && l.target.recurring === false));

  // ── 3. Hash errado ─────────────────────────────────────────────────────
  console.log("\n── 3. Um manifesto que não é o autorizado não passa");
  {
    const falso = "0".repeat(64);
    const r = correrExecutor(["--apply", "--confirm-production", "ENSAIO-DESCARTAVEL",
      "--manifest", path.join(SAIDA, "six-forward.json"), "--manifest-sha", falso]);
    verificar("SIX11. sha errado → recusa", r.status !== 0 && /não é o que foi autorizado/.test(r.saida));
    verificar("SIX11. e nada foi escrito", impressao(await retrato(c)) === PRESTATE_FP);
  }

  // ── 4. Falha a meio do lote ────────────────────────────────────────────
  console.log("\n── 4. Falha a meio: prestate integral");
  {
    // Faz-se a quarta linha falhar: o movimento deixa de estar como o manifesto
    // o viu. O `UPDATE` condicional afecta zero linhas, e a transacção inteira
    // tem de cair — incluindo os três pagamentos já inseridos.
    const quarto = manifesto.linhas[3].legacy_cashflow_id;
    await c.query(`UPDATE public.cash_flow_entries SET status = 'confirmado' WHERE id = $1`, [quarto]);
    const meio = await retrato(c);

    const r = correrExecutor(["--apply", "--confirm-production", "ENSAIO-DESCARTAVEL",
      "--manifest", path.join(SAIDA, "six-forward.json"), "--manifest-sha", manifesto.sha256]);

    verificar("SIX12. o lote falha", r.status !== 0);
    verificar("SIX12. 🔴 SIX_MID_BATCH_PERSISTED = 0 — nem os três primeiros ficaram",
      impressao(await retrato(c)) === impressao(meio),
      `pagamentos = ${(await retrato(c)).pagamentos.length}`);

    await c.query(`UPDATE public.cash_flow_entries SET status = 'pendente' WHERE id = $1`, [quarto]);
    verificar("SIX12. reposto o estado inicial", impressao(await retrato(c)) === PRESTATE_FP);
  }

  // ── 5. Forward ─────────────────────────────────────────────────────────
  console.log("\n── 5. Forward: 6 pagamentos, os mesmos 6 movimentos");
  {
    const r = correrExecutor(["--apply", "--confirm-production", "ENSAIO-DESCARTAVEL",
      "--manifest", path.join(SAIDA, "six-forward.json"), "--manifest-sha", manifesto.sha256]);
    verificar("SIX13. o repair corre", r.status === 0, r.status === 0 ? "" : r.saida.slice(0, 400));

    const depois = await retrato(c);
    verificar("SIX13. 6 pagamentos novos, todos pendentes",
      depois.pagamentos.length === 6 && depois.pagamentos.every((p) => p.status === "pendente"));
    verificar("SIX13. 🔴 nenhum movimento novo — continuam 8 no total",
      depois.movimentos.length === PRESTATE.movimentos.length,
      `${PRESTATE.movimentos.length} → ${depois.movimentos.length}`);
    verificar("SIX14. os 6 são os MESMOS ids de antes",
      manifesto.linhas.every((l) => depois.movimentos.some((m) => m.id === l.legacy_cashflow_id)));
    verificar("SIX14. e ficaram ligados aos pagamentos novos",
      manifesto.linhas.every((l) =>
        depois.movimentos.find((m) => m.id === l.legacy_cashflow_id)?.reference_id === l.target_payment_id));
    verificar("SIX15. continuam pendentes — o dinheiro ainda não saiu",
      manifesto.linhas.every((l) =>
        depois.movimentos.find((m) => m.id === l.legacy_cashflow_id)?.status === "pendente"));
    verificar("SIX15. e a data e o valor legados não foram tocados",
      manifesto.linhas.every((l) => {
        const antes = PRESTATE.movimentos.find((m) => m.id === l.legacy_cashflow_id);
        const agora = depois.movimentos.find((m) => m.id === l.legacy_cashflow_id);
        return antes.date === agora.date && antes.amount === agora.amount
          && antes.created_at === agora.created_at && antes.notes === agora.notes;
      }));
    verificar("SIX15. o movimento manual e a entrada não foram tocados",
      PRESTATE.movimentos.filter((m) => !manifesto.linhas.some((l) => l.legacy_cashflow_id === m.id))
        .every((m) => JSON.stringify(m) === JSON.stringify(depois.movimentos.find((x) => x.id === m.id))));
  }

  // ── 6. Marcar um como pago ─────────────────────────────────────────────
  console.log("\n── 6. Marcar um pagamento como pago (é aqui que a 079 entra)");
  const alvoPago = manifesto.linhas[0];
  {
    const antes = await retrato(c);
    await c.query("SELECT * FROM public.mark_payment_paid($1, $2, $3)",
      [EMPRESA, alvoPago.target_payment_id, "2026-08-26"]);
    const depois = await retrato(c);

    verificar("SIX16. 🔴 continuam os mesmos movimentos — nenhum nasceu",
      depois.movimentos.length === antes.movimentos.length);
    const m = depois.movimentos.find((x) => x.id === alvoPago.legacy_cashflow_id);
    verificar("SIX16. exactamente aquele ficou confirmado", m.status === "confirmado");
    verificar("SIX16. com a data efectiva do pagamento", m.date === "2026-08-26");
    verificar("SIX16. e é a MESMA linha — o id não mudou", m.id === alvoPago.legacy_cashflow_id);
    verificar("SIX16. os outros cinco continuam pendentes",
      manifesto.linhas.slice(1).every((l) =>
        depois.movimentos.find((x) => x.id === l.legacy_cashflow_id).status === "pendente"));

    // Retry
    await c.query("SELECT * FROM public.mark_payment_paid($1, $2, $3)",
      [EMPRESA, alvoPago.target_payment_id, "2026-08-26"]);
    const outraVez = await retrato(c);
    verificar("SIX17. repetir não cria nada", outraVez.movimentos.length === depois.movimentos.length);
    verificar("SIX17. e não muda nada", impressao(outraVez) === impressao(depois));
  }

  // ── 7. Rollback recusa depois de actividade real ───────────────────────
  console.log("\n── 7. O rollback recusa quando já houve actividade");
  {
    const antes = await retrato(c);
    const r = correrExecutor(["--rollback", "--confirm-production", "ENSAIO-DESCARTAVEL",
      "--manifest", path.join(SAIDA, "six-rollback.json"), "--manifest-sha", rollbackM.sha256]);
    verificar("🔴 recusa — um dos pagamentos já foi pago",
      r.status !== 0 && /A reversão recusa/.test(r.saida));
    verificar("e não tocou em nada", impressao(await retrato(c)) === impressao(antes));
  }

  // ── 8. Rollback seguro ─────────────────────────────────────────────────
  console.log("\n── 8. Rollback com tudo intacto: prestate integral");
  {
    // Desfaz-se o pagamento, para o rollback poder correr.
    await c.query("SELECT * FROM public.unmark_payment_paid($1, $2)",
      [EMPRESA, alvoPago.target_payment_id]);
    // O `unmark` da 073 APAGA o movimento — ver o que a 079 deliberadamente não
    // mudou. Repõe-se a linha legada para o ensaio do rollback ser sobre o
    // estado que o rollback espera.
    const l = alvoPago;
    await c.query(
      `INSERT INTO public.cash_flow_entries
         (id, company_id, type, amount, description, category, date, status,
          reference_type, reference_id, expense_category_id, notes, created_at)
       VALUES ($1,$2,'saida',$3,$4,'despesa',$5,'pendente','fixed_variable_payment',$6,$7,$8,$9)`,
      [l.legacy_cashflow_id, EMPRESA, l.before.amount, l.before.description, l.before.date,
       l.target_payment_id, l.before.expense_category_id, l.before.notes, l.before.created_at],
    );

    const r = correrExecutor(["--rollback", "--confirm-production", "ENSAIO-DESCARTAVEL",
      "--manifest", path.join(SAIDA, "six-rollback.json"), "--manifest-sha", rollbackM.sha256]);
    verificar("o rollback corre", r.status === 0, r.status === 0 ? "" : r.saida.slice(0, 400));

    const depois = await retrato(c);
    verificar("🔴 zero pagamentos criados pelo repair sobreviveram", depois.pagamentos.length === 0);
    verificar("os 6 movimentos voltaram a não ter origem",
      manifesto.linhas.every((l2) => {
        const m = depois.movimentos.find((x) => x.id === l2.legacy_cashflow_id);
        return m && m.reference_type === null && m.reference_id === null && m.status === "pendente";
      }));
    verificar("🔴 nenhum movimento foi apagado — DELETE_COUNT = 0",
      depois.movimentos.length === PRESTATE.movimentos.length);
    verificar("prestate integral", impressao(depois) === PRESTATE_FP,
      impressao(depois) === PRESTATE_FP ? "" : "a fotografia final difere da inicial");
  }

  await c.end();
}

let codigo = 0;
try {
  await main();
} catch (e) {
  console.error(`\n✘ ENSAIO INTERROMPIDO: ${e?.message ?? e}`);
  resultados.push({ nome: "o ensaio correu até ao fim", ok: false, detalhe: String(e?.message ?? e) });
  codigo = 1;
} finally {
  destruir();
  fs.rmSync(SAIDA, { recursive: true, force: true });
  const restos = docker(["ps", "-a", "--filter", `name=${CONTENTOR}`, "--format", "{{.Names}}"]);
  const aindaExiste = (restos.stdout ?? "").trim() !== "";
  console.log(`\nDISPOSABLE_CONTAINER_DESTROYED = ${aindaExiste ? "NO" : "YES"}`);
  if (aindaExiste) codigo = 1;
}

const falhas = resultados.filter((r) => !r.ok);
console.log(`\n═══ ${resultados.length - falhas.length}/${resultados.length} verificações ═══`);
if (falhas.length > 0) {
  console.log("\nFALHOU:");
  for (const f of falhas) console.log(`  ✘ ${f.nome}${f.detalhe ? `  — ${f.detalhe}` : ""}`);
  codigo = 1;
}
process.exit(codigo);

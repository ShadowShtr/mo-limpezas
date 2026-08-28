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
const IMAGEM = "postgres:17-alpine";
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

// 🔴 A cadeia completa, não só até à 079.
//
// Este ensaio aplicava 073 + 079 e parava aí — e o executor precisa de
// `payment_cashflow_provenance`, que nasce na 080. O comando ficava
// conhecido como quebrado. A causa era as duas peças ainda não terem
// número: viviam em `draft/` e não havia nada estável a que chamar. Com a
// 080 e a 081 numeradas, a correcção é apenas montar a cadeia toda.
//
// O `_migrations` e o `get_my_company_id()` fazem parte dela: a 081 exige a
// linha da 080 no ledger, e as políticas da 080 chamam o resolver. Não estão
// no BASELINE partilhado porque o ensaio da 079 não precisa deles.
const EXTRAS_DA_CADEIA = `
  -- Os papeis do Supabase. A 083 revoga-lhes privilegios, e revogar de um
  -- papel que nao existe rebenta — em producao existem, aqui tem de existir.
  DO $papeis$ BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname='anon') THEN CREATE ROLE anon; END IF;
    IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname='authenticated') THEN CREATE ROLE authenticated; END IF;
    IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname='service_role') THEN CREATE ROLE service_role BYPASSRLS; END IF;
  END $papeis$;
  CREATE TABLE IF NOT EXISTS public._migrations (
    name text PRIMARY KEY, checksum text,
    applied_at timestamptz NOT NULL DEFAULT now());
  ALTER TABLE public.profiles ADD COLUMN IF NOT EXISTS auth_user_id uuid;
  ALTER TABLE public.profiles ADD COLUMN IF NOT EXISTS role text;

  -- 🔴 O executor lê o anexo do pagamento. Sem estas colunas ele rebentava com
  --    «column p.attachment_url does not exist» — e um ensaio que espera uma
  --    recusa via um processo a sair com código 1 e dava-a por boa. Erro não é
  --    recusa: a verificação exige também a mensagem, e foi ela que apanhou isto.
  ALTER TABLE public.fixed_variable_payments ADD COLUMN IF NOT EXISTS attachment_url text;
  ALTER TABLE public.fixed_variable_payments ADD COLUMN IF NOT EXISTS attachment_name text;

  -- O executor conta os anexos do pagamento. A forma é a mesma que o ensaio
  -- endurecido usa — "six-repair-hardened-postgres.test.ts".
  CREATE TABLE IF NOT EXISTS public.attachments (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(), company_id uuid NOT NULL,
    parent_type text NOT NULL, parent_id uuid NOT NULL,
    storage_bucket text NOT NULL, storage_path text NOT NULL,
    original_name text NOT NULL);
  CREATE OR REPLACE FUNCTION public.get_my_company_id() RETURNS uuid
    LANGUAGE sql SECURITY DEFINER STABLE
    AS $gmc$ SELECT company_id FROM public.profiles WHERE auth_user_id = auth.uid() LIMIT 1 $gmc$;
  CREATE OR REPLACE FUNCTION public.get_my_role() RETURNS text
    LANGUAGE sql SECURITY DEFINER STABLE
    AS $gmr$ SELECT role FROM public.profiles WHERE auth_user_id = auth.uid() LIMIT 1 $gmr$;

  -- 🔴 O unmark da 081 consulta a conciliação antes de tocar em nada, e o
  --    ON DELETE CASCADE aqui é metade do motivo por que ela existe. Sem estas
  --    duas tabelas o ensaio rebentava a meio — e foi assim que rebentou.
  CREATE TABLE IF NOT EXISTS public.bank_transactions (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(), company_id uuid NOT NULL,
    status text NOT NULL DEFAULT 'pending');
  CREATE TABLE IF NOT EXISTS public.bank_reconciliation_matches (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(), company_id uuid NOT NULL,
    bank_transaction_id uuid NOT NULL REFERENCES public.bank_transactions(id) ON DELETE CASCADE,
    cash_flow_entry_id uuid REFERENCES public.cash_flow_entries(id) ON DELETE CASCADE,
    match_score integer NOT NULL DEFAULT 0,
    status text NOT NULL DEFAULT 'confirmed'
      CHECK (status IN ('suggested','confirmed','rejected')),
    created_at timestamptz NOT NULL DEFAULT now());
`;

/** 073 → 079 → 080 (com a linha do ledger) → 081. Por esta ordem, que é forçada. */
async function aplicarCadeia(c) {
  await c.query(sqlMigracao("073_payment_to_cashflow.sql"));
  await c.query(sqlMigracao("079_reuse_pending_cashflow_on_payment.sql"));
  await c.query(EXTRAS_DA_CADEIA);
  await c.query(sqlMigracao("080_payment_cashflow_provenance.sql"));
  // O runner é que regista; aqui reproduz-se o que ele faria. Nunca em
  // produção — ali a linha só existe se a migração correr mesmo.
  await c.query(
    `INSERT INTO public._migrations (name, checksum)
     VALUES ('080_payment_cashflow_provenance.sql', 'ensaio')
     ON CONFLICT (name) DO NOTHING`);
  await c.query(sqlMigracao("081_safe_unmark_payment_paid.sql"));

  // 🔴 A 083 entra na cadeia porque ja esta em producao.
  //
  //    Ha DOIS caminhos de escrita, e sao coisas diferentes:
  //
  //      aplicacao   Server Action -> service_role -> RPC canonica
  //      reparacao   executor de manutencao autorizado pelo dono
  //                  -> ligacao PostgreSQL privilegiada e directa
  //                  -> as seis linhas exactas, com manifesto e guardas
  //
  //    Este executor e o segundo. Nao escreve como service_role: usa um
  //    pg.Client com uma ligacao administrativa. Dizer "identidade de servico"
  //    era impreciso, e a imprecisao importa — sugeria que a reparacao passava
  //    pelo mesmo caminho que a 083 governa, quando e um caminho excepcional,
  //    fora da aplicacao, que so existe sob autorizacao explicita.
  //
  //    A 083 nao e enfraquecida por isto: continua a bloquear mutacao pela
  //    app a PUBLIC, anon e authenticated. Aplica-la aqui prova que a
  //    reparacao continua a funcionar com ela no lugar — e isso prova-se a
  //    correr, nao a afirmar.
  await c.query(sqlMigracao("083_payment_authorization_hardening.sql"));
  await c.query(
    `INSERT INTO public._migrations (name, checksum)
     VALUES ('083_payment_authorization_hardening.sql', 'ensaio')
     ON CONFLICT (name) DO NOTHING`);
}

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
  await aplicarCadeia(c);

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

    // 🔴 Aqui estava um `INSERT` a repor a linha legada à mão, porque o
    //    `unmark` da 073 APAGAVA o movimento e não havia outra forma de voltar
    //    ao estado que o rollback espera.
    //
    //    Com a 081 deixou de ser preciso — e passou a ser impossível: o
    //    movimento foi **adoptado**, e desmarcar restaura-o no sítio, com o
    //    mesmo id. O `INSERT` colidia na chave primária, que foi como este
    //    ensaio deu por si desactualizado. Não se repõe nada: verifica-se que
    //    a própria RPC repôs, que é a diferença que esta frente inteira serve.
    {
      const { rows } = await c.query(
        `SELECT id::text, status, date::text, expense_category_id::text
           FROM public.cash_flow_entries WHERE id = $1`, [alvoPago.legacy_cashflow_id]);
      verificar("🔴 o movimento legado sobreviveu ao unmark — não foi apagado",
        rows.length === 1);
      verificar("e voltou a pendente, com a data legada",
        rows[0]?.status === "pendente" && rows[0]?.date === alvoPago.before.date,
        rows[0] ? `status=${rows[0].status} date=${rows[0].date}` : "sem linha");
    }

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

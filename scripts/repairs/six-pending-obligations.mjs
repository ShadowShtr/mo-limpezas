#!/usr/bin/env node
// ============================================================================
// REPARAÇÃO DAS 6 OBRIGAÇÕES PENDENTES — executor atómico
// ============================================================================
//
// ⛔ POR OMISSÃO NÃO ESCREVE NADA. Sem `--apply` faz uma leitura, mostra o que
//    faria, e escreve dois manifestos no disco. Escrever exige `--apply`,
//    `--manifest`, `--manifest-sha` e `--confirm-production` **todos juntos**,
//    e a autorização explícita do proprietário na conversa em curso
//    (`AGENTS.md`, REGRA ZERO).
//
// ---------------------------------------------------------------------------
// O que faz
// ---------------------------------------------------------------------------
// Seis facturas de fornecedor foram registadas directamente em
// `cash_flow_entries` como saídas **pendentes**. São obrigações a pagar, e o
// sítio delas é Pagamentos. Por cada uma:
//
//   1. cria um `fixed_variable_payments` pendente, com id gerado de antemão;
//   2. liga o movimento que já existe a esse pagamento;
//   3. e mais nada — o movimento continua pendente, com a sua data e o seu id.
//
// 🔴 Nenhum movimento é criado. Nenhum movimento é apagado. `DELETE_COUNT = 0`
//    e `DUPLICATE_FUTURE_CASHFLOW = NO` são invariantes, não intenções.
//
// ---------------------------------------------------------------------------
// Tudo ou nada
// ---------------------------------------------------------------------------
// Uma só transacção, por `pg` — o PostgREST não sabe fazer isto. Se a quarta
// linha falhar, as três primeiras desaparecem com ela. Um lote meio aplicado
// seria pior do que nenhum: metade das obrigações em Pagamentos, metade em
// Fluxo de Caixa, e nada a dizer qual é qual.
//
// ---------------------------------------------------------------------------
// Segredos
// ---------------------------------------------------------------------------
// 🔴 A ligação nunca é impressa, nem em erro. Todas as mensagens passam por
//    `sanitizar()`. O parser de `.env.local` ignora linhas sem `KEY=` — foi uma
//    linha dessas, tratada como par chave/valor, que expôs uma password num
//    diagnóstico anterior. O ficheiro não muda; a forma de o ler mudou.
// ============================================================================

import { createHash, randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import pg from "pg";

import {
  ESPERADAS, ORIGEM_PAGAMENTO, CAMPOS_ESCRITOS_NO_MOVIMENTO,
  construirAlvo, razoesDeInelegibilidade, competenciaDaDataLegada,
  serializarParaHash, verificarHashManifesto, validarManifesto, planoRollback,
} from "./lib/six-pending-core.mjs";

const ROOT = path.join(import.meta.dirname, "..", "..");

const sha256 = (t) => createHash("sha256").update(t).digest("hex");

// ─── Argumentos ──────────────────────────────────────────────────────────────

const argv = process.argv.slice(2);
const temFlag = (n) => argv.includes(n);
const valor = (n) => {
  const i = argv.indexOf(n);
  return i >= 0 ? argv[i + 1] : null;
};

const OPCOES = {
  apply: temFlag("--apply"),
  rollback: temFlag("--rollback"),
  manifesto: valor("--manifest"),
  manifestoSha: valor("--manifest-sha"),
  confirmar: valor("--confirm-production"),
  databaseUrl: valor("--database-url"),
  saida: valor("--out") ?? path.join(ROOT, "..", "manifests"),
};

// ─── Segredos ────────────────────────────────────────────────────────────────

let SEGREDOS = [];

/** Nenhuma mensagem sai daqui com uma credencial dentro. */
function sanitizar(texto) {
  let s = String(texto ?? "");
  for (const seg of SEGREDOS) {
    if (seg && seg.length > 6) s = s.split(seg).join("«REDIGIDO»");
  }
  // Rede de segurança: qualquer coisa com forma de URL de ligação.
  s = s.replace(/postgres(?:ql)?:\/\/[^\s"']+/gi, "postgresql://«REDIGIDO»");
  return s;
}

function morrer(mensagem) {
  console.error(`\n⛔ ${sanitizar(mensagem)}\n`);
  process.exit(1);
}

/**
 * 🔴 Só linhas com `KEY=` contam.
 *
 *    A versão ingénua deste parser partia cada linha pelo primeiro `=` sem
 *    verificar se havia chave à esquerda, e imprimiu uma linha de ligação
 *    inteira — password incluída — num diagnóstico. A credencial foi rodada. O
 *    parser passou a ser este.
 */
function lerEnvLocal() {
  const p = path.join(ROOT, ".env.local");
  if (!fs.existsSync(p)) return {};
  const env = {};
  for (const linha of fs.readFileSync(p, "utf8").split(/\r?\n/)) {
    const i = linha.indexOf("=");
    if (i < 1) continue;
    const chave = linha.slice(0, i).trim();
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(chave)) continue;
    env[chave] = linha.slice(i + 1).trim().replace(/^["']|["']$/g, "");
  }
  return env;
}

// ─── Alvo ────────────────────────────────────────────────────────────────────

function refDoSupabase(url) {
  let u;
  try { u = new URL(url); } catch { return null; }
  const directo = u.hostname.match(/^db\.([a-z0-9]+)\.supabase\.co$/i);
  if (directo) return directo[1];
  if (/^[a-z0-9-]+\.pooler\.supabase\.com$/i.test(u.hostname)) {
    const m = decodeURIComponent(u.username).match(/^postgres\.([a-z0-9]+)$/i);
    if (m) return m[1];
  }
  return null;
}

/**
 * Que base é esta, e o que é preciso para lhe escrever.
 *
 * 🔴 Um alvo que não se consegue identificar é motivo de **recusa**, nunca de
 *    passagem. A #78 teve exactamente este buraco: a confirmação só era exigida
 *    quando o ref era legível, portanto uma URL estranha escrevia sem confirmar
 *    coisa nenhuma.
 */
function identificarAlvo(url) {
  let u;
  try { u = new URL(url); } catch {
    return { tipo: "ilegivel", erro: "A URL de ligação não é uma URL válida." };
  }

  const ref = refDoSupabase(url);
  if (ref) return { tipo: "producao", ref, ssl: { rejectUnauthorized: false } };

  const local = ["127.0.0.1", "localhost", "::1"].includes(u.hostname);
  if (local && OPCOES.databaseUrl) return { tipo: "ensaio", ref: null, ssl: false };

  return {
    tipo: "desconhecido",
    erro:
      "Não consigo dizer que base é esta. Um ensaio tem de vir por `--database-url` " +
      "e apontar para o computador local; produção tem de ser reconhecível como Supabase. " +
      "Um alvo não identificado nunca é escrito.",
  };
}

// ─── Leitura ─────────────────────────────────────────────────────────────────

const COLUNAS_MOVIMENTO = `
  id::text                  AS id,
  company_id::text          AS company_id,
  type,
  amount::text              AS amount,
  description,
  category,
  date::text                AS date,
  status,
  reference_type,
  reference_id::text        AS reference_id,
  expense_category_id::text AS expense_category_id,
  notes,
  created_at::text          AS created_at
`;

/**
 * 🔴 Tudo o que é data ou número vem como `::text`.
 *
 *    O node-postgres devolve colunas `date` como objectos `Date` e `numeric`
 *    como string — misturar as duas convenções foi o que, na #78, fez um
 *    snapshot devolver zero candidatos e passar por sucesso. Aqui o texto que
 *    entra no manifesto é o texto que a base tem.
 */
async function lerCandidatos(cliente, companyId) {
  const { rows } = await cliente.query(
    `SELECT ${COLUNAS_MOVIMENTO}
       FROM public.cash_flow_entries
      WHERE company_id = $1
        AND type = 'saida'
        AND status = 'pendente'
        AND reference_type IS NULL
        AND reference_id IS NULL
      ORDER BY date, created_at, id`,
    [companyId],
  );
  return rows;
}

async function lerCatalogo(cliente, companyId) {
  const { rows } = await cliente.query(
    `SELECT id::text AS id, name FROM public.expense_categories WHERE company_id = $1`,
    [companyId],
  );
  return rows;
}

async function descobrirEmpresa(cliente) {
  const { rows } = await cliente.query(
    `SELECT id::text AS id, name FROM public.companies ORDER BY name`,
  );
  if (rows.length !== 1) {
    morrer(`Esperava uma empresa, encontrei ${rows.length}. Passa a empresa explicitamente.`);
  }
  return rows[0];
}

// ─── Manifestos ──────────────────────────────────────────────────────────────

function construirManifesto(candidatos, catalogo, alvo) {
  const linhas = [];
  const avisos = [];

  for (const legado of candidatos) {
    const razoes = razoesDeInelegibilidade(legado);
    if (razoes.length > 0) {
      morrer(
        `A linha ${legado.id} não é o que a reparação espera:\n  · ${razoes.join("\n  · ")}\n\n` +
        "O lote inteiro pára. Saltar a linha daria um lote «bem sucedido» com menos linhas do que devia.",
      );
    }

    const paymentId = randomUUID();
    const r = construirAlvo(legado, { paymentId, catalogo });
    if (!r.ok) morrer(r.error);

    if (r.categoriaOrigem === "sem-equivalencia-deterministica") {
      avisos.push(
        `${legado.id}: categoria legada «${legado.category}» sem equivalência determinística — fica nula. ` +
        "O texto legado não se perde: continua no movimento.",
      );
    }

    linhas.push({
      legacy_cashflow_id: legado.id,
      target_payment_id: paymentId,
      company_id: legado.company_id,
      categoria_origem: r.categoriaOrigem,
      before: { ...legado },
      target: r.alvo,
      after: {
        ...legado,
        reference_type: ORIGEM_PAGAMENTO,
        reference_id: paymentId,
      },
    });
  }

  const manifesto = {
    gerado_em: new Date().toISOString(),
    alvo: { tipo: alvo.tipo, project_ref: alvo.ref ?? null },
    campos_escritos_no_movimento: CAMPOS_ESCRITOS_NO_MOVIMENTO,
    esperadas: ESPERADAS,
    total_cents: linhas.reduce((s, l) => s + Math.round(Number(l.before.amount) * 100), 0),
    linhas,
    avisos,
  };
  manifesto.sha256 = sha256(serializarParaHash(manifesto));
  return manifesto;
}

function construirRollback(manifesto) {
  return {
    gerado_em: manifesto.gerado_em,
    para_o_manifesto: manifesto.sha256,
    alvo: manifesto.alvo,
    // O rollback é o manifesto lido ao contrário: desligar, depois apagar.
    passos: manifesto.linhas.map((l) => ({
      cash_flow_id: l.legacy_cashflow_id,
      repor: { reference_type: l.before.reference_type, reference_id: l.before.reference_id },
      apagar_pagamento: l.target_payment_id,
      // Guardado para a reversão poder recusar se alguma coisa mudou.
      esperado_antes_da_reversao: {
        pagamento: { status: "pendente", amount: l.target.amount, due_date: null },
        movimento: { status: "pendente", reference_id: l.target_payment_id },
      },
    })),
  };
}

// ─── Escrita ─────────────────────────────────────────────────────────────────

/**
 * 🔴 A escrita é condicional ao estado que o manifesto viu.
 *
 *    O `UPDATE` exige `reference_type IS NULL` e `status = 'pendente'` e o valor
 *    exacto. Se alguém mexeu na linha entre a geração do manifesto e a
 *    execução, o `UPDATE` afecta zero linhas — e zero linhas aborta a
 *    transacção inteira. É a diferença entre «escrevi o que autorizaste» e
 *    «escrevi por cima do que entretanto aconteceu».
 */
async function aplicar(cliente, manifesto) {
  const feitos = [];
  await cliente.query("BEGIN");
  try {
    for (const l of manifesto.linhas) {
      const t = l.target;
      await cliente.query(
        `INSERT INTO public.fixed_variable_payments
           (id, company_id, kind, description, amount, due_date, status, recurring,
            period_year, period_month, notes, expense_category_id)
         VALUES ($1,$2,$3,$4,$5,NULL,$6,$7,$8,$9,$10,$11)`,
        [t.id, t.company_id, t.kind, t.description, t.amount, t.status,
         t.recurring, t.period_year, t.period_month, t.notes, t.expense_category_id],
      );

      const upd = await cliente.query(
        `UPDATE public.cash_flow_entries
            SET reference_type = $1, reference_id = $2
          WHERE id = $3
            AND company_id = $4
            AND reference_type IS NULL
            AND reference_id IS NULL
            AND status = 'pendente'
            AND type = 'saida'
            AND amount::text = $5`,
        [ORIGEM_PAGAMENTO, t.id, l.legacy_cashflow_id, l.company_id, String(l.before.amount)],
      );

      if (upd.rowCount !== 1) {
        throw new Error(
          `O movimento ${l.legacy_cashflow_id} já não está como o manifesto o viu ` +
          `(${upd.rowCount} linhas afectadas, esperava 1). Nada foi gravado.`,
        );
      }
      feitos.push(l.legacy_cashflow_id);
    }

    // Contagem final dentro da mesma transacção: se não bate certo, não commita.
    const { rows } = await cliente.query(
      `SELECT count(*)::int AS n FROM public.cash_flow_entries
        WHERE reference_type = $1 AND reference_id = ANY($2::uuid[])`,
      [ORIGEM_PAGAMENTO, manifesto.linhas.map((l) => l.target_payment_id)],
    );
    if (rows[0].n !== manifesto.linhas.length) {
      throw new Error(`Ligações finais: ${rows[0].n}, esperava ${manifesto.linhas.length}.`);
    }

    await cliente.query("COMMIT");
    return { ok: true, feitos };
  } catch (e) {
    await cliente.query("ROLLBACK");
    return { ok: false, error: sanitizar(e?.message ?? e), feitos: [] };
  }
}

async function reverter(cliente, rollbackManifesto) {
  const ids = rollbackManifesto.passos.map((p) => p.apagar_pagamento);
  const movIds = rollbackManifesto.passos.map((p) => p.cash_flow_id);

  const pagamentos = Object.fromEntries(
    (await cliente.query(
      `SELECT id::text AS id, status, amount::text AS amount, due_date::text AS due_date
         FROM public.fixed_variable_payments WHERE id = ANY($1::uuid[])`, [ids],
    )).rows.map((r) => [r.id, r]),
  );
  const movimentos = Object.fromEntries(
    (await cliente.query(
      `SELECT id::text AS id, status, reference_id::text AS reference_id
         FROM public.cash_flow_entries WHERE id = ANY($1::uuid[])`, [movIds],
    )).rows.map((r) => [r.id, r]),
  );

  const plano = planoRollback(
    { linhas: rollbackManifesto.passos.map((p) => ({
        legacy_cashflow_id: p.cash_flow_id,
        target_payment_id: p.apagar_pagamento,
        target: { amount: p.esperado_antes_da_reversao.pagamento.amount },
        before: p.repor,
      })) },
    { pagamentos, movimentos },
  );

  if (!plano.ok) {
    return {
      ok: false,
      error:
        "A reversão recusa. Houve actividade depois da reparação, e apagá-la seria " +
        "destruir trabalho real:\n  · " + plano.impedimentos.join("\n  · "),
    };
  }

  await cliente.query("BEGIN");
  try {
    for (const passo of plano.passos) {
      const u = await cliente.query(
        `UPDATE public.cash_flow_entries
            SET reference_type = $1, reference_id = $2
          WHERE id = $3 AND reference_id = $4`,
        [passo.desligar.para.reference_type, passo.desligar.para.reference_id,
         passo.desligar.cash_flow_id, passo.apagar_pagamento],
      );
      if (u.rowCount !== 1) throw new Error(`Desligar ${passo.desligar.cash_flow_id}: ${u.rowCount} linhas.`);

      const d = await cliente.query(
        `DELETE FROM public.fixed_variable_payments WHERE id = $1 AND status = 'pendente'`,
        [passo.apagar_pagamento],
      );
      if (d.rowCount !== 1) throw new Error(`Apagar o pagamento ${passo.apagar_pagamento}: ${d.rowCount} linhas.`);
    }
    await cliente.query("COMMIT");
    return { ok: true };
  } catch (e) {
    await cliente.query("ROLLBACK");
    return { ok: false, error: sanitizar(e?.message ?? e) };
  }
}

// ─── Principal ───────────────────────────────────────────────────────────────

async function main() {
  const env = lerEnvLocal();
  const url = OPCOES.databaseUrl ?? env.SUPABASE_DB_URL;
  if (!url) morrer("Sem ligação: falta `SUPABASE_DB_URL` no .env.local, ou `--database-url`.");
  // 🔴 Só a cadeia de ligação. A chave administrativa **não** é lida aqui, nem
  //    sequer para a lista de redacção: este executor fala Postgres directo e
  //    não tem nada que ver com ela. Ler uma credencial que não se usa é dar-se
  //    uma capacidade a mais — e o inventário da T17 marcou exactamente isso
  //    como `PRODUCTION_DANGEROUS` quando a linha estava aqui. Tinha razão.
  SEGREDOS = [url].filter(Boolean);

  const alvo = identificarAlvo(url);
  if (alvo.tipo === "ilegivel" || alvo.tipo === "desconhecido") morrer(alvo.erro);

  const escreve = OPCOES.apply || OPCOES.rollback;

  if (escreve) {
    if (alvo.tipo === "producao") {
      if (!OPCOES.confirmar) {
        morrer(
          `Escrever em produção exige --confirm-production ${alvo.ref}.\n` +
          "Não é uma formalidade: é a única coisa que separa este comando de o correr por engano.",
        );
      }
      if (OPCOES.confirmar !== alvo.ref) {
        morrer(`--confirm-production diz «${OPCOES.confirmar}», o alvo real é outro. Não escrevo.`);
      }
    } else if (OPCOES.confirmar !== "ENSAIO-DESCARTAVEL") {
      morrer("Um ensaio exige --confirm-production ENSAIO-DESCARTAVEL, literalmente.");
    }
    if (!OPCOES.manifesto) morrer("Escrever exige --manifest <ficheiro>.");
    if (!OPCOES.manifestoSha) morrer("Escrever exige --manifest-sha <sha256>.");
  }

  const cliente = new pg.Client({ connectionString: url, ssl: alvo.ssl });
  try {
    await cliente.connect();
  } catch (e) {
    morrer(`Não consegui ligar: ${sanitizar(e?.message ?? e)}`);
  }

  console.log(`\nALVO = ${alvo.tipo}${alvo.ref ? `  (${alvo.ref})` : ""}`);
  console.log(`MODO = ${OPCOES.rollback ? "ROLLBACK" : OPCOES.apply ? "APPLY" : "DRY-RUN (só leitura)"}\n`);

  try {
    // ── Reversão ──────────────────────────────────────────────────────────
    if (OPCOES.rollback) {
      const rb = JSON.parse(fs.readFileSync(OPCOES.manifesto, "utf8"));
      const h = verificarHashManifesto(rb, OPCOES.manifestoSha, sha256);
      if (!h.ok) morrer(h.error);
      const r = await reverter(cliente, rb);
      if (!r.ok) morrer(r.error);
      console.log("ROLLBACK_APPLIED = YES");
      return;
    }

    const empresa = await descobrirEmpresa(cliente);
    const catalogo = await lerCatalogo(cliente, empresa.id);
    const candidatos = await lerCandidatos(cliente, empresa.id);

    console.log(`SIX_FRESH_COUNT = ${candidatos.length}`);
    if (candidatos.length !== ESPERADAS) {
      morrer(
        `Esperava ${ESPERADAS} obrigações pendentes, encontrei ${candidatos.length}.\n` +
        "O mundo mudou desde a medição. Nada é escrito sobre um número que não bate certo.",
      );
    }

    // ── Aplicação ─────────────────────────────────────────────────────────
    if (OPCOES.apply) {
      const manifesto = JSON.parse(fs.readFileSync(OPCOES.manifesto, "utf8"));
      const h = verificarHashManifesto(manifesto, OPCOES.manifestoSha, sha256);
      if (!h.ok) morrer(h.error);
      const v = validarManifesto(manifesto);
      if (!v.ok) morrer(`O manifesto não passa nas invariantes:\n  · ${v.erros.join("\n  · ")}`);

      const r = await aplicar(cliente, manifesto);
      if (!r.ok) morrer(r.error);
      console.log(`SIX_REPAIR_EXECUTED = YES   linhas = ${r.feitos.length}   DELETE_COUNT = 0`);
      return;
    }

    // ── Dry-run ───────────────────────────────────────────────────────────
    const manifesto = construirManifesto(candidatos, catalogo, alvo);
    const rollbackM = construirRollback(manifesto);
    rollbackM.sha256 = sha256(serializarParaHash(rollbackM));

    const v = validarManifesto(manifesto);
    if (!v.ok) morrer(`O manifesto gerado não passa nas suas próprias invariantes:\n  · ${v.erros.join("\n  · ")}`);

    fs.mkdirSync(OPCOES.saida, { recursive: true });
    const fFwd = path.join(OPCOES.saida, "six-forward.json");
    const fRb = path.join(OPCOES.saida, "six-rollback.json");
    fs.writeFileSync(fFwd, JSON.stringify(manifesto, null, 2));
    fs.writeFileSync(fRb, JSON.stringify(rollbackM, null, 2));

    console.log(`SIX_FRESH_TOTAL_CENTS = ${manifesto.total_cents}`);
    console.log(`STRUCTURED_CATEGORY_COUNT = ${manifesto.linhas.filter((l) => l.categoria_origem === "preservada").length}`);
    console.log(`DETERMINISTIC_CATEGORY_MAPPINGS = ${manifesto.linhas.filter((l) => l.categoria_origem === "mapeada").length}`);
    console.log(`UNCATEGORIZED_AFTER_MAPPING = ${manifesto.linhas.filter((l) => !l.target.expense_category_id).length}`);
    console.log("");
    for (const l of manifesto.linhas) {
      const c = competenciaDaDataLegada(l.before.date);
      console.log(
        `  ${l.before.date}  ${String(l.before.amount).padStart(9)} €  ` +
        `competência ${c.ano}/${String(c.mes).padStart(2, "0")}  due_date=NULL  ${l.before.description}`,
      );
    }
    for (const a of manifesto.avisos) console.log(`  ⚠ ${a}`);
    console.log("");
    console.log(`FORWARD_MANIFEST_SHA  = ${manifesto.sha256}`);
    console.log(`ROLLBACK_MANIFEST_SHA = ${rollbackM.sha256}`);
    console.log(`\n(fora do Git: ${OPCOES.saida})`);
    console.log("SIX_PRODUCTION_WRITES = 0");
  } finally {
    await cliente.end();
  }
}

main().catch((e) => morrer(e?.stack ?? e?.message ?? e));

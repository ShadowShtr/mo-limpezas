#!/usr/bin/env node
// ============================================================================
// ENSAIO DA 079 — Postgres real, descartável, duas ligações
// ============================================================================
//
// 🔴 PORQUE NÃO PGlite. O `rehearse-071.mjs` usa PGlite e chega para provar
//    esquema. Aqui não chega: a 079 existe para se comportar bem quando duas
//    pessoas carregam no mesmo botão ao mesmo tempo, e PGlite só aceita **uma**
//    ligação. Provar `FOR UPDATE` com uma ligação é provar nada. Por isso este
//    ensaio levanta um Postgres a sério num contentor, e destrói-o no fim.
//
// 🔴 NÃO TOCA EM PRODUÇÃO. Não lê `.env`, não lê `SUPABASE_DB_URL`, não abre
//    rede para fora da máquina. A única base que conhece é a que ele próprio
//    cria e apaga. Se este ficheiro alguma vez precisar de uma credencial,
//    alguma coisa correu muito mal.
//
// ---------------------------------------------------------------------------
// O QUE ESTE ENSAIO PROVA
// ---------------------------------------------------------------------------
//
//   · o comportamento ANTES (073 sozinha): um movimento pendente ligado fica
//     preso em `pendente` depois de o pagamento ser pago — a prova de mutação
//     de que a 079 corrige alguma coisa de verdade;
//   · A) pagamento sem movimento        → mark paid → 1 movimento confirmado;
//   · B) pagamento + movimento pendente → mark paid → **a mesma linha**
//        confirmada, mesmo `id`, mesmo `created_at`, contagem inalterada;
//   · C) repetir                        → continua um, e nada muda;
//   · D) duas ligações em simultâneo    → continua um, e a segunda esperou
//        mesmo pela primeira (mede-se o tempo de bloqueio);
//   · E) erro a meio                    → a transacção reverte por inteiro:
//        o pagamento não fica pago e o movimento não é tocado;
//   · os guardas recusam reutilizar um movimento que não é o esperado
//     (empresa, tipo, valor, vínculo);
//   · a categoria do movimento acompanha a do pagamento sem nunca a apagar;
//   · a data do movimento passa a ser a data efectiva do pagamento;
//   · o rollback repõe a definição da 073 **byte a byte**.
//
// O QUE NÃO PROVA
//
//   · RLS em execução — não há utilizador autenticado aqui, `auth.uid()`
//     devolve `NULL`. As políticas são inspeccionadas noutros ensaios;
//   · que as 78 migrations históricas correm todas nesta base. O baseline
//     reproduz **apenas** aquilo de que a 073/079 dependem, com os CHECK reais
//     copiados dos ficheiros que os criaram. Reexecutar o histórico aqui
//     falharia por razões que nada têm que ver com esta migration.
// ============================================================================

import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import path from "node:path";
import pg from "pg";

const ROOT = path.join(import.meta.dirname, "..");
const MIGRACOES = path.join(ROOT, "supabase", "migrations");

const CONTENTOR = "escala-ensaio-079";
const PORTA = 55479;
const IMAGEM = "postgres:16-alpine";
const SENHA = "ensaio-descartavel-sem-valor";

const sql = (nome) => readFileSync(path.join(MIGRACOES, nome), "utf8");
const sqlRollback = (nome) => readFileSync(path.join(MIGRACOES, "rollback", nome), "utf8");

const M073 = "073_payment_to_cashflow.sql";
const M079 = "079_reuse_pending_cashflow_on_payment.sql";
const M079_DOWN = "079_reuse_pending_cashflow_on_payment.down.sql";

// ─── Registo de resultados ───────────────────────────────────────────────────

const resultados = [];
function verificar(nome, condicao, detalhe = "") {
  const ok = !!condicao;
  resultados.push({ nome, ok, detalhe });
  console.log(`  ${ok ? "✔" : "✘"} ${nome}${detalhe ? `  — ${detalhe}` : ""}`);
  return ok;
}

// ─── Contentor ───────────────────────────────────────────────────────────────

function docker(args, { silencioso = true } = {}) {
  const r = spawnSync("docker", args, { encoding: "utf8" });
  if (!silencioso && r.stdout) process.stdout.write(r.stdout);
  return r;
}

function destruirContentor() {
  docker(["rm", "-f", CONTENTOR]);
}

function levantarContentor() {
  // Se ficou um de uma execução anterior interrompida, vai-se embora primeiro.
  destruirContentor();
  const r = docker([
    "run", "-d", "--name", CONTENTOR,
    "-e", `POSTGRES_PASSWORD=${SENHA}`,
    "-e", "POSTGRES_DB=ensaio",
    "-p", `${PORTA}:5432`,
    IMAGEM,
  ]);
  if (r.status !== 0) {
    throw new Error(`Não foi possível levantar o contentor: ${r.stderr || r.stdout}`);
  }
}

/**
 * 🔴 `pg_isready` não chega, e a primeira versão deste ensaio provou-o: falhou
 *    com «Connection terminated unexpectedly» logo na primeira consulta.
 *
 *    A imagem do Postgres arranca o servidor uma vez para correr os scripts de
 *    inicialização, **pára-o**, e só depois o arranca a sério. Entre as duas
 *    coisas o `pg_isready` responde que sim, e quem se ligar nesse instante é
 *    desligado a meio. Esperar por uma ligação que sobrevive a um `SELECT` é a
 *    única prova de que a base está mesmo de pé.
 */
async function esperarProntoOuFalhar() {
  const limite = Date.now() + 90_000;
  let ultimo = "";
  while (Date.now() < limite) {
    const r = docker(["exec", CONTENTOR, "pg_isready", "-U", "postgres", "-d", "ensaio"]);
    if (r.status === 0) {
      const sonda = ligar();
      try {
        await sonda.connect();
        await sonda.query("SELECT 1");
        await sonda.end();
        return;
      } catch (e) {
        ultimo = String(e?.message ?? e);
        try { await sonda.end(); } catch { /* já morta */ }
      }
    } else {
      ultimo = (r.stderr || r.stdout || "").trim();
    }
    await new Promise((r2) => setTimeout(r2, 500));
  }
  throw new Error(`Postgres não ficou pronto a tempo. Último estado: ${ultimo}`);
}

function ligar() {
  return new pg.Client({
    host: "127.0.0.1",
    port: PORTA,
    user: "postgres",
    password: SENHA,
    database: "ensaio",
    // 🔴 `ssl: false` só é aceitável porque este destino é local e descartável.
    //    Um destino Supabase nunca passa por aqui — não há forma de este script
    //    apontar para um.
    ssl: false,
  });
}

// ─── Baseline ────────────────────────────────────────────────────────────────
//
// Os CHECK são cópias dos ficheiros que os criaram: `20260608_new_features`
// (cash_flow_entries), `037` (fixed_variable_payments), `049`+`075`
// (reference_type), `071` (expense_category_id, financial_periods) e `024`
// (o índice único de origem). Escrevê-los à mão aqui seria testar o andaime.

const BASELINE = `
CREATE SCHEMA IF NOT EXISTS auth;
CREATE OR REPLACE FUNCTION auth.uid() RETURNS uuid LANGUAGE sql STABLE AS $base$
  SELECT NULL::uuid
$base$;

CREATE TABLE public.companies (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name text NOT NULL
);

CREATE TABLE public.profiles (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id uuid REFERENCES public.companies(id) ON DELETE CASCADE,
  role text NOT NULL DEFAULT 'colaboradora'
);

CREATE TABLE public.expense_categories (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id uuid NOT NULL REFERENCES public.companies(id) ON DELETE CASCADE,
  name text NOT NULL,
  color text
);

CREATE TABLE public.financial_periods (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id uuid NOT NULL REFERENCES public.companies(id) ON DELETE CASCADE,
  year smallint NOT NULL,
  month smallint NOT NULL CHECK (month BETWEEN 1 AND 12),
  status text NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'closed')),
  closed_at timestamptz,
  CONSTRAINT financial_periods_unique UNIQUE (company_id, year, month)
);

CREATE TABLE public.cash_flow_entries (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id uuid NOT NULL REFERENCES public.companies(id) ON DELETE CASCADE,
  type text NOT NULL CHECK (type IN ('entrada', 'saida')),
  amount numeric(10,2) NOT NULL,
  description text NOT NULL,
  category text DEFAULT 'outro'
    CHECK (category IN ('faturacao', 'salario', 'despesa', 'fornecedor', 'outro')),
  date date NOT NULL,
  reference_id uuid,
  reference_type text
    CHECK (reference_type IS NULL OR reference_type IN
      ('invoice', 'payroll', 'service_payment', 'fixed_variable_payment')),
  status text NOT NULL DEFAULT 'confirmado'
    CHECK (status IN ('pendente', 'confirmado')),
  notes text,
  created_by uuid REFERENCES public.profiles(id),
  created_at timestamptz DEFAULT now(),
  expense_category_id uuid REFERENCES public.expense_categories(id) ON DELETE SET NULL
);

CREATE TABLE public.fixed_variable_payments (
  id uuid DEFAULT gen_random_uuid() PRIMARY KEY,
  company_id uuid NOT NULL REFERENCES public.companies(id) ON DELETE CASCADE,
  kind text NOT NULL CHECK (kind IN ('fixo', 'variavel')),
  description text NOT NULL,
  amount numeric(10,2),
  due_date date,
  direct_debit boolean,
  status text NOT NULL DEFAULT 'pendente' CHECK (status IN ('pago', 'pendente')),
  recurring boolean NOT NULL DEFAULT false,
  period_year integer NOT NULL,
  period_month integer NOT NULL CHECK (period_month BETWEEN 1 AND 12),
  paid_at timestamptz,
  notes text,
  sort_order integer DEFAULT 0,
  source_id uuid,
  created_by uuid REFERENCES public.profiles(id),
  created_at timestamptz DEFAULT now(),
  updated_at timestamptz DEFAULT now(),
  expense_category_id uuid REFERENCES public.expense_categories(id) ON DELETE SET NULL
);

-- 🔴 O índice da 024. É ele que impede duas linhas para a mesma origem.
CREATE UNIQUE INDEX cash_flow_entries_reference_unique
  ON public.cash_flow_entries (company_id, reference_type, reference_id)
  WHERE reference_type IS NOT NULL AND reference_id IS NOT NULL;
`;

// ─── Identificadores fixos, todos inventados ────────────────────────────────

const EMPRESA = "11111111-1111-1111-1111-111111111111";
const OUTRA_EMPRESA = "22222222-2222-2222-2222-222222222222";
const CATEGORIA = "33333333-3333-3333-3333-333333333333";
const DATA_PAGAMENTO = "2026-08-26";

let seq = 0;
const novoId = () => {
  seq += 1;
  return `aaaaaaaa-0000-4000-8000-${String(seq).padStart(12, "0")}`;
};

// ─── Utilidades de leitura ──────────────────────────────────────────────────

/**
 * A definição instalada, normalizada a LF.
 *
 * 🔴 A normalização não é cosmética, e também não é uma forma de fazer o teste
 *    passar. O corpo de uma função guarda os fins de linha do ficheiro que a
 *    criou, e em Windows o `core.autocrlf` entrega a 073 com CRLF e um ficheiro
 *    novo com LF — a mesma função dá duas definições diferentes consoante a
 *    máquina onde o ensaio corre. Comparar em bruto tornaria este ensaio
 *    vermelho em Windows e verde no CI, que é a pior combinação possível.
 *
 *    É exactamente a regra que `scripts/lib/migration-checksum.mjs` já aplica
 *    às migrations novas: o conteúdo conta, o fim de linha do checkout não.
 *
 *    A primeira execução deste ensaio apanhou uma divergência **real** aqui —
 *    faltavam cinco linhas de comentário no rollback — antes de a normalização
 *    existir. Continua a apanhar: só os `\\r` são ignorados.
 */
async function defFuncao(c) {
  const { rows } = await c.query(
    `SELECT pg_get_functiondef(p.oid) AS def
       FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
      WHERE n.nspname = 'public' AND p.proname = 'mark_payment_paid'`,
  );
  return rows.map((r) => r.def).join("\n").replace(/\r\n/g, "\n");
}

async function movimentosDe(c, pagamentoId) {
  const { rows } = await c.query(
    `SELECT id::text, status, amount::text, date::text, type, description,
            expense_category_id::text, created_at::text, notes
       FROM public.cash_flow_entries
      WHERE reference_type = 'fixed_variable_payment' AND reference_id = $1
      ORDER BY created_at`,
    [pagamentoId],
  );
  return rows;
}

async function pagamento(c, id) {
  const { rows } = await c.query(
    `SELECT status, paid_at::text FROM public.fixed_variable_payments WHERE id = $1`,
    [id],
  );
  return rows[0];
}

async function totalMovimentos(c) {
  const { rows } = await c.query(`SELECT count(*)::int AS n FROM public.cash_flow_entries`);
  return rows[0].n;
}

/** Cria um pagamento pendente. Devolve o id. */
async function criarPagamento(c, over = {}) {
  const id = novoId();
  const o = {
    company_id: EMPRESA, kind: "variavel", description: "Factura de fornecedor",
    amount: "153.75", period_year: 2026, period_month: 8,
    expense_category_id: null, due_date: null, ...over,
  };
  await c.query(
    `INSERT INTO public.fixed_variable_payments
       (id, company_id, kind, description, amount, due_date, status,
        period_year, period_month, expense_category_id)
     VALUES ($1,$2,$3,$4,$5,$6,'pendente',$7,$8,$9)`,
    [id, o.company_id, o.kind, o.description, o.amount, o.due_date,
     o.period_year, o.period_month, o.expense_category_id],
  );
  return id;
}

/** Cria um movimento de caixa já ligado a um pagamento. Devolve o id. */
async function criarMovimentoLigado(c, pagamentoId, over = {}) {
  const id = novoId();
  const o = {
    company_id: EMPRESA, type: "saida", amount: "153.75",
    description: "Factura de fornecedor", category: "despesa",
    date: "2026-07-10", status: "pendente", expense_category_id: null,
    notes: "lançamento legado", ...over,
  };
  await c.query(
    `INSERT INTO public.cash_flow_entries
       (id, company_id, type, amount, description, category, date,
        reference_type, reference_id, status, expense_category_id, notes)
     VALUES ($1,$2,$3,$4,$5,$6,$7,'fixed_variable_payment',$8,$9,$10,$11)`,
    [id, o.company_id, o.type, o.amount, o.description, o.category, o.date,
     pagamentoId, o.status, o.expense_category_id, o.notes],
  );
  return id;
}

function marcarPago(c, pagamentoId, data = DATA_PAGAMENTO, empresa = EMPRESA) {
  return c.query("SELECT * FROM public.mark_payment_paid($1, $2, $3)", [empresa, pagamentoId, data]);
}

// ─── Ensaio ──────────────────────────────────────────────────────────────────

async function main() {
  console.log("\n═══ ENSAIO 079 — reutilizar o movimento pendente (Postgres descartável) ═══\n");

  levantarContentor();
  await esperarProntoOuFalhar();

  const c = ligar();
  await c.connect();

  const { rows: [{ v }] } = await c.query("SELECT version() AS v");
  const versao = v.split(" ").slice(0, 2).join(" ");
  console.log(`Motor: ${versao}   (contentor descartável ${CONTENTOR})\n`);

  await c.query(BASELINE);
  await c.query(
    `INSERT INTO public.companies (id, name) VALUES ($1,'Ensaio A'), ($2,'Ensaio B')`,
    [EMPRESA, OUTRA_EMPRESA],
  );
  await c.query(
    `INSERT INTO public.expense_categories (id, company_id, name, color)
     VALUES ($1, $2, 'Fornecedores', 'violet')`,
    [CATEGORIA, EMPRESA],
  );

  // ── 0. A 073, tal como está em produção ───────────────────────────────────
  console.log("── 0. Estado anterior: a 073 do ficheiro versionado");
  await c.query(sql(M073));
  const DEF_073 = await defFuncao(c);
  verificar("`mark_payment_paid` instalada a partir da 073", DEF_073.length > 0);

  // ── 1. 🔴 PROVA DE MUTAÇÃO — o defeito, com a 073 sozinha ─────────────────
  console.log("\n── 1. 🔴 O defeito, reproduzido com a 073 sozinha");
  {
    const pag = await criarPagamento(c);
    const mov = await criarMovimentoLigado(c, pag);
    const r = await marcarPago(c, pag);

    const movs = await movimentosDe(c, pag);
    verificar("o pagamento fica pago", (await pagamento(c, pag)).status === "pago");
    verificar("não se cria um segundo movimento (o índice da 024 aguenta)", movs.length === 1);
    verificar(
      "🔴 mas o movimento fica PRESO em `pendente` — é este o buraco",
      movs[0].status === "pendente",
      `status=${movs[0].status}`,
    );
    verificar("a data antiga também fica", movs[0].date === "2026-07-10", `date=${movs[0].date}`);
    verificar("e a RPC devolve o id certo, sem erro nenhum", r.rows[0].cash_entry_id === mov);
  }

  // ── 2. Aplicar a 079 ───────────────────────────────────────────────────────
  console.log("\n── 2. Aplicar a 079");
  const movimentosAntesDa079 = await totalMovimentos(c);
  const { rows: pagAntes } = await c.query(
    `SELECT id::text, status FROM public.fixed_variable_payments ORDER BY id`,
  );
  await c.query(sql(M079));
  verificar("a 079 aplica sem erro", true);
  verificar(
    "MIGRATION_DATA_WRITES = 0 — não criou nem apagou movimentos",
    (await totalMovimentos(c)) === movimentosAntesDa079,
    `${movimentosAntesDa079} antes e depois`,
  );
  {
    const { rows: pagDepois } = await c.query(
      `SELECT id::text, status FROM public.fixed_variable_payments ORDER BY id`,
    );
    verificar(
      "MIGRATION_DATA_WRITES = 0 — não mexeu em nenhum pagamento",
      JSON.stringify(pagAntes) === JSON.stringify(pagDepois),
    );
  }

  // ── 3. Ciclo A — pagamento sem movimento ──────────────────────────────────
  console.log("\n── 3. A) pagamento sem movimento ligado");
  {
    const pag = await criarPagamento(c, { expense_category_id: CATEGORIA });
    const r = await marcarPago(c, pag);
    const movs = await movimentosDe(c, pag);

    verificar("RPC01. cria exactamente um movimento", movs.length === 1);
    verificar("RPC01. nasce `confirmado`", movs[0].status === "confirmado");
    verificar("RPC01. com a data do pagamento", movs[0].date === DATA_PAGAMENTO);
    verificar("RPC01. e com a categoria do pagamento", movs[0].expense_category_id === CATEGORIA);
    verificar("RPC01. `ja_estava_pago` = false — houve efeito", r.rows[0].ja_estava_pago === false);
  }

  // ── 4. Ciclo B — pagamento com movimento pendente ligado ──────────────────
  console.log("\n── 4. B) pagamento com movimento pendente ligado  (o caso das 6)");
  let pagB, movB, criadoEmB;
  {
    pagB = await criarPagamento(c, { expense_category_id: CATEGORIA });
    movB = await criarMovimentoLigado(c, pagB);
    const antes = (await movimentosDe(c, pagB))[0];
    criadoEmB = antes.created_at;

    const totalAntes = await totalMovimentos(c);
    const r = await marcarPago(c, pagB);
    const movs = await movimentosDe(c, pagB);

    verificar("RPC02. continua a haver um só movimento", movs.length === 1);
    verificar("RPC02. e o total da tabela não subiu", (await totalMovimentos(c)) === totalAntes);
    verificar("RPC02. a linha passou a `confirmado`", movs[0].status === "confirmado");
    verificar("RPC03. 🔴 SAME_CASHFLOW_ID_AFTER_PAYMENT — o `id` é o mesmo", movs[0].id === movB);
    verificar("RPC03. o `created_at` original sobrevive", movs[0].created_at === criadoEmB);
    verificar("RPC03. as notas do lançamento legado sobrevivem", movs[0].notes === "lançamento legado");
    verificar(
      "RPC12. a data passou a ser a do pagamento efectivo",
      movs[0].date === DATA_PAGAMENTO,
      `${antes.date} → ${movs[0].date}`,
    );
    verificar("RPC10. o snapshot de categoria acompanha o pagamento",
      movs[0].expense_category_id === CATEGORIA);
    verificar("RPC02. `ja_estava_pago` = false — a conversão é um efeito real",
      r.rows[0].ja_estava_pago === false);
    verificar("RPC02. e o pagamento ficou pago", (await pagamento(c, pagB)).status === "pago");
  }

  // ── 5. Ciclo C — repetir ──────────────────────────────────────────────────
  console.log("\n── 5. C) repetir a mesma operação");
  {
    const totalAntes = await totalMovimentos(c);
    const antes = (await movimentosDe(c, pagB))[0];

    const r1 = await marcarPago(c, pagB);
    const r2 = await marcarPago(c, pagB);
    const movs = await movimentosDe(c, pagB);

    verificar("RPC05. continua um só movimento", movs.length === 1);
    verificar("RPC05. e o total da tabela não mexeu", (await totalMovimentos(c)) === totalAntes);
    verificar("RPC04. o `id` continua o mesmo", movs[0].id === movB);
    verificar("RPC04. e a linha ficou exactamente como estava",
      JSON.stringify(movs[0]) === JSON.stringify(antes));
    verificar("RPC04. `ja_estava_pago` = true nas repetições",
      r1.rows[0].ja_estava_pago === true && r2.rows[0].ja_estava_pago === true);
  }

  // ── 6. Guardas — falhar fechado ───────────────────────────────────────────
  console.log("\n── 6. Guardas: nenhum movimento estranho é aproveitado");

  async function recusa(nome, prepara, esperado) {
    const pag = await criarPagamento(c);
    const mov = await prepara(pag);
    const antesMov = mov ? (await movimentosDe(c, pag))[0] : null;
    const totalAntes = await totalMovimentos(c);

    let erro = null;
    try {
      await marcarPago(c, pag);
    } catch (e) {
      erro = e;
    }

    const depoisPag = await pagamento(c, pag);
    const depoisMov = mov ? (await movimentosDe(c, pag))[0] : null;

    verificar(`${nome} — recusa com ${esperado}`, !!erro && String(erro.message).includes(esperado),
      erro ? String(erro.message).split("\n")[0] : "não levantou excepção");
    verificar(`${nome} — 🔴 o pagamento NÃO ficou pago (transacção revertida)`,
      depoisPag.status === "pendente", `status=${depoisPag.status}`);
    if (antesMov) {
      verificar(`${nome} — o movimento não foi tocado`,
        JSON.stringify(depoisMov) === JSON.stringify(antesMov));
    }
    verificar(`${nome} — nenhuma linha nova`, (await totalMovimentos(c)) === totalAntes);
  }

  await recusa("RPC07 valor diferente",
    (pag) => criarMovimentoLigado(c, pag, { amount: "999.99" }),
    "CASHFLOW_LINK_AMOUNT_MISMATCH");

  await recusa("RPC08 tipo errado (`entrada`)",
    (pag) => criarMovimentoLigado(c, pag, { type: "entrada", category: "faturacao" }),
    "CASHFLOW_LINK_TYPE_MISMATCH");

  // RPC06 — empresa diferente. Aqui o pagamento não existe para aquela empresa,
  // e a função pára logo na primeira leitura. É o comportamento certo: um
  // movimento de outra empresa nunca chega a ser considerado.
  {
    const pag = await criarPagamento(c);
    let erro = null;
    try {
      await marcarPago(c, pag, DATA_PAGAMENTO, OUTRA_EMPRESA);
    } catch (e) { erro = e; }
    verificar("RPC06. empresa diferente — recusa antes de tocar em nada",
      !!erro && /inexistente ou de outra empresa/i.test(String(erro.message)));
    verificar("RPC06. o pagamento continua pendente",
      (await pagamento(c, pag)).status === "pendente");
  }

  // RPC09 — vínculo apontado a outro pagamento. O movimento existe, mas com
  // `reference_id` de outra coisa: a função não o pode encontrar, e cria o seu.
  {
    const pagA = await criarPagamento(c);
    const pagB2 = await criarPagamento(c);
    await criarMovimentoLigado(c, pagA);          // pertence ao pagA
    const totalAntes = await totalMovimentos(c);

    await marcarPago(c, pagB2);

    verificar("RPC09. um movimento de outro pagamento não é aproveitado",
      (await movimentosDe(c, pagB2)).length === 1);
    verificar("RPC09. o movimento do outro pagamento continua pendente e intacto",
      (await movimentosDe(c, pagA))[0].status === "pendente");
    verificar("RPC09. criou-se uma linha nova, não se reciclou a alheia",
      (await totalMovimentos(c)) === totalAntes + 1);
  }

  // RPC15 — nada mais na tabela mexeu.
  {
    const solto = novoId();
    await c.query(
      `INSERT INTO public.cash_flow_entries
         (id, company_id, type, amount, description, category, date, status)
       VALUES ($1, $2, 'saida', 42.00, 'Despesa manual sem origem', 'despesa', '2026-08-01', 'pendente')`,
      [solto, EMPRESA],
    );
    const antes = (await c.query(`SELECT * FROM public.cash_flow_entries WHERE id = $1`, [solto])).rows[0];

    const pag = await criarPagamento(c);
    await marcarPago(c, pag);

    const depois = (await c.query(`SELECT * FROM public.cash_flow_entries WHERE id = $1`, [solto])).rows[0];
    verificar("RPC15. um movimento manual sem origem não é tocado",
      JSON.stringify(antes) === JSON.stringify(depois));
  }

  // RPC10b — o pagamento sem categoria não apaga a que o movimento já tinha.
  {
    const pag = await criarPagamento(c, { expense_category_id: null });
    await criarMovimentoLigado(c, pag, { expense_category_id: CATEGORIA });
    await marcarPago(c, pag);
    const movs = await movimentosDe(c, pag);
    verificar("RPC10b. pagamento sem categoria não apaga a do movimento",
      movs[0].expense_category_id === CATEGORIA);
    verificar("RPC10b. e a conversão fez-se na mesma", movs[0].status === "confirmado");
  }

  // ── 7. E) erro a meio — a transacção reverte por inteiro ──────────────────
  console.log("\n── 7. E) erro depois da actualização: reversão total");
  {
    const pag = await criarPagamento(c);
    const mov = await criarMovimentoLigado(c, pag);
    const movAntes = (await movimentosDe(c, pag))[0];

    // A conversão acontece, e a seguir a transacção rebenta por outra razão.
    // Se a atomicidade não fosse real, ficava um movimento confirmado sem o
    // pagamento correspondente — que é a divergência que tudo isto evita.
    let erro = null;
    await c.query("BEGIN");
    try {
      await marcarPago(c, pag);
      await c.query("SELECT 1 / 0");
    } catch (e) {
      erro = e;
    }
    await c.query("ROLLBACK");

    verificar("RPC13. o erro forçado rebentou mesmo", !!erro);
    verificar("RPC13. 🔴 o movimento voltou a `pendente`",
      (await movimentosDe(c, pag))[0].status === "pendente");
    verificar("RPC13. com a data original", (await movimentosDe(c, pag))[0].date === movAntes.date);
    verificar("RPC13. e o pagamento voltou a `pendente`",
      (await pagamento(c, pag)).status === "pendente");
    verificar("RPC13. o `id` do movimento nunca mudou",
      (await movimentosDe(c, pag))[0].id === mov);
  }

  // ── 8. D) duas ligações em simultâneo ─────────────────────────────────────
  console.log("\n── 8. D) duas ligações a marcar o mesmo pagamento ao mesmo tempo");
  {
    const pag = await criarPagamento(c);
    await criarMovimentoLigado(c, pag);

    const a = ligar();
    const b = ligar();
    await a.connect();
    await b.connect();

    await a.query("BEGIN");
    await a.query("SELECT * FROM public.mark_payment_paid($1, $2, $3)", [EMPRESA, pag, DATA_PAGAMENTO]);

    // B entra a seguir e tem de esperar pela tranca de A.
    await b.query("BEGIN");
    const t0 = Date.now();
    const promessaB = b
      .query("SELECT * FROM public.mark_payment_paid($1, $2, $3)", [EMPRESA, pag, DATA_PAGAMENTO])
      .then((r) => ({ ok: true, r, ms: Date.now() - t0 }))
      .catch((e) => ({ ok: false, e, ms: Date.now() - t0 }));

    // Dá-se tempo suficiente para B ter avançado, se não estivesse bloqueado.
    await new Promise((r) => setTimeout(r, 1200));
    const aindaBloqueado = await (async () => {
      const { rows } = await c.query(
        `SELECT count(*)::int AS n FROM pg_stat_activity
          WHERE datname = 'ensaio' AND wait_event_type = 'Lock'`,
      );
      return rows[0].n > 0;
    })();

    await a.query("COMMIT");
    const resB = await promessaB;
    await b.query("COMMIT");

    const movs = await movimentosDe(c, pag);
    verificar("RPC14. 🔴 B ficou mesmo à espera de A", aindaBloqueado && resB.ms >= 1000,
      `bloqueio observado, B esperou ${resB.ms}ms`);
    verificar("RPC14. B não falhou — serializou", resB.ok, resB.ok ? "" : String(resB.e?.message));
    verificar("RPC14. um pagamento pago", (await pagamento(c, pag)).status === "pago");
    verificar("RPC14. 🔴 um movimento, e confirmado", movs.length === 1 && movs[0].status === "confirmado");
    verificar("RPC14. zero duplicados", movs.length === 1);
    verificar("RPC14. a segunda chamada reportou-se sem efeito",
      resB.ok && resB.r.rows[0].ja_estava_pago === true);

    await a.end();
    await b.end();
  }

  // ── 9. Rollback da migration ──────────────────────────────────────────────
  console.log("\n── 9. Rollback: a definição da 073 volta byte a byte");
  {
    const DEF_079 = await defFuncao(c);
    verificar("a 079 mudou mesmo a definição instalada", DEF_079 !== DEF_073);

    const movimentosAntes = await totalMovimentos(c);
    await c.query(sqlRollback(M079_DOWN));
    const DEF_REPOSTA = await defFuncao(c);

    verificar("🔴 PREVIOUS_RPC restaurada — definição idêntica à da 073",
      DEF_REPOSTA === DEF_073,
      DEF_REPOSTA === DEF_073 ? "" : "a definição reposta DIVERGE da 073",
    );
    verificar("o rollback não tocou em dados", (await totalMovimentos(c)) === movimentosAntes);

    // E o comportamento antigo volta — a prova de que o rollback é real e não
    // apenas texto igual.
    const pag = await criarPagamento(c);
    await criarMovimentoLigado(c, pag);
    await marcarPago(c, pag);
    verificar("depois do rollback o defeito antigo volta (movimento fica pendente)",
      (await movimentosDe(c, pag))[0].status === "pendente");

    // Reaplicar a 079 fecha-o outra vez — apply → rollback → apply.
    await c.query(sql(M079));
    await marcarPago(c, pag);
    verificar("reaplicar a 079 volta a fechá-lo",
      (await movimentosDe(c, pag))[0].status === "confirmado");
  }

  await c.end();
}

// ─── Execução ────────────────────────────────────────────────────────────────

let codigo = 0;
try {
  await main();
} catch (e) {
  console.error(`\n✘ ENSAIO INTERROMPIDO: ${e?.message ?? e}`);
  resultados.push({ nome: "o ensaio correu até ao fim", ok: false, detalhe: String(e?.message ?? e) });
  codigo = 1;
} finally {
  destruirContentor();
  const morto = docker(["ps", "-a", "--filter", `name=${CONTENTOR}`, "--format", "{{.Names}}"]);
  const aindaExiste = (morto.stdout ?? "").trim() !== "";
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

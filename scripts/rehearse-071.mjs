#!/usr/bin/env node
// ============================================================================
// GATE M1 — ensaio da migration 071 numa base descartável
// ============================================================================
//
// 🔴 SEM DOCKER. Usa PGlite: Postgres compilado para WASM, a correr dentro
//    deste processo. Nasce vazia, morre no fim, e não há serviço a instalar
//    nem porta a abrir.
//
// 🔴 NÃO TOCA EM PRODUÇÃO. Não lê credenciais, não abre rede, não conhece o
//    projecto Supabase. Se este ficheiro alguma vez precisar de uma variável
//    de ambiente, alguma coisa correu muito mal.
//
// ---------------------------------------------------------------------------
// O QUE ESTE ENSAIO PROVA — E O QUE NÃO PROVA
// ---------------------------------------------------------------------------
//
// PROVA:
//   · a 071 aplica sem erro sobre um baseline que reproduz o que ela toca;
//   · cria o que diz criar, e nada mais;
//   · não semeia categorias nenhumas;
//   · as restrições comportam-se como esperado, incluindo o índice único de
//     origem que vem da 024;
//   · o rollback devolve o esquema ao estado anterior, campo a campo.
//
// NÃO PROVA:
//   · que as 71 migrações históricas correm todas — muitas dependem de coisas
//     que só existem no Supabase (`auth.users`, `storage.objects`, os papéis
//     `service_role`/`authenticated`, extensões próprias). Reexecutá-las aqui
//     falharia por razões que nada têm que ver com a 071;
//   · o histórico de storage byte a byte — a divergência aceite do `022`;
//   · o comportamento real do RLS sob os papéis do Supabase. As políticas são
//     criadas e verificadas na sua **definição**, não exercidas com um
//     utilizador autenticado a sério.
//
// O baseline é construído para reproduzir **exactamente aquilo de que a 071
// depende**: `companies`, `profiles`, `cash_flow_entries`,
// `fixed_variable_payments`, o índice da 024 e um `auth.uid()` que as
// políticas possam referenciar. Nada mais, para o ensaio não passar a testar
// o andaime em vez da migration.
// ============================================================================

import { PGlite } from "@electric-sql/pglite";
import fs from "node:fs";
import path from "node:path";

const ROOT = path.join(import.meta.dirname, "..");
const MIGRACOES = path.join(ROOT, "supabase", "migrations");

const resultados = [];
function verificar(nome, condicao, detalhe = "") {
  resultados.push({ nome, ok: !!condicao, detalhe });
  const marca = condicao ? "  ✔" : "  ✘";
  console.log(`${marca} ${nome}${detalhe ? `  — ${detalhe}` : ""}`);
  return !!condicao;
}

/** As colunas de uma tabela, ordenadas — a impressão digital do esquema. */
async function colunas(db, tabela) {
  const r = await db.query(
    `select column_name, data_type, is_nullable
       from information_schema.columns
      where table_schema = 'public' and table_name = $1
      order by column_name`,
    [tabela],
  );
  return r.rows.map((c) => `${c.column_name}:${c.data_type}:${c.is_nullable}`);
}

async function existeTabela(db, tabela) {
  const r = await db.query(
    `select 1 from information_schema.tables
      where table_schema = 'public' and table_name = $1`,
    [tabela],
  );
  return r.rows.length > 0;
}

async function existeIndice(db, nome) {
  const r = await db.query(`select 1 from pg_indexes where schemaname='public' and indexname=$1`, [nome]);
  return r.rows.length > 0;
}

// ─── Baseline ────────────────────────────────────────────────────────────────

const BASELINE = `
-- Papéis e função que as políticas do Supabase referenciam. Aqui são um
-- andaime: existem para o SQL das políticas ser válido, não para simular
-- autenticação a sério.
CREATE SCHEMA IF NOT EXISTS auth;
CREATE OR REPLACE FUNCTION auth.uid() RETURNS uuid LANGUAGE sql STABLE AS $$
  SELECT NULL::uuid
$$;

CREATE TABLE public.companies (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name text NOT NULL
);

CREATE TABLE public.profiles (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id uuid REFERENCES public.companies(id) ON DELETE CASCADE,
  role text NOT NULL DEFAULT 'colaboradora'
);

CREATE TABLE public.cash_flow_entries (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id uuid NOT NULL REFERENCES public.companies(id) ON DELETE CASCADE,
  type text NOT NULL,
  amount numeric(12,2) NOT NULL,
  description text,
  category text,
  date date NOT NULL,
  reference_id uuid,
  reference_type text,
  status text NOT NULL DEFAULT 'confirmado',
  notes text,
  created_by uuid,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE public.fixed_variable_payments (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id uuid NOT NULL REFERENCES public.companies(id) ON DELETE CASCADE,
  kind text NOT NULL,
  description text NOT NULL,
  amount numeric(12,2),
  due_date date,
  status text NOT NULL DEFAULT 'pendente',
  recurring boolean NOT NULL DEFAULT false,
  period_year smallint NOT NULL,
  period_month smallint NOT NULL,
  paid_at timestamptz,
  source_id uuid,
  created_at timestamptz NOT NULL DEFAULT now()
);

-- 🔴 O índice da 024. É por existir aqui que a 071 não precisa de o recriar.
CREATE UNIQUE INDEX IF NOT EXISTS cash_flow_entries_reference_unique
  ON cash_flow_entries (company_id, reference_type, reference_id)
  WHERE reference_type IS NOT NULL AND reference_id IS NOT NULL;
`;

// ─── Rollback ────────────────────────────────────────────────────────────────
//
// 🔴 A 071 termina com COMMIT. Um `ROLLBACK` depois disso não desfaz nada — é
//    por isso que o rollback tem de ser SQL explícito, na ordem inversa, e
//    ensaiado como qualquer outra coisa. Este script existe também para provar
//    que este SQL está certo antes de alguém precisar dele a sério.

const ROLLBACK = `
BEGIN;
DROP INDEX IF EXISTS public.idx_financial_periods_lookup;
DROP TABLE IF EXISTS public.financial_periods;
DROP INDEX IF EXISTS public.idx_cash_flow_category;
ALTER TABLE public.fixed_variable_payments DROP COLUMN IF EXISTS expense_category_id;
ALTER TABLE public.cash_flow_entries DROP COLUMN IF EXISTS expense_category_id;
DROP INDEX IF EXISTS public.idx_expense_categories_company;
DROP TABLE IF EXISTS public.expense_categories;
COMMIT;
`;

// ─── Ensaio ──────────────────────────────────────────────────────────────────

async function main() {
  console.log("\n═══ GATE M1 — ensaio da 071 em base descartável (PGlite, sem Docker) ═══\n");

  const db = await PGlite.create();
  const versao = (await db.query("select version()")).rows[0].version.split(",")[0];
  console.log(`Motor: ${versao}\n`);

  // ── 1. Baseline ────────────────────────────────────────────────────────────
  console.log("── 1. Baseline pré-071");
  await db.exec(BASELINE);

  const impressaoAntes = {
    cash_flow_entries: await colunas(db, "cash_flow_entries"),
    fixed_variable_payments: await colunas(db, "fixed_variable_payments"),
  };

  verificar("cash_flow_entries existe", await existeTabela(db, "cash_flow_entries"));
  verificar("fixed_variable_payments existe", await existeTabela(db, "fixed_variable_payments"));
  verificar("o índice de origem da 024 está presente",
    await existeIndice(db, "cash_flow_entries_reference_unique"));
  verificar("expense_categories NÃO existe ainda", !(await existeTabela(db, "expense_categories")));
  verificar("financial_periods NÃO existe ainda", !(await existeTabela(db, "financial_periods")));
  verificar("expense_category_id NÃO existe ainda",
    !impressaoAntes.cash_flow_entries.some((c) => c.startsWith("expense_category_id")));

  // Dados históricos, para provar que a migration não lhes toca.
  await db.exec(`
    INSERT INTO public.companies (id, name) VALUES
      ('11111111-1111-1111-1111-111111111111', 'Empresa A'),
      ('22222222-2222-2222-2222-222222222222', 'Empresa B');
    INSERT INTO public.cash_flow_entries (company_id, type, amount, description, category, date) VALUES
      ('11111111-1111-1111-1111-111111111111', 'saida', 100.00, 'Gasóleo', 'combustivel', '2026-08-01'),
      ('11111111-1111-1111-1111-111111111111', 'saida',  50.00, 'Produtos', NULL,          '2026-08-02'),
      ('11111111-1111-1111-1111-111111111111', 'entrada', 200.00, 'Recebimento', NULL,     '2026-08-03');
  `);
  const antesLinhas = (await db.query("select count(*)::int as n from cash_flow_entries")).rows[0].n;

  // ── 2. Aplicar a 071 ───────────────────────────────────────────────────────
  console.log("\n── 2. Aplicar a 071");
  const sql071 = fs.readFileSync(
    path.join(MIGRACOES, "071_finance_periods_and_expense_categories.sql"), "utf8",
  );
  try {
    await db.exec(sql071);
    verificar("a 071 aplica sem erro", true);
  } catch (e) {
    verificar("a 071 aplica sem erro", false, e.message);
    throw e;
  }

  // ── 3. O que a 071 criou ───────────────────────────────────────────────────
  console.log("\n── 3. O que ficou criado");
  verificar("expense_categories existe", await existeTabela(db, "expense_categories"));
  verificar("financial_periods existe", await existeTabela(db, "financial_periods"));

  const colCash = await colunas(db, "cash_flow_entries");
  const colPag = await colunas(db, "fixed_variable_payments");
  verificar("cash_flow_entries.expense_category_id existe",
    colCash.some((c) => c.startsWith("expense_category_id")));
  verificar("fixed_variable_payments.expense_category_id existe",
    colPag.some((c) => c.startsWith("expense_category_id")));
  verificar("expense_category_id é NULLABLE — não se inventa categoria para o histórico",
    colCash.some((c) => c.startsWith("expense_category_id") && c.endsWith(":YES")));

  const nCat = (await db.query("select count(*)::int as n from expense_categories")).rows[0].n;
  verificar("🔴 ZERO categorias semeadas", nCat === 0, `${nCat} linhas`);

  const nPer = (await db.query("select count(*)::int as n from financial_periods")).rows[0].n;
  verificar("nenhum período criado — todos nascem abertos por ausência", nPer === 0);

  const depoisLinhas = (await db.query("select count(*)::int as n from cash_flow_entries")).rows[0].n;
  verificar("o histórico não foi tocado", depoisLinhas === antesLinhas,
    `${antesLinhas} → ${depoisLinhas}`);

  const semCat = (await db.query(
    "select count(*)::int as n from cash_flow_entries where expense_category_id is null"
  )).rows[0].n;
  verificar("🔴 zero classificação automática do histórico", semCat === depoisLinhas,
    `${semCat}/${depoisLinhas} sem categoria`);

  verificar("a 071 NÃO recriou o índice de origem", !(await existeIndice(db, "uq_cash_flow_origin")));
  verificar("o índice da 024 continua lá", await existeIndice(db, "cash_flow_entries_reference_unique"));

  // ── 4. Idempotência de origem ──────────────────────────────────────────────
  console.log("\n── 4. Idempotência de origem (índice da 024)");
  const A = "11111111-1111-1111-1111-111111111111";
  const B = "22222222-2222-2222-2222-222222222222";
  const PAG = "33333333-3333-3333-3333-333333333333";

  const inserirComOrigem = (company) => db.query(
    `insert into cash_flow_entries (company_id, type, amount, date, reference_type, reference_id)
     values ($1, 'saida', 49.90, '2026-08-12', 'fixed_variable_payment', $2)`,
    [company, PAG],
  );

  await inserirComOrigem(A);
  let segundaRecusada = false;
  try { await inserirComOrigem(A); } catch { segundaRecusada = true; }
  verificar("🔴 a mesma origem duas vezes é recusada pela base", segundaRecusada);

  let outraEmpresaOk = true;
  try { await inserirComOrigem(B); } catch { outraEmpresaOk = false; }
  verificar("origens iguais em empresas diferentes são permitidas", outraEmpresaOk);

  let manuaisOk = true;
  try {
    await db.exec(`
      insert into cash_flow_entries (company_id, type, amount, date) values
        ('${A}', 'saida', 10.00, '2026-08-12'),
        ('${A}', 'saida', 10.00, '2026-08-12');
    `);
  } catch { manuaisOk = false; }
  verificar("duas despesas manuais sem origem são permitidas (índice parcial)", manuaisOk);

  // ── 5. Restrições dos períodos ─────────────────────────────────────────────
  console.log("\n── 5. financial_periods");
  const tentar = async (sql) => {
    try { await db.query(sql); return true; } catch { return false; }
  };

  verificar("mês 8 é aceite",
    await tentar(`insert into financial_periods (company_id, year, month) values ('${A}', 2026, 8)`));
  verificar("mês 0 é recusado",
    !(await tentar(`insert into financial_periods (company_id, year, month) values ('${A}', 2026, 0)`)));
  verificar("mês 13 é recusado",
    !(await tentar(`insert into financial_periods (company_id, year, month) values ('${A}', 2026, 13)`)));
  verificar("o mesmo mês duas vezes é recusado",
    !(await tentar(`insert into financial_periods (company_id, year, month) values ('${A}', 2026, 8)`)));
  verificar("estado inválido é recusado",
    !(await tentar(`insert into financial_periods (company_id, year, month, status) values ('${A}', 2026, 9, 'meio-aberto')`)));
  verificar("🔴 reabrir sem motivo é recusado",
    !(await tentar(`update financial_periods set reopened_at = now() where company_id='${A}' and month=8`)));
  verificar("reabrir com motivo é aceite",
    await tentar(`update financial_periods set reopened_at = now(), reopen_reason = 'correcção de fatura' where company_id='${A}' and month=8`));
  verificar("motivo em branco é recusado",
    !(await tentar(`update financial_periods set reopened_at = now(), reopen_reason = '   ' where company_id='${A}' and month=8`)));

  // ── 6. Categorias ──────────────────────────────────────────────────────────
  console.log("\n── 6. expense_categories");
  verificar("uma categoria é aceite",
    await tentar(`insert into expense_categories (company_id, name, normalized_name) values ('${A}', 'Combustível', 'combustivel')`));
  verificar("🔴 o mesmo nome normalizado duas vezes é recusado",
    !(await tentar(`insert into expense_categories (company_id, name, normalized_name) values ('${A}', 'COMBUSTIVEL', 'combustivel')`)));
  verificar("o mesmo nome noutra empresa é aceite",
    await tentar(`insert into expense_categories (company_id, name, normalized_name) values ('${B}', 'Combustível', 'combustivel')`));

  const rls = await db.query(
    `select c.relname, c.relrowsecurity from pg_class c
      join pg_namespace n on n.oid = c.relnamespace
     where n.nspname='public' and c.relname in ('expense_categories','financial_periods')`,
  );
  verificar("RLS activa nas duas tabelas novas",
    rls.rows.length === 2 && rls.rows.every((r) => r.relrowsecurity),
    rls.rows.map((r) => `${r.relname}=${r.relrowsecurity}`).join(", "));

  const pols = await db.query(
    `select tablename, policyname from pg_policies
      where schemaname='public' and tablename in ('expense_categories','financial_periods')`,
  );
  verificar("as quatro políticas foram criadas", pols.rows.length === 4, `${pols.rows.length} políticas`);

  // ── 7. Rollback ────────────────────────────────────────────────────────────
  console.log("\n── 7. Rollback e equivalência");
  // Limpar as linhas criadas no ensaio: o rollback é do **esquema**, e as
  // tabelas novas desaparecem com os seus dados.
  await db.exec(ROLLBACK);

  verificar("expense_categories desapareceu", !(await existeTabela(db, "expense_categories")));
  verificar("financial_periods desapareceu", !(await existeTabela(db, "financial_periods")));

  const impressaoDepois = {
    cash_flow_entries: await colunas(db, "cash_flow_entries"),
    fixed_variable_payments: await colunas(db, "fixed_variable_payments"),
  };

  for (const t of ["cash_flow_entries", "fixed_variable_payments"]) {
    const igual = JSON.stringify(impressaoAntes[t]) === JSON.stringify(impressaoDepois[t]);
    verificar(`🔴 ${t}: esquema idêntico ao baseline`, igual,
      igual ? `${impressaoDepois[t].length} colunas` :
        `antes ${impressaoAntes[t].length} / depois ${impressaoDepois[t].length}`);
  }

  verificar("o índice da 024 sobreviveu ao rollback",
    await existeIndice(db, "cash_flow_entries_reference_unique"));
  verificar("os índices da 071 desapareceram",
    !(await existeIndice(db, "idx_expense_categories_company"))
    && !(await existeIndice(db, "idx_cash_flow_category"))
    && !(await existeIndice(db, "idx_financial_periods_lookup")));

  // ── 8. Reaplicar depois do rollback ────────────────────────────────────────
  console.log("\n── 8. Reaplicar depois do rollback");
  let reaplica = true;
  try { await db.exec(sql071); } catch (e) { reaplica = false; console.log("   ", e.message); }
  verificar("a 071 volta a aplicar sobre o baseline reposto", reaplica);

  await db.close();

  // ── Resumo ─────────────────────────────────────────────────────────────────
  const falhas = resultados.filter((r) => !r.ok);
  console.log(`\n═══ ${resultados.length - falhas.length}/${resultados.length} verificações passaram ═══`);
  if (falhas.length > 0) {
    console.log("\nFalhas:");
    for (const f of falhas) console.log(`  ✘ ${f.nome}${f.detalhe ? ` — ${f.detalhe}` : ""}`);
    process.exit(1);
  }
  console.log("\nPRODUCTION TOUCHED = NO · CREDENTIALS READ = NO · DOCKER = NO\n");
}

main().catch((e) => {
  console.error("\nEnsaio interrompido:", e.message);
  process.exit(1);
});

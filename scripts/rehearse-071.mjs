#!/usr/bin/env node
// ============================================================================
// GATE M1 — ensaio das migrations 071, 072 e 073 numa base descartável
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
//   · o comportamento real do RLS **em execução**. As expressões das políticas
//     são inspeccionadas (`pg_policies.qual`) e verifica-se que ligam
//     `company_id` ao `profiles` do utilizador e que a escrita exige
//     `admin`/`gestor` — mas nenhuma consulta é feita como um utilizador
//     autenticado. Aqui `auth.uid()` devolve sempre `NULL`.
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

CREATE TABLE public.services (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id uuid NOT NULL REFERENCES public.companies(id) ON DELETE CASCADE,
  status text NOT NULL DEFAULT 'agendado'
);


CREATE TABLE public.invoices (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id uuid NOT NULL REFERENCES public.companies(id) ON DELETE CASCADE,
  client_id uuid,
  invoice_number text NOT NULL,
  invoice_date date NOT NULL DEFAULT CURRENT_DATE,
  due_date date,
  period_start date,
  period_end date,
  subtotal numeric(12,2) NOT NULL DEFAULT 0,
  vat_rate numeric(5,2) NOT NULL DEFAULT 23,
  vat_amount numeric(12,2) NOT NULL DEFAULT 0,
  total numeric(12,2) NOT NULL DEFAULT 0,
  -- O CHECK real da 008. E esta lista que o dominio tem de usar - e foi por
  -- nao a usar que os KPIs estiveram estruturalmente a zero.
  status text DEFAULT 'rascunho'
    CHECK (status IN ('rascunho', 'pendente', 'pago', 'vencido', 'cancelado')),
  paid_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE public.invoice_items (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  invoice_id uuid NOT NULL REFERENCES public.invoices(id) ON DELETE CASCADE,
  description text NOT NULL,
  quantity numeric(10,2) NOT NULL DEFAULT 1,
  unit_price numeric(12,2) NOT NULL DEFAULT 0,
  total numeric(12,2) NOT NULL DEFAULT 0,
  sort_order int NOT NULL DEFAULT 0,
  service_id uuid
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
  console.log("\n═══ GATE M1 — ensaio das 071/072/073 em base descartável (PGlite, sem Docker) ═══\n");

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

  // 🔴 Contar políticas não é verificá-las.
  //
  // A primeira versão desta secção contava quatro linhas em `pg_policies` e o
  // cabeçalho do script dizia que as políticas eram verificadas «na sua
  // definição». Não eram: quatro políticas vazias, ou quatro que deixassem
  // passar toda a gente, davam o mesmo número.
  //
  // `pg_policies.qual` traz a expressão inteira. É isso que se verifica agora
  // — que cada política liga `company_id` ao `profiles` do utilizador
  // autenticado, e que a de escrita exige `admin` ou `gestor`.
  const pols = await db.query(
    `select tablename, policyname, cmd, qual, with_check from pg_policies
      where schemaname='public' and tablename in ('expense_categories','financial_periods')
      order by tablename, cmd`,
  );
  verificar("as quatro políticas foram criadas", pols.rows.length === 4, `${pols.rows.length} políticas`);

  for (const tabela of ["expense_categories", "financial_periods"]) {
    const daTabela = pols.rows.filter((p) => p.tablename === tabela);
    const leitura = daTabela.find((p) => p.cmd === "SELECT");
    const escrita = daTabela.find((p) => p.cmd === "ALL");

    verificar(`${tabela}: uma política de leitura e uma de escrita`,
      !!leitura && !!escrita, daTabela.map((p) => p.cmd).join(", "));

    const q = String(leitura?.qual ?? "");
    verificar(`${tabela}: a leitura é company-scoped pelo perfil autenticado`,
      q.includes("company_id") && q.includes("profiles") && q.includes("auth.uid()"),
      q.replace(/\s+/g, " ").slice(0, 90));

    const w = String(escrita?.qual ?? "");
    verificar(`${tabela}: a escrita é company-scoped`,
      w.includes("company_id") && w.includes("profiles") && w.includes("auth.uid()"));
    verificar(`🔴 ${tabela}: a escrita exige admin ou gestor`,
      w.includes("'admin'") && w.includes("'gestor'"),
      w.replace(/\s+/g, " ").slice(0, 110));

    // Uma política sem `qual` deixa passar tudo — o pior desfecho possível,
    // porque o RLS aparece como activo.
    verificar(`${tabela}: nenhuma política é permissiva por omissão`,
      q.trim().length > 0 && w.trim().length > 0);
  }

  // ── 6b. Migration 072 — faturas atómicas ───────────────────────────────────
  console.log("\n── 6b. Migration 072 — criação atómica e numeração");

  const sql072 = fs.readFileSync(
    path.join(MIGRACOES, "072_invoice_atomic_creation.sql"), "utf8",
  );
  try {
    await db.exec(sql072);
    verificar("a 072 aplica sem erro", true);
  } catch (e) {
    verificar("a 072 aplica sem erro", false, e.message);
    throw e;
  }

  verificar("índice único do número de fatura", await existeIndice(db, "uq_invoices_number_per_company"));
  verificar("índice parcial do rascunho por cliente/período",
    await existeIndice(db, "uq_invoices_draft_per_client_period"));

  const CLI = "44444444-4444-4444-4444-444444444444";
  const criar = (company, cliente, itens, inicio = "2026-08-01", fim = "2026-08-31") =>
    db.query(
      `select * from create_invoice_with_items(
         $1::uuid, $2::uuid, 'F', 2026, '2026-08-31'::date, '2026-09-30'::date,
         $3::date, $4::date, 100, 23, 23, 123, $5::jsonb)`,
      [company, cliente, inicio, fim, JSON.stringify(itens)],
    );

  const UMA_LINHA = [{ description: "Avença mensal", quantity: 1, unit_price: 100, total: 100 }];

  const r1 = await criar(A, CLI, UMA_LINHA);
  verificar("a primeira fatura é F2026/001", r1.rows[0].invoice_number === "F2026/001",
    r1.rows[0].invoice_number);

  const nItens = (await db.query(
    "select count(*)::int as n from invoice_items where invoice_id = $1", [r1.rows[0].invoice_id],
  )).rows[0].n;
  verificar("as linhas entraram com o cabeçalho", nItens === 1);

  // ── Atomicidade ────────────────────────────────────────────────────────────
  //
  // Uma linha com `total` inválido faz o INSERT das linhas rebentar. Numa
  // função plpgsql isso aborta a transacção inteira: o cabeçalho não fica.
  const antesFaturas = (await db.query("select count(*)::int as n from invoices")).rows[0].n;
  let abortou = false;
  try {
    await criar(A, CLI, [{ description: "Má", quantity: 1, unit_price: 1, total: "não-é-número" }]);
  } catch { abortou = true; }
  const depoisFaturas = (await db.query("select count(*)::int as n from invoices")).rows[0].n;
  verificar("🔴 linhas inválidas abortam a operação inteira", abortou);
  verificar("🔴 nenhum cabeçalho órfão ficou para trás", depoisFaturas === antesFaturas,
    `${antesFaturas} → ${depoisFaturas}`);

  let semLinhas = false;
  try { await criar(A, CLI, []); } catch { semLinhas = true; }
  verificar("uma fatura sem linhas é recusada", semLinhas);

  // ── Numeração em sequência ─────────────────────────────────────────────────
  //
  // 🔴 PGlite tem uma só ligação, por isso **não há paralelismo verdadeiro**
  //    aqui. O que se prova é o efeito — dez criações dão dez números
  //    distintos e consecutivos — e que a base recusa qualquer repetição.
  //
  //    A serialização a sério vem do `pg_advisory_xact_lock` dentro da função,
  //    e essa não é exercível numa ligação única. Fica dito, em vez de se
  //    fingir que a concorrência foi provada.
  const CLI2 = "55555555-5555-5555-5555-555555555555";
  const numeros = [];
  for (let i = 0; i < 10; i++) {
    // Períodos distintos: o índice parcial recusa dois rascunhos do mesmo
    // cliente para o mesmo período — e recusou mesmo, quando esta linha
    // reciclava os meses ao fim de nove. O índice fez o que devia; a fixture
    // é que estava errada.
    const mes = String(i + 1).padStart(2, "0");
    const r = await criar(A, CLI2, UMA_LINHA, `2026-${mes}-01`, `2026-${mes}-28`);
    numeros.push(r.rows[0].invoice_number);
  }
  verificar("dez criações dão dez números distintos", new Set(numeros).size === 10,
    numeros.join(" "));

  let numeroRepetido = false;
  try {
    await db.query(
      `insert into invoices (company_id, client_id, invoice_number, total)
       values ($1, $2, 'F2026/001', 1)`, [A, CLI],
    );
  } catch { numeroRepetido = true; }
  verificar("🔴 a base recusa um número repetido na mesma empresa", numeroRepetido);

  let numeroNoutraEmpresa = true;
  try {
    await db.query(
      `insert into invoices (company_id, client_id, invoice_number, total)
       values ($1, $2, 'F2026/001', 1)`, [B, CLI],
    );
  } catch { numeroNoutraEmpresa = false; }
  verificar("o mesmo número noutra empresa é permitido", numeroNoutraEmpresa);

  // ── Não reutilizar número apagado ─────────────────────────────────────────
  const maxAntes = (await db.query(
    `select max((regexp_match(invoice_number, '/(\\d+)$'))[1]::int) as m
       from invoices where company_id = $1`, [A],
  )).rows[0].m;
  await db.query(`delete from invoices where company_id = $1 and invoice_number = 'F2026/005'`, [A]);
  const rDepois = await criar(A, CLI2, UMA_LINHA, "2026-10-01", "2026-10-31");
  const esperado = `F2026/${String(Number(maxAntes) + 1).padStart(3, "0")}`;
  verificar("🔴 apagar uma fatura não faz reutilizar o número",
    rDepois.rows[0].invoice_number === esperado,
    `apagou F2026/005 → seguinte ${rDepois.rows[0].invoice_number}`);

  // ── Duplicado de geração ───────────────────────────────────────────────────
  let rascunhoDuplicado = false;
  try { await criar(A, CLI, UMA_LINHA, "2026-08-01", "2026-08-31"); } catch { rascunhoDuplicado = true; }
  verificar("🔴 dois rascunhos para o mesmo cliente e período são recusados", rascunhoDuplicado);

  // Emitir o primeiro liberta o período para uma fatura legítima seguinte —
  // uma correcção, ou trabalho extra do mesmo mês.
  await db.query(
    `update invoices set status = 'pendente'
      where company_id = $1 and client_id = $2 and period_start = '2026-08-01'`, [A, CLI],
  );
  let suplementarOk = true;
  try { await criar(A, CLI, UMA_LINHA, "2026-08-01", "2026-08-31"); } catch { suplementarOk = false; }
  verificar("uma fatura suplementar depois de emitida a primeira é permitida", suplementarOk);
  // ── service_id nas linhas ──────────────────────────────────────────────────
  //
  // 🔴 É por esta coluna que `getUnbilledServices` sabe o que já foi faturado.
  //    Sem ela, as faturas nasciam certas e os serviços que elas cobravam
  //    continuavam a aparecer como «por faturar» — até alguém os faturar
  //    outra vez, ao cliente.
  const SVC1 = "66666666-6666-6666-6666-666666666666";
  const SVC2 = "77777777-7777-7777-7777-777777777777";
  await db.query(
    `insert into services (id, company_id, status) values ($1,$3,'concluido'), ($2,$3,'concluido')`,
    [SVC1, SVC2, A],
  );

  const CLI3 = "88888888-8888-8888-8888-888888888888";
  const rSvc = await criar(A, CLI3, [
    { description: "Limpeza 12/08", quantity: 1, unit_price: 60, total: 60, service_id: SVC1, sort_order: 0 },
    { description: "Limpeza 19/08", quantity: 1, unit_price: 40, total: 40, service_id: SVC2, sort_order: 1 },
    // Linha de avença: cobre um contrato, não uma visita. Fica a null.
    { description: "Avença mensal", quantity: 1, unit_price: 100, total: 100, sort_order: 2 },
  ], "2026-11-01", "2026-11-30");

  const itens = (await db.query(
    `select description, service_id from invoice_items where invoice_id = $1 order by sort_order`,
    [rSvc.rows[0].invoice_id],
  )).rows;

  verificar("🔴 a linha de um serviço guarda o seu service_id",
    itens[0].service_id === SVC1 && itens[1].service_id === SVC2,
    `${itens[0].service_id?.slice(0, 8)}… / ${itens[1].service_id?.slice(0, 8)}…`);

  verificar("🔴 a linha de avença fica com service_id nulo",
    itens[2].service_id === null,
    "cobre um contrato, não uma visita");

  // O cruzamento que `getUnbilledServices` faz, tal e qual.
  const jaFaturados = (await db.query(
    `select service_id from invoice_items where service_id = any($1::uuid[])`,
    [[SVC1, SVC2]],
  )).rows.map((r) => r.service_id);

  verificar("🔴 os dois serviços deixam de estar «por faturar»",
    jaFaturados.length === 2 && jaFaturados.includes(SVC1) && jaFaturados.includes(SVC2),
    `${jaFaturados.length} de 2 reconhecidos`);

  // Um serviço que não entrou em nenhuma fatura continua por faturar.
  const SVC3 = "99999999-9999-9999-9999-999999999999";
  await db.query(`insert into services (id, company_id, status) values ($1,$2,'concluido')`, [SVC3, A]);
  const aindaPorFaturar = (await db.query(
    `select 1 from invoice_items where service_id = $1`, [SVC3],
  )).rows.length === 0;
  verificar("um serviço não faturado continua por faturar", aindaPorFaturar);

  // ── Rollback da 072 ────────────────────────────────────────────────────────
  await db.exec(`
    BEGIN;
    DROP FUNCTION IF EXISTS public.create_invoice_with_items(
      uuid, uuid, text, int, date, date, date, date, numeric, numeric, numeric, numeric, jsonb);
    DROP INDEX IF EXISTS public.uq_invoices_draft_per_client_period;
    DROP INDEX IF EXISTS public.uq_invoices_number_per_company;
    COMMIT;
  `);
  verificar("rollback da 072: a função desapareceu",
    (await db.query("select 1 from pg_proc where proname='create_invoice_with_items'")).rows.length === 0);
  verificar("rollback da 072: os índices desapareceram",
    !(await existeIndice(db, "uq_invoices_number_per_company"))
    && !(await existeIndice(db, "uq_invoices_draft_per_client_period")));
  // ── 6c. Migration 073 — pagamento → caixa ──────────────────────────────────
  console.log("\n── 6c. Migration 073 — pagamento → caixa");

  const sql073 = fs.readFileSync(
    path.join(MIGRACOES, "073_payment_to_cashflow.sql"), "utf8",
  );
  try {
    await db.exec(sql073);
    verificar("a 073 aplica sem erro", true);
  } catch (e) {
    verificar("a 073 aplica sem erro", false, e.message);
    throw e;
  }

  const novoPagamento = async (company, valor, ano = 2026, mes = 8) => {
    const r = await db.query(
      `insert into fixed_variable_payments
         (company_id, kind, description, amount, period_year, period_month)
       values ($1, 'fixo', 'Internet', $2, $3, $4) returning id`,
      [company, valor, ano, mes],
    );
    return r.rows[0].id;
  };

  const movimentosDe = async (pagamento) =>
    (await db.query(
      `select id, amount, type, status from cash_flow_entries
        where reference_type = 'fixed_variable_payment' and reference_id = $1`,
      [pagamento],
    )).rows;

  // ── Pagar uma vez ──────────────────────────────────────────────────────────
  const PAG1 = await novoPagamento(A, 49.9);
  const r1p = await db.query(
    `select * from mark_payment_paid($1::uuid, $2::uuid, '2026-08-12'::date)`, [A, PAG1],
  );
  verificar("pagar cria exactamente um movimento", (await movimentosDe(PAG1)).length === 1);
  verificar("o movimento é uma saída confirmada com o valor do pagamento",
    (await movimentosDe(PAG1))[0].type === "saida"
    && Number((await movimentosDe(PAG1))[0].amount) === 49.9
    && (await movimentosDe(PAG1))[0].status === "confirmado");
  verificar("o pagamento ficou pago",
    (await db.query("select status, paid_at from fixed_variable_payments where id=$1", [PAG1]))
      .rows[0].status === "pago");
  verificar("a primeira chamada diz que não estava pago", r1p.rows[0].ja_estava_pago === false);

  // ── 🔴 Idempotência ────────────────────────────────────────────────────────
  const r2p = await db.query(
    `select * from mark_payment_paid($1::uuid, $2::uuid, '2026-08-13'::date)`, [A, PAG1],
  );
  verificar("🔴 pagar duas vezes não duplica o movimento", (await movimentosDe(PAG1)).length === 1);
  verificar("a segunda chamada devolve o mesmo movimento",
    r2p.rows[0].cash_entry_id === r1p.rows[0].cash_entry_id);
  verificar("e diz que já estava pago", r2p.rows[0].ja_estava_pago === true);

  let cincoVezes = true;
  for (let i = 0; i < 5; i++) {
    try {
      await db.query(`select * from mark_payment_paid($1::uuid, $2::uuid, '2026-08-14'::date)`, [A, PAG1]);
    } catch { cincoVezes = false; }
  }
  verificar("🔴 cinco repetições: nem erro nem duplicado",
    cincoVezes && (await movimentosDe(PAG1)).length === 1);

  // ── Isolamento entre empresas ──────────────────────────────────────────────
  const PAG_B = await novoPagamento(B, 49.9);
  await db.query(`select * from mark_payment_paid($1::uuid, $2::uuid, '2026-08-12'::date)`, [B, PAG_B]);
  verificar("empresas diferentes não colidem",
    (await movimentosDe(PAG_B)).length === 1 && (await movimentosDe(PAG1)).length === 1);

  let doutraEmpresa = false;
  try {
    await db.query(`select * from mark_payment_paid($1::uuid, $2::uuid, '2026-08-12'::date)`, [B, PAG1]);
  } catch { doutraEmpresa = true; }
  verificar("🔴 pagar um pagamento de outra empresa é recusado", doutraEmpresa);

  // ── Valor inválido ─────────────────────────────────────────────────────────
  const PAG_SEM = await novoPagamento(A, null);
  let semValor = false;
  try {
    await db.query(`select * from mark_payment_paid($1::uuid, $2::uuid, '2026-08-12'::date)`, [A, PAG_SEM]);
  } catch { semValor = true; }
  verificar("um pagamento sem valor não gera movimento", semValor);
  verificar("e não ficou marcado como pago",
    (await db.query("select status from fixed_variable_payments where id=$1", [PAG_SEM]))
      .rows[0].status === "pendente");

  // ── 🔴 Reversão não toca em movimentos manuais ─────────────────────────────
  //
  // Uma reversão por valor e data levaria à frente a despesa manual que alguém
  // lançou no mesmo dia pelo mesmo montante — e essa não voltava.
  await db.query(
    `insert into cash_flow_entries (company_id, type, amount, description, date)
     values ($1, 'saida', 49.90, 'Despesa manual do mesmo dia e valor', '2026-08-12')`, [A],
  );
  const manuaisAntes = (await db.query(
    `select count(*)::int as n from cash_flow_entries
      where company_id=$1 and reference_type is null and amount = 49.90`, [A],
  )).rows[0].n;

  const rev = await db.query(`select * from unmark_payment_paid($1::uuid, $2::uuid)`, [A, PAG1]);
  verificar("desmarcar remove o movimento de origem", rev.rows[0].movimentos_removidos === 1);
  verificar("o pagamento voltou a pendente, sem data",
    (await db.query("select status, paid_at from fixed_variable_payments where id=$1", [PAG1]))
      .rows[0].status === "pendente");

  const manuaisDepois = (await db.query(
    `select count(*)::int as n from cash_flow_entries
      where company_id=$1 and reference_type is null and amount = 49.90`, [A],
  )).rows[0].n;
  verificar("🔴 a despesa manual do mesmo dia e valor sobreviveu",
    manuaisDepois === manuaisAntes, `${manuaisAntes} → ${manuaisDepois}`);

  verificar("desmarcar duas vezes não rebenta",
    (await db.query(`select * from unmark_payment_paid($1::uuid, $2::uuid)`, [A, PAG1]))
      .rows[0].movimentos_removidos === 0);

  // Repagar depois de reverter volta a criar um movimento — e só um.
  await db.query(`select * from mark_payment_paid($1::uuid, $2::uuid, '2026-08-20'::date)`, [A, PAG1]);
  verificar("repagar depois de reverter cria um movimento novo",
    (await movimentosDe(PAG1)).length === 1);

  // ── 🔴 Período fechado ─────────────────────────────────────────────────────
  const PAG_SET = await novoPagamento(A, 30, 2026, 9);
  await db.query(
    `insert into financial_periods (company_id, year, month, status, closed_at)
     values ($1, 2026, 9, 'closed', now())`, [A],
  );
  verificar("um período sem linha está aberto",
    (await db.query("select is_financial_period_open($1::uuid, 2026, 7) as o", [A])).rows[0].o === true);
  verificar("um período fechado está fechado",
    (await db.query("select is_financial_period_open($1::uuid, 2026, 9) as o", [A])).rows[0].o === false);

  let mesFechado = false;
  try {
    await db.query(`select * from mark_payment_paid($1::uuid, $2::uuid, '2026-09-05'::date)`, [A, PAG_SET]);
  } catch (e) { mesFechado = String(e.message).includes("FINANCIAL_PERIOD_CLOSED"); }
  verificar("🔴 pagar num mês fechado é recusado", mesFechado);
  verificar("e não deixou o pagamento pago nem criou movimento",
    (await db.query("select status from fixed_variable_payments where id=$1", [PAG_SET]))
      .rows[0].status === "pendente"
    && (await movimentosDe(PAG_SET)).length === 0);

  verificar("Agosto continua aberto e aceita pagamentos",
    (await db.query("select is_financial_period_open($1::uuid, 2026, 8) as o", [A])).rows[0].o === true);

  // ── Rollback da 073 ────────────────────────────────────────────────────────
  await db.exec(`
    BEGIN;
    DROP FUNCTION IF EXISTS public.unmark_payment_paid(uuid, uuid);
    DROP FUNCTION IF EXISTS public.mark_payment_paid(uuid, uuid, date);
    DROP FUNCTION IF EXISTS public.is_financial_period_open(uuid, int, int);
    COMMIT;
  `);
  verificar("rollback da 073: as três funções desapareceram",
    (await db.query(
      `select 1 from pg_proc where proname in
       ('mark_payment_paid','unmark_payment_paid','is_financial_period_open')`)).rows.length === 0);
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

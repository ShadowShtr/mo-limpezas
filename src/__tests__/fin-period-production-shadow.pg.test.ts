// ============================================================================
// PRODUCTION-PARITY SHADOW — 090..097 sobre a forma real do schema
// ============================================================================
//
// As suites da 090 e da 091 provam o protocolo sobre um palco mínimo: as
// tabelas que as funções tocam, e mais nada. Isso responde «o protocolo
// funciona?». Não responde «aplicar isto à base que existe corre bem?».
//
// São perguntas diferentes, e a segunda é a que decide se se aplica em
// produção. O palco mínimo não tem RLS, não tem as políticas, não tem as
// chaves estrangeiras a `companies`/`profiles`, e não tem os papéis do
// Supabase com os grants que a base real tem. Uma migration pode passar num e
// falhar no outro — e o sítio onde falharia seria produção.
//
// Aqui parte-se de `fixtures/production-schema-shape.sql`, que é um dump
// READ-ONLY da forma real (tabelas, colunas, FKs, RLS, políticas — zero
// linhas), e aplica-se por cima a cadeia que produção tem hoje mais a que esta
// ronda propõe.
//
// ---------------------------------------------------------------------------
// 🔴 O dump NÃO é paridade completa, e dizê-lo importa
// ---------------------------------------------------------------------------
//
// Traz tabelas, colunas, PK/FK, RLS e políticas. NÃO traz constraints CHECK,
// NÃO traz índices, NÃO traz funções, e não traz tabelas criadas depois da
// leitura que o gerou. Chamar-lhe «paridade» sem esta ressalva seria uma
// afirmação falsa — e a stack 090..097 depende de várias dessas coisas.
//
// O que falta vive num sítio SÓ, versionado:
//
//     PRODUCTION_SHADOW_BASE_SCOPE
//       = tabelas + colunas + PK/FK + RLS + políticas
//         (`fixtures/production-schema-shape.sql`, leitura read-only)
//
//     PRODUCTION_SHADOW_OVERLAY
//       = `fixtures/production-financial-prestate.sql`
//         (constraints, índices e tabelas pós-dump, cada um com a migration
//          de origem nomeada)
//
// Isto começou como `ALTER TABLE` espalhados por dentro desta suite. É assim
// que duas suites acabam a ensaiar mundos diferentes sem ninguém dar por isso.
//
// 🔴 Nada aqui toca em produção. É um contentor descartável.
// ============================================================================

import { readFileSync } from "node:fs";
import { join } from "node:path";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { startPostgresContainer, type PostgresContainer } from "./helpers/pg-container";
import { baselineCompleto } from "./helpers/production-baseline";

const ROOT = process.cwd();
const CONTAINER = `finshadow-${process.pid}`;

let container: PostgresContainer;
let pool: pg.Pool;

const ler = (p: string) => readFileSync(join(ROOT, p), "utf8");

/**
 * As migrations DESTA RONDA, aplicadas sobre o estado de produção.
 *
 * 🔴 Porque é que a 086 não está aqui, e o que isso significa.
 *
 *    Produção tem o ledger em 89: a 086 **já está aplicada**. Replayá-la aqui
 *    seria ensaiar uma aplicação que não vai acontecer — e obrigaria a
 *    replayar antes toda a cadeia de funções de que ela depende (a 062, a
 *    049, …), porque o dump da forma traz tabelas e políticas mas não traz
 *    funções.
 *
 *    O que se ensaia é o que a direcção vai autorizar aplicar: 078, 090, 091
 *    e 094,
 *    sobre uma base que já tem o que produção tem. O pré-estado da 086 —
 *    `manual_charges` e as três RPCs — é montado abaixo a partir do mesmo
 *    fixture extraído que a suite da 091 usa, para as duas partirem do mesmo
 *    sítio.
 */
const CADEIA = [
  "supabase/migrations/078_domain_mutation_change_event_foundation.sql",
  "supabase/migrations/090_financial_period_lock_protocol.sql",
  "supabase/migrations/091_manual_charges_period_atomic.sql",
  "supabase/migrations/092_payments_period_atomic.sql",
  "supabase/migrations/093_cashflow_period_atomic.sql",
  "supabase/migrations/094_invoices_period_atomic.sql",
  "supabase/migrations/095_bank_reconciliation_period_atomic.sql",
  "supabase/migrations/096_payroll_period_atomic.sql",
  "supabase/migrations/097_service_payment_period_atomic.sql",
] as const;

/**
 * O que produção tem HOJE e que a cadeia vai substituir.
 *
 * 🔴 Sem isto, cada `CREATE OR REPLACE` criaria uma função nova em vez de
 *    substituir, e as precondições — que são metade do valor destas migrations
 *    — nunca seriam exercitadas contra o schema real.
 *
 *    São extraídos das próprias migrations que os definem, por geradores, e não
 *    escritos à mão: uma cópia manual diverge no dia em que alguém corrigir a
 *    origem e não o fixture.
 */
const PRE_ESTADO = [
  "src/__tests__/fixtures/073-is-financial-period-open.sql",
  "src/__tests__/fixtures/086-manual-charges-table.sql",
  "src/__tests__/fixtures/086-manual-charges-rpcs.sql",
  "src/__tests__/fixtures/pre-092-payment-rpcs.sql",
  "src/__tests__/fixtures/pre-093-cashflow-rpcs.sql",
  "src/__tests__/fixtures/pre-094-invoice-rpc.sql",
  "src/__tests__/fixtures/pre-095-bank-rpc.sql",
  "src/__tests__/fixtures/pre-097-service-payment-rpc.sql",
] as const;

beforeAll(async () => {
  container = await startPostgresContainer({
    name: CONTAINER,
    database: "finshadow",
    serverFlags: ["shared_buffers=32MB", "max_connections=25", "work_mem=1MB", "maintenance_work_mem=16MB"],
  });
  pool = new pg.Pool({ ...container.connection, max: 4 });

  // A forma real: andaime do Supabase (papéis, `auth`), o dump do schema, os
  // helpers legados e os grants.
  await pool.query(baselineCompleto());
  // 🔴 A pgcrypto no schema `extensions`, como no Supabase real — e NÃO em
  //    `public`. Foi a omissão do `WITH SCHEMA` que deixou a 094 passar aqui
  //    dependendo de `public.digest`, que produção não tem. A prova explícita
  //    desta paridade está no primeiro teste, antes de a cadeia ser aplicada.
  await pool.query("CREATE SCHEMA IF NOT EXISTS extensions");
  await pool.query("CREATE EXTENSION IF NOT EXISTS pgcrypto WITH SCHEMA extensions");
  await pool.query("INSERT INTO public._migrations (name) VALUES ('077_secure_migrations_ledger.sql')");

  // O overlay canónico: tudo o que o dump não traz e a stack 090..097 exige.
  // Uma fonte só, versionada, com cada bloco a nomear a migration de origem.
  await pool.query(ler("src/__tests__/fixtures/production-financial-prestate.sql"));

  // O pré-estado das funções que a cadeia substitui, extraído das migrations
  // que as definem.
  for (const fixture of PRE_ESTADO) {
    await pool.query(ler(fixture));
  }

  for (const migration of CADEIA) {
    await pool.query(ler(migration));
  }
}, 300_000);

afterAll(async () => {
  await pool?.end();
  container?.stop();
});

describe("shadow — a cadeia aplica sobre a forma real de produção", () => {
  // ───────────────────────────────────────────────────────────────────────────
  // 🔴 A paridade da pgcrypto, afirmada ANTES de tudo o resto.
  //
  // Se este ensaio voltar a instalar `digest` em `public`, a 094 passa aqui e
  // parte em produção — foi assim que o defeito sobreviveu a um shadow verde.
  // Afirmar as duas metades (ausente de `public`, presente em `extensions`)
  // torna essa regressão impossível de passar despercebida.
  // ───────────────────────────────────────────────────────────────────────────
  it("🔴 pgcrypto está em `extensions` e NÃO em `public`, como em produção", async () => {
    const { rows } = await pool.query(`
      SELECT to_regprocedure('public.digest(bytea,text)')::text     AS publico,
             to_regprocedure('extensions.digest(bytea,text)')::text AS extensao
    `);
    expect(rows[0].publico).toBeNull();
    expect(rows[0].extensao).not.toBeNull();
  });

  it("090 → 097 aplicam, por ordem, sobre o schema real", async () => {
    // Se o `beforeAll` chegou aqui, aplicaram. Este teste existe para que a
    // falha apareça com nome próprio em vez de como «beforeAll rebentou».
    const { rows } = await pool.query("SELECT current_database() db");
    expect(rows[0].db).toBe("finshadow");
  }, 300_000);

  it("as doze funções da 090 existem com a assinatura do contrato", async () => {
    const esperado: ReadonlyArray<readonly [string, string]> = [
      ["financial_period_lock_key", "p_year integer, p_month integer"],
      ["financial_period_lock_keys", "p_dates date[]"],
      ["lock_financial_periods_many", "p_company_id uuid, p_keys integer[]"],
      ["assert_financial_periods_open_locked_many", "p_company_id uuid, p_keys integer[]"],
      ["assert_financial_period_dates_open_locked", "p_company_id uuid, p_dates date[]"],
      ["lock_financial_period", "p_company_id uuid, p_year integer, p_month integer"],
      [
        "lock_financial_periods_pair",
        "p_company_id uuid, p_year_a integer, p_month_a integer, p_year_b integer, p_month_b integer",
      ],
      ["assert_financial_period_open_locked", "p_company_id uuid, p_year integer, p_month integer"],
      [
        "assert_financial_periods_open_locked_pair",
        "p_company_id uuid, p_year_a integer, p_month_a integer, p_year_b integer, p_month_b integer",
      ],
      ["financial_period_blockers", "p_company_id uuid, p_year integer, p_month integer"],
      ["close_financial_period_atomic", "p_company_id uuid, p_year integer, p_month integer, p_actor uuid"],
      [
        "reopen_financial_period_atomic",
        "p_company_id uuid, p_year integer, p_month integer, p_actor uuid, p_reason text",
      ],
    ];

    for (const [nome, assinatura] of esperado) {
      const { rows } = await pool.query(
        `SELECT pg_get_function_identity_arguments(p.oid) args
           FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
          WHERE n.nspname='public' AND p.proname=$1`,
        [nome],
      );
      expect(rows.map((r) => r.args), nome).toContain(assinatura);
    }
  }, 120_000);

  it("as quatro RPCs de cobranças ficam com a assinatura preservada da 086", async () => {
    // 🔴 EXPAND FIRST: a 091 substitui três funções e acrescenta uma. Se
    //    alguma assinatura tivesse mudado, o código publicado hoje deixaria de
    //    as encontrar — e isso só se veria depois de aplicar em produção.
    const esperado: ReadonlyArray<readonly [string, string]> = [
      [
        "create_manual_charge_atomic",
        "p_company_id uuid, p_client_id uuid, p_charge_date date, p_description text, p_amount numeric, p_apply_vat boolean, p_notes text, p_actor uuid",
      ],
      ["update_manual_charge_atomic", "p_company_id uuid, p_charge_id uuid, p_patch jsonb, p_actor uuid"],
      [
        "set_manual_charge_payment_atomic",
        "p_company_id uuid, p_charge_id uuid, p_status text, p_paid_amount numeric, p_actor uuid",
      ],
      ["void_manual_charge_atomic", "p_company_id uuid, p_charge_id uuid, p_actor uuid"],
    ];

    for (const [nome, assinatura] of esperado) {
      const { rows } = await pool.query(
        `SELECT pg_get_function_identity_arguments(p.oid) args
           FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
          WHERE n.nspname='public' AND p.proname=$1`,
        [nome],
      );
      expect(rows.map((r) => r.args), nome).toContain(assinatura);
    }
  }, 120_000);

  it("apenas a RPC canónica de invoice é SECURITY DEFINER", async () => {
    const { rows } = await pool.query(
      `SELECT p.proname FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
        WHERE n.nspname='public' AND p.prosecdef
          AND (p.proname LIKE '%financial_period%'
            OR p.proname LIKE '%manual_charge%'
            OR p.proname LIKE '%payment%'
            OR p.proname LIKE '%cashflow%'
            OR p.proname LIKE '%invoice%'
            OR p.proname LIKE '%bank_%'
            OR p.proname LIKE '%payroll%')`,
    );
    expect(rows.map((r) => r.proname)).toEqual(["set_invoice_status_atomic"]);
  }, 120_000);

  it("a superfície fica fechada a anon e authenticated, e aberta a service_role", async () => {
    const alvos = [
      "public.financial_period_lock_key(integer, integer)",
      "public.lock_financial_period(uuid, integer, integer)",
      "public.lock_financial_periods_pair(uuid, integer, integer, integer, integer)",
      "public.assert_financial_period_open_locked(uuid, integer, integer)",
      "public.assert_financial_periods_open_locked_pair(uuid, integer, integer, integer, integer)",
      "public.financial_period_blockers(uuid, integer, integer)",
      "public.close_financial_period_atomic(uuid, integer, integer, uuid)",
      "public.reopen_financial_period_atomic(uuid, integer, integer, uuid, text)",
      "public.create_manual_charge_atomic(uuid, uuid, date, text, numeric, boolean, text, uuid)",
      "public.update_manual_charge_atomic(uuid, uuid, jsonb, uuid)",
      "public.set_manual_charge_payment_atomic(uuid, uuid, text, numeric, uuid)",
      "public.void_manual_charge_atomic(uuid, uuid, uuid)",
      "public.financial_period_lock_keys(date[])",
      "public.lock_financial_periods_many(uuid, integer[])",
      "public.assert_financial_periods_open_locked_many(uuid, integer[])",
      "public.assert_financial_period_dates_open_locked(uuid, date[])",
      "public.create_payment_atomic(uuid, text, text, numeric, date, integer, integer, uuid, boolean, text, uuid)",
      "public.update_payment_atomic(uuid, uuid, jsonb)",
      "public.mark_payment_paid(uuid, uuid, date)",
      "public.unmark_payment_paid(uuid, uuid)",
      "public.delete_payment_atomic(uuid, uuid)",
      "public.set_payment_status_atomic(uuid, uuid, text, uuid)",
      "public.create_cashflow_entry_atomic(uuid, text, numeric, text, text, date, text, text, uuid, uuid)",
      "public.update_cashflow_entry_atomic(uuid, uuid, jsonb)",
      "public.delete_cashflow_entry_atomic(uuid, uuid)",
      "public.set_invoice_status_atomic(uuid, uuid, uuid, text, text, uuid, integer)",
      "public.delete_invoice_atomic(uuid, uuid, uuid)",
      "public.confirm_bank_match_atomic(uuid, uuid, uuid)",
      "public.reject_bank_match_atomic(uuid, uuid, uuid)",
      "public.manual_bank_match_atomic(uuid, uuid, uuid, uuid)",
      "public.set_bank_transaction_ignored_atomic(uuid, uuid, boolean, uuid)",
      "public.create_cashflow_from_bank_transaction_atomic(uuid, uuid, text, uuid)",
      "public.delete_bank_import_atomic(uuid, uuid, uuid)",
      "public.upsert_payroll_records_atomic(uuid, integer, integer, jsonb, uuid)",
      "public.adjust_payroll_record_atomic(uuid, uuid, jsonb, uuid)",
      "public.approve_payroll_records_atomic(uuid, uuid[], uuid)",
      "public.mark_payroll_paid_atomic(uuid, uuid[], date, uuid)",
      "public.set_service_payment_atomic(uuid, uuid, text, numeric, uuid)",
    ];

    for (const alvo of alvos) {
      for (const papel of ["anon", "authenticated", "public"]) {
        const { rows } = await pool.query("SELECT has_function_privilege($1,$2,'EXECUTE') pode", [papel, alvo]);
        expect(rows[0].pode, `${papel} NÃO executa ${alvo}`).toBe(false);
      }
      const { rows } = await pool.query("SELECT has_function_privilege('service_role',$1,'EXECUTE') pode", [alvo]);
      expect(rows[0].pode, `service_role executa ${alvo}`).toBe(true);
    }
  }, 180_000);

  it("o RLS e as políticas do schema real ficam intactos", async () => {
    // A cadeia não pode desligar RLS nem apagar políticas por arrasto.
    // `manual_charges` fica de fora desta lista de proposito: no shadow ela
    // vem do fixture da 086 (so o CREATE TABLE), e nao do dump da forma. O que
    // se mede aqui e se a cadeia desligou RLS nas tabelas que o dump governa.
    for (const tabela of ["financial_periods", "cash_flow_entries", "audit_logs", "invoices"]) {
      const { rows } = await pool.query(
        "SELECT relrowsecurity FROM pg_class WHERE oid = ('public.' || $1)::regclass",
        [tabela],
      );
      expect(rows[0].relrowsecurity, `${tabela} com RLS`).toBe(true);
    }

    const { rows } = await pool.query(
      "SELECT count(*)::int n FROM pg_policies WHERE schemaname='public' AND tablename='financial_periods'",
    );
    expect(rows[0].n).toBeGreaterThan(0);
  }, 120_000);

  it("o protocolo funciona sobre o schema real, e não só sobre o palco mínimo", async () => {
    // Uma empresa e um perfil reais — as FKs do schema real exigem-nos, e é
    // precisamente isso que o palco mínimo não testa.
    const empresa = "11111111-1111-4111-8111-111111111111";
    const actor = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";

    // `slug` e NOT NULL no schema real — o palco minimo nao tem essa coluna, e
    // e exactamente esse tipo de diferenca que este ensaio existe para apanhar.
    await pool.query(
      "INSERT INTO public.companies (id, name, slug) VALUES ($1,'Shadow','shadow') ON CONFLICT DO NOTHING",
      [empresa],
    );
    // `profiles.id` referencia `auth.users` no schema real. Mais uma
    // diferenca que so aparece aqui.
    await pool.query("INSERT INTO auth.users (id, email) VALUES ($1,'gestora@shadow.test') ON CONFLICT DO NOTHING", [actor]);
    await pool.query(
      "INSERT INTO public.profiles (id, company_id, full_name, role) VALUES ($1,$2,'Gestora','gestor') ON CONFLICT DO NOTHING",
      [actor, empresa],
    );

    const fecho = await pool.query("SELECT * FROM public.close_financial_period_atomic($1, 2031, 5, $2)", [
      empresa,
      actor,
    ]);
    expect(fecho.rows[0].fechado).toBe(true);

    // A auditoria entrou na mesma transação, contra a tabela real com as suas
    // FKs a `companies` e `profiles`.
    const { rows: audit } = await pool.query(
      "SELECT * FROM public.audit_logs WHERE action='financial_period_closed' AND entity_id='2031-05'",
    );
    expect(audit).toHaveLength(1);
    expect(audit[0].actor_id).toBe(actor);

    // E o mês fechado recusa uma escrita.
    await expect(
      pool.query("SELECT public.assert_financial_period_open_locked($1, 2031, 5)", [empresa]),
    ).rejects.toThrow(/FINANCIAL_PERIOD_CLOSED/);
  }, 180_000);
});

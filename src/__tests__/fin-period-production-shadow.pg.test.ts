// ============================================================================
// PRODUCTION-PARITY SHADOW — 078, 090, 091 e 094 sobre a forma real do schema
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
  "supabase/migrations/094_invoices_period_atomic.sql",
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
  await pool.query("CREATE EXTENSION IF NOT EXISTS pgcrypto");
  await pool.query("INSERT INTO public._migrations (name) VALUES ('077_secure_migrations_ledger.sql')");

  // 🔴 O dump da forma NÃO traz constraints CHECK nem índices — só tabelas,
  //    colunas, FKs, RLS e políticas (ver o cabeçalho de
  //    `helpers/production-baseline.ts`). Duas coisas que produção tem, que a
  //    086 exige como pré-estado, e que por isso entram aqui à mão:
  //
  //      · o CHECK de `reference_type` como a 075 o deixou;
  //      · o índice único PARCIAL da 024, que os `ON CONFLICT` inferem.
  //
  //    Sem elas, a precondição da 086 recusa — e recusa com razão. O que
  //    faltava era o palco, não a migration.
  await pool.query(`
    ALTER TABLE public.cash_flow_entries
      DROP CONSTRAINT IF EXISTS cash_flow_entries_reference_type_check;
    ALTER TABLE public.cash_flow_entries
      ADD CONSTRAINT cash_flow_entries_reference_type_check
      CHECK (
        reference_type IS NULL
        OR reference_type IN ('invoice', 'payroll', 'service_payment', 'fixed_variable_payment')
      );

    CREATE UNIQUE INDEX IF NOT EXISTS cash_flow_entries_reference_unique
      ON public.cash_flow_entries (company_id, reference_type, reference_id)
      WHERE reference_type IS NOT NULL AND reference_id IS NOT NULL;

    -- O UNIQUE que a 071 pos em financial_periods. E o arbitro do
    -- ON CONFLICT de close_financial_period_atomic: sem ele, «there is no
    -- unique or exclusion constraint matching the ON CONFLICT specification».
    ALTER TABLE public.financial_periods
      DROP CONSTRAINT IF EXISTS financial_periods_unique;
    ALTER TABLE public.financial_periods
      ADD CONSTRAINT financial_periods_unique UNIQUE (company_id, year, month);
  `);
  await pool.query(ler("src/__tests__/fixtures/production-financial-prestate.sql"));

  // A precondição da 090 exige `is_financial_period_open` com a assinatura
  // exacta — produção tem-na desde a 073, e o dump da forma não traz funções.
  await pool.query(ler("src/__tests__/fixtures/073-is-financial-period-open.sql"));

  // O que a 086 deixou em produção e que a 091 vai substituir: a tabela
  // `manual_charges` (com as suas FKs reais) e as três RPCs, extraídas da
  // própria 086 pelo mesmo gerador que a suite da 091 usa.
  await pool.query(ler("src/__tests__/fixtures/086-manual-charges-table.sql"));
  await pool.query(ler("src/__tests__/fixtures/086-manual-charges-rpcs.sql"));
  await pool.query(ler("src/__tests__/fixtures/pre-094-invoice-rpc.sql"));

  for (const migration of CADEIA) {
    await pool.query(ler(migration));
  }
}, 300_000);

afterAll(async () => {
  await pool?.end();
  container?.stop();
});

describe("shadow — a cadeia aplica sobre a forma real de produção", () => {
  it("078 → 090 → 091 → 094 aplicam sem erro sobre o schema real", async () => {
    // Se o `beforeAll` chegou aqui, aplicaram. Este teste existe para que a
    // falha apareça com nome próprio em vez de como «beforeAll rebentou».
    const { rows } = await pool.query("SELECT current_database() db");
    expect(rows[0].db).toBe("finshadow");
  }, 300_000);

  it("as oito funções da 090 existem com a assinatura do contrato", async () => {
    const esperado: ReadonlyArray<readonly [string, string]> = [
      ["financial_period_lock_key", "p_year integer, p_month integer"],
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

  it("nenhuma função nova é SECURITY DEFINER", async () => {
    const { rows } = await pool.query(
      `SELECT p.proname FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
        WHERE n.nspname='public' AND p.prosecdef
          AND (p.proname LIKE '%financial_period%' OR p.proname LIKE '%manual_charge%')`,
    );
    expect(rows.map((r) => r.proname)).toEqual([]);
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

import { readFileSync } from "node:fs";
import { join } from "node:path";
import pg from "pg";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { baselineCompleto } from "./helpers/production-baseline";
import { startPostgresContainer, type PostgresContainer } from "./helpers/pg-container";

const ROOT = process.cwd();
const migration = readFileSync(join(ROOT, "supabase/migrations/096_payroll_period_atomic.sql"), "utf8");
const migration024 = readFileSync(join(ROOT, "supabase/migrations/024_cash_flow_reference_integrity.sql"), "utf8");
const migration090 = readFileSync(join(ROOT, "supabase/migrations/090_financial_period_lock_protocol.sql"), "utf8");

const COMPANY = "00000000-0000-0000-0000-000000000001";
const OTHER_COMPANY = "00000000-0000-0000-0000-000000000002";
const ACTOR = "00000000-0000-0000-0000-000000000011";
const OTHER_ACTOR = "00000000-0000-0000-0000-000000000021";
const COLLABORATOR = "00000000-0000-0000-0000-000000000012";
const COLLABORATOR_TWO = "00000000-0000-0000-0000-000000000013";
const OTHER_COLLABORATOR = "00000000-0000-0000-0000-000000000022";
const LATE_CASH_GATE = 918273645;

const baseline = `
DROP SCHEMA IF EXISTS public CASCADE;
DROP SCHEMA IF EXISTS auth CASCADE;
CREATE SCHEMA public;
${baselineCompleto()}
${migration024}
ALTER TABLE public.financial_periods
  ADD CONSTRAINT financial_periods_unique UNIQUE (company_id, year, month);
CREATE OR REPLACE FUNCTION public.is_financial_period_open(
  p_company_id uuid, p_year integer, p_month integer
) RETURNS boolean LANGUAGE sql STABLE AS $fn$
  SELECT NOT EXISTS (
    SELECT 1 FROM public.financial_periods
     WHERE company_id = p_company_id AND year = p_year AND month = p_month
       AND status = 'closed'
  )
$fn$;
${migration090}
${migration}
`;

describe("PAYROLL-SAFETY-01 contra o schema de produção e 090 real", () => {
  let container: PostgresContainer;
  const clients: pg.Client[] = [];

  async function connect() {
    const client = new pg.Client({ ...container.connection });
    await client.connect();
    clients.push(client);
    return client;
  }

  async function call(client: pg.Client, name: string, args: string, ...params: unknown[]) {
    return client.query(`SELECT * FROM public.${name}(${args})`, params);
  }

  async function payroll(client: pg.Client, collaboratorId = COLLABORATOR, year = 2026, month = 8, salary: number | string | null = 1200, status = "aprovado") {
    return (await client.query(
      `INSERT INTO public.payroll_records(company_id, collaborator_id, period_year, period_month, net_salary, status)
       VALUES ($1,$2,$3,$4,$5,$6) RETURNING id`,
      [COMPANY, collaboratorId, year, month, salary, status],
    )).rows[0].id as string;
  }

  async function count(client: pg.Client, table: string, where = "true", params: unknown[] = []) {
    return Number((await client.query(`SELECT count(*)::int AS n FROM public.${table} WHERE ${where}`, params)).rows[0].n);
  }

  beforeAll(async () => {
    container = await startPostgresContainer({ name: `payroll-safety-${process.pid}`, database: "payroll_safety" });
    const client = await connect();
    await client.query(baseline);
    const shape = await client.query(`
      SELECT format_type(a.atttypid, a.atttypmod) AS type
        FROM pg_attribute a
       WHERE a.attrelid = 'public.cash_flow_entries'::regclass AND a.attname = 'reference_id'
         AND a.attnum > 0 AND NOT a.attisdropped
    `);
    expect(shape.rows[0]?.type).toBe("uuid");
    expect((await client.query(`SELECT indexdef FROM pg_indexes WHERE indexname='cash_flow_entries_reference_unique'`)).rows).toHaveLength(1);
  }, 180_000);

  beforeEach(async () => {
    const client = clients[0];
    await client.query("TRUNCATE TABLE public.companies, auth.users CASCADE");
    await client.query("INSERT INTO public.companies(id,name,slug) VALUES ($1,'A','a'),($2,'B','b')", [COMPANY, OTHER_COMPANY]);
    await client.query("INSERT INTO auth.users(id,email) VALUES ($1,'actor-a@example.test'),($2,'actor-b@example.test'),($3,'collab-a@example.test'),($4,'collab-a2@example.test'),($5,'collab-b@example.test')", [ACTOR, OTHER_ACTOR, COLLABORATOR, COLLABORATOR_TWO, OTHER_COLLABORATOR]);
    await client.query(
      "INSERT INTO public.profiles(id,company_id,full_name,role) VALUES ($1,$2,'Maria Silva','admin'),($3,$4,'Gestor B','gestor'),($5,$2,'Colaboradora A','colaborador'),($6,$2,'Colaboradora A2','colaborador'),($7,$4,'Colaborador B','colaborador')",
      [ACTOR, COMPANY, OTHER_ACTOR, OTHER_COMPANY, COLLABORATOR, COLLABORATOR_TWO, OTHER_COLLABORATOR],
    );
    await client.query("INSERT INTO public.company_settings(company_id) VALUES ($1),($2)", [COMPANY, OTHER_COMPANY]);
    await client.query(
      "INSERT INTO public.financial_periods(company_id,year,month,status) VALUES ($1,2026,7,'open'),($1,2026,8,'open'),($1,2026,9,'open'),($1,2026,10,'open'),($2,2026,8,'open'),($2,2026,9,'open')",
      [COMPANY, OTHER_COMPANY],
    );
  });

  afterAll(async () => {
    for (const client of clients) await client.end().catch(() => undefined);
    container?.stop();
  });

  it("usa UUID nativo e o índice parcial real", async () => {
    const client = clients[0];
    const id = await payroll(client);
    const result = await call(client, "mark_payroll_paid_atomic", "$1::uuid, ARRAY[$2::uuid], $3::date, $4::uuid", COMPANY, id, "2026-09-04", ACTOR);
    expect(result.rows[0]).toMatchObject({ paid_count: 1, cash_entry_count: 1 });
    const cash = (await client.query("SELECT reference_id, created_by, description FROM public.cash_flow_entries WHERE reference_id=$1", [id])).rows[0];
    expect(cash.reference_id).toBe(id);
    expect(cash.created_by).toBe(ACTOR);
    expect(cash.description).toBe("Salario Colaboradora A - 08/2026");
  });

  it("rascunho não pode pagar", async () => {
    const client = clients[0];
    const id = await payroll(client, COLLABORATOR, 2026, 8, 1200, "rascunho");
    await expect(call(client, "mark_payroll_paid_atomic", "$1::uuid, ARRAY[$2::uuid], $3::date, $4::uuid", COMPANY, id, "2026-09-04", ACTOR)).rejects.toThrow(/PAYROLL_NOT_APPROVED/);
    expect(await count(client, "cash_flow_entries")).toBe(0);
  });

  it("pago com cashflow compatível é retry idempotente e read-only", async () => {
    const client = clients[0];
    const id = await payroll(client);
    await call(client, "mark_payroll_paid_atomic", "$1::uuid, ARRAY[$2::uuid], $3::date, $4::uuid", COMPANY, id, "2026-09-04", ACTOR);
    const before = (await client.query("SELECT paid_at FROM public.payroll_records WHERE id=$1", [id])).rows[0].paid_at;
    await client.query("UPDATE public.financial_periods SET status='closed' WHERE company_id=$1 AND year=2026 AND month=10", [COMPANY]);
    const retry = await call(client, "mark_payroll_paid_atomic", "$1::uuid, ARRAY[$2::uuid], $3::date, $4::uuid", COMPANY, id, "2026-10-04", ACTOR);
    expect(retry.rows[0]).toEqual({ paid_count: 0, already_paid_count: 1, cash_entry_count: 0 });
    expect((await client.query("SELECT paid_at FROM public.payroll_records WHERE id=$1", [id])).rows[0].paid_at).toEqual(before);
    expect(await count(client, "cash_flow_entries")).toBe(1);
    expect(await count(client, "audit_logs", "action='payroll_paid'")).toBe(1);
  });

  it("pago sem cashflow falha fechado", async () => {
    const client = clients[0];
    const id = await payroll(client, COLLABORATOR, 2026, 8, 1200, "pago");
    await expect(call(client, "mark_payroll_paid_atomic", "$1::uuid, ARRAY[$2::uuid], $3::date, $4::uuid", COMPANY, id, "2026-09-04", ACTOR)).rejects.toThrow(/PAYROLL_PAID_CASHFLOW_MISSING/);
    expect(await count(client, "cash_flow_entries")).toBe(0);
  });

  it("cashflow com valor ou contrato incompatível falha sem alterar a folha", async () => {
    const client = clients[0];
    const id = await payroll(client, COLLABORATOR, 2026, 8, 1200, "aprovado");
    await client.query("INSERT INTO public.cash_flow_entries(company_id,type,amount,description,category,date,reference_id,reference_type,status) VALUES ($1,'saida',1201,'conflito','salario','2026-09-04',$2,'payroll','confirmado')", [COMPANY, id]);
    await expect(call(client, "mark_payroll_paid_atomic", "$1::uuid, ARRAY[$2::uuid], $3::date, $4::uuid", COMPANY, id, "2026-09-04", ACTOR)).rejects.toThrow(/PAYROLL_CASHFLOW_CONFLICT/);
    expect((await client.query("SELECT status FROM public.payroll_records WHERE id=$1", [id])).rows[0].status).toBe("aprovado");
  });

  it("cashflow pré-existente compatível é adotado explicitamente", async () => {
    const client = clients[0];
    const id = await payroll(client, COLLABORATOR, 2026, 8, 1200, "aprovado");
    await client.query("INSERT INTO public.cash_flow_entries(company_id,type,amount,description,category,date,reference_id,reference_type,status) VALUES ($1,'saida',1200,'legado','salario','2026-09-04',$2,'payroll','confirmado')", [COMPANY, id]);
    const result = await call(client, "mark_payroll_paid_atomic", "$1::uuid, ARRAY[$2::uuid], $3::date, $4::uuid", COMPANY, id, "2026-10-04", ACTOR);
    expect(result.rows[0]).toMatchObject({ paid_count: 1, cash_entry_count: 0 });
    expect((await client.query("SELECT meta->>'source' AS source FROM public.audit_logs WHERE action='payroll_paid'")).rows[0].source).toBe("adopted_existing");
  });

  it("período da folha e período do cashflow são ambos protegidos", async () => {
    const client = clients[0];
    const id = await payroll(client);
    await client.query("UPDATE public.financial_periods SET status='closed' WHERE company_id=$1 AND year=2026 AND month=9", [COMPANY]);
    await expect(call(client, "mark_payroll_paid_atomic", "$1::uuid, ARRAY[$2::uuid], $3::date, $4::uuid", COMPANY, id, "2026-09-04", ACTOR)).rejects.toThrow(/FINANCIAL_PERIOD_CLOSED/);
    expect(await count(client, "cash_flow_entries")).toBe(0);
    await client.query("UPDATE public.financial_periods SET status='open' WHERE company_id=$1 AND year=2026 AND month=9", [COMPANY]);
    await client.query("UPDATE public.financial_periods SET status='closed' WHERE company_id=$1 AND year=2026 AND month=8", [COMPANY]);
    await expect(call(client, "mark_payroll_paid_atomic", "$1::uuid, ARRAY[$2::uuid], $3::date, $4::uuid", COMPANY, id, "2026-09-04", ACTOR)).rejects.toThrow(/FINANCIAL_PERIOD_CLOSED/);
  });

  async function runLateCashflowRace() {
    const setup = clients[0];
    const actor = await connect();
    const blocker = await connect();
    const id = await payroll(setup, COLLABORATOR, 2026, 8, 1200, "aprovado");
    await actor.query("SET application_name='payroll-late-cash-actor'");
    await setup.query(`
      CREATE OR REPLACE FUNCTION public.payroll_late_cash_gate() RETURNS trigger LANGUAGE plpgsql AS $fn$
      BEGIN
        IF NEW.reference_id = '${id}'::uuid THEN
          PERFORM pg_advisory_xact_lock(${LATE_CASH_GATE});
        END IF;
        RETURN NEW;
      END
      $fn$;
      DROP TRIGGER IF EXISTS payroll_late_cash_gate ON public.cash_flow_entries;
      CREATE TRIGGER payroll_late_cash_gate
        BEFORE INSERT ON public.cash_flow_entries
        FOR EACH ROW EXECUTE FUNCTION public.payroll_late_cash_gate();
    `);

    let outcome: { result?: pg.QueryResult; error?: Error };
    try {
      await blocker.query("BEGIN");
      await blocker.query("SELECT pg_advisory_xact_lock($1)", [LATE_CASH_GATE]);
      const marking = actor
        .query("SELECT * FROM public.mark_payroll_paid_atomic($1::uuid, ARRAY[$2::uuid], $3::date, $4::uuid)", [COMPANY, id, "2026-09-04", ACTOR])
        .then((result) => ({ result, error: undefined }))
        .catch((error: Error) => ({ result: undefined, error }));

      const deadline = Date.now() + 10_000;
      for (;;) {
        const waiting = await setup.query(
          `SELECT 1 FROM pg_stat_activity
            WHERE application_name='payroll-late-cash-actor'
              AND wait_event_type='Lock' AND wait_event='advisory'`,
        );
        if (waiting.rowCount === 1) break;
        if (Date.now() > deadline) throw new Error("A RPC não chegou à barreira do cashflow tardio.");
        await new Promise((resolve) => setTimeout(resolve, 20));
      }

      await blocker.query(
        `INSERT INTO public.cash_flow_entries(
           company_id,type,amount,description,category,date,reference_id,reference_type,status
         ) VALUES ($1,'saida',1200,'cashflow concorrente tardio','salario','2026-10-04',$2,'payroll','confirmado')`,
        [COMPANY, id],
      );
      await blocker.query("COMMIT");
      outcome = await marking;
      return { setup, id, outcome };
    } finally {
      await setup.query("DROP TRIGGER IF EXISTS payroll_late_cash_gate ON public.cash_flow_entries");
      await setup.query("DROP FUNCTION IF EXISTS public.payroll_late_cash_gate()");
      await blocker.query("ROLLBACK").catch(() => undefined);
      await actor.end().catch(() => undefined);
      await blocker.end().catch(() => undefined);
    }
  }

  it("cashflow concorrente tardio fora do lock set falha e retry aberto adota", async () => {
    const { setup, id, outcome } = await runLateCashflowRace();
    expect(outcome.error?.message).toMatch(/PAYROLL_CASHFLOW_PERIOD_CHANGED/);
    expect((await setup.query("SELECT status FROM public.payroll_records WHERE id=$1", [id])).rows[0].status).toBe("aprovado");
    expect(await count(setup, "audit_logs", "action='payroll_paid'")).toBe(0);
    expect((await setup.query("SELECT date::text FROM public.cash_flow_entries WHERE reference_id=$1", [id])).rows[0].date).toBe("2026-10-04");

    const retry = await call(setup, "mark_payroll_paid_atomic", "$1::uuid, ARRAY[$2::uuid], $3::date, $4::uuid", COMPANY, id, "2026-09-04", ACTOR);
    expect(retry.rows[0]).toMatchObject({ paid_count: 1, already_paid_count: 0, cash_entry_count: 0 });
    expect((await setup.query("SELECT status FROM public.payroll_records WHERE id=$1", [id])).rows[0].status).toBe("pago");
  });

  it("retry do cashflow tardio rejeita se o período descoberto estiver fechado", async () => {
    const { setup, id, outcome } = await runLateCashflowRace();
    expect(outcome.error?.message).toMatch(/PAYROLL_CASHFLOW_PERIOD_CHANGED/);
    await setup.query("UPDATE public.financial_periods SET status='closed' WHERE company_id=$1 AND year=2026 AND month=10", [COMPANY]);
    await expect(call(setup, "mark_payroll_paid_atomic", "$1::uuid, ARRAY[$2::uuid], $3::date, $4::uuid", COMPANY, id, "2026-09-04", ACTOR)).rejects.toThrow(/FINANCIAL_PERIOD_CLOSED/);
    expect((await setup.query("SELECT status FROM public.payroll_records WHERE id=$1", [id])).rows[0].status).toBe("aprovado");
    expect(await count(setup, "audit_logs", "action='payroll_paid'")).toBe(0);
  });

  it("dois pagamentos concorrentes geram um único efeito económico", async () => {
    const first = clients[0];
    const second = await connect();
    const id = await payroll(first, COLLABORATOR, 2026, 8, 800, "aprovado");
    const results = await Promise.all([
      call(first, "mark_payroll_paid_atomic", "$1::uuid, ARRAY[$2::uuid], $3::date, $4::uuid", COMPANY, id, "2026-09-04", ACTOR),
      call(second, "mark_payroll_paid_atomic", "$1::uuid, ARRAY[$2::uuid], $3::date, $4::uuid", COMPANY, id, "2026-09-04", ACTOR),
    ]);
    expect(results.map((r) => r.rows[0].paid_count).sort()).toEqual([0, 1]);
    expect(await count(first, "cash_flow_entries")).toBe(1);
  });

  it("writer começa primeiro e close espera o commit", async () => {
    const writer = clients[0];
    const closer = await connect();
    const id = await payroll(writer);
    await writer.query("BEGIN");
    await call(writer, "mark_payroll_paid_atomic", "$1::uuid, ARRAY[$2::uuid], $3::date, $4::uuid", COMPANY, id, "2026-09-04", ACTOR);
    await closer.query("BEGIN");
    const close = closer.query("SELECT public.assert_financial_periods_open_locked_many($1, ARRAY[202608,202609])", [COMPANY]);
    await new Promise((resolve) => setTimeout(resolve, 100));
    expect((await writer.query("SELECT status FROM public.payroll_records WHERE id=$1", [id])).rows[0].status).toBe("pago");
    await writer.query("COMMIT");
    await close;
    await closer.query("UPDATE public.financial_periods SET status='closed' WHERE company_id=$1 AND year=2026 AND month=8", [COMPANY]);
    await closer.query("COMMIT");
  });

  it("close começa primeiro e writer rejeita depois do lock", async () => {
    const writer = clients[0];
    const closer = await connect();
    const id = await payroll(writer);
    await closer.query("BEGIN");
    await closer.query("SELECT public.assert_financial_periods_open_locked_many($1, ARRAY[202608,202609])", [COMPANY]);
    await closer.query("UPDATE public.financial_periods SET status='closed' WHERE company_id=$1 AND year=2026 AND month=8", [COMPANY]);
    const blocked = call(writer, "mark_payroll_paid_atomic", "$1::uuid, ARRAY[$2::uuid], $3::date, $4::uuid", COMPANY, id, "2026-09-04", ACTOR);
    await new Promise((resolve) => setTimeout(resolve, 100));
    await closer.query("COMMIT");
    await expect(blocked).rejects.toThrow(/FINANCIAL_PERIOD_CLOSED/);
    expect((await writer.query("SELECT status FROM public.payroll_records WHERE id=$1", [id])).rows[0].status).toBe("aprovado");
  });

  it("lote com vários payroll periods usa o conjunto canónico e não dá deadlock", async () => {
    const first = clients[0];
    const second = await connect();
    const july = await payroll(first, COLLABORATOR, 2026, 7, 700, "aprovado");
    const august = await payroll(first, COLLABORATOR_TWO, 2026, 8, 800, "aprovado");
    const results = await Promise.all([
      call(first, "mark_payroll_paid_atomic", "$1::uuid, $2::uuid[], $3::date, $4::uuid", COMPANY, [july, august], "2026-09-04", ACTOR),
      call(second, "mark_payroll_paid_atomic", "$1::uuid, $2::uuid[], $3::date, $4::uuid", COMPANY, [august, july], "2026-09-04", ACTOR),
    ]);
    expect(results.map((r) => Number(r.rows[0].paid_count)).sort()).toEqual([0, 2]);
    expect(await count(first, "cash_flow_entries")).toBe(2);
  });

  it("falha de auditoria reverte payroll e cashflow", async () => {
    const client = clients[0];
    const id = await payroll(client);
    await client.query("ALTER TABLE public.audit_logs RENAME TO audit_logs_broken");
    try {
      await expect(call(client, "mark_payroll_paid_atomic", "$1::uuid, ARRAY[$2::uuid], $3::date, $4::uuid", COMPANY, id, "2026-09-04", ACTOR)).rejects.toThrow();
    } finally {
      await client.query("ALTER TABLE public.audit_logs_broken RENAME TO audit_logs");
    }
    expect((await client.query("SELECT status FROM public.payroll_records WHERE id=$1", [id])).rows[0].status).toBe("aprovado");
    expect(await count(client, "cash_flow_entries")).toBe(0);
  });

  it("id inexistente e cross-company não escrevem", async () => {
    const client = clients[0];
    await expect(call(client, "mark_payroll_paid_atomic", "$1::uuid, ARRAY[$2::uuid], $3::date, $4::uuid", COMPANY, "00000000-0000-0000-0000-000000000099", "2026-09-04", ACTOR)).rejects.toThrow(/PAYROLL_RECORD_NOT_FOUND/);
    const id = await payroll(client);
    await expect(call(client, "mark_payroll_paid_atomic", "$1::uuid, ARRAY[$2::uuid], $3::date, $4::uuid", OTHER_COMPANY, id, "2026-09-04", OTHER_ACTOR)).rejects.toThrow(/PAYROLL_RECORD_NOT_FOUND/);
    expect(await count(client, "cash_flow_entries")).toBe(0);
  });

  it("estado desconhecido e total inválido falham fechado", async () => {
    const client = clients[0];
    const unknown = await payroll(client, COLLABORATOR, 2026, 8, 100, "estado-desconhecido");
    await expect(call(client, "mark_payroll_paid_atomic", "$1::uuid, ARRAY[$2::uuid], $3::date, $4::uuid", COMPANY, unknown, "2026-09-04", ACTOR)).rejects.toThrow(/PAYROLL_UNKNOWN_STATUS/);
    const zero = await payroll(client, OTHER_COLLABORATOR, 2026, 8, 0, "aprovado");
    await expect(call(client, "mark_payroll_paid_atomic", "$1::uuid, ARRAY[$2::uuid], $3::date, $4::uuid", COMPANY, zero, "2026-09-04", ACTOR)).rejects.toThrow(/PAYROLL_INVALID_TOTAL/);
    const negative = await payroll(client, COLLABORATOR, 2026, 7, -1, "aprovado");
    await expect(call(client, "mark_payroll_paid_atomic", "$1::uuid, ARRAY[$2::uuid], $3::date, $4::uuid", COMPANY, negative, "2026-09-04", ACTOR)).rejects.toThrow(/PAYROLL_INVALID_TOTAL/);
  });

  it("total null e NaN falham fechado", async () => {
    const client = clients[0];
    const nullTotal = await payroll(client, COLLABORATOR, 2026, 7, null, "aprovado");
    await expect(call(client, "mark_payroll_paid_atomic", "$1::uuid, ARRAY[$2::uuid], $3::date, $4::uuid", COMPANY, nullTotal, "2026-09-04", ACTOR)).rejects.toThrow(/PAYROLL_INVALID_TOTAL/);
    const nanTotal = await payroll(client, COLLABORATOR_TWO, 2026, 8, "NaN", "aprovado");
    await expect(call(client, "mark_payroll_paid_atomic", "$1::uuid, ARRAY[$2::uuid], $3::date, $4::uuid", COMPANY, nanTotal, "2026-09-04", ACTOR)).rejects.toThrow(/PAYROLL_INVALID_TOTAL/);
    expect(await count(client, "cash_flow_entries")).toBe(0);
  });

  it("ajuste devolve DTO completo e audita before/after", async () => {
    const client = clients[0];
    const id = await payroll(client, COLLABORATOR, 2026, 8, 1000, "rascunho");
    const result = await call(client, "adjust_payroll_record_atomic", "$1::uuid,$2::uuid,$3::jsonb,$4::uuid", COMPANY, id, JSON.stringify({ net_salary: 1100, notes: "ajuste" }), ACTOR);
    expect(result.rows[0].record_id).toBe(id);
    expect(Number(result.rows[0].net_salary)).toBe(1100);
    const audit = (await client.query("SELECT meta FROM public.audit_logs WHERE action='payroll_adjusted'")).rows[0].meta;
    expect(audit).toMatchObject({ payroll_id: id, before_status: "rascunho", after_status: "rascunho", amount: 1100 });
    expect(audit.before.net_salary).toBe(1000);
    expect(audit.after.net_salary).toBe(1100);
  });

  it("ajuste concorrente com mudança de estado falha sem falso sucesso", async () => {
    const writer = clients[0];
    const other = await connect();
    const id = await payroll(writer, COLLABORATOR, 2026, 8, 1000, "rascunho");
    await writer.query("BEGIN");
    await writer.query("SELECT * FROM public.payroll_records WHERE id=$1 FOR UPDATE", [id]);
    const blocked = call(other, "adjust_payroll_record_atomic", "$1::uuid,$2::uuid,$3::jsonb,$4::uuid", COMPANY, id, JSON.stringify({ net_salary: 1100 }), ACTOR);
    await new Promise((resolve) => setTimeout(resolve, 100));
    await writer.query("UPDATE public.payroll_records SET status='aprovado' WHERE id=$1", [id]);
    await writer.query("COMMIT");
    await expect(blocked).rejects.toThrow(/PAYROLL_MUTATION_NOT_ALLOWED|PAYROLL_CONCURRENT_STATE_CHANGE/);
  });

  it("aprovação concorrente é coerente e não perde a transição", async () => {
    const first = clients[0];
    const second = await connect();
    const id = await payroll(first, COLLABORATOR, 2026, 8, 1000, "rascunho");
    const results = await Promise.all([
      call(first, "approve_payroll_records_atomic", "$1::uuid,$2::uuid[],$3::uuid", COMPANY, [id], ACTOR),
      call(second, "approve_payroll_records_atomic", "$1::uuid,$2::uuid[],$3::uuid", COMPANY, [id], ACTOR),
    ]);
    expect(results.map((r) => [r.rows[0].approved_count, r.rows[0].already_approved_count]).sort()).toEqual([[0, 1], [1, 0]]);
    expect((await first.query("SELECT status FROM public.payroll_records WHERE id=$1", [id])).rows[0].status).toBe("aprovado");
  });

  it("resposta vazia não é fabricada pelo contrato SQL", async () => {
    const client = clients[0];
    const result = await call(client, "mark_payroll_paid_atomic", "$1::uuid,$2::uuid[],$3::date,$4::uuid", COMPANY, [], "2026-09-04", ACTOR);
    expect(result.rows[0]).toEqual({ paid_count: 0, already_paid_count: 0, cash_entry_count: 0 });
  });
});

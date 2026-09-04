import fs from "node:fs";
import pg from "pg";
import { beforeAll, afterAll, beforeEach, describe, expect, it } from "vitest";
import { startPostgresContainer, type PostgresContainer } from "./helpers/pg-container";

const migration = fs.readFileSync("supabase/migrations/draft/PAYROLL-SAFETY-01.sql", "utf8");
const baseline = `
CREATE EXTENSION IF NOT EXISTS pgcrypto;
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'anon') THEN CREATE ROLE anon NOLOGIN; END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'authenticated') THEN CREATE ROLE authenticated NOLOGIN; END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'service_role') THEN CREATE ROLE service_role NOLOGIN; END IF;
END $$;
CREATE TABLE companies (id uuid PRIMARY KEY, name text NOT NULL);
CREATE TABLE profiles (id uuid PRIMARY KEY, company_id uuid NOT NULL REFERENCES companies(id), full_name text NOT NULL, role text NOT NULL DEFAULT 'admin');
CREATE TABLE financial_periods (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), company_id uuid NOT NULL REFERENCES companies(id),
  year integer NOT NULL, month integer NOT NULL, status text NOT NULL DEFAULT 'open'
);
CREATE TABLE payroll_records (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), company_id uuid NOT NULL REFERENCES companies(id),
  collaborator_id uuid NOT NULL REFERENCES profiles(id), period_year integer NOT NULL, period_month integer NOT NULL,
  contracted_hours numeric, worked_hours numeric DEFAULT 0, overtime_hours numeric DEFAULT 0,
  absence_hours numeric DEFAULT 0, days_worked integer DEFAULT 0, hourly_rate numeric,
  gross_salary numeric DEFAULT 0, meal_allowance numeric DEFAULT 0, overtime_bonus numeric DEFAULT 0,
  absence_deductions numeric DEFAULT 0, other_additions numeric DEFAULT 0, other_deductions numeric DEFAULT 0,
  net_salary numeric DEFAULT 0, status text NOT NULL DEFAULT 'rascunho', notes text,
  approved_by uuid, paid_at timestamptz, updated_at timestamptz DEFAULT now(),
  UNIQUE(company_id, collaborator_id, period_year, period_month)
);
CREATE TABLE cash_flow_entries (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), company_id uuid NOT NULL REFERENCES companies(id),
  type text NOT NULL, amount numeric NOT NULL, description text NOT NULL, category text,
  date date NOT NULL, reference_id text, reference_type text, status text NOT NULL, notes text, created_by uuid
);
CREATE UNIQUE INDEX cash_flow_entries_reference_unique ON cash_flow_entries(company_id, reference_type, reference_id)
  WHERE reference_type IS NOT NULL AND reference_id IS NOT NULL;
CREATE TABLE audit_logs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), company_id uuid NOT NULL REFERENCES companies(id),
  actor_id uuid NOT NULL REFERENCES profiles(id), action text NOT NULL, entity_type text NOT NULL,
  entity_id text, meta jsonb NOT NULL DEFAULT '{}', created_at timestamptz NOT NULL DEFAULT now()
);
CREATE OR REPLACE FUNCTION is_financial_period_open(p_company_id uuid, p_year integer, p_month integer)
RETURNS boolean LANGUAGE sql STABLE AS $$
  SELECT NOT EXISTS (SELECT 1 FROM financial_periods WHERE company_id = p_company_id AND year = p_year AND month = p_month AND status = 'closed');
$$;
CREATE OR REPLACE FUNCTION financial_period_lock_key(p_year integer, p_month integer)
RETURNS integer LANGUAGE sql IMMUTABLE AS $$ SELECT p_year * 100 + p_month $$;
CREATE OR REPLACE FUNCTION lock_financial_period(p_company_id uuid, p_year integer, p_month integer)
RETURNS void LANGUAGE plpgsql AS $$ BEGIN PERFORM pg_advisory_xact_lock(hashtextextended(p_company_id::text || ':' || (p_year * 100 + p_month)::text, 0)); END $$;
CREATE OR REPLACE FUNCTION lock_financial_periods_many(p_company_id uuid, p_keys integer[])
RETURNS integer[] LANGUAGE plpgsql AS $$ DECLARE k integer; BEGIN FOR k IN SELECT DISTINCT unnest(p_keys) ORDER BY 1 LOOP PERFORM lock_financial_period(p_company_id,k/100,k%100); END LOOP; RETURN p_keys; END $$;
CREATE OR REPLACE FUNCTION assert_financial_periods_open_locked_many(p_company_id uuid, p_keys integer[])
RETURNS integer[] LANGUAGE plpgsql AS $$ DECLARE k integer; BEGIN PERFORM lock_financial_periods_many(p_company_id,p_keys); FOR k IN SELECT DISTINCT unnest(p_keys) ORDER BY 1 LOOP IF NOT is_financial_period_open(p_company_id,k/100,k%100) THEN RAISE EXCEPTION 'FINANCIAL_PERIOD_CLOSED'; END IF; END LOOP; RETURN p_keys; END $$;
CREATE OR REPLACE FUNCTION assert_financial_period_open_locked(p_company_id uuid, p_year integer, p_month integer)
RETURNS void LANGUAGE plpgsql AS $$ BEGIN PERFORM assert_financial_periods_open_locked_many(p_company_id, ARRAY[p_year * 100 + p_month]); END $$;
`;

describe("PAYROLL-SAFETY-01 em PostgreSQL real", () => {
  let container: PostgresContainer;
  const clients: pg.Client[] = [];
  const company = "00000000-0000-0000-0000-000000000001";
  const otherCompany = "00000000-0000-0000-0000-000000000002";
  const actor = "00000000-0000-0000-0000-000000000011";
  const collaborator = "00000000-0000-0000-0000-000000000012";
  const otherCollaborator = "00000000-0000-0000-0000-000000000022";

  async function connect() {
    const client = new pg.Client({ ...container.connection });
    await client.connect();
    clients.push(client);
    return client;
  }

  async function call(client: pg.Client, name: string, args: string, ...params: unknown[]) {
    return client.query(`SELECT * FROM public.${name}(${args})`, params);
  }

  beforeAll(async () => {
    container = await startPostgresContainer({ name: `payroll-safety-${process.pid}`, database: "payroll_safety" });
    const client = await connect();
    await client.query(baseline);
    await client.query(migration);
  }, 180_000);

  beforeEach(async () => {
    const client = clients[0];
    await client.query("TRUNCATE audit_logs, cash_flow_entries, payroll_records, financial_periods, profiles, companies CASCADE");
    await client.query("INSERT INTO companies(id,name) VALUES ($1,'A'),($2,'B')", [company, otherCompany]);
    await client.query("INSERT INTO profiles(id,company_id,full_name) VALUES ($1,$2,'Gestora'),($3,$2,'Colaborador A'),($4,$5,'Colaborador B')", [actor, company, collaborator, otherCollaborator, otherCompany]);
    await client.query("INSERT INTO financial_periods(company_id,year,month) VALUES ($1,2026,9)", [company]);
  });

  afterAll(async () => {
    for (const client of clients) await client.end().catch(() => undefined);
    container?.stop();
  });

  it("aprova, paga atomicamente e aceita retry sem duplicar caixa", async () => {
    const client = clients[0];
    const inserted = await client.query(
      "INSERT INTO payroll_records(company_id,collaborator_id,period_year,period_month,net_salary,status) VALUES ($1,$2,2026,9,1200,'rascunho') RETURNING id",
      [company, collaborator],
    );
    const id = inserted.rows[0].id;
    const approved = await call(client, "approve_payroll_records_atomic", `$1::uuid, ARRAY[$2::uuid], $3::uuid`, company, id, actor);
    expect(approved.rows[0]).toMatchObject({ approved_count: 1, already_approved_count: 0 });
    const paid = await call(client, "mark_payroll_paid_atomic", `$1::uuid, ARRAY[$2::uuid], '2026-09-04'::date, $3::uuid`, company, id, actor);
    expect(paid.rows[0]).toMatchObject({ paid_count: 1, already_paid_count: 0, cash_entry_count: 1 });
    const retry = await call(client, "mark_payroll_paid_atomic", `$1::uuid, ARRAY[$2::uuid], '2026-09-04'::date, $3::uuid`, company, id, actor);
    expect(retry.rows[0]).toMatchObject({ paid_count: 0, already_paid_count: 1, cash_entry_count: 0 });
    expect((await client.query("SELECT status FROM payroll_records WHERE id=$1", [id])).rows[0].status).toBe("pago");
    expect((await client.query("SELECT count(*)::int AS n FROM cash_flow_entries WHERE reference_id=$1", [id])).rows[0].n).toBe(1);
  });

  it("recusa rascunho, total inválido, empresa alheia e ids inexistentes sem writes", async () => {
    const client = clients[0];
    const row = await client.query("INSERT INTO payroll_records(company_id,collaborator_id,period_year,period_month,net_salary,status) VALUES ($1,$2,2026,9,0,'rascunho') RETURNING id", [company, collaborator]);
    const id = row.rows[0].id;
    await expect(call(client, "mark_payroll_paid_atomic", `$1::uuid, ARRAY[$2::uuid], '2026-09-04'::date, $3::uuid`, company, id, actor)).rejects.toThrow(/PAYROLL_NOT_APPROVED|PAYROLL_INVALID_TOTAL/);
    await expect(call(client, "mark_payroll_paid_atomic", `$1::uuid, ARRAY[$2::uuid], '2026-09-04'::date, $3::uuid`, otherCompany, id, actor)).rejects.toThrow(/PAYROLL_ACTOR_NOT_AUTHORIZED|PAYROLL_RECORD_NOT_FOUND/);
    expect((await client.query("SELECT status FROM payroll_records WHERE id=$1", [id])).rows[0].status).toBe("rascunho");
    expect((await client.query("SELECT count(*)::int AS n FROM cash_flow_entries")).rows[0].n).toBe(0);
  });

  it("duas conexões concorrentes produzem uma só saída", async () => {
    const first = clients[0];
    const second = await connect();
    const row = await first.query("INSERT INTO payroll_records(company_id,collaborator_id,period_year,period_month,net_salary,status) VALUES ($1,$2,2026,9,800,'aprovado') RETURNING id", [company, collaborator]);
    const id = row.rows[0].id;
    const results = await Promise.all([
      call(first, "mark_payroll_paid_atomic", `$1::uuid, ARRAY[$2::uuid], '2026-09-04'::date, $3::uuid`, company, id, actor),
      call(second, "mark_payroll_paid_atomic", `$1::uuid, ARRAY[$2::uuid], '2026-09-04'::date, $3::uuid`, company, id, actor),
    ]);
    expect(results.map((r) => r.rows[0].paid_count).sort()).toEqual([0, 1]);
    expect((await first.query("SELECT count(*)::int AS n FROM cash_flow_entries WHERE reference_id=$1", [id])).rows[0].n).toBe(1);
  });

  it("o lock partilhado com o fecho elimina a janela TOCTOU", async () => {
    const first = clients[0];
    const second = await connect();
    const row = await first.query("INSERT INTO payroll_records(company_id,collaborator_id,period_year,period_month,net_salary,status) VALUES ($1,$2,2026,9,700,'aprovado') RETURNING id", [company, collaborator]);
    const id = row.rows[0].id;
    await first.query("BEGIN");
    await first.query("SELECT public.lock_financial_period($1,2026,9)", [company]);
    const blocked = call(second, "mark_payroll_paid_atomic", `$1::uuid, ARRAY[$2::uuid], '2026-09-04'::date, $3::uuid`, company, id, actor);
    await new Promise((resolve) => setTimeout(resolve, 100));
    await first.query("UPDATE financial_periods SET status='closed' WHERE company_id=$1 AND year=2026 AND month=9", [company]);
    await first.query("COMMIT");
    await expect(blocked).rejects.toThrow(/FINANCIAL_PERIOD_CLOSED/);
    expect((await first.query("SELECT status FROM payroll_records WHERE id=$1", [id])).rows[0].status).toBe("aprovado");
    expect((await first.query("SELECT count(*)::int AS n FROM cash_flow_entries WHERE reference_id=$1", [id])).rows[0].n).toBe(0);
  });

  it("cashflow incompatível falha fechado e reverte o lote", async () => {
    const client = clients[0];
    const row = await client.query("INSERT INTO payroll_records(company_id,collaborator_id,period_year,period_month,net_salary,status) VALUES ($1,$2,2026,9,900,'aprovado') RETURNING id", [company, collaborator]);
    const id = row.rows[0].id;
    await client.query("INSERT INTO cash_flow_entries(company_id,type,amount,description,category,date,reference_id,reference_type,status) VALUES ($1,'saida',901,'conflito','salario','2026-09-04',$2,'payroll','confirmado')", [company, id]);
    await expect(call(client, "mark_payroll_paid_atomic", `$1::uuid, ARRAY[$2::uuid], '2026-09-04'::date, $3::uuid`, company, id, actor)).rejects.toThrow(/PAYROLL_CASHFLOW_CONFLICT/);
    expect((await client.query("SELECT status FROM payroll_records WHERE id=$1", [id])).rows[0].status).toBe("aprovado");
    expect((await client.query("SELECT count(*)::int AS n FROM cash_flow_entries WHERE reference_id=$1", [id])).rows[0].n).toBe(1);
  });

  it("ajuste atómico grava o valor e a auditoria na mesma transação", async () => {
    const client = clients[0];
    const row = await client.query("INSERT INTO payroll_records(company_id,collaborator_id,period_year,period_month,net_salary,status) VALUES ($1,$2,2026,9,1000,'rascunho') RETURNING id", [company, collaborator]);
    const id = row.rows[0].id;
    const result = await call(client, "adjust_payroll_record_atomic", `$1::uuid, $2::uuid, $3::jsonb, $4::uuid`, company, id, JSON.stringify({ net_salary: 1100, notes: "ajuste" }), actor);
    expect(result.rows[0].net_salary).toBe("1100");
    expect((await client.query("SELECT notes FROM payroll_records WHERE id=$1", [id])).rows[0].notes).toBe("ajuste");
    const audited = await client.query("SELECT count(*)::int AS n FROM audit_logs WHERE action='payroll_adjusted'");
    expect(audited.rows[0].n).toBe(1);
  });

  it("período fechado, id inexistente, empresa alheia e estado desconhecido falham", async () => {
    const client = clients[0];
    const row = await client.query("INSERT INTO payroll_records(company_id,collaborator_id,period_year,period_month,net_salary,status) VALUES ($1,$2,2026,9,500,'aprovado') RETURNING id", [company, collaborator]);
    const id = row.rows[0].id;
    await client.query("UPDATE financial_periods SET status='closed' WHERE company_id=$1 AND year=2026 AND month=9", [company]);
    await expect(call(client, "mark_payroll_paid_atomic", `$1::uuid, ARRAY[$2::uuid], '2026-09-04'::date, $3::uuid`, company, id, actor)).rejects.toThrow(/FINANCIAL_PERIOD_CLOSED/);
    await expect(call(client, "mark_payroll_paid_atomic", `$1::uuid, ARRAY[$2::uuid], '2026-09-04'::date, $3::uuid`, company, "00000000-0000-0000-0000-000000000099", actor)).rejects.toThrow(/PAYROLL_RECORD_NOT_FOUND/);
    await expect(call(client, "mark_payroll_paid_atomic", `$1::uuid, ARRAY[$2::uuid], '2026-09-04'::date, $3::uuid`, otherCompany, id, actor)).rejects.toThrow(/PAYROLL_ACTOR_NOT_AUTHORIZED/);
    await client.query("UPDATE financial_periods SET status='open' WHERE company_id=$1 AND year=2026 AND month=9", [company]);
    await client.query("UPDATE payroll_records SET status='estado-desconhecido' WHERE id=$1", [id]);
    await expect(call(client, "mark_payroll_paid_atomic", `$1::uuid, ARRAY[$2::uuid], '2026-09-04'::date, $3::uuid`, company, id, actor)).rejects.toThrow(/PAYROLL_NOT_APPROVED/);
  });

  it("erro de query na auditoria reverte payroll e cashflow", async () => {
    const client = clients[0];
    const row = await client.query("INSERT INTO payroll_records(company_id,collaborator_id,period_year,period_month,net_salary,status) VALUES ($1,$2,2026,9,600,'aprovado') RETURNING id", [company, collaborator]);
    const id = row.rows[0].id;
    await client.query("ALTER TABLE audit_logs RENAME TO audit_logs_broken");
    try {
      await expect(call(client, "mark_payroll_paid_atomic", `$1::uuid, ARRAY[$2::uuid], '2026-09-04'::date, $3::uuid`, company, id, actor)).rejects.toThrow();
    } finally {
      await client.query("ALTER TABLE audit_logs_broken RENAME TO audit_logs");
    }
    expect((await client.query("SELECT status FROM payroll_records WHERE id=$1", [id])).rows[0].status).toBe("aprovado");
    expect((await client.query("SELECT count(*)::int AS n FROM cash_flow_entries WHERE reference_id=$1", [id])).rows[0].n).toBe(0);
  });
});

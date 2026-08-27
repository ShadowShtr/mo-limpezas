import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import pg from "pg";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

const connectionString = process.env.CODEX_TEST_DATABASE_URL;
const postgresEnabled = Boolean(connectionString || process.env.CODEX_POSTGRES_TESTS === "1");
const describePostgres = postgresEnabled ? describe : describe.skip;
const COMPANY = "11111111-1111-4111-8111-111111111111";
const ACTOR = "22222222-2222-4222-8222-222222222222";
const CLIENT = "33333333-3333-4333-8333-333333333333";

describePostgres("PostgreSQL real - invoice/cash atomicity", () => {
  const pool = new pg.Pool({ connectionString: connectionString || undefined, max: 8 });

  beforeAll(async () => {
    const host = connectionString ? new URL(connectionString).hostname : process.env.PGHOST;
    if (!host || !["localhost", "127.0.0.1", "postgres"].includes(host)) {
      throw new Error(`TEST_DATABASE_MUST_BE_LOCAL: ${host}`);
    }
    await pool.query(`
      DROP SCHEMA IF EXISTS public CASCADE;
      CREATE SCHEMA public;
      CREATE EXTENSION IF NOT EXISTS pgcrypto WITH SCHEMA public;
      DO $roles$ BEGIN
        IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'anon') THEN CREATE ROLE anon; END IF;
        IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'authenticated') THEN CREATE ROLE authenticated; END IF;
        IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'service_role') THEN CREATE ROLE service_role; END IF;
      END $roles$;

      CREATE TABLE companies(id uuid PRIMARY KEY);
      CREATE TABLE profiles(id uuid PRIMARY KEY, company_id uuid NOT NULL, role text NOT NULL);
      CREATE TABLE clients(id uuid PRIMARY KEY, company_id uuid NOT NULL, name text NOT NULL);
      CREATE TABLE invoices(
        id uuid PRIMARY KEY, company_id uuid NOT NULL, client_id uuid NOT NULL,
        invoice_number text NOT NULL, invoice_date date NOT NULL, total numeric(10,2) NOT NULL,
        status text NOT NULL, paid_at timestamptz, payment_method text, revision bigint NOT NULL DEFAULT 1
      );
      CREATE TABLE cash_flow_entries(
        id uuid PRIMARY KEY DEFAULT gen_random_uuid(), company_id uuid NOT NULL,
        type text NOT NULL, amount numeric(10,2) NOT NULL, description text NOT NULL,
        category text, date date NOT NULL, reference_id uuid, reference_type text,
        status text NOT NULL, created_by uuid
      );
      CREATE UNIQUE INDEX cash_flow_entries_reference_unique
        ON cash_flow_entries(company_id, reference_type, reference_id)
        WHERE reference_type IS NOT NULL AND reference_id IS NOT NULL;
      CREATE TABLE financial_periods(
        company_id uuid NOT NULL, year integer NOT NULL, month integer NOT NULL,
        status text NOT NULL, UNIQUE(company_id, year, month)
      );
      CREATE TABLE bank_reconciliation_matches(
        id uuid PRIMARY KEY DEFAULT gen_random_uuid(), company_id uuid NOT NULL,
        cash_flow_entry_id uuid NOT NULL, status text NOT NULL
      );
      CREATE TABLE audit_logs(
        id uuid PRIMARY KEY DEFAULT gen_random_uuid(), company_id uuid NOT NULL,
        actor_id uuid, action text, entity_type text, entity_id text, meta jsonb
      );
      CREATE TABLE domain_mutations(
        id uuid PRIMARY KEY DEFAULT gen_random_uuid(), company_id uuid NOT NULL,
        mutation_id uuid NOT NULL, domain text NOT NULL, status text NOT NULL,
        operation text NOT NULL, entity_id uuid, request_hash text NOT NULL,
        result jsonb NOT NULL, completed_at timestamptz, UNIQUE(company_id, mutation_id)
      );
      CREATE TABLE company_change_events(
        id uuid PRIMARY KEY DEFAULT gen_random_uuid(), company_id uuid NOT NULL,
        sequence bigint GENERATED ALWAYS AS IDENTITY, mutation_id uuid NOT NULL,
        domain text, event_type text, entity_ids uuid[], scopes text[],
        affected_from date, affected_to date, payload jsonb,
        UNIQUE(company_id, mutation_id)
      );

      CREATE FUNCTION fn_increment_revision() RETURNS trigger LANGUAGE plpgsql AS $fn$
      BEGIN NEW.revision := OLD.revision + 1; RETURN NEW; END $fn$;
      CREATE TRIGGER invoice_revision BEFORE UPDATE ON invoices
        FOR EACH ROW EXECUTE FUNCTION fn_increment_revision();

      CREATE FUNCTION is_financial_period_open(p_company_id uuid, p_year integer, p_month integer)
      RETURNS boolean LANGUAGE sql AS $fn$
        SELECT NOT EXISTS(
          SELECT 1 FROM financial_periods
           WHERE company_id = p_company_id AND year = p_year AND month = p_month AND status = 'closed'
        )
      $fn$;
      CREATE FUNCTION assert_company_manager(p_company_id uuid, p_actor uuid)
      RETURNS jsonb LANGUAGE sql AS $fn$
        SELECT CASE WHEN EXISTS(
          SELECT 1 FROM profiles WHERE id = p_actor AND company_id = p_company_id AND role IN ('admin','gestor')
        ) THEN '{"ok":true}'::jsonb ELSE '{"ok":false,"code":"FORBIDDEN_ACTOR"}'::jsonb END
      $fn$;
      CREATE FUNCTION lock_domain_mutation(p_company_id uuid, p_mutation_id uuid)
      RETURNS void LANGUAGE plpgsql AS $fn$ BEGIN
        PERFORM pg_advisory_xact_lock(hashtext(p_company_id::text || p_mutation_id::text));
      END $fn$;
      CREATE FUNCTION find_or_conflict_domain_mutation(
        p_company_id uuid, p_mutation_id uuid, p_operation text, p_request_hash text
      ) RETURNS jsonb LANGUAGE plpgsql AS $fn$ DECLARE v domain_mutations; BEGIN
        SELECT * INTO v FROM domain_mutations WHERE company_id=p_company_id AND mutation_id=p_mutation_id;
        IF NOT FOUND THEN RETURN NULL; END IF;
        IF v.operation=p_operation AND v.request_hash=p_request_hash THEN RETURN v.result; END IF;
        RETURN '{"ok":false,"code":"MUTATION_REUSE_CONFLICT"}'::jsonb;
      END $fn$;
      CREATE FUNCTION complete_domain_mutation(
        p_company_id uuid, p_mutation_id uuid, p_domain text, p_operation text,
        p_entity_id uuid, p_request_hash text, p_status text, p_result jsonb
      ) RETURNS jsonb LANGUAGE plpgsql AS $fn$ BEGIN
        INSERT INTO domain_mutations(company_id,mutation_id,domain,status,operation,entity_id,request_hash,result,completed_at)
        VALUES(p_company_id,p_mutation_id,p_domain,p_status,p_operation,p_entity_id,p_request_hash,p_result,now());
        RETURN p_result;
      END $fn$;
      CREATE FUNCTION record_company_change_event(
        p_company_id uuid, p_mutation_id uuid, p_domain text, p_event_type text,
        p_entity_ids uuid[], p_scopes text[], p_affected_from date, p_affected_to date, p_payload jsonb
      ) RETURNS jsonb LANGUAGE plpgsql AS $fn$ DECLARE v company_change_events; BEGIN
        INSERT INTO company_change_events(company_id,mutation_id,domain,event_type,entity_ids,scopes,affected_from,affected_to,payload)
        VALUES(p_company_id,p_mutation_id,p_domain,p_event_type,p_entity_ids,p_scopes,p_affected_from,p_affected_to,p_payload)
        RETURNING * INTO v;
        RETURN to_jsonb(v);
      END $fn$;
    `);
    const migration = fs.readFileSync(
      path.join(process.cwd(), "supabase/migrations/provisional/PROVISIONAL_invoice_cash_atomicity.sql"),
      "utf8",
    );
    await pool.query(migration);
  }, 30_000);

  beforeEach(async () => {
    await pool.query(`
      TRUNCATE bank_reconciliation_matches, audit_logs, company_change_events,
        domain_mutations, cash_flow_entries, financial_periods, invoices, clients, profiles, companies
    `);
    await pool.query("INSERT INTO companies(id) VALUES ($1)", [COMPANY]);
    await pool.query(
      "INSERT INTO profiles(id,company_id,role) VALUES ($1,$2,'gestor')",
      [ACTOR, COMPANY],
    );
    await pool.query(
      "INSERT INTO clients(id,company_id,name) VALUES ($1,$2,'Cliente Teste')",
      [CLIENT, COMPANY],
    );
  });

  afterAll(async () => pool.end());

  async function invoice(over: Record<string, unknown> = {}) {
    const id = randomUUID();
    await pool.query(`
      INSERT INTO invoices(id,company_id,client_id,invoice_number,invoice_date,total,status,paid_at,payment_method,revision)
      VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)
    `, [id, COMPANY, CLIENT, `F2026/${id.slice(0, 4)}`, over.invoice_date ?? "2026-07-15",
      over.total ?? 123, over.status ?? "pendente", over.paid_at ?? null,
      over.payment_method ?? null, over.revision ?? 1]);
    return id;
  }

  async function call(client: pg.Pool | pg.PoolClient, id: string, input: Record<string, unknown> = {}) {
    const response = await client.query(
      `SELECT public.set_invoice_status_atomic($1,$2,$3,$4,$5,$6,$7)::jsonb AS result`,
      [id, COMPANY, ACTOR, input.status ?? "pago", input.method ?? "transferencia",
        input.mutation ?? randomUUID(), input.revision ?? 1],
    );
    return response.rows[0].result as Record<string, unknown>;
  }

  async function snapshot(id: string) {
    const [inv, cash, audit, events] = await Promise.all([
      pool.query("SELECT status,paid_at,payment_method,revision FROM invoices WHERE id=$1", [id]),
      pool.query("SELECT id,date::text,amount::text,status FROM cash_flow_entries WHERE reference_id=$1", [id]),
      pool.query("SELECT count(*)::int n FROM audit_logs WHERE entity_id=$1", [id]),
      pool.query("SELECT count(*)::int n FROM company_change_events WHERE $1=ANY(entity_ids)", [id]),
    ]);
    return { invoice: inv.rows[0], cash: cash.rows, audits: audit.rows[0].n, events: events.rows[0].n };
  }

  it("pagar cria exatamente um recebimento e retry preserva data/revisão", async () => {
    const id = await invoice();
    const mutation = randomUUID();
    const first = await call(pool, id, { mutation });
    const beforeRetry = await snapshot(id);
    const retry = await call(pool, id, { mutation });
    const afterRetry = await snapshot(id);

    expect(first.ok).toBe(true);
    expect(retry).toEqual(first);
    expect(beforeRetry).toEqual(afterRetry);
    expect(afterRetry.invoice).toMatchObject({ status: "pago", revision: "2" });
    expect(afterRetry.cash).toHaveLength(1);
    expect(afterRetry.audits).toBe(1);
    expect(afterRetry.events).toBe(1);
  });

  it("falha ao inserir caixa reverte a atualização da fatura", async () => {
    const id = await invoice();
    await pool.query(`
      CREATE FUNCTION fail_cash_insert() RETURNS trigger LANGUAGE plpgsql AS $fn$
      BEGIN RAISE EXCEPTION 'FORCED_CASH_FAILURE'; END $fn$;
      CREATE TRIGGER fail_cash BEFORE INSERT ON cash_flow_entries FOR EACH ROW EXECUTE FUNCTION fail_cash_insert();
    `);
    await expect(call(pool, id)).rejects.toThrow(/FORCED_CASH_FAILURE/);
    await pool.query("DROP TRIGGER fail_cash ON cash_flow_entries; DROP FUNCTION fail_cash_insert()");
    expect(await snapshot(id)).toMatchObject({
      invoice: { status: "pendente", paid_at: null, revision: "1" }, cash: [], audits: 0, events: 0,
    });
  });

  it("falha de auditoria depois de invoice+cash reverte ambos", async () => {
    const id = await invoice();
    await pool.query(`
      CREATE FUNCTION fail_audit_insert() RETURNS trigger LANGUAGE plpgsql AS $fn$
      BEGIN RAISE EXCEPTION 'FORCED_AUDIT_FAILURE'; END $fn$;
      CREATE TRIGGER fail_audit BEFORE INSERT ON audit_logs FOR EACH ROW EXECUTE FUNCTION fail_audit_insert();
    `);
    await expect(call(pool, id)).rejects.toThrow(/FORCED_AUDIT_FAILURE/);
    await pool.query("DROP TRIGGER fail_audit ON audit_logs; DROP FUNCTION fail_audit_insert()");
    expect(await snapshot(id)).toMatchObject({
      invoice: { status: "pendente", paid_at: null, revision: "1" }, cash: [], audits: 0, events: 0,
    });
  });

  it("duas ligações concorrentes produzem um sucesso e um conflito, com um caixa", async () => {
    const id = await invoice();
    const a = await pool.connect();
    const b = await pool.connect();
    try {
      const results = await Promise.all([
        call(a, id, { mutation: randomUUID() }),
        call(b, id, { mutation: randomUUID() }),
      ]);
      expect(results.filter((r) => r.ok === true)).toHaveLength(1);
      expect(results.filter((r) => r.code === "REVISION_CONFLICT")).toHaveLength(1);
      expect((await snapshot(id)).cash).toHaveLength(1);
    } finally {
      a.release(); b.release();
    }
  });

  it("período de caixa fechado bloqueia sem tocar na fatura", async () => {
    const id = await invoice();
    await pool.query(`
      INSERT INTO financial_periods(company_id,year,month,status)
      SELECT $1, EXTRACT(YEAR FROM now() AT TIME ZONE 'Europe/Lisbon')::int,
        EXTRACT(MONTH FROM now() AT TIME ZONE 'Europe/Lisbon')::int, 'closed'
    `, [COMPANY]);
    const result = await call(pool, id);
    expect(result).toMatchObject({ ok: false, code: "FINANCIAL_PERIOD_CLOSED", period_kind: "cash" });
    expect(await snapshot(id)).toMatchObject({ invoice: { status: "pendente", revision: "1" }, cash: [] });
  });

  it("período da fatura fechado também bloqueia", async () => {
    const id = await invoice();
    await pool.query("INSERT INTO financial_periods VALUES($1,2026,7,'closed')", [COMPANY]);
    const result = await call(pool, id);
    expect(result).toMatchObject({ ok: false, code: "FINANCIAL_PERIOD_CLOSED", period_kind: "invoice" });
    expect((await snapshot(id)).cash).toEqual([]);
  });

  it("não remove recebimento conciliado", async () => {
    const id = await invoice();
    await call(pool, id);
    const state = await snapshot(id);
    await pool.query(
      "INSERT INTO bank_reconciliation_matches(company_id,cash_flow_entry_id,status) VALUES($1,$2,'confirmed')",
      [COMPANY, state.cash[0].id],
    );
    const result = await call(pool, id, { status: "pendente", method: null, revision: 2 });
    expect(result).toMatchObject({ ok: false, code: "RECONCILED_CASHFLOW" });
    expect(await snapshot(id)).toMatchObject({ invoice: { status: "pago", revision: "2" }, cash: [{ status: "confirmado" }] });
  });

  it("movimento existente com valor errado falha fechado", async () => {
    const id = await invoice();
    await pool.query(`
      INSERT INTO cash_flow_entries(company_id,type,amount,description,category,date,reference_id,reference_type,status)
      VALUES($1,'entrada',999,'errado','faturacao','2026-07-20',$2,'invoice','confirmado')
    `, [COMPANY, id]);
    const result = await call(pool, id);
    expect(result).toMatchObject({ ok: false, code: "CASHFLOW_INVOICE_MISMATCH" });
    expect((await snapshot(id)).invoice).toMatchObject({ status: "pendente", revision: "1" });
  });

  it("rollback restaura a RPC anterior e a migration volta a aplicar", async () => {
    const rollback = fs.readFileSync(
      path.join(
        process.cwd(),
        "supabase/migrations/provisional/PROVISIONAL_invoice_cash_atomicity.rollback.sql",
      ),
      "utf8",
    );
    const migration = fs.readFileSync(
      path.join(process.cwd(), "supabase/migrations/provisional/PROVISIONAL_invoice_cash_atomicity.sql"),
      "utf8",
    );

    await pool.query(rollback);
    const restored = await pool.query(`
      SELECT pg_get_functiondef(
        'public.set_invoice_status_atomic(uuid,uuid,uuid,text,text,uuid,bigint)'::regprocedure
      ) AS definition
    `);
    expect(restored.rows[0].definition).toContain("ON CONFLICT (company_id, reference_type, reference_id)");
    expect(restored.rows[0].definition).not.toContain("is_financial_period_open");

    await pool.query(migration);
    const reapplied = await pool.query(`
      SELECT pg_get_functiondef(
        'public.set_invoice_status_atomic(uuid,uuid,uuid,text,text,uuid,bigint)'::regprocedure
      ) AS definition
    `);
    expect(reapplied.rows[0].definition).toContain("is_financial_period_open");
  });
});

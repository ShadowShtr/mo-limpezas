import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import pg from "pg";
import fs from "node:fs";
import path from "node:path";
import { startPostgresContainer, type PostgresContainer } from "./helpers/pg-container";

const ROOT = path.join(__dirname, "..", "..");
const SQL = fs.readFileSync(path.join(ROOT, "docs", "INTERVENTION_ATOMIC_SCHEMA_CANDIDATE.sql"), "utf8");
const COMPANY = "11111111-1111-1111-1111-111111111111";
const ACTOR = "22222222-2222-2222-2222-222222222222";
const LOCATION = "33333333-3333-3333-3333-333333333333";
const TEAM = "44444444-4444-4444-4444-444444444444";
const OTHER_TEAM = "77777777-7777-7777-7777-777777777777";
const CONTRACT = "55555555-5555-5555-5555-555555555555";
const SERVICE = "66666666-6666-6666-6666-666666666666";

const PATCH = {
  location_id: LOCATION, name: "Série atualizada", frequency: "weekly", interval_days: 1,
  weekdays: [5], schedule_days: [{ day: "fri", start_time: "10:00", duration_min: 90, team_id: TEAM }],
  starts_on: "2026-09-04", ends_on: null, status: "ativo", notes: "combinada", cleaning_type: "limpeza_regular",
  payment_status: null, upholstery_type: null, upholstery_notes: null, upholstery_units: null,
  upholstery_unit_price: null, fixed_price: null, fixed_monthly: false, apply_vat: true, num_people: 2,
};

const PAYLOAD = {
  location_id: LOCATION, team_id: TEAM,
  scheduled_start: "2026-09-04T10:00:00+01:00", scheduled_end: "2026-09-04T11:30:00+01:00",
  hourly_rate: 12, calculated_value: 36, apply_vat: true, num_people: 2,
  cleaning_type: "limpeza_regular", payment_status: null, upholstery_type: null,
  upholstery_notes: null, upholstery_units: null, upholstery_unit_price: null,
};

type Client = pg.Client;
let container: PostgresContainer;
let db: Client;

async function query<T extends pg.QueryResultRow = pg.QueryResultRow>(text: string, values: unknown[] = []) {
  return db.query<T>(text, values);
}

async function call(overrides: {
  patch?: Record<string, unknown>;
  plan?: unknown[];
  expected?: string | null;
  actor?: string | null;
} = {}) {
  const patch = overrides.patch ?? PATCH;
  const plan = overrides.plan ?? [{ decision: "UPDATE_FROM_CONTRACT", service_id: SERVICE, occurrence_date: "2026-09-04", payload: PAYLOAD }];
  return query(
    "SELECT public.apply_contract_change_atomic($1,$2,$3,$4::jsonb,$5,$6,$7::jsonb,$8,$9::jsonb)",
    [COMPANY, CONTRACT, overrides.expected ?? "2026-09-03T08:00:00Z", JSON.stringify(patch), false, null, JSON.stringify(plan), overrides.actor ?? ACTOR, JSON.stringify({ action: "intervention_updated" })],
  );
}

async function resetData() {
  await query("TRUNCATE audit_logs, services, contracts, teams, locations, profiles, companies CASCADE");
  await query("INSERT INTO companies VALUES ($1)", [COMPANY]);
  await query("INSERT INTO profiles VALUES ($1,$2)", [ACTOR, COMPANY]);
  await query("INSERT INTO locations VALUES ($1,$2,12)", [LOCATION, COMPANY]);
  await query("INSERT INTO teams VALUES ($1,$2),($3,$2)", [TEAM, COMPANY, OTHER_TEAM]);
  await query(
    "INSERT INTO contracts (id,company_id,location_id,name,frequency,interval_days,weekdays,schedule_days,starts_on,ends_on,status,notes,cleaning_type,payment_status,upholstery_type,upholstery_notes,upholstery_units,upholstery_unit_price,fixed_price,fixed_monthly,apply_vat,excluded_dates,num_people,updated_at) VALUES ($1,$2,$3,'Antes','weekly',1,ARRAY[4],$4::jsonb,'2026-09-03',NULL,'ativo',NULL,NULL,NULL,NULL,NULL,NULL,NULL,NULL,false,true,'{}',NULL,'2026-09-03T08:00:00Z')",
    [CONTRACT, COMPANY, LOCATION, JSON.stringify([{ day: "thu", start_time: "09:00", duration_min: 120, team_id: TEAM }])],
  );
  await query(
    "INSERT INTO services (id,company_id,location_id,team_id,contract_id,reference_number,scheduled_start,scheduled_end,hourly_rate,calculated_value,apply_vat,num_people,status,is_exception) VALUES ($1,$2,$3,$4,$5,'0001','2026-09-03T09:00:00+01:00','2026-09-03T11:00:00+01:00',10,40,false,1,'agendado',false)",
    [SERVICE, COMPANY, LOCATION, TEAM, CONTRACT],
  );
}

beforeAll(async () => {
  container = await startPostgresContainer({ name: `intervention-atomic-${process.pid}`, database: "intervention" });
  db = new pg.Client({ host: container.connection.host, port: container.port, user: "postgres", database: container.connection.database });
  await db.connect();
  await db.query("CREATE EXTENSION IF NOT EXISTS pgcrypto");
  await db.query(`
    CREATE ROLE service_role NOLOGIN;
    CREATE TABLE companies (id uuid PRIMARY KEY);
    CREATE TABLE profiles (id uuid PRIMARY KEY, company_id uuid NOT NULL REFERENCES companies(id));
    CREATE TABLE locations (id uuid PRIMARY KEY, company_id uuid NOT NULL REFERENCES companies(id), hourly_rate numeric);
    CREATE TABLE teams (id uuid PRIMARY KEY, company_id uuid NOT NULL REFERENCES companies(id));
    CREATE TABLE contracts (
      id uuid PRIMARY KEY, company_id uuid NOT NULL REFERENCES companies(id), location_id uuid NOT NULL,
      name text, frequency text NOT NULL, interval_days integer, weekdays integer[], schedule_days jsonb NOT NULL,
      starts_on date NOT NULL, ends_on date, status text, notes text, cleaning_type text, payment_status text,
      upholstery_type text, upholstery_notes text, upholstery_units numeric, upholstery_unit_price numeric,
      fixed_price numeric, fixed_monthly boolean, apply_vat boolean, excluded_dates text[] DEFAULT '{}',
      num_people integer, updated_at timestamptz NOT NULL
    );
    CREATE TABLE services (
      id uuid PRIMARY KEY, company_id uuid NOT NULL REFERENCES companies(id), location_id uuid NOT NULL,
      team_id uuid REFERENCES teams(id), contract_id uuid REFERENCES contracts(id), reference_number text NOT NULL,
      scheduled_start timestamptz NOT NULL, scheduled_end timestamptz NOT NULL, hourly_rate numeric,
      calculated_value numeric, apply_vat boolean, num_people integer, status text, cleaning_type text,
      payment_status text, upholstery_type text, upholstery_notes text, upholstery_units numeric,
      upholstery_unit_price numeric, original_date date NULL,
      is_exception boolean NOT NULL DEFAULT false, contract_synced_at timestamptz NULL,
      created_by uuid REFERENCES profiles(id)
    );
    CREATE TABLE audit_logs (
      id uuid DEFAULT gen_random_uuid(), company_id uuid NOT NULL, actor_id uuid NOT NULL REFERENCES profiles(id),
      action text NOT NULL, entity_type text NOT NULL, entity_id uuid, meta jsonb
    );
  `);
  await db.query(SQL);
}, 180_000);

afterAll(async () => {
  await db?.end();
  container?.stop();
}, 30_000);

describe("RPC candidata de intervenções em PostgreSQL real", () => {
  beforeEach(resetData, 30_000);

  it("mantém no fixture a forma mínima exigida de services", async () => {
    const result = await query<{
      column_name: string;
      data_type: string;
      is_nullable: string;
      column_default: string | null;
    }>(
      "SELECT column_name,data_type,is_nullable,column_default FROM information_schema.columns WHERE table_schema='public' AND table_name='services' AND column_name=ANY($1::text[]) ORDER BY column_name",
      [["original_date", "is_exception", "contract_synced_at"]],
    );
    expect(result.rows).toHaveLength(3);
    expect(result.rows.find((row) => row.column_name === "original_date")).toMatchObject({
      data_type: "date",
      is_nullable: "YES",
    });
    expect(result.rows.find((row) => row.column_name === "is_exception")).toMatchObject({
      data_type: "boolean",
      is_nullable: "NO",
    });
    expect(result.rows.find((row) => row.column_name === "is_exception")?.column_default).toContain("false");
    expect(result.rows.find((row) => row.column_name === "contract_synced_at")).toMatchObject({
      data_type: "timestamp with time zone",
      is_nullable: "YES",
    });
  }, 30_000);

  it("faz commit conjunto de contrato, equipa, data, horário e auditoria", async () => {
    await call();
    const result = await query<{ name: string; team_id: string; scheduled_start: string; action: string }>(
      "SELECT c.name, s.team_id, s.scheduled_start::text, a.action FROM contracts c JOIN services s ON s.contract_id=c.id JOIN audit_logs a ON a.entity_id=c.id WHERE c.id=$1", [CONTRACT],
    );
    expect(result.rows[0]).toMatchObject({ name: "Série atualizada", team_id: TEAM, action: "intervention_updated" });
    expect(result.rows[0]?.scheduled_start).toContain("09:00:00+00");
  }, 30_000);

  it("falha antes da primeira escrita e deixa zero mudanças", async () => {
    await expect(call({ patch: { ...PATCH, location_id: "88888888-8888-8888-8888-888888888888" } })).rejects.toThrow(/INVALID_LOCATION/);
    const result = await query<{ name: string; logs: string }>("SELECT name,(SELECT count(*)::text FROM audit_logs) logs FROM contracts WHERE id=$1", [CONTRACT]);
    expect(result.rows[0]).toEqual({ name: "Antes", logs: "0" });
  }, 30_000);

  it("falha depois do update lógico e faz rollback total", async () => {
    await expect(call({ plan: [{ decision: "REMOVE_ORPHAN", service_id: OTHER_TEAM }] })).rejects.toThrow(/SERVICE_STALE_OR_PROTECTED/);
    const result = await query<{ name: string; logs: string }>("SELECT name,(SELECT count(*)::text FROM audit_logs) logs FROM contracts WHERE id=$1", [CONTRACT]);
    expect(result.rows[0]).toEqual({ name: "Antes", logs: "0" });
  }, 30_000);

  it("falha tardiamente na auditoria e faz rollback de contrato e serviço", async () => {
    await expect(call({ actor: "99999999-9999-9999-9999-999999999999" })).rejects.toThrow();
    const result = await query<{ name: string; team_id: string; logs: string }>("SELECT c.name,s.team_id,(SELECT count(*)::text FROM audit_logs) logs FROM contracts c JOIN services s ON s.contract_id=c.id WHERE c.id=$1", [CONTRACT]);
    expect(result.rows[0]).toEqual({ name: "Antes", team_id: TEAM, logs: "0" });
  }, 30_000);

  it("recusa revision stale sem partial write", async () => {
    await query("UPDATE contracts SET name='Outra sessão', updated_at='2026-09-03T08:30:00Z' WHERE id=$1", [CONTRACT]);
    await expect(call()).rejects.toThrow(/STALE_CONFLICT/);
    const result = await query<{ name: string; logs: string }>("SELECT name,(SELECT count(*)::text FROM audit_logs) logs FROM contracts WHERE id=$1", [CONTRACT]);
    expect(result.rows[0]).toEqual({ name: "Outra sessão", logs: "0" });
  }, 30_000);

  it("serializa duas sessões pelo lock de contrato", async () => {
    await resetData();
    const locker = new pg.Client({ host: container.connection.host, port: container.port, user: "postgres", database: container.connection.database });
    await locker.connect();
    await locker.query("BEGIN");
    await locker.query("SELECT id FROM contracts WHERE id=$1 FOR UPDATE", [CONTRACT]);
    const started = Date.now();
    const pending = call();
    await new Promise((resolve) => setTimeout(resolve, 150));
    await locker.query("COMMIT");
    await locker.end();
    await pending;
    expect(Date.now() - started).toBeGreaterThanOrEqual(100);
  }, 30_000);

  it("não sobrescreve uma intervenção marcada como exceção", async () => {
    await resetData();
    await query("UPDATE services SET is_exception=true, team_id=$1 WHERE id=$2", [OTHER_TEAM, SERVICE]);
    await expect(call()).rejects.toThrow(/SERVICE_STALE_OR_PROTECTED/);
    const result = await query<{ team_id: string; is_exception: boolean }>("SELECT team_id,is_exception FROM services WHERE id=$1", [SERVICE]);
    expect(result.rows[0]).toEqual({ team_id: OTHER_TEAM, is_exception: true });
  }, 30_000);
});

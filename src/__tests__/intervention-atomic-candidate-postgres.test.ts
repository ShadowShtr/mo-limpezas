import { beforeEach, describe, expect, it } from "vitest";
import { PGlite } from "@electric-sql/pglite";
import fs from "node:fs";
import path from "node:path";

const ROOT = path.join(__dirname, "..", "..");
const SQL = fs.readFileSync(path.join(ROOT, "docs", "INTERVENTION_ATOMIC_SCHEMA_CANDIDATE.sql"), "utf8");
const COMPANY = "11111111-1111-1111-1111-111111111111";
const ACTOR = "22222222-2222-2222-2222-222222222222";
const LOCATION = "33333333-3333-3333-3333-333333333333";
const TEAM = "44444444-4444-4444-4444-444444444444";
const CONTRACT = "55555555-5555-5555-5555-555555555555";
const SERVICE = "66666666-6666-6666-6666-666666666666";

const PATCH = {
  location_id: LOCATION, name: "Série", frequency: "weekly", interval_days: 1,
  weekdays: [4], schedule_days: [{ day: "thu", start_time: "09:00", duration_min: 120, team_id: TEAM }],
  starts_on: "2026-09-03", ends_on: null, status: "ativo", notes: null,
  cleaning_type: "limpeza_regular", payment_status: null, upholstery_type: null,
  upholstery_notes: null, upholstery_units: null, upholstery_unit_price: null,
  fixed_price: null, fixed_monthly: false, apply_vat: true, num_people: null,
};

const PAYLOAD = {
  location_id: LOCATION, team_id: TEAM,
  scheduled_start: "2026-09-03T09:00:00+01:00", scheduled_end: "2026-09-03T11:00:00+01:00",
  hourly_rate: 12, calculated_value: 48, apply_vat: true, num_people: 2,
  cleaning_type: "limpeza_regular", payment_status: null, upholstery_type: null,
  upholstery_notes: null, upholstery_units: null, upholstery_unit_price: null,
};

async function base(): Promise<PGlite> {
  const db = new PGlite();
  await db.exec(`
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
      upholstery_unit_price numeric, is_exception boolean DEFAULT false, contract_synced_at timestamptz,
      created_by uuid REFERENCES profiles(id)
    );
    CREATE TABLE audit_logs (
      id uuid DEFAULT gen_random_uuid(), company_id uuid NOT NULL, actor_id uuid NOT NULL,
      action text NOT NULL, entity_type text NOT NULL, entity_id uuid, meta jsonb
    );
  `);
  await db.exec(`
    INSERT INTO companies VALUES ('${COMPANY}');
    INSERT INTO profiles VALUES ('${ACTOR}', '${COMPANY}');
    INSERT INTO locations VALUES ('${LOCATION}', '${COMPANY}', 12);
    INSERT INTO teams VALUES ('${TEAM}', '${COMPANY}');
    INSERT INTO contracts (id, company_id, location_id, name, frequency, interval_days, weekdays, schedule_days, starts_on, ends_on, status, notes, cleaning_type, payment_status, upholstery_type, upholstery_notes, upholstery_units, upholstery_unit_price, fixed_price, fixed_monthly, apply_vat, excluded_dates, num_people, updated_at)
    VALUES ('${CONTRACT}', '${COMPANY}', '${LOCATION}', 'Antes', 'weekly', 1, ARRAY[4], '${JSON.stringify(PATCH.schedule_days)}', '2026-09-03', NULL, 'ativo', NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, false, true, '{}', NULL, '2026-09-03T08:00:00Z');
    INSERT INTO services (id, company_id, location_id, team_id, contract_id, reference_number, scheduled_start, scheduled_end, hourly_rate, calculated_value, apply_vat, num_people, status, is_exception)
    VALUES ('${SERVICE}', '${COMPANY}', '${LOCATION}', '${TEAM}', '${CONTRACT}', '0001', '2026-09-03T09:00:00+01:00', '2026-09-03T11:00:00+01:00', 10, 40, false, 1, 'agendado', false);
  `);
  await db.exec(SQL);
  return db;
}

function args(overrides: Record<string, unknown> = {}) {
  return [COMPANY, CONTRACT, "2026-09-03T08:00:00Z", JSON.stringify(PATCH), false, null, JSON.stringify([
    { decision: "UPDATE_FROM_CONTRACT", service_id: SERVICE, occurrence_date: "2026-09-03", payload: PAYLOAD },
  ]), ACTOR, JSON.stringify({ action: "intervention_updated" }), ...Object.values(overrides)];
}

describe("RPC candidata de intervenções em PostgreSQL embutido", () => {
  let db: PGlite;

  beforeEach(async () => { db = await base(); }, 30_000);

  it("faz commit conjunto de contrato, serviço e auditoria", async () => {
    await db.query("SELECT public.apply_contract_change_atomic($1,$2,$3,$4::jsonb,$5,$6,$7::jsonb,$8,$9::jsonb)", args());
    const state = await db.query<{ name: string; team_id: string; action: string }>(
      "SELECT c.name, s.team_id, a.action FROM contracts c JOIN services s ON s.contract_id=c.id JOIN audit_logs a ON a.entity_id=c.id WHERE c.id=$1", [CONTRACT],
    );
    expect(state.rows[0]).toMatchObject({ name: "Série", team_id: TEAM, action: "intervention_updated" });
  });

  it("faz rollback total quando uma escrita posterior falha", async () => {
    const badPayload = { ...PAYLOAD, team_id: "77777777-7777-7777-7777-777777777777" };
    await expect(db.query("SELECT public.apply_contract_change_atomic($1,$2,$3,$4::jsonb,$5,$6,$7::jsonb,$8,$9::jsonb)", [
      COMPANY, CONTRACT, "2026-09-03T08:00:00Z", JSON.stringify(PATCH), false, null,
      JSON.stringify([{ decision: "UPDATE_FROM_CONTRACT", service_id: SERVICE, occurrence_date: "2026-09-03", payload: badPayload }]),
      ACTOR, JSON.stringify({ action: "must_not_persist" }),
    ])).rejects.toThrow();
    const state = await db.query<{ name: string; team_id: string; logs: string }>(
      "SELECT c.name, s.team_id, (SELECT count(*)::text FROM audit_logs) logs FROM contracts c JOIN services s ON s.contract_id=c.id WHERE c.id=$1", [CONTRACT],
    );
    expect(state.rows[0]).toMatchObject({ name: "Antes", team_id: TEAM, logs: "0" });
  });

  it("recusa snapshot stale antes de qualquer escrita", async () => {
    await db.query("UPDATE contracts SET name='Outra sessão', updated_at='2026-09-03T08:30:00Z' WHERE id=$1", [CONTRACT]);
    await expect(db.query("SELECT public.apply_contract_change_atomic($1,$2,$3,$4::jsonb,$5,$6,$7::jsonb,$8,$9::jsonb)", args())).rejects.toThrow(/STALE_CONFLICT/);
    const state = await db.query<{ name: string; logs: string }>(
      "SELECT c.name, (SELECT count(*)::text FROM audit_logs) logs FROM contracts c WHERE c.id=$1", [CONTRACT],
    );
    expect(state.rows[0]).toEqual({ name: "Outra sessão", logs: "0" });
  });
});

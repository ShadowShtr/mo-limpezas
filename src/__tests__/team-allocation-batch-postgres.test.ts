import { beforeAll, describe, expect, it } from "vitest";
import { PGlite } from "@electric-sql/pglite";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const COMPANY = "11111111-1111-4111-8111-111111111111";
const ACTOR = "22222222-2222-4222-8222-222222222222";
const ANA = "33333333-3333-4333-8333-333333333333";
const BIA = "44444444-4444-4444-8444-444444444444";
const TEAM_A = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const TEAM_B = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const VEHICLE = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";
const DATE = "2026-08-27";

const emptySnapshot = { member_assignments: [], vehicle_allocations: [] };
const db = new PGlite();

async function scalar<T>(sql: string, params: unknown[]): Promise<T> {
  const result = await db.query<Record<string, T>>(sql, params);
  return Object.values(result.rows[0])[0];
}

async function saveDay(args: {
  expected: unknown;
  members: unknown[];
  vehicles?: unknown[];
}) {
  return scalar<unknown>(
    "SELECT public.save_team_day_allocations($1,$2,$3,$4::jsonb,$5::jsonb,$6::jsonb) AS value",
    [COMPANY, ACTOR, DATE, JSON.stringify(args.expected), JSON.stringify(args.members), JSON.stringify(args.vehicles ?? [])],
  );
}

beforeAll(async () => {
  await db.exec(`
    CREATE ROLE service_role;
    CREATE TABLE profiles (
      id uuid PRIMARY KEY, company_id uuid NOT NULL, role text NOT NULL
    );
    CREATE TABLE teams (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(), company_id uuid NOT NULL,
      name text NOT NULL, color text, leader_id uuid, active boolean DEFAULT true,
      created_at timestamptz DEFAULT now(), updated_at timestamptz DEFAULT now()
    );
    CREATE TABLE team_members (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(), team_id uuid NOT NULL REFERENCES teams(id),
      collaborator_id uuid NOT NULL REFERENCES profiles(id), joined_at date DEFAULT CURRENT_DATE,
      left_at date, CONSTRAINT team_members_team_id_collaborator_id_key UNIQUE(team_id, collaborator_id)
    );
    CREATE TABLE vehicles (
      id uuid PRIMARY KEY, company_id uuid NOT NULL, status text NOT NULL DEFAULT 'ativo'
    );
    CREATE TABLE collaborator_ride_assignments (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(), company_id uuid NOT NULL,
      collaborator_id uuid NOT NULL REFERENCES profiles(id), team_id uuid NOT NULL REFERENCES teams(id),
      date date NOT NULL, assigned_by uuid, created_at timestamptz DEFAULT now(), updated_at timestamptz DEFAULT now(),
      UNIQUE(collaborator_id, date)
    );
    CREATE TABLE vehicle_allocations (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(), company_id uuid NOT NULL,
      vehicle_id uuid NOT NULL REFERENCES vehicles(id), team_id uuid NOT NULL REFERENCES teams(id),
      driver_id uuid, date date NOT NULL, created_at timestamptz DEFAULT now(), updated_at timestamptz DEFAULT now(),
      UNIQUE(vehicle_id, date)
    );
    INSERT INTO profiles VALUES
      ('${ACTOR}','${COMPANY}','admin'),
      ('${ANA}','${COMPANY}','colaborador'),
      ('${BIA}','${COMPANY}','colaborador');
    INSERT INTO teams(id,company_id,name,color) VALUES
      ('${TEAM_A}','${COMPANY}','Equipa A','#16A34A'),
      ('${TEAM_B}','${COMPANY}','Equipa B','#0EA5E9');
    INSERT INTO vehicles VALUES ('${VEHICLE}','${COMPANY}','ativo');
    INSERT INTO team_members(team_id,collaborator_id) VALUES ('${TEAM_A}','${ANA}');
  `);
  await db.exec(readFileSync(resolve("supabase/migrations/draft/PROVISIONAL_team_allocation_batch.sql"), "utf8"));
});

describe("save diário transacional", () => {
  it("representa equipa para Disponível com team_id NULL", async () => {
    const snapshot = await saveDay({
      expected: emptySnapshot,
      members: [{ collaborator_id: ANA, team_id: null }],
    });
    expect(snapshot).toMatchObject({
      member_assignments: [{ collaborator_id: ANA, team_id: null }],
    });
    expect(await scalar<number>(
      "SELECT count(*)::int AS value FROM collaborator_ride_assignments WHERE collaborator_id=$1 AND team_id IS NULL",
      [ANA],
    )).toBe(1);
  });

  it("retry com o snapshot devolvido é idempotente", async () => {
    const current = await scalar<unknown>(
      `SELECT jsonb_build_object(
        'member_assignments', jsonb_agg(jsonb_build_object('collaborator_id',collaborator_id,'team_id',team_id) ORDER BY collaborator_id),
        'vehicle_allocations', '[]'::jsonb
      ) AS value FROM collaborator_ride_assignments WHERE company_id=$1 AND date=$2`,
      [COMPANY, DATE],
    );
    const next = await saveDay({
      expected: current,
      members: [{ collaborator_id: ANA, team_id: null }],
    });
    expect(next).toEqual(current);
    expect(await scalar<number>(
      "SELECT count(*)::int AS value FROM collaborator_ride_assignments WHERE collaborator_id=$1 AND date=$2",
      [ANA, DATE],
    )).toBe(1);
  });

  it("snapshot stale recusa o lote inteiro", async () => {
    await expect(saveDay({
      expected: emptySnapshot,
      members: [{ collaborator_id: ANA, team_id: TEAM_B }],
      vehicles: [{ team_id: TEAM_B, vehicle_id: VEHICLE, driver_id: ANA }],
    })).rejects.toThrow(/TEAM_ALLOCATION_CONFLICT/);
    expect(await scalar<number>(
      "SELECT count(*)::int AS value FROM vehicle_allocations WHERE date=$1",
      [DATE],
    )).toBe(0);
    expect(await scalar<string | null>(
      "SELECT team_id::text AS value FROM collaborator_ride_assignments WHERE collaborator_id=$1 AND date=$2",
      [ANA, DATE],
    )).toBeNull();
  });
});

describe("composição permanente diferencial", () => {
  it("remove sem DELETE e preserva o intervalo histórico", async () => {
    const updatedAt = await scalar<string>("SELECT updated_at::text AS value FROM teams WHERE id=$1", [TEAM_A]);
    await scalar<string>(
      "SELECT public.save_team_with_members_v2($1,$2,$3,$4,$5::jsonb,$6,$7,$8,$9,$10::uuid[])::text AS value",
      [COMPANY, ACTOR, TEAM_A, updatedAt, JSON.stringify([ANA]), "Equipa A", "#16A34A", true, null, []],
    );
    expect(await scalar<number>(
      "SELECT count(*)::int AS value FROM team_members WHERE team_id=$1 AND collaborator_id=$2 AND left_at IS NOT NULL",
      [TEAM_A, ANA],
    )).toBe(1);
  });

  it("reentrada cria um novo intervalo sem apagar o anterior", async () => {
    const updatedAt = await scalar<string>("SELECT updated_at::text AS value FROM teams WHERE id=$1", [TEAM_A]);
    await scalar<string>(
      "SELECT public.save_team_with_members_v2($1,$2,$3,$4,$5::jsonb,$6,$7,$8,$9,$10::uuid[])::text AS value",
      [COMPANY, ACTOR, TEAM_A, updatedAt, JSON.stringify([]), "Equipa A", "#16A34A", true, ANA, [ANA]],
    );
    expect(await scalar<number>(
      "SELECT count(*)::int AS value FROM team_members WHERE team_id=$1 AND collaborator_id=$2",
      [TEAM_A, ANA],
    )).toBe(2);
    expect(await scalar<number>(
      "SELECT count(*)::int AS value FROM team_members WHERE team_id=$1 AND collaborator_id=$2 AND left_at IS NULL",
      [TEAM_A, ANA],
    )).toBe(1);
  });

  it("membro ativo noutra equipa reverte tudo", async () => {
    const updatedAt = await scalar<string>("SELECT updated_at::text AS value FROM teams WHERE id=$1", [TEAM_B]);
    await expect(scalar<string>(
      "SELECT public.save_team_with_members_v2($1,$2,$3,$4,$5::jsonb,$6,$7,$8,$9,$10::uuid[])::text AS value",
      [COMPANY, ACTOR, TEAM_B, updatedAt, JSON.stringify([]), "Alterada", "#0EA5E9", true, null, [ANA]],
    )).rejects.toThrow(/TEAM_SAVE_MEMBER_IN_OTHER_TEAM/);
    expect(await scalar<string>("SELECT name AS value FROM teams WHERE id=$1", [TEAM_B])).toBe("Equipa B");
  });
});

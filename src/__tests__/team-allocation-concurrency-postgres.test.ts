import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import pg from "pg";

const CONTAINER = `team-allocation-${process.pid}`;
const COMPANY = "11111111-1111-4111-8111-111111111111";
const ACTOR = "22222222-2222-4222-8222-222222222222";
const ANA = "33333333-3333-4333-8333-333333333333";
const BIA = "44444444-4444-4444-8444-444444444444";
const TEAM_A = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const TEAM_B = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";

let port = 0;
let pool: pg.Pool;

const docker = (args: string[]) => spawnSync("docker", args, { encoding: "utf8" });

async function waitForPostgres() {
  const deadline = Date.now() + 60_000;
  while (Date.now() < deadline) {
    const client = new pg.Client({ host: "127.0.0.1", port, user: "postgres", database: "equipas" });
    try {
      await client.connect();
      await client.query("SELECT 1");
      await client.end();
      return;
    } catch {
      try { await client.end(); } catch { /* connection did not open */ }
      await new Promise((resolve) => setTimeout(resolve, 250));
    }
  }
  throw new Error("PostgreSQL descartável não ficou pronto.");
}

beforeAll(async () => {
  docker(["rm", "-f", CONTAINER]);
  const started = docker([
    "run", "--rm", "-d", "--name", CONTAINER,
    "-e", "POSTGRES_HOST_AUTH_METHOD=trust", "-e", "POSTGRES_DB=equipas",
    "-p", "127.0.0.1::5432", "postgres:16-alpine",
  ]);
  if (started.status !== 0) throw new Error(started.stderr || started.stdout);
  const mapping = docker(["port", CONTAINER, "5432/tcp"]).stdout.trim();
  port = Number(mapping.slice(mapping.lastIndexOf(":") + 1));
  await waitForPostgres();
  pool = new pg.Pool({ host: "127.0.0.1", port, user: "postgres", database: "equipas", max: 4 });
  await pool.query(`
    CREATE ROLE service_role;
    CREATE TABLE profiles (id uuid PRIMARY KEY, company_id uuid NOT NULL, role text NOT NULL);
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
    CREATE TABLE vehicles (id uuid PRIMARY KEY, company_id uuid NOT NULL, status text NOT NULL DEFAULT 'ativo');
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
      ('${ACTOR}','${COMPANY}','admin'), ('${ANA}','${COMPANY}','colaborador'),
      ('${BIA}','${COMPANY}','colaborador');
    INSERT INTO teams(id,company_id,name,color) VALUES
      ('${TEAM_A}','${COMPANY}','Equipa A','#16A34A'),
      ('${TEAM_B}','${COMPANY}','Equipa B','#0EA5E9');
  `);
  await pool.query(readFileSync(
    "supabase/migrations/draft/PROVISIONAL_team_allocation_batch.sql",
    "utf8",
  ));
}, 120_000);

afterAll(async () => {
  await pool?.end();
  docker(["rm", "-f", CONTAINER]);
});

describe.sequential("concorrência real das equipas", () => {
  it("dois saves do mesmo dia: um vence e o stale recusa", async () => {
    const expected = JSON.stringify({ member_assignments: [], vehicle_allocations: [] });
    const call = (collaboratorId: string, teamId: string) => pool.query(
      "SELECT save_team_day_allocations($1,$2,$3,$4::jsonb,$5::jsonb,'[]'::jsonb)",
      [COMPANY, ACTOR, "2026-08-28", expected, JSON.stringify([
        { collaborator_id: collaboratorId, team_id: teamId },
      ])],
    );
    const results = await Promise.allSettled([call(ANA, TEAM_A), call(BIA, TEAM_B)]);
    expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(1);
    const failure = results.find((result) => result.status === "rejected");
    expect(failure && failure.status === "rejected" ? failure.reason.message : "")
      .toMatch(/TEAM_ALLOCATION_CONFLICT/);
    expect((await pool.query(
      "SELECT count(*)::int n FROM collaborator_ride_assignments WHERE date='2026-08-28'",
    )).rows[0].n).toBe(1);
  });

  it("dois editores da mesma equipa não perdem membros", async () => {
    const updatedAt = (await pool.query("SELECT updated_at FROM teams WHERE id=$1", [TEAM_A])).rows[0].updated_at;
    const call = (memberId: string) => pool.query(
      "SELECT save_team_with_members_v2($1,$2,$3,$4,'[]'::jsonb,$5,$6,$7,$8,$9::uuid[])",
      [COMPANY, ACTOR, TEAM_A, updatedAt, "Equipa A", "#16A34A", true, null, [memberId]],
    );
    const results = await Promise.allSettled([call(ANA), call(BIA)]);
    const diagnostics = results.map((result) =>
      result.status === "fulfilled" ? "fulfilled" : result.reason?.message ?? String(result.reason),
    );
    expect(
      results.filter((result) => result.status === "fulfilled"),
      diagnostics.join(" | "),
    ).toHaveLength(1);
    const failure = results.find((result) => result.status === "rejected");
    expect(failure && failure.status === "rejected" ? failure.reason.message : "")
      .toMatch(/TEAM_SAVE_CONFLICT/);
    expect((await pool.query(
      "SELECT count(*)::int n FROM team_members WHERE team_id=$1 AND left_at IS NULL",
      [TEAM_A],
    )).rows[0].n).toBe(1);
  });
});

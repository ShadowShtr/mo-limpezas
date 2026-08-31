/**
 * Equipas R4 — os três conceitos, e um save por transação.
 *
 * O que se prova aqui, em PostgreSQL 17 real:
 *
 *   1. A regra de precedência do dia, incluindo a distinção que o produto pede:
 *      LINHA AUSENTE != LINHA COM `team_id` NULL.
 *
 *   2. 🔴 CONCORRÊNCIA. Dois gestores no mesmo dia, ambos com o snapshot S0.
 *      O primeiro grava; o segundo tem de ser RECUSADO, com zero escritas.
 *      Last-write-wins aqui significa uma pessoa a aparecer numa equipa onde
 *      ninguém a pôs.
 *
 *   3. 🔴 HISTÓRICO. Remover alguém de uma equipa fecha a pertença com
 *      `left_at`; nunca apaga a linha. E mudar a equipa permanente NÃO destrói
 *      decisões diárias já tomadas para outros dias.
 *
 * Postgres 17 em Docker: é a versão de produção.
 */
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import pg from "pg";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

const ROOT = process.cwd();
const CONTAINER = `eq-r4-${process.pid}`;
let port = 0;
let pool: pg.Pool;

const docker = (a: string[]) => spawnSync("docker", a, { cwd: ROOT, encoding: "utf8" });
const MIGRATION = readFileSync(
  join(ROOT, "supabase", "migrations", "draft", "PROVISIONAL_equipas_r4.sql"), "utf8");

const EMP = "11111111-1111-4111-8111-111111111111";
const T1 = "aaaaaaaa-0000-4000-8000-000000000001";
const T2 = "aaaaaaaa-0000-4000-8000-000000000002";
const T3 = "aaaaaaaa-0000-4000-8000-000000000003";
const A = "bbbbbbbb-0000-4000-8000-00000000000a";
const B = "bbbbbbbb-0000-4000-8000-00000000000b";
const C = "bbbbbbbb-0000-4000-8000-00000000000c";
const GESTOR = "cccccccc-0000-4000-8000-000000000001";
const V1 = "dddddddd-0000-4000-8000-000000000001";
const V2 = "dddddddd-0000-4000-8000-000000000002";
const DIA = "2026-08-31";
const OUTRO_DIA = "2026-09-01";
const OUTRA_EMP = "22222222-2222-4222-8222-222222222222";
const OUTRO_COLAB = "eeeeeeee-0000-4000-8000-00000000000e";
const OUTRO_TEAM = "ffffffff-0000-4000-8000-000000000001";
const OUTRO_VEH = "99999999-0000-4000-8000-000000000001";

/** O prestate: 004 (teams/team_members), 016 (viaturas), 040 (overrides). */
const BASELINE = `
  DROP SCHEMA IF EXISTS public CASCADE;
  CREATE SCHEMA public;
  DO $p$ BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname='anon') THEN CREATE ROLE anon; END IF;
    IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname='authenticated') THEN CREATE ROLE authenticated; END IF;
    IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname='service_role') THEN CREATE ROLE service_role BYPASSRLS; END IF;
  END $p$;
  GRANT USAGE ON SCHEMA public TO anon, authenticated, service_role;

  CREATE TABLE public.companies (id uuid PRIMARY KEY, name text NOT NULL);
  CREATE TABLE public.profiles (
    id uuid PRIMARY KEY, company_id uuid NOT NULL, full_name text NOT NULL,
    role text DEFAULT 'colaborador', status text DEFAULT 'ativo', avatar_url text, phone text);
  CREATE TABLE public.teams (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    company_id uuid NOT NULL REFERENCES public.companies(id) ON DELETE CASCADE,
    name text NOT NULL, color text DEFAULT '#16A34A',
    leader_id uuid REFERENCES public.profiles(id) ON DELETE SET NULL,
    active boolean NOT NULL DEFAULT true,
    created_at timestamptz NOT NULL DEFAULT now(),
    updated_at timestamptz NOT NULL DEFAULT now());
  CREATE TABLE public.team_members (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    team_id uuid NOT NULL REFERENCES public.teams(id) ON DELETE CASCADE,
    collaborator_id uuid NOT NULL REFERENCES public.profiles(id) ON DELETE CASCADE,
    joined_at date DEFAULT CURRENT_DATE,
    left_at date,
    -- 🔴 A constraint da 004 que impede o histórico. A migration tem de a tirar.
    CONSTRAINT team_members_team_id_collaborator_id_key UNIQUE (team_id, collaborator_id));
  CREATE TABLE public.vehicles (
    id uuid PRIMARY KEY, company_id uuid NOT NULL, model text, plate text,
    status text DEFAULT 'ativo');
  CREATE TABLE public.vehicle_allocations (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    company_id uuid NOT NULL REFERENCES public.companies(id) ON DELETE CASCADE,
    vehicle_id uuid NOT NULL REFERENCES public.vehicles(id) ON DELETE CASCADE,
    team_id uuid NOT NULL REFERENCES public.teams(id) ON DELETE CASCADE,
    driver_id uuid REFERENCES public.profiles(id) ON DELETE SET NULL,
    date date NOT NULL,
    created_at timestamptz NOT NULL DEFAULT now(),
    updated_at timestamptz NOT NULL DEFAULT now(),
    CONSTRAINT vehicle_allocations_vehicle_date_unique UNIQUE (vehicle_id, date));
  CREATE TABLE public.collaborator_ride_assignments (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    company_id uuid NOT NULL REFERENCES public.companies(id) ON DELETE CASCADE,
    collaborator_id uuid NOT NULL REFERENCES public.profiles(id) ON DELETE CASCADE,
    team_id uuid NOT NULL REFERENCES public.teams(id) ON DELETE CASCADE,
    date date NOT NULL,
    assigned_by uuid REFERENCES public.profiles(id) ON DELETE SET NULL,
    created_at timestamptz NOT NULL DEFAULT now(),
    updated_at timestamptz NOT NULL DEFAULT now(),
    CONSTRAINT collaborator_ride_collaborator_date_unique UNIQUE (collaborator_id, date));
  CREATE TABLE public.absences (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    company_id uuid NOT NULL, collaborator_id uuid NOT NULL,
    absence_type text NOT NULL, starts_on date NOT NULL, ends_on date NOT NULL);
  CREATE TABLE public.services (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    company_id uuid NOT NULL, team_id uuid REFERENCES public.teams(id) ON DELETE SET NULL,
    scheduled_start timestamptz NOT NULL);

  -- A view da 010, tal como esta no master: e ela a definicao canonica de
  -- "membro ativo", e ja filtra left_at IS NULL. A migration acrescenta-lhe a
  -- revisao no fim.
  CREATE VIEW public.teams_with_members AS
  SELECT t.id, t.company_id, t.name, t.color, t.active, t.leader_id,
    COALESCE(json_agg(json_build_object('id', p.id, 'full_name', p.full_name,
      'avatar_url', p.avatar_url, 'phone', p.phone))
      FILTER (WHERE p.id IS NOT NULL), '[]') AS members
  FROM public.teams t
  LEFT JOIN public.team_members tm ON tm.team_id = t.id AND tm.left_at IS NULL
  LEFT JOIN public.profiles p ON p.id = tm.collaborator_id
  GROUP BY t.id, t.company_id, t.name, t.color, t.active, t.leader_id;
`;

const SEED = `
  INSERT INTO public.companies(id,name) VALUES('${EMP}','A');
  INSERT INTO public.profiles(id,company_id,full_name,role) VALUES
    ('${A}','${EMP}','Ana Alves','colaborador'),
    ('${B}','${EMP}','Bruna Barros','colaborador'),
    ('${C}','${EMP}','Carla Costa','colaborador'),
    ('${GESTOR}','${EMP}','Gestora','gestor');
  INSERT INTO public.teams(id,company_id,name) VALUES
    ('${T1}','${EMP}','Equipa 1'),('${T2}','${EMP}','Equipa 2'),('${T3}','${EMP}','Equipa 3');
  INSERT INTO public.vehicles(id,company_id,model,plate) VALUES
    ('${V1}','${EMP}','Kangoo','AA-01-AA'),('${V2}','${EMP}','Partner','BB-02-BB');
`;

async function esperar() {
  const limite = Date.now() + 90_000;
  while (Date.now() < limite) {
    if (docker(["exec", CONTAINER, "pg_isready", "-U", "postgres", "-d", "eq"]).status === 0) {
      const c = new pg.Client({ host: "127.0.0.1", port, user: "postgres", database: "eq" });
      try { await c.connect(); await c.query("SELECT 1"); await c.end(); return; }
      catch { try { await c.end(); } catch { /* nunca abriu */ } }
    }
    await new Promise((r) => setTimeout(r, 300));
  }
  throw new Error("PostgreSQL descartável não ficou pronto.");
}

beforeAll(async () => {
  docker(["rm", "-f", CONTAINER]);
  const up = docker(["run", "--rm", "-d", "--name", CONTAINER,
    "-e", "POSTGRES_HOST_AUTH_METHOD=trust", "-e", "POSTGRES_DB=eq",
    "-p", "127.0.0.1::5432", "postgres:17-alpine"]);
  if (up.status !== 0) throw new Error(up.stderr || up.stdout);
  const mapping = docker(["port", CONTAINER, "5432/tcp"]).stdout.trim();
  port = Number(mapping.slice(mapping.lastIndexOf(":") + 1));
  await esperar();
  pool = new pg.Pool({ host: "127.0.0.1", port, user: "postgres", database: "eq", max: 6 });
}, 180_000);

afterAll(async () => {
  try { await pool?.end(); } catch { /* já fechada */ }
  docker(["rm", "-f", CONTAINER]);
});

async function reset() {
  await pool.query(BASELINE);
  await pool.query(SEED);
  await pool.query(MIGRATION);
}

/** Pertença permanente ativa, pela definição canónica. */
async function ativos(teamId: string): Promise<string[]> {
  const { rows } = await pool.query(
    `SELECT collaborator_id FROM public.team_members
      WHERE team_id=$1 AND left_at IS NULL ORDER BY collaborator_id`, [teamId]);
  return rows.map((r: { collaborator_id: string }) => r.collaborator_id);
}

async function snapshot(data = DIA): Promise<string> {
  const { rows } = await pool.query("SELECT public.team_day_snapshot($1,$2) AS s", [EMP, data]);
  return rows[0].s as string;
}

async function membershipSnapshot(): Promise<string> {
  const { rows } = await pool.query("SELECT public.permanent_membership_snapshot($1) AS s", [EMP]);
  return rows[0].s as string;
}

async function efetiva(data = DIA) {
  const { rows } = await pool.query(
    `SELECT collaborator_id, effective_team_id, permanent_team_id, origem, ausente
       FROM public.team_day_effective($1,$2) ORDER BY collaborator_id`, [EMP, data]);
  return rows as Array<{
    collaborator_id: string; effective_team_id: string | null;
    permanent_team_id: string | null; origem: string; ausente: boolean;
  }>;
}

const guardarDia = (esperado: string, overrides: unknown[], viaturas: unknown[], data = DIA) =>
  pool.query(
    "SELECT * FROM public.save_team_day_allocations_atomic($1,$2,$3,$4,$5::jsonb,$6::jsonb)",
    [EMP, data, GESTOR, esperado, JSON.stringify(overrides), JSON.stringify(viaturas)]);

async function guardarEquipa(
  teamId: string | null, rev: number | null, esperados: string[],
  nome: string, membros: string[],
  expectedMembershipSnapshot?: string,
) {
  const expected = expectedMembershipSnapshot ?? await membershipSnapshot();
  return pool.query(
    "SELECT * FROM public.save_permanent_team_atomic($1,$2,$3,$4,$5::uuid[],$6,$7,$8,$9,$10,$11::uuid[])",
    [EMP, GESTOR, teamId, rev, esperados, expected, nome, "#16A34A", true, null, membros]);
}

async function backendPid(c: pg.PoolClient): Promise<number> {
  return Number((await c.query("SELECT pg_backend_pid() AS pid")).rows[0].pid);
}

async function esperarBloqueio(blockedPid: number, blockerPid: number) {
  const limite = Date.now() + 10_000;
  while (Date.now() < limite) {
    const { rows } = await pool.query("SELECT pg_blocking_pids($1) AS pids", [blockedPid]);
    const pids = rows[0].pids as number[];
    if (pids.includes(blockerPid)) return;
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error(`backend ${blockedPid} não ficou bloqueado por ${blockerPid}`);
}

// ═══════════════════════════════════════════════════════════════════════════

describe.sequential("Equipas R4 — o motor e a forma", () => {
  beforeEach(reset);

  it("🔴 corre em PostgreSQL 17, perguntado ao servidor", async () => {
    const { rows } = await pool.query("SELECT version() AS v");
    expect(rows[0].v).toMatch(/^PostgreSQL 17\./);
  });

  it("o ficheiro não abre nem fecha transação própria", () => {
    const linhas = MIGRATION.split("\n").map((l) => l.trim());
    expect(linhas.filter((l) => l === "BEGIN;")).toHaveLength(0);
    expect(linhas.filter((l) => l === "COMMIT;")).toHaveLength(0);
  });

  it("🔴 a constraint que impedia o histórico saiu, e a que impede duplicados entrou", async () => {
    const antiga = await pool.query(
      `SELECT count(*)::int n FROM pg_constraint
        WHERE conrelid='public.team_members'::regclass AND contype='u'
          AND pg_get_constraintdef(oid) LIKE '%(team_id, collaborator_id)%'`);
    expect(antiga.rows[0].n, "UNIQUE(team_id, collaborator_id) devia ter saído").toBe(0);

    const nova = await pool.query(
      "SELECT to_regclass('public.team_members_one_active_per_collaborator') AS reg");
    expect(nova.rows[0].reg).not.toBeNull();
  });

  it("🔴 uma pessoa não pode ter duas pertenças ATIVAS", async () => {
    await pool.query(
      "INSERT INTO public.team_members(team_id,collaborator_id) VALUES($1,$2)", [T1, A]);
    await expect(pool.query(
      "INSERT INTO public.team_members(team_id,collaborator_id) VALUES($1,$2)", [T2, A],
    )).rejects.toThrow(/team_members_one_active_per_collaborator|duplicate key/);
  });

  it("mas pode ter várias pertenças HISTÓRICAS à mesma equipa", async () => {
    // Saiu em Março, voltou em Setembro: são dois factos, e o índice antigo
    // obrigava a apagar o primeiro para registar o segundo.
    await pool.query(
      "INSERT INTO public.team_members(team_id,collaborator_id,joined_at,left_at) VALUES($1,$2,'2026-01-10','2026-03-31')", [T1, A]);
    await pool.query(
      "INSERT INTO public.team_members(team_id,collaborator_id,joined_at) VALUES($1,$2,'2026-09-01')", [T1, A]);
    const { rows } = await pool.query(
      "SELECT count(*)::int n FROM public.team_members WHERE team_id=$1 AND collaborator_id=$2", [T1, A]);
    expect(rows[0].n).toBe(2);
  });

  it("🔴 team_id do override passou a poder ser NULL — o stand by explícito", async () => {
    await pool.query(
      `INSERT INTO public.collaborator_ride_assignments(company_id,collaborator_id,team_id,date)
       VALUES($1,$2,NULL,$3)`, [EMP, A, DIA]);
    const { rows } = await pool.query(
      "SELECT team_id FROM public.collaborator_ride_assignments WHERE collaborator_id=$1", [A]);
    expect(rows[0].team_id).toBeNull();
  });
});

// ═══════════════════════════════════════════════════════════════════════════

describe.sequential("Equipas R4 — a regra de precedência do dia", () => {
  beforeEach(async () => {
    await reset();
    await pool.query(
      "INSERT INTO public.team_members(team_id,collaborator_id) VALUES($1,$2),($1,$3)", [T1, A, B]);
  });

  it("sem override: vale a equipa permanente", async () => {
    const e = await efetiva();
    const ana = e.find((r) => r.collaborator_id === A)!;
    expect(ana.effective_team_id).toBe(T1);
    expect(ana.origem).toBe("permanent");
  });

  it("override com equipa: vence a permanente naquele dia", async () => {
    await guardarDia(await snapshot(), [{ collaborator_id: A, team_id: T2 }], []);
    const e = await efetiva();
    const ana = e.find((r) => r.collaborator_id === A)!;
    expect(ana.effective_team_id).toBe(T2);
    expect(ana.permanent_team_id, "a permanente NÃO mudou").toBe(T1);
    expect(ana.origem).toBe("override_team");
  });

  it("🔴 override com NULL: stand by explícito, e continua na equipa permanente", async () => {
    await guardarDia(await snapshot(), [{ collaborator_id: A, team_id: null }], []);
    const e = await efetiva();
    const ana = e.find((r) => r.collaborator_id === A)!;
    expect(ana.effective_team_id).toBeNull();
    expect(ana.permanent_team_id, "não saiu da equipa").toBe(T1);
    expect(ana.origem).toBe("override_standby");
  });

  it("🔴 LINHA AUSENTE != LINHA COM NULL — as duas origens são distinguíveis", async () => {
    // Carla não tem equipa nenhuma e não tem override: `sem_equipa`.
    // Ana tem equipa e foi posta em stand by hoje: `override_standby`.
    // As duas aparecem em Disponível, e o modelo sabe porquê.
    await guardarDia(await snapshot(), [{ collaborator_id: A, team_id: null }], []);
    const e = await efetiva();
    expect(e.find((r) => r.collaborator_id === A)!.origem).toBe("override_standby");
    expect(e.find((r) => r.collaborator_id === C)!.origem).toBe("sem_equipa");
    // Ambas sem equipa efetiva — a superfície visual é a mesma.
    expect(e.find((r) => r.collaborator_id === A)!.effective_team_id).toBeNull();
    expect(e.find((r) => r.collaborator_id === C)!.effective_team_id).toBeNull();
  });

  it("🔴 no dia seguinte, sem override, volta à equipa permanente", async () => {
    await guardarDia(await snapshot(), [{ collaborator_id: A, team_id: null }], []);
    const amanha = await efetiva(OUTRO_DIA);
    const ana = amanha.find((r) => r.collaborator_id === A)!;
    expect(ana.effective_team_id).toBe(T1);
    expect(ana.origem).toBe("permanent");
  });

  it("🔴 uma pessoa ausente tem UMA representação efetiva, não três", async () => {
    // Não pode aparecer ao mesmo tempo como membro do dia, disponível e
    // ausente. A função devolve uma linha por pessoa, e `ausente` é um
    // atributo dessa linha — não uma quarta lista paralela.
    await pool.query(
      `INSERT INTO public.absences(company_id,collaborator_id,absence_type,starts_on,ends_on)
       VALUES($1,$2,'ferias',$3,$3)`, [EMP, B, DIA]);
    const e = await efetiva();
    const bruna = e.filter((r) => r.collaborator_id === B);
    expect(bruna).toHaveLength(1);
    expect(bruna[0].ausente).toBe(true);
    expect(bruna[0].permanent_team_id).toBe(T1);
  });
});

// ═══════════════════════════════════════════════════════════════════════════

describe.sequential("Equipas R4 — o save do dia é uma transação só", () => {
  beforeEach(async () => {
    await reset();
    await pool.query(
      "INSERT INTO public.team_members(team_id,collaborator_id) VALUES($1,$2),($1,$3)", [T1, A, B]);
  });

  it("pessoas e viaturas entram juntas", async () => {
    await guardarDia(await snapshot(),
      [{ collaborator_id: A, team_id: T2 }, { collaborator_id: B, team_id: null }],
      [{ team_id: T1, vehicle_id: V1, driver_id: null }]);

    const ov = await pool.query(
      "SELECT count(*)::int n FROM public.collaborator_ride_assignments WHERE date=$1", [DIA]);
    const ve = await pool.query(
      "SELECT count(*)::int n FROM public.vehicle_allocations WHERE date=$1", [DIA]);
    expect(ov.rows[0].n).toBe(2);
    expect(ve.rows[0].n).toBe(1);
  });

  it("🔴 se a viatura falhar, as pessoas também não entram", async () => {
    // Uma viatura de outra empresa viola a FK. O ponto é que a metade das
    // pessoas — que corre ANTES — tem de desaparecer com ela.
    const antes = await pool.query(
      "SELECT count(*)::int n FROM public.collaborator_ride_assignments WHERE date=$1", [DIA]);

    await expect(guardarDia(await snapshot(),
      [{ collaborator_id: A, team_id: T2 }],
      [{ team_id: T1, vehicle_id: "dddddddd-0000-4000-8000-0000000000ff", driver_id: null }],
    )).rejects.toThrow();

    const depois = await pool.query(
      "SELECT count(*)::int n FROM public.collaborator_ride_assignments WHERE date=$1", [DIA]);
    expect(depois.rows[0].n, "PARTIAL_WRITES tem de ser 0").toBe(antes.rows[0].n);
  });

  it("guardar sem um colaborador na lista remove o override DESSE dia", async () => {
    await guardarDia(await snapshot(), [{ collaborator_id: A, team_id: T2 }], []);
    await guardarDia(await snapshot(), [], []);
    const e = await efetiva();
    expect(e.find((r) => r.collaborator_id === A)!.origem).toBe("permanent");
  });

  it("🔴 e NÃO toca nos overrides de outros dias", async () => {
    await guardarDia(await snapshot(OUTRO_DIA), [{ collaborator_id: A, team_id: T3 }], [], OUTRO_DIA);
    await guardarDia(await snapshot(DIA), [{ collaborator_id: A, team_id: T2 }], [], DIA);
    await guardarDia(await snapshot(DIA), [], [], DIA);

    const amanha = await efetiva(OUTRO_DIA);
    expect(amanha.find((r) => r.collaborator_id === A)!.effective_team_id).toBe(T3);
  });
});

// ═══════════════════════════════════════════════════════════════════════════

describe.sequential("🔴 Equipas R4 — dois gestores no mesmo dia", () => {
  beforeEach(async () => {
    await reset();
    await pool.query(
      "INSERT INTO public.team_members(team_id,collaborator_id) VALUES($1,$2),($1,$3)", [T1, A, B]);
  });

  it("o segundo save, baseado no snapshot antigo, é RECUSADO", async () => {
    // Ambos abrem o dia e recebem S0.
    const s0 = await snapshot();

    // A grava.
    await guardarDia(s0, [{ collaborator_id: A, team_id: T2 }], []);
    const s1 = await snapshot();
    expect(s1).not.toBe(s0);

    // B tenta gravar ainda com S0.
    await expect(guardarDia(s0, [{ collaborator_id: B, team_id: T3 }], []))
      .rejects.toThrow(/TEAM_ALLOCATION_CONFLICT/);

    // 🔴 E não escreveu nada: o estado é o que A deixou.
    expect(await snapshot()).toBe(s1);
    const e = await efetiva();
    expect(e.find((r) => r.collaborator_id === A)!.effective_team_id).toBe(T2);
    expect(e.find((r) => r.collaborator_id === B)!.effective_team_id).toBe(T1);
  });

  it("depois de reler, o segundo save passa", async () => {
    const s0 = await snapshot();
    await guardarDia(s0, [{ collaborator_id: A, team_id: T2 }], []);
    // B atualiza e volta a tentar — agora com o snapshot verdadeiro.
    await guardarDia(await snapshot(), [
      { collaborator_id: A, team_id: T2 },
      { collaborator_id: B, team_id: T3 },
    ], []);
    const e = await efetiva();
    expect(e.find((r) => r.collaborator_id === B)!.effective_team_id).toBe(T3);
  });

  it("🔴 o lock é por empresa+DATA: dois dias diferentes não se bloqueiam", async () => {
    // Se o lock fosse só por empresa, editar hoje impediria editar amanhã sem
    // razão nenhuma. As duas transações abaixo correm em paralelo e as duas
    // têm de terminar.
    const a = await pool.connect();
    const b = await pool.connect();
    try {
      const sHoje = await snapshot(DIA);
      const sAmanha = await snapshot(OUTRO_DIA);

      await a.query("BEGIN");
      await a.query(
        "SELECT * FROM public.save_team_day_allocations_atomic($1,$2,$3,$4,$5::jsonb,'[]'::jsonb)",
        [EMP, DIA, GESTOR, sHoje, JSON.stringify([{ collaborator_id: A, team_id: T2 }])]);

      // B, noutro dia, não pode ficar à espera de A.
      await b.query("BEGIN");
      const feito = await Promise.race([
        b.query(
          "SELECT * FROM public.save_team_day_allocations_atomic($1,$2,$3,$4,$5::jsonb,'[]'::jsonb)",
          [EMP, OUTRO_DIA, GESTOR, sAmanha, JSON.stringify([{ collaborator_id: B, team_id: T3 }])],
        ).then(() => "passou"),
        new Promise((r) => setTimeout(() => r("bloqueou"), 4000)),
      ]);
      expect(feito, "o dia seguinte não devia esperar pelo dia de hoje").toBe("passou");

      await a.query("COMMIT");
      await b.query("COMMIT");
    } finally {
      try { await a.query("ROLLBACK"); } catch { /* já terminou */ }
      try { await b.query("ROLLBACK"); } catch { /* já terminou */ }
      a.release(); b.release();
    }
  }, 60_000);

  it("🔴 e o MESMO dia serializa-se — o segundo espera e depois recusa", async () => {
    const a = await pool.connect();
    const b = await pool.connect();
    try {
      const s0 = await snapshot();
      await a.query("BEGIN");
      await a.query(
        "SELECT * FROM public.save_team_day_allocations_atomic($1,$2,$3,$4,$5::jsonb,'[]'::jsonb)",
        [EMP, DIA, GESTOR, s0, JSON.stringify([{ collaborator_id: A, team_id: T2 }])]);

      const bPromise = b.query(
        "SELECT * FROM public.save_team_day_allocations_atomic($1,$2,$3,$4,$5::jsonb,'[]'::jsonb)",
        [EMP, DIA, GESTOR, s0, JSON.stringify([{ collaborator_id: B, team_id: T3 }])],
      ).then(() => "escreveu").catch((e: Error) => e.message);

      await a.query("COMMIT");
      expect(await bPromise).toMatch(/TEAM_ALLOCATION_CONFLICT/);
    } finally {
      try { await a.query("ROLLBACK"); } catch { /* já terminou */ }
      try { await b.query("ROLLBACK"); } catch { /* já terminou */ }
      a.release(); b.release();
    }
  }, 60_000);
});

// ═══════════════════════════════════════════════════════════════════════════

describe.sequential("🔴 Equipas R4 — lock comum daily/permanente", () => {
  beforeEach(async () => {
    await reset();
    await pool.query(
      "INSERT INTO public.team_members(team_id,collaborator_id) VALUES($1,$2),($1,$3)", [T1, A, B]);
  });

  it("daily com shared TEAM_CONFIG_LOCK faz o save permanente esperar", async () => {
    const daily = await pool.connect();
    const permanent = await pool.connect();
    try {
      const dailyPid = await backendPid(daily);
      const permanentPid = await backendPid(permanent);
      const s0 = await snapshot();
      const ms0 = await membershipSnapshot();
      const revT2 = (await pool.query("SELECT revision FROM public.teams WHERE id=$1", [T2])).rows[0].revision;

      await daily.query("BEGIN");
      await daily.query(
        "SELECT * FROM public.save_team_day_allocations_atomic($1,$2,$3,$4,$5::jsonb,'[]'::jsonb)",
        [EMP, DIA, GESTOR, s0, JSON.stringify([{ collaborator_id: A, team_id: T2 }])]);

      await permanent.query("BEGIN");
      const permanentSave = permanent.query(
        "SELECT * FROM public.save_permanent_team_atomic($1,$2,$3,$4,$5::uuid[],$6,$7,$8,$9,$10,$11::uuid[])",
        [EMP, GESTOR, T2, revT2, [], ms0, "Equipa 2", "#16A34A", true, null, [C]],
      );
      await esperarBloqueio(permanentPid, dailyPid);

      await daily.query("COMMIT");
      await permanentSave;
      await permanent.query("COMMIT");

      expect(await ativos(T2)).toEqual([C]);
    } finally {
      try { await daily.query("ROLLBACK"); } catch { /* já terminou */ }
      try { await permanent.query("ROLLBACK"); } catch { /* já terminou */ }
      daily.release();
      permanent.release();
    }
  }, 60_000);

  it("permanente com exclusive TEAM_CONFIG_LOCK faz daily esperar e depois recusar stale", async () => {
    const permanent = await pool.connect();
    const daily = await pool.connect();
    try {
      const permanentPid = await backendPid(permanent);
      const dailyPid = await backendPid(daily);
      const staleDaySnapshot = await snapshot();
      const revT2 = (await pool.query("SELECT revision FROM public.teams WHERE id=$1", [T2])).rows[0].revision;

      await permanent.query("BEGIN");
      await permanent.query(
        "SELECT * FROM public.save_permanent_team_atomic($1,$2,$3,$4,$5::uuid[],$6,$7,$8,$9,$10,$11::uuid[])",
        [EMP, GESTOR, T2, revT2, [], await membershipSnapshot(), "Equipa 2", "#16A34A", true, null, [A]]);

      await daily.query("BEGIN");
      const dailySave = daily.query(
        "SELECT * FROM public.save_team_day_allocations_atomic($1,$2,$3,$4,$5::jsonb,$6::jsonb)",
        [EMP, DIA, GESTOR, staleDaySnapshot, JSON.stringify([{ collaborator_id: B, team_id: T3 }]), "[]"],
      ).then(() => "escreveu").catch((e: Error) => e.message);
      await esperarBloqueio(dailyPid, permanentPid);

      await permanent.query("COMMIT");
      expect(await dailySave).toMatch(/TEAM_ALLOCATION_CONFLICT/);
      await daily.query("ROLLBACK");

      const ov = await pool.query(
        "SELECT count(*)::int n FROM public.collaborator_ride_assignments WHERE company_id=$1 AND date=$2",
        [EMP, DIA]);
      const ve = await pool.query(
        "SELECT count(*)::int n FROM public.vehicle_allocations WHERE company_id=$1 AND date=$2",
        [EMP, DIA]);
      expect(ov.rows[0].n).toBe(0);
      expect(ve.rows[0].n).toBe(0);
      expect(await ativos(T2)).toEqual([A]);
    } finally {
      try { await permanent.query("ROLLBACK"); } catch { /* já terminou */ }
      try { await daily.query("ROLLBACK"); } catch { /* já terminou */ }
      permanent.release();
      daily.release();
    }
  }, 60_000);
});

// ═══════════════════════════════════════════════════════════════════════════

describe.sequential("🔴 Equipas R4 — o bug do proprietário, no lado da base", () => {
  beforeEach(async () => {
    await reset();
    await pool.query(
      "INSERT INTO public.team_members(team_id,collaborator_id) VALUES($1,$2),($1,$3)", [T1, A, B]);
  });

  it("remover B da Equipa 1: A fica ativa, B é ENCERRADA, histórico preservado", async () => {
    expect(await ativos(T1)).toEqual([A, B].sort());

    const { rows } = await pool.query("SELECT revision FROM public.teams WHERE id=$1", [T1]);
    await guardarEquipa(T1, rows[0].revision, [A, B].sort(), "Equipa 1", [A]);

    // Pertença ativa: só A.
    expect(await ativos(T1)).toEqual([A]);

    // 🔴 A linha de B continua lá, encerrada. Não foi apagada.
    const hist = await pool.query(
      "SELECT left_at FROM public.team_members WHERE team_id=$1 AND collaborator_id=$2", [T1, B]);
    expect(hist.rowCount, "a linha histórica de B tem de existir").toBe(1);
    expect(hist.rows[0].left_at).not.toBeNull();
  });

  it("🔴 e no calendário, num dia sem override, B passa a Disponível", async () => {
    const { rows } = await pool.query("SELECT revision FROM public.teams WHERE id=$1", [T1]);
    await guardarEquipa(T1, rows[0].revision, [A, B].sort(), "Equipa 1", [A]);

    const e = await efetiva();
    expect(e.find((r) => r.collaborator_id === A)!.effective_team_id).toBe(T1);
    const bruna = e.find((r) => r.collaborator_id === B)!;
    expect(bruna.effective_team_id).toBeNull();
    expect(bruna.origem).toBe("sem_equipa");
  });

  it("🔴 mas um override diário DELIBERADO sobrevive à remoção permanente", async () => {
    // B sai da Equipa 1 permanentemente, mas amanhã já estava decidido que
    // trabalha com a Equipa 3. Essa decisão é daquele dia e continua válida.
    await guardarDia(await snapshot(OUTRO_DIA), [{ collaborator_id: B, team_id: T3 }], [], OUTRO_DIA);

    const { rows } = await pool.query("SELECT revision FROM public.teams WHERE id=$1", [T1]);
    await guardarEquipa(T1, rows[0].revision, [A, B].sort(), "Equipa 1", [A]);

    const amanha = await efetiva(OUTRO_DIA);
    expect(amanha.find((r) => r.collaborator_id === B)!.effective_team_id,
      "a decisão de amanhã não podia ser apagada").toBe(T3);

    const hoje = await efetiva(DIA);
    expect(hoje.find((r) => r.collaborator_id === B)!.effective_team_id).toBeNull();
  });

  it("voltar a acrescentar B cria uma pertença NOVA, sem apagar a antiga", async () => {
    const r1 = await pool.query("SELECT revision FROM public.teams WHERE id=$1", [T1]);
    await guardarEquipa(T1, r1.rows[0].revision, [A, B].sort(), "Equipa 1", [A]);
    const r2 = await pool.query("SELECT revision FROM public.teams WHERE id=$1", [T1]);
    await guardarEquipa(T1, r2.rows[0].revision, [A], "Equipa 1", [A, B]);

    expect(await ativos(T1)).toEqual([A, B].sort());
    const linhas = await pool.query(
      "SELECT count(*)::int n FROM public.team_members WHERE team_id=$1 AND collaborator_id=$2", [T1, B]);
    expect(linhas.rows[0].n, "duas pertenças: a encerrada e a nova").toBe(2);
  });

  it("mudar de equipa encerra a anterior — nunca duas ativas", async () => {
    const r = await pool.query("SELECT revision FROM public.teams WHERE id=$1", [T2]);
    await guardarEquipa(T2, r.rows[0].revision, [], "Equipa 2", [A]);
    expect(await ativos(T1)).toEqual([B]);
    expect(await ativos(T2)).toEqual([A]);
  });
});

// ═══════════════════════════════════════════════════════════════════════════

describe.sequential("🔴 Equipas R4 — concorrência na equipa permanente", () => {
  beforeEach(async () => {
    await reset();
    await pool.query(
      "INSERT INTO public.team_members(team_id,collaborator_id) VALUES($1,$2),($1,$3)", [T1, A, B]);
  });

  it("revisão desatualizada: TEAM_SAVE_CONFLICT e zero escritas", async () => {
    const r0 = (await pool.query("SELECT revision FROM public.teams WHERE id=$1", [T1])).rows[0].revision;
    await guardarEquipa(T1, r0, [A, B].sort(), "Equipa 1 renomeada", [A, B]);

    await expect(guardarEquipa(T1, r0, [A, B].sort(), "Outro nome", [A]))
      .rejects.toThrow(/TEAM_SAVE_CONFLICT/);

    const t = await pool.query("SELECT name FROM public.teams WHERE id=$1", [T1]);
    expect(t.rows[0].name).toBe("Equipa 1 renomeada");
    expect(await ativos(T1)).toEqual([A, B].sort());
  });

  it("🔴 revisão certa mas membros mudados por outra pessoa: também recusa", async () => {
    // A revisão sozinha não chega — `team_members` muda sem tocar em `teams`.
    const r0 = (await pool.query("SELECT revision FROM public.teams WHERE id=$1", [T1])).rows[0].revision;
    await pool.query(
      "INSERT INTO public.team_members(team_id,collaborator_id) VALUES($1,$2)", [T1, C]);

    await expect(guardarEquipa(T1, r0, [A, B].sort(), "Equipa 1", [A]))
      .rejects.toThrow(/TEAM_SAVE_CONFLICT/);
    expect(await ativos(T1)).toEqual([A, B, C].sort());
  });

  it("um UPDATE que não muda nada não faz a revisão avançar", async () => {
    // Senão, quem estivesse a editar perderia o token por causa de um save
    // que não alterou coisa nenhuma.
    const r0 = (await pool.query("SELECT revision FROM public.teams WHERE id=$1", [T1])).rows[0].revision;
    await pool.query("UPDATE public.teams SET name = name WHERE id=$1", [T1]);
    const r1 = (await pool.query("SELECT revision FROM public.teams WHERE id=$1", [T1])).rows[0].revision;
    expect(r1).toBe(r0);
  });

  it("criar equipa nova não exige revisão", async () => {
    const r = await guardarEquipa(null, null, [], "Equipa 4", [C]);
    expect(r.rows[0].out_team_id).toBeTruthy();
    expect(await ativos(r.rows[0].out_team_id)).toEqual([C]);
  });

  it("um membro de outra empresa é recusado pela RPC", async () => {
    await pool.query(
      "INSERT INTO public.companies(id,name) VALUES('22222222-2222-4222-8222-222222222222','B')");
    await pool.query(
      `INSERT INTO public.profiles(id,company_id,full_name) VALUES
       ('eeeeeeee-0000-4000-8000-00000000000e','22222222-2222-4222-8222-222222222222','Estranha')`);
    const r0 = (await pool.query("SELECT revision FROM public.teams WHERE id=$1", [T1])).rows[0].revision;
    await expect(guardarEquipa(T1, r0, [A, B].sort(), "Equipa 1",
      [A, "eeeeeeee-0000-4000-8000-00000000000e"]))
      .rejects.toThrow(/TEAM_MEMBER_NOT_ACTIVE_COLLABORATOR/);
  });

  it("🔴 duas conexões: stale cross-team não move a pessoa silenciosamente", async () => {
    const g1 = await pool.connect();
    const g2 = await pool.connect();
    try {
      const s0 = await membershipSnapshot();
      const rB = (await pool.query("SELECT revision FROM public.teams WHERE id=$1", [T2])).rows[0].revision;
      const rC = (await pool.query("SELECT revision FROM public.teams WHERE id=$1", [T3])).rows[0].revision;

      await g1.query(
        "SELECT * FROM public.save_permanent_team_atomic($1,$2,$3,$4,$5::uuid[],$6,$7,$8,$9,$10,$11::uuid[])",
        [EMP, GESTOR, T2, rB, [], s0, "Equipa 2", "#16A34A", true, null, [A]]);

      await expect(g2.query(
        "SELECT * FROM public.save_permanent_team_atomic($1,$2,$3,$4,$5::uuid[],$6,$7,$8,$9,$10,$11::uuid[])",
        [EMP, GESTOR, T3, rC, [], s0, "Equipa 3", "#16A34A", true, null, [A]],
      )).rejects.toThrow(/TEAM_SAVE_CONFLICT/);

      expect(await ativos(T2)).toEqual([A]);
      expect(await ativos(T3)).toEqual([]);

      const rC2 = (await pool.query("SELECT revision FROM public.teams WHERE id=$1", [T3])).rows[0].revision;
      await g2.query(
        "SELECT * FROM public.save_permanent_team_atomic($1,$2,$3,$4,$5::uuid[],$6,$7,$8,$9,$10,$11::uuid[])",
        [EMP, GESTOR, T3, rC2, [], await membershipSnapshot(), "Equipa 3", "#16A34A", true, null, [A]]);
      expect(await ativos(T2)).toEqual([]);
      expect(await ativos(T3)).toEqual([A]);
    } finally {
      g1.release();
      g2.release();
    }
  });
});

// ═══════════════════════════════════════════════════════════════════════════

describe.sequential("🔴 Equipas R4 — arquivar, não apagar", () => {
  beforeEach(async () => {
    await reset();
    await pool.query(
      "INSERT INTO public.team_members(team_id,collaborator_id) VALUES($1,$2),($1,$3)", [T1, A, B]);
  });

  it("arquivar desativa a equipa e encerra as pertenças, sem destruir nada", async () => {
    await pool.query("SELECT * FROM public.archive_team_atomic($1,$2,$3)", [EMP, GESTOR, T1]);

    const t = await pool.query("SELECT active FROM public.teams WHERE id=$1", [T1]);
    expect(t.rows[0].active).toBe(false);
    expect(await ativos(T1)).toEqual([]);

    // 🔴 As linhas continuam lá. Um `DELETE FROM teams` levaria o histórico
    //    todo atrás pelo CASCADE — é isso que esta RPC substitui.
    const hist = await pool.query(
      "SELECT count(*)::int n FROM public.team_members WHERE team_id=$1", [T1]);
    expect(hist.rows[0].n).toBe(2);
  });

  it("e quem lá estava passa a Disponível no calendário", async () => {
    await pool.query("SELECT * FROM public.archive_team_atomic($1,$2,$3)", [EMP, GESTOR, T1]);
    const e = await efetiva();
    expect(e.find((r) => r.collaborator_id === A)!.effective_team_id).toBeNull();
    expect(e.find((r) => r.collaborator_id === A)!.origem).toBe("sem_equipa");
  });
});

// ═══════════════════════════════════════════════════════════════════════════

describe.sequential("Equipas R4 — precondições fail-closed", () => {
  it("🔴 duas pertenças ativas antes da migration: recusa, com contagem", async () => {
    await pool.query(BASELINE);
    await pool.query(SEED);
    await pool.query(
      "INSERT INTO public.team_members(team_id,collaborator_id) VALUES($1,$3),($2,$3)", [T1, T2, A]);
    await expect(pool.query(MIGRATION))
      .rejects.toThrow(/EQUIPAS_R4_DUPLICATE_ACTIVE_MEMBERSHIP/);
  }, 60_000);

  it("🔴 sem a identidade (collaborator_id, date): recusa", async () => {
    await pool.query(BASELINE);
    await pool.query(SEED);
    await pool.query(
      "ALTER TABLE public.collaborator_ride_assignments DROP CONSTRAINT collaborator_ride_collaborator_date_unique");
    await expect(pool.query(MIGRATION))
      .rejects.toThrow(/EQUIPAS_R4_MISSING_RIDE_IDENTITY/);
  }, 60_000);

  it("🔴 teams.revision com outro tipo: recusa", async () => {
    await pool.query(BASELINE);
    await pool.query(SEED);
    await pool.query("ALTER TABLE public.teams ADD COLUMN revision text");
    await expect(pool.query(MIGRATION))
      .rejects.toThrow(/EQUIPAS_R4_UNEXPECTED_TEAMS_REVISION/);
  }, 60_000);

  it("🔴 teams.revision já presente sem mecanismo conhecido: recusa", async () => {
    await pool.query(BASELINE);
    await pool.query(SEED);
    await pool.query("ALTER TABLE public.teams ADD COLUMN revision integer NOT NULL DEFAULT 1");
    await expect(pool.query(MIGRATION)).rejects.toThrow(/EQUIPAS_R4_UNEXPECTED_REVISION_STATE/);
  }, 60_000);

  it("🔴 production legacy revision é adotado sem resetar valores", async () => {
    await pool.query(BASELINE);
    await pool.query(SEED);
    await pool.query(`
      ALTER TABLE public.teams ADD COLUMN revision integer NOT NULL DEFAULT 1;
      UPDATE public.teams SET revision = 5 WHERE id='${T1}';
      CREATE OR REPLACE FUNCTION public.fn_increment_revision()
      RETURNS trigger LANGUAGE plpgsql AS $fn$
      BEGIN
        NEW.revision := COALESCE(OLD.revision, 0) + 1;
        RETURN NEW;
      END
      $fn$;
      CREATE TRIGGER trg_teams_revision
        BEFORE UPDATE ON public.teams
        FOR EACH ROW EXECUTE FUNCTION public.fn_increment_revision();`);
    await pool.query(MIGRATION);
    const r = await pool.query("SELECT revision FROM public.teams WHERE id=$1", [T1]);
    expect(r.rows[0].revision).toBe(5);
    await pool.query("UPDATE public.teams SET name = 'Equipa 1x' WHERE id=$1", [T1]);
    const r2 = await pool.query("SELECT revision FROM public.teams WHERE id=$1", [T1]);
    expect(r2.rows[0].revision).toBe(6);
    await pool.query("UPDATE public.teams SET name = name WHERE id=$1", [T1]);
    const r3 = await pool.query("SELECT revision FROM public.teams WHERE id=$1", [T1]);
    expect(r3.rows[0].revision).toBe(6);
    const trg = await pool.query(`
      SELECT count(*)::int n FROM pg_trigger t
       WHERE t.tgrelid='public.teams'::regclass
         AND NOT t.tgisinternal
         AND t.tgname ILIKE '%revision%'`);
    expect(trg.rows[0].n).toBe(1);
  }, 60_000);

  it("🔴 legacy revision adulterado é recusado antes de alterar", async () => {
    await pool.query(BASELINE);
    await pool.query(SEED);
    await pool.query(`
      ALTER TABLE public.teams ADD COLUMN revision integer NOT NULL DEFAULT 1;
      CREATE OR REPLACE FUNCTION public.fn_increment_revision()
      RETURNS trigger LANGUAGE plpgsql AS $fn$
      BEGIN
        NEW.revision := 99;
        RETURN NEW;
      END
      $fn$;
      CREATE TRIGGER trg_teams_revision
        BEFORE UPDATE ON public.teams
        FOR EACH ROW EXECUTE FUNCTION public.fn_increment_revision();`);
    await expect(pool.query(MIGRATION)).rejects.toThrow(/EQUIPAS_R4_UNEXPECTED_REVISION_STATE/);
    const still = await pool.query("SELECT to_regprocedure('public.fn_teams_bump_revision()') AS r4");
    expect(still.rows[0].r4).toBeNull();
  }, 60_000);

  it("reaplicar a migration é seguro", async () => {
    await reset();
    await pool.query(MIGRATION);
    const idx = await pool.query(
      "SELECT to_regclass('public.team_members_one_active_per_collaborator') AS reg");
    expect(idx.rows[0].reg).not.toBeNull();
  }, 60_000);
});

describe.sequential("🔴 Equipas R4 — guardas adicionais pedidas pela direção", () => {
  beforeEach(async () => {
    await reset();
    await pool.query(
      "INSERT INTO public.team_members(team_id,collaborator_id) VALUES($1,$2),($1,$3)", [T1, A, B]);
  });

  it("admin ativo não entra na equipa efetiva nem pode ser membro permanente", async () => {
    const e = await efetiva();
    expect(e.some((r) => r.collaborator_id === GESTOR)).toBe(false);
    const r0 = (await pool.query("SELECT revision FROM public.teams WHERE id=$1", [T1])).rows[0].revision;
    await expect(guardarEquipa(T1, r0, [A, B].sort(), "Equipa 1", [A, GESTOR]))
      .rejects.toThrow(/TEAM_MEMBER_NOT_ACTIVE_COLLABORATOR/);
  });

  it("payload cross-tenant de override é recusado e não escreve", async () => {
    await pool.query(`
      INSERT INTO public.companies(id,name) VALUES('${OUTRA_EMP}','B');
      INSERT INTO public.profiles(id,company_id,full_name,role,status)
        VALUES('${OUTRO_COLAB}','${OUTRA_EMP}','Outra','colaborador','ativo');`);
    const s0 = await snapshot();
    await expect(guardarDia(s0, [{ collaborator_id: OUTRO_COLAB, team_id: T1 }], []))
      .rejects.toThrow(/TEAM_ALLOCATION_INVALID_COLLABORATOR/);
    expect(await snapshot()).toBe(s0);
  });

  it("payload cross-tenant de team/vehicle/driver é recusado", async () => {
    await pool.query(`
      INSERT INTO public.companies(id,name) VALUES('${OUTRA_EMP}','B');
      INSERT INTO public.profiles(id,company_id,full_name,role,status)
        VALUES('${OUTRO_COLAB}','${OUTRA_EMP}','Outra','colaborador','ativo');
      INSERT INTO public.teams(id,company_id,name) VALUES('${OUTRO_TEAM}','${OUTRA_EMP}','Outra equipa');
      INSERT INTO public.vehicles(id,company_id,model,plate,status)
        VALUES('${OUTRO_VEH}','${OUTRA_EMP}','Outra','ZZ','ativo');`);
    const s0 = await snapshot();
    await expect(guardarDia(s0, [], [{ team_id: OUTRO_TEAM, vehicle_id: V1, driver_id: null }]))
      .rejects.toThrow(/TEAM_ALLOCATION_INVALID_VEHICLE_PAYLOAD/);
    await expect(guardarDia(s0, [], [{ team_id: T1, vehicle_id: OUTRO_VEH, driver_id: null }]))
      .rejects.toThrow(/TEAM_ALLOCATION_INVALID_VEHICLE_PAYLOAD/);
    await expect(guardarDia(s0, [], [{ team_id: T1, vehicle_id: V1, driver_id: OUTRO_COLAB }]))
      .rejects.toThrow(/TEAM_ALLOCATION_INVALID_VEHICLE_PAYLOAD/);
  });

  it("condutor tem de pertencer à equipa efetiva desejada", async () => {
    const s0 = await snapshot();
    await expect(guardarDia(s0, [], [{ team_id: T2, vehicle_id: V1, driver_id: A }]))
      .rejects.toThrow(/TEAM_ALLOCATION_DRIVER_NOT_IN_TEAM/);
  });

  it("mudança permanente noutra superfície invalida o snapshot do dia", async () => {
    const s0 = await snapshot();
    const r0 = (await pool.query("SELECT revision FROM public.teams WHERE id=$1", [T1])).rows[0].revision;
    await guardarEquipa(T1, r0, [A, B].sort(), "Equipa 1", [A]);
    await expect(guardarDia(s0, [], []))
      .rejects.toThrow(/TEAM_ALLOCATION_CONFLICT/);
  });

  it("ausência criada durante edição invalida o snapshot do dia", async () => {
    const s0 = await snapshot();
    await pool.query(
      `INSERT INTO public.absences(company_id,collaborator_id,absence_type,starts_on,ends_on)
       VALUES($1,$2,'ferias',$3,$3)`, [EMP, A, DIA]);
    await expect(guardarDia(s0, [], []))
      .rejects.toThrow(/TEAM_ALLOCATION_CONFLICT/);
  });

  it("trocar Team1 de V1 para V2 deixa exatamente uma viatura", async () => {
    await guardarDia(await snapshot(), [], [{ team_id: T1, vehicle_id: V1, driver_id: null }]);
    await guardarDia(await snapshot(), [], [{ team_id: T1, vehicle_id: V2, driver_id: null }]);
    const rows = await pool.query(
      "SELECT vehicle_id FROM public.vehicle_allocations WHERE company_id=$1 AND date=$2 AND team_id=$3",
      [EMP, DIA, T1]);
    expect(rows.rows.map((r: { vehicle_id: string }) => r.vehicle_id)).toEqual([V2]);
  });

  it("payload com viatura duplicada e team duplicado é recusado", async () => {
    const s0 = await snapshot();
    await expect(guardarDia(s0, [], [
      { team_id: T1, vehicle_id: V1, driver_id: null },
      { team_id: T2, vehicle_id: V1, driver_id: null },
    ])).rejects.toThrow(/TEAM_ALLOCATION_DUPLICATE_VEHICLE/);
    await expect(guardarDia(s0, [], [
      { team_id: T1, vehicle_id: V1, driver_id: null },
      { team_id: T1, vehicle_id: V2, driver_id: null },
    ])).rejects.toThrow(/TEAM_ALLOCATION_DUPLICATE_TEAM_VEHICLE/);
  });

  it("archive bloqueia serviço futuro e preserva serviço passado", async () => {
    await pool.query(
      "INSERT INTO public.services(company_id,team_id,scheduled_start) VALUES($1,$2,'2020-01-01T09:00:00Z')",
      [EMP, T1]);
    await pool.query("SELECT * FROM public.archive_team_atomic($1,$2,$3)", [EMP, GESTOR, T1]);
    const past = await pool.query("SELECT team_id FROM public.services WHERE company_id=$1", [EMP]);
    expect(past.rows[0].team_id).toBe(T1);

    await reset();
    await pool.query("INSERT INTO public.team_members(team_id,collaborator_id) VALUES($1,$2)", [T1, A]);
    await pool.query(
      "INSERT INTO public.services(company_id,team_id,scheduled_start) VALUES($1,$2,'2099-01-01T09:00:00Z')",
      [EMP, T1]);
    await expect(pool.query("SELECT * FROM public.archive_team_atomic($1,$2,$3)", [EMP, GESTOR, T1]))
      .rejects.toThrow(/TEAM_ARCHIVE_BLOCKED_BY_FUTURE_ASSIGNMENTS/);
    expect((await pool.query("SELECT active FROM public.teams WHERE id=$1", [T1])).rows[0].active).toBe(true);
  });
});

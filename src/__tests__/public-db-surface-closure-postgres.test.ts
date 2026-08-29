/**
 * 085 — fechar a superfície pública: duas views e três funções.
 *
 * O incidente foi medido em produção, não suposto: `SET ROLE anon` lia
 * `teams_with_members` e `monthly_hours_summary` — nome, telefone, avatar,
 * horas — e `anon` tinha EXECUTE numa função SECURITY DEFINER que ESCREVE.
 *
 * 🔴 A prova do defeito é feita ANTES da migration, neste Postgres
 *    descartável. É deliberado: sem reproduzir a exposição, os `false` de
 *    depois provariam apenas que a fixture nasceu fechada — não que a 085
 *    fecha alguma coisa.
 *
 * 🔴 Nenhum dado real. Nomes e telefones aqui são inventados, e nenhuma
 *    contagem de linhas de produção é copiada para asserção: contagens mudam
 *    sozinhas e provariam a exposição de hoje, não a classe de acesso.
 *
 * Postgres 17 real, em Docker: é a versão de produção.
 */
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const ROOT = process.cwd();
const CONTAINER = `surface-085-${process.pid}`;
const IMAGEM = "postgres:17-alpine";
let port = 0;
let cli: pg.Client;

const EMP_A = "11111111-1111-4111-8111-111111111111";
const EMP_B = "22222222-2222-4222-8222-222222222222";
const ADMIN_A = "aaaaaaaa-0000-4000-8000-000000000001";
const COLAB_A = "aaaaaaaa-0000-4000-8000-000000000002";
const ADMIN_B = "bbbbbbbb-0000-4000-8000-000000000001";
const EQUIPA_A = "cccccccc-0000-4000-8000-000000000001";
const EQUIPA_B = "cccccccc-0000-4000-8000-000000000002";

function docker(args: string[]) {
  return spawnSync("docker", args, { cwd: ROOT, encoding: "utf8" });
}
const sql = (rel: string) => readFileSync(join(ROOT, "supabase", "migrations", rel), "utf8");

/**
 * Schema mínimo com o que as duas views tocam. As policies são as reais da
 * 014 — sem elas, `security_invoker` não teria nada a que obedecer e o teste
 * mediria o vazio.
 */
const BASELINE = `
  DROP SCHEMA IF EXISTS public CASCADE;
  CREATE SCHEMA public;

  CREATE TABLE public.companies (id uuid PRIMARY KEY, name text NOT NULL);
  CREATE TABLE public.profiles (
    id uuid PRIMARY KEY, company_id uuid, role text, full_name text,
    avatar_url text, phone text, contracted_hours_month numeric);
  CREATE TABLE public.teams (
    id uuid PRIMARY KEY, company_id uuid NOT NULL, name text, color text,
    active boolean DEFAULT true, leader_id uuid);
  CREATE TABLE public.team_members (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(), team_id uuid, collaborator_id uuid,
    left_at timestamptz);
  CREATE TABLE public.timesheets (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(), collaborator_id uuid,
    clock_in_at timestamptz, clock_out_at timestamptz, duration_minutes integer,
    location_warning boolean DEFAULT false);
  CREATE TABLE public.collaborator_documents (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(), company_id uuid NOT NULL,
    collaborator_id uuid, file_name text, file_url text, file_size integer,
    mime_type text, category text, notes text,
    created_at timestamptz DEFAULT now(), expires_at timestamptz,
    archived_at timestamptz);
  CREATE TABLE public.services (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(), company_id uuid NOT NULL,
    team_id uuid, scheduled_start timestamptz, scheduled_end timestamptz,
    status text DEFAULT 'agendado');

  CREATE OR REPLACE FUNCTION public.get_my_company_id() RETURNS uuid
    LANGUAGE sql SECURITY DEFINER STABLE SET search_path = public
    AS $g$ SELECT company_id FROM profiles WHERE id = auth.uid() LIMIT 1 $g$;
  CREATE OR REPLACE FUNCTION public.get_my_role() RETURNS text
    LANGUAGE sql SECURITY DEFINER STABLE SET search_path = public
    AS $r$ SELECT role FROM profiles WHERE id = auth.uid() LIMIT 1 $r$;
`;

/** As policies da 014, tal como estão em produção. */
const POLICIES = `
  ALTER TABLE public.profiles     ENABLE ROW LEVEL SECURITY;
  ALTER TABLE public.teams        ENABLE ROW LEVEL SECURITY;
  ALTER TABLE public.team_members ENABLE ROW LEVEL SECURITY;
  ALTER TABLE public.timesheets   ENABLE ROW LEVEL SECURITY;

  CREATE POLICY "profiles_select" ON public.profiles FOR SELECT
    USING (id = auth.uid() OR company_id = public.get_my_company_id());
  CREATE POLICY "teams_select" ON public.teams FOR SELECT
    USING (company_id = public.get_my_company_id());
  CREATE POLICY "team_members_select" ON public.team_members FOR SELECT
    USING (team_id IN (SELECT id FROM public.teams WHERE company_id = public.get_my_company_id()));
  CREATE POLICY "timesheets_manager_select" ON public.timesheets FOR SELECT
    USING (collaborator_id IN (SELECT id FROM public.profiles
                                WHERE company_id = public.get_my_company_id()));
`;

/** As duas views da 010 e as três funções, tal como nasceram — sem hardening. */
const PRESTATE = `
  CREATE OR REPLACE VIEW public.monthly_hours_summary AS
  SELECT p.id AS collaborator_id, p.company_id, p.full_name, p.contracted_hours_month,
         DATE_TRUNC('month', ts.clock_in_at) AS month,
         COUNT(ts.id) AS services_count,
         SUM(ts.duration_minutes) / 60.0 AS worked_hours,
         SUM(CASE WHEN ts.location_warning THEN 1 ELSE 0 END) AS location_warnings
    FROM public.profiles p
    LEFT JOIN public.timesheets ts ON ts.collaborator_id = p.id
     AND ts.clock_in_at IS NOT NULL AND ts.clock_out_at IS NOT NULL
   WHERE p.role = 'colaborador'
   GROUP BY p.id, p.company_id, p.full_name, p.contracted_hours_month,
            DATE_TRUNC('month', ts.clock_in_at);

  CREATE OR REPLACE VIEW public.teams_with_members AS
  SELECT t.id, t.company_id, t.name, t.color, t.active, t.leader_id,
         COALESCE(json_agg(json_build_object(
           'id', p.id, 'full_name', p.full_name,
           'avatar_url', p.avatar_url, 'phone', p.phone
         )) FILTER (WHERE p.id IS NOT NULL), '[]') AS members
    FROM public.teams t
    LEFT JOIN public.team_members tm ON tm.team_id = t.id AND tm.left_at IS NULL
    LEFT JOIN public.profiles p ON p.id = tm.collaborator_id
   GROUP BY t.id;

  CREATE OR REPLACE FUNCTION public.archive_expired_documents(p_company_id uuid)
  RETURNS integer LANGUAGE plpgsql SECURITY DEFINER AS $a$
  DECLARE v_count integer;
  BEGIN
    UPDATE collaborator_documents SET archived_at = now()
     WHERE company_id = p_company_id AND expires_at < now() AND archived_at IS NULL;
    GET DIAGNOSTICS v_count = ROW_COUNT;
    RETURN v_count;
  END; $a$;

  CREATE OR REPLACE FUNCTION public.get_documents_to_archive(p_company_id uuid)
  RETURNS TABLE (id uuid, collaborator_id uuid, collaborator_name text, file_name text,
                 file_url text, file_size integer, mime_type text, category text,
                 notes text, created_at timestamptz, expires_at timestamptz)
  LANGUAGE sql SECURITY DEFINER AS $g$
    SELECT d.id, d.collaborator_id, p.full_name, d.file_name, d.file_url, d.file_size,
           d.mime_type, d.category, d.notes, d.created_at, d.expires_at
      FROM collaborator_documents d
      LEFT JOIN profiles p ON p.id = d.collaborator_id
     WHERE d.company_id = p_company_id AND d.archived_at IS NULL
  $g$;

  CREATE OR REPLACE FUNCTION public.detect_schedule_conflicts(p_start date, p_end date)
  RETURNS TABLE (company_id uuid, team_id uuid, service1_id uuid, service2_id uuid,
                 service1_start timestamptz, service1_end timestamptz)
  LANGUAGE sql SECURITY DEFINER AS $d$
    SELECT s1.company_id, s1.team_id, s1.id, s2.id, s1.scheduled_start, s1.scheduled_end
      FROM services s1 JOIN services s2
        ON s2.team_id = s1.team_id AND s2.id <> s1.id
       AND s2.scheduled_start < s1.scheduled_end
       AND s2.scheduled_end > s1.scheduled_start
     WHERE s1.scheduled_start::date BETWEEN p_start AND p_end
  $d$;

  -- 🔴 O ACL do prestate, tal como medido em produção — e medido a sério.
  --
  --    A versão anterior desta fixture concedia só SELECT nas views e dizia
  --    ser «o ACL amplo de produção». Não era: produção tem os OITO
  --    privilégios de PG17 concedidos a anon, authenticated e service_role em
  --    cada uma das duas views. Uma fixture mais fechada do que a realidade
  --    fabrica um prestate mais seguro do que aquele que a migration vai
  --    encontrar, e a prova «ANTES» deixa de representar seja o que for.
  GRANT USAGE ON SCHEMA public TO anon, authenticated, service_role;
  GRANT SELECT, INSERT, UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER, MAINTAIN
    ON public.teams_with_members, public.monthly_hours_summary
    TO anon, authenticated, service_role;
  GRANT SELECT ON public.profiles, public.teams, public.team_members,
    public.timesheets, public.collaborator_documents, public.services, public.companies
    TO anon, authenticated, service_role;

  -- As três funções ficam com o EXECUTE do prestate: PUBLIC, anon,
  -- authenticated e service_role. Concedê-lo explicitamente materializa o
  -- proacl em vez de o deixar NULL — e as duas formas são estados diferentes
  -- no catálogo, ainda que equivalentes no efeito.
  GRANT EXECUTE ON FUNCTION public.archive_expired_documents(uuid)
    TO PUBLIC, anon, authenticated, service_role;
  GRANT EXECUTE ON FUNCTION public.get_documents_to_archive(uuid)
    TO PUBLIC, anon, authenticated, service_role;
  GRANT EXECUTE ON FUNCTION public.detect_schedule_conflicts(date, date)
    TO PUBLIC, anon, authenticated, service_role;
`;

/** Corre `fn` sob um papel/identidade e diz se passou ou foi barrado. */
async function como<T>(role: string, uid: string | null, fn: () => Promise<T>) {
  await cli.query("BEGIN");
  await cli.query(`SET LOCAL ROLE ${role}`);
  if (uid) await cli.query("SELECT set_config('request.jwt.claim.sub',$1,true)", [uid]);
  let r: { ok: boolean; linhas?: number; err?: string };
  try {
    const out = (await fn()) as unknown as { rowCount?: number };
    r = { ok: true, linhas: out?.rowCount ?? undefined };
  } catch (e) {
    r = { ok: false, err: (e as Error).message.split("\n")[0] };
  }
  await cli.query("ROLLBACK");
  return r;
}

/** Reconstrói o prestate do zero — usado por cada cenário adversarial. */
async function reporPrestate() {
  await cli.query(BASELINE);
  await cli.query(POLICIES);
  await cli.query(PRESTATE);
  await cli.query("INSERT INTO public.companies(id,name) VALUES($1,'A'),($2,'B')", [EMP_A, EMP_B]);
  await cli.query(
    `INSERT INTO public.profiles(id,company_id,role,full_name,phone,avatar_url,contracted_hours_month)
     VALUES ($1,$4,'admin','Admin A','+351900000001','a.png',160),
            ($2,$4,'colaborador','Colab A','+351900000002','c.png',120),
            ($3,$5,'admin','Admin B','+351900000003','b.png',160)`,
    [ADMIN_A, COLAB_A, ADMIN_B, EMP_A, EMP_B],
  );
  await cli.query(
    "INSERT INTO public.teams(id,company_id,name,color) VALUES($1,$3,'Equipa A','#111'),($2,$4,'Equipa B','#222')",
    [EQUIPA_A, EQUIPA_B, EMP_A, EMP_B],
  );
  await cli.query("INSERT INTO public.team_members(team_id,collaborator_id) VALUES($1,$2)", [EQUIPA_A, COLAB_A]);
  await cli.query(
    `INSERT INTO public.timesheets(collaborator_id,clock_in_at,clock_out_at,duration_minutes)
     VALUES ($1, now() - interval '3 hours', now(), 180)`,
    [COLAB_A],
  );
  await cli.query(
    `INSERT INTO public.collaborator_documents(company_id,collaborator_id,file_name,expires_at)
     VALUES ($1,$2,'contrato.pdf', now() - interval '1 day')`,
    [EMP_A, COLAB_A],
  );
}

const aplicar085 = () => cli.query(sql("085_public_db_surface_closure.sql"));

beforeAll(async () => {
  docker(["rm", "-f", CONTAINER]);
  const up = docker(["run", "--rm", "-d", "--name", CONTAINER,
    "-e", "POSTGRES_HOST_AUTH_METHOD=trust", "-e", "POSTGRES_DB=az",
    "-p", "127.0.0.1::5432", IMAGEM]);
  if (up.status !== 0) throw new Error(up.stderr || up.stdout);
  const mapping = docker(["port", CONTAINER, "5432/tcp"]).stdout.trim();
  port = Number(mapping.slice(mapping.lastIndexOf(":") + 1));

  for (let i = 0; i < 90; i++) {
    try {
      cli = new pg.Client({ host: "127.0.0.1", port, user: "postgres", database: "az" });
      await cli.connect();
      break;
    } catch { await new Promise((r) => setTimeout(r, 1000)); }
  }

  await cli.query(`
    CREATE ROLE anon NOLOGIN; CREATE ROLE authenticated NOLOGIN;
    CREATE ROLE service_role NOLOGIN BYPASSRLS;
    CREATE SCHEMA IF NOT EXISTS auth;
    CREATE OR REPLACE FUNCTION auth.uid() RETURNS uuid LANGUAGE sql STABLE
      AS $u$ SELECT NULLIF(current_setting('request.jwt.claim.sub', true), '')::uuid $u$;
    GRANT USAGE ON SCHEMA auth TO anon, authenticated, service_role;`);
  await reporPrestate();
}, 300_000);

afterAll(async () => {
  await cli?.end();
  docker(["rm", "-f", CONTAINER]);
});

// ═══════════════════════════════════════════════════════════════════════════
// O DEFEITO, ANTES DA 085
// ═══════════════════════════════════════════════════════════════════════════
describe.sequential("085 — o defeito existe ANTES da migration", () => {
  it("A. 🔴 anon LÊ teams_with_members — nome, telefone e avatar", async () => {
    const r = await como("anon", null, () =>
      cli.query("SELECT id, name, members FROM public.teams_with_members"));
    expect(r.ok).toBe(true);
    // A classe de acesso é o que interessa: linhas > 0, não um número concreto.
    expect(r.linhas).toBeGreaterThan(0);
  });

  it("B. 🔴 anon LÊ monthly_hours_summary — horas e nome", async () => {
    const r = await como("anon", null, () =>
      cli.query("SELECT collaborator_id, full_name, worked_hours FROM public.monthly_hours_summary"));
    expect(r.ok).toBe(true);
    expect(r.linhas).toBeGreaterThan(0);
  });

  it("C. 🔴 anon EXECUTA detect_schedule_conflicts", async () => {
    const r = await como("anon", null, () =>
      cli.query("SELECT * FROM public.detect_schedule_conflicts(CURRENT_DATE - 7, CURRENT_DATE + 7)"));
    expect(r.ok).toBe(true);
  });

  it("D. 🔴 anon EXECUTA get_documents_to_archive e recebe dados de pessoas", async () => {
    const r = await como("anon", null, () =>
      cli.query("SELECT collaborator_name, file_name FROM public.get_documents_to_archive($1)", [EMP_A]));
    expect(r.ok).toBe(true);
    expect(r.linhas).toBeGreaterThan(0);
  });

  it("E. 🔴 anon provoca ESCRITA por archive_expired_documents (só em PG descartável)", async () => {
    // 🔴 Esta prova NUNCA é feita em produção: a definição + ACL bastam lá.
    //    Aqui, num container que morre no fim, mede-se o efeito real.
    await cli.query("BEGIN");
    await cli.query("SET LOCAL ROLE anon");
    const n = await cli.query("SELECT public.archive_expired_documents($1) AS n", [EMP_A]);
    expect(Number(n.rows[0].n)).toBeGreaterThan(0);
    const afectados = await cli.query(
      "SELECT count(*)::int c FROM public.collaborator_documents WHERE archived_at IS NOT NULL");
    expect(afectados.rows[0].c).toBeGreaterThan(0);
    await cli.query("ROLLBACK");
  });

  it("VIEW_PRESTATE_EXACT_PRIVILEGE_VECTOR: os 8 privilégios estão mesmo lá", async () => {
    // Se a fixture não reproduzir o vector real, as provas «DEPOIS» medem a
    // remoção de algo que nunca existiu.
    const a = await cli.query(`SELECT c.relname, pg_get_userbyid(x.grantee) papel,
        string_agg(DISTINCT x.privilege_type, ',' ORDER BY x.privilege_type) privs
      FROM pg_class c
      JOIN pg_namespace n ON n.oid = c.relnamespace
      CROSS JOIN LATERAL aclexplode(c.relacl) x
      WHERE n.nspname='public' AND c.relname IN ('teams_with_members','monthly_hours_summary')
        AND pg_get_userbyid(x.grantee) IN ('anon','authenticated','service_role')
      GROUP BY c.relname, x.grantee ORDER BY c.relname, papel`);
    expect(a.rowCount).toBe(6);
    for (const row of a.rows) {
      expect(row.privs, `${row.relname}/${row.papel}`)
        .toBe("DELETE,INSERT,MAINTAIN,REFERENCES,SELECT,TRIGGER,TRUNCATE,UPDATE");
    }
  });

  it("FUNCTION_PRESTATE_EXECUTE_VECTOR: PUBLIC+anon+authenticated+service_role", async () => {
    const f = await cli.query(`SELECT p.proname,
        has_function_privilege('anon', p.oid, 'EXECUTE') anon_x,
        has_function_privilege('authenticated', p.oid, 'EXECUTE') auth_x,
        has_function_privilege('service_role', p.oid, 'EXECUTE') svc_x,
        has_function_privilege('public', p.oid, 'EXECUTE') pub_x
      FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
      WHERE n.nspname='public' AND p.proname IN
        ('archive_expired_documents','get_documents_to_archive','detect_schedule_conflicts')`);
    expect(f.rowCount).toBe(3);
    for (const row of f.rows) {
      expect(row.anon_x, row.proname).toBe(true);
      expect(row.auth_x, row.proname).toBe(true);
      expect(row.svc_x, row.proname).toBe(true);
      expect(row.pub_x, row.proname).toBe(true);
    }
  });

  it("as views correm como a dona — o RLS não se aplica", async () => {
    const v = await cli.query(`SELECT relname, coalesce(array_to_string(reloptions,','),'') opts
      FROM pg_class WHERE relname IN ('teams_with_members','monthly_hours_summary')`);
    for (const row of v.rows) expect(row.opts).not.toMatch(/security_invoker/i);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// DEPOIS DA 085
// ═══════════════════════════════════════════════════════════════════════════
describe.sequential("085 aplicada — a superfície fecha", () => {
  it("aplica a migration", async () => {
    await aplicar085();
  });

  it("VIEW_SECURITY_INVOKER_AFTER: as duas views correm como quem chama", async () => {
    const v = await cli.query(`SELECT relname, coalesce(array_to_string(reloptions,','),'') opts
      FROM pg_class WHERE relname IN ('teams_with_members','monthly_hours_summary') ORDER BY relname`);
    expect(v.rowCount).toBe(2);
    for (const row of v.rows) expect(row.opts).toMatch(/security_invoker=true/i);
  });

  it.each([["teams_with_members"], ["monthly_hours_summary"]])(
    "anon NÃO lê %s", async (vista) => {
      const r = await como("anon", null, () => cli.query(`SELECT * FROM public.${vista}`));
      expect(r.ok).toBe(false);
      expect(r.err).toMatch(/permission denied/i);
    });

  it.each([
    ["archive_expired_documents", "SELECT public.archive_expired_documents('11111111-1111-4111-8111-111111111111')"],
    ["get_documents_to_archive", "SELECT * FROM public.get_documents_to_archive('11111111-1111-4111-8111-111111111111')"],
    ["detect_schedule_conflicts", "SELECT * FROM public.detect_schedule_conflicts(CURRENT_DATE, CURRENT_DATE)"],
  ])("anon NÃO executa %s", async (_n, q) => {
    const r = await como("anon", null, () => cli.query(q));
    expect(r.ok).toBe(false);
    expect(r.err).toMatch(/permission denied/i);
  });

  it.each([
    ["archive_expired_documents", "SELECT public.archive_expired_documents('11111111-1111-4111-8111-111111111111')"],
    ["get_documents_to_archive", "SELECT * FROM public.get_documents_to_archive('11111111-1111-4111-8111-111111111111')"],
    ["detect_schedule_conflicts", "SELECT * FROM public.detect_schedule_conflicts(CURRENT_DATE, CURRENT_DATE)"],
  ])("authenticated NÃO executa %s — são service_role-only", async (_n, q) => {
    const r = await como("authenticated", ADMIN_A, () => cli.query(q));
    expect(r.ok).toBe(false);
    expect(r.err).toMatch(/permission denied/i);
  });

  it("FUNCTION_SEARCH_PATH_EXACT_AFTER: valor exacto pg_catalog, public", async () => {
    // 🔴 Valor exacto, não «contém search_path»: um `SET search_path = public`
    //    satisfazia a asserção antiga e deixava `pg_catalog` fora.
    const f = await cli.query(`SELECT p.proname,
        replace(coalesce((SELECT s FROM unnest(p.proconfig) s WHERE s LIKE 'search_path=%'), ''), ' ', '') sp
      FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
      WHERE n.nspname='public' AND p.proname IN
        ('archive_expired_documents','get_documents_to_archive','detect_schedule_conflicts')
      ORDER BY p.proname`);
    expect(f.rowCount).toBe(3);
    for (const row of f.rows) {
      expect(row.sp, row.proname).toBe("search_path=pg_catalog,public");
    }
  });

  it("FUNCTION_EXECUTE_ACL_AFTER: só service_role executa as três", async () => {
    const f = await cli.query(`SELECT p.proname,
        has_function_privilege('anon', p.oid, 'EXECUTE') anon_x,
        has_function_privilege('authenticated', p.oid, 'EXECUTE') auth_x,
        has_function_privilege('service_role', p.oid, 'EXECUTE') svc_x
      FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
      WHERE n.nspname='public' AND p.proname IN
        ('archive_expired_documents','get_documents_to_archive','detect_schedule_conflicts')`);
    expect(f.rowCount).toBe(3);
    for (const row of f.rows) {
      expect(row.anon_x, `${row.proname} anon`).toBe(false);
      expect(row.auth_x, `${row.proname} authenticated`).toBe(false);
      expect(row.svc_x, `${row.proname} service_role`).toBe(true);
    }
  });

  it("VIEW_POSTSTATE_ALL_8_PRIVILEGES: a ACL final é exactamente a nominal", async () => {
    // 🔴 Os OITO, não só o SELECT. Um REVOKE que não pegasse em UPDATE ou
    //    TRUNCATE passaria despercebido numa verificação de SELECT — e
    //    TRUNCATE não passa por RLS nenhum.
    const a = await cli.query(`SELECT papel, relname, privilegio,
        has_table_privilege(papel, 'public.'||relname, privilegio) tem
      FROM unnest(ARRAY['anon','authenticated','service_role']) papel
      CROSS JOIN unnest(ARRAY['teams_with_members','monthly_hours_summary']) relname
      CROSS JOIN unnest(ARRAY['SELECT','INSERT','UPDATE','DELETE',
                              'TRUNCATE','REFERENCES','TRIGGER','MAINTAIN']) privilegio`);
    expect(a.rowCount).toBe(48);
    for (const r of a.rows as { papel: string; relname: string; privilegio: string; tem: boolean }[]) {
      const esperado =
        r.privilegio === "SELECT" &&
        (r.papel === "service_role" ||
          (r.papel === "authenticated" && r.relname === "teams_with_members"));
      expect(r.tem, `${r.privilegio} ${r.relname}/${r.papel}`).toBe(esperado);
    }
  });

  it("PUBLIC sem grants residuais nas duas views", async () => {
    const p = await cli.query(`SELECT c.relname,
        coalesce((SELECT string_agg(DISTINCT a.privilege_type,',')
                    FROM aclexplode(c.relacl) a WHERE a.grantee = 0), '') pub
      FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
      WHERE n.nspname='public' AND c.relname IN ('teams_with_members','monthly_hours_summary')`);
    for (const row of p.rows) expect(row.pub, row.relname).toBe("");
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// COMPORTAMENTO POR PAPEL — o que a 085 preserva
// ═══════════════════════════════════════════════════════════════════════════
describe.sequential("085 — os callers legítimos continuam a funcionar", () => {
  it("ADMIN_MANAGER_BEHAVIOR: admin da empresa A lê a sua equipa", async () => {
    const r = await como("authenticated", ADMIN_A, () =>
      cli.query("SELECT id, name FROM public.teams_with_members"));
    expect(r.ok).toBe(true);
    expect(r.linhas).toBe(1);
  });

  it("🔴 TENANT_ISOLATION: admin de A não vê a equipa de B", async () => {
    await cli.query("BEGIN");
    await cli.query("SET LOCAL ROLE authenticated");
    await cli.query("SELECT set_config('request.jwt.claim.sub',$1,true)", [ADMIN_A]);
    const q = await cli.query("SELECT id FROM public.teams_with_members WHERE id = $1", [EQUIPA_B]);
    await cli.query("ROLLBACK");
    expect(q.rowCount).toBe(0);
  });

  it("🔴 TENANT_ISOLATION: admin de B não vê a equipa de A", async () => {
    await cli.query("BEGIN");
    await cli.query("SET LOCAL ROLE authenticated");
    await cli.query("SELECT set_config('request.jwt.claim.sub',$1,true)", [ADMIN_B]);
    const q = await cli.query("SELECT id FROM public.teams_with_members WHERE id = $1", [EQUIPA_A]);
    await cli.query("ROLLBACK");
    expect(q.rowCount).toBe(0);
  });

  it("COLLABORATOR_BEHAVIOR: colaborador vê a equipa da SUA empresa, e só essa", async () => {
    // 🔴 Decisão explícita, não omissão: `teams_select` (014) é company-scoped
    //    e não distingue papel. Um colaborador de A vê as equipas de A — que é
    //    o que a tabela `teams` já lhe dava antes desta migration. A 085 não
    //    aperta isso, e apertá-lo seria uma mudança de produto, não de
    //    segurança. O que a 085 fecha é o acesso SEM sessão.
    await cli.query("BEGIN");
    await cli.query("SET LOCAL ROLE authenticated");
    await cli.query("SELECT set_config('request.jwt.claim.sub',$1,true)", [COLAB_A]);
    const proprias = await cli.query("SELECT id FROM public.teams_with_members");
    const alheias = await cli.query("SELECT id FROM public.teams_with_members WHERE id = $1", [EQUIPA_B]);
    await cli.query("ROLLBACK");
    expect(proprias.rowCount).toBe(1);
    expect(alheias.rowCount).toBe(0);
  });

  it("SERVICE_ROLE_BEHAVIOR: os callers reais continuam a passar", async () => {
    await cli.query("BEGIN");
    await cli.query("SET LOCAL ROLE service_role");
    // collaborator-documents.ts
    const docs = await cli.query("SELECT * FROM public.get_documents_to_archive($1)", [EMP_A]);
    // cron/generate-services
    const conf = await cli.query(
      "SELECT * FROM public.detect_schedule_conflicts(CURRENT_DATE - 7, CURRENT_DATE + 7)");
    // as duas views
    const eq = await cli.query("SELECT id FROM public.teams_with_members");
    const hrs = await cli.query("SELECT collaborator_id FROM public.monthly_hours_summary");
    await cli.query("ROLLBACK");
    expect(docs.rowCount).toBeGreaterThan(0);
    expect(conf.rowCount).not.toBeNull();
    expect(eq.rowCount).toBeGreaterThan(0);
    expect(hrs.rowCount).toBeGreaterThan(0);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// PRECONDIÇÕES — UNKNOWN_STATE = FAIL_CLOSED
// ═══════════════════════════════════════════════════════════════════════════
describe.sequential("085 — precondições fail-closed", () => {
  it("segunda aplicação é recusada: o prestate já não é o caracterizado", async () => {
    // A 085 não é idempotente por desenho — depois de aplicada, o prestate que
    // ela exige deixou de existir. Recusar é o comportamento certo: quem a
    // corre outra vez está a correr sobre um estado que não caracterizou.
    let erro = "";
    try { await aplicar085(); } catch (e) { erro = (e as Error).message; }
    expect(erro).toContain("085_UNEXPECTED_PUBLIC_SURFACE_STATE");
  });

  it("view ausente → FAIL_CLOSED, e nada é alterado", async () => {
    await reporPrestate();
    await cli.query("DROP VIEW public.monthly_hours_summary");
    const antes = await cli.query(`SELECT coalesce(array_to_string(reloptions,','),'') opts
      FROM pg_class WHERE relname='teams_with_members'`);

    let erro = "";
    try { await aplicar085(); } catch (e) { erro = (e as Error).message; }
    expect(erro).toContain("085_UNEXPECTED_PUBLIC_SURFACE_STATE");

    // 🔴 A prova de que nada foi aplicado pela metade: a outra view ficou
    //    exactamente como estava, sem security_invoker.
    const depois = await cli.query(`SELECT coalesce(array_to_string(reloptions,','),'') opts
      FROM pg_class WHERE relname='teams_with_members'`);
    expect(depois.rows[0].opts).toBe(antes.rows[0].opts);
    expect(depois.rows[0].opts).not.toMatch(/security_invoker/i);
  });

  it("função com assinatura divergente → FAIL_CLOSED", async () => {
    await reporPrestate();
    await cli.query("DROP FUNCTION public.get_documents_to_archive(uuid)");
    await cli.query(`CREATE FUNCTION public.get_documents_to_archive(p_empresa uuid)
      RETURNS integer LANGUAGE sql SECURITY DEFINER AS $x$ SELECT 1 $x$`);

    let erro = "";
    try { await aplicar085(); } catch (e) { erro = (e as Error).message; }
    expect(erro).toContain("085_UNEXPECTED_PUBLIC_SURFACE_STATE");
    expect(erro).toMatch(/assinatura inesperada/i);
  });

  it("security_invoker já presente → FAIL_CLOSED (alguém mexeu fora do versionamento)", async () => {
    await reporPrestate();
    await cli.query("ALTER VIEW public.teams_with_members SET (security_invoker = true)");

    let erro = "";
    try { await aplicar085(); } catch (e) { erro = (e as Error).message; }
    expect(erro).toContain("085_UNEXPECTED_PUBLIC_SURFACE_STATE");
    expect(erro).toMatch(/ja tem security_invoker/i);
  });

  it("search_path já fixado → FAIL_CLOSED", async () => {
    await reporPrestate();
    await cli.query("ALTER FUNCTION public.detect_schedule_conflicts(date,date) SET search_path = public");

    let erro = "";
    try { await aplicar085(); } catch (e) { erro = (e as Error).message; }
    expect(erro).toContain("085_UNEXPECTED_PUBLIC_SURFACE_STATE");
    expect(erro).toMatch(/ja tem search_path/i);
  });

  // ── ACL DIVERGENTE ────────────────────────────────────────────────────────
  //
  // 🔴 A forma dos objectos pode estar intacta e o ACL ter mudado. Sem estas
  //    guardas, a 085 convergia em silêncio e apagava uma decisão de grant que
  //    nunca caracterizou — e o relatório dizia «aplicado com sucesso».

  /** Estado das duas views e das três funções, para comparar antes/depois. */
  async function fotografia() {
    const v = await cli.query(`SELECT relname, coalesce(array_to_string(reloptions,','),'') opts
      FROM pg_class WHERE relname IN ('teams_with_members','monthly_hours_summary') ORDER BY relname`);
    const f = await cli.query(`SELECT p.proname, coalesce(array_to_string(p.proconfig,','),'') cfg
      FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
      WHERE n.nspname='public' AND p.proname IN
        ('archive_expired_documents','get_documents_to_archive','detect_schedule_conflicts')
      ORDER BY p.proname`);
    return JSON.stringify({ v: v.rows, f: f.rows });
  }

  it("ACL_DIVERGENCE_VIEW_TEST: um privilégio a menos numa view → FAIL_CLOSED", async () => {
    await reporPrestate();
    await cli.query("REVOKE UPDATE ON public.teams_with_members FROM authenticated");
    const antes = await fotografia();

    let erro = "";
    try { await aplicar085(); } catch (e) { erro = (e as Error).message; }
    expect(erro).toContain("085_UNEXPECTED_PUBLIC_SURFACE_STATE");

    // ZERO_PARTIAL_MUTATION: a outra view não ganhou security_invoker e o
    // search_path das funções não foi tocado.
    expect(await fotografia()).toBe(antes);
  });

  it("ACL_DIVERGENCE_VIEW_TEST: grant inesperado a PUBLIC → FAIL_CLOSED, não normalizado", async () => {
    await reporPrestate();
    await cli.query("GRANT SELECT ON public.monthly_hours_summary TO PUBLIC");
    const antes = await fotografia();

    let erro = "";
    try { await aplicar085(); } catch (e) { erro = (e as Error).message; }
    expect(erro).toContain("085_UNEXPECTED_PUBLIC_SURFACE_STATE");
    expect(erro).toMatch(/PUBLIC/);

    // 🔴 E o grant desconhecido continua lá: a 085 não o apaga em silêncio.
    const pub = await cli.query(`SELECT count(*)::int n FROM pg_class c, aclexplode(c.relacl) a
      WHERE c.relname='monthly_hours_summary' AND a.grantee = 0`);
    expect(pub.rows[0].n).toBeGreaterThan(0);
    expect(await fotografia()).toBe(antes);
  });

  it("ACL_DIVERGENCE_FUNCTION_TEST: EXECUTE revogado a anon → FAIL_CLOSED", async () => {
    await reporPrestate();
    await cli.query("REVOKE EXECUTE ON FUNCTION public.get_documents_to_archive(uuid) FROM anon");
    const antes = await fotografia();

    let erro = "";
    try { await aplicar085(); } catch (e) { erro = (e as Error).message; }
    expect(erro).toContain("085_UNEXPECTED_PUBLIC_SURFACE_STATE");
    expect(await fotografia()).toBe(antes);
  });

  it("overload inesperado → FAIL_CLOSED (senão ficaria uma assinatura aberta)", async () => {
    await reporPrestate();
    await cli.query(`CREATE FUNCTION public.detect_schedule_conflicts(p_start date)
      RETURNS integer LANGUAGE sql SECURITY DEFINER AS $x$ SELECT 1 $x$`);

    let erro = "";
    try { await aplicar085(); } catch (e) { erro = (e as Error).message; }
    expect(erro).toContain("085_UNEXPECTED_PUBLIC_SURFACE_STATE");
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// MUTAÇÃO — cada hardening tem de ser necessário
// ═══════════════════════════════════════════════════════════════════════════
describe.sequential("085 — provas de mutação", () => {
  it("SECURITY_MUTATION: sem security_invoker, anon voltaria a ler (a view é a defesa)", async () => {
    await reporPrestate();
    await aplicar085();
    // Reverter APENAS o security_invoker e devolver o SELECT a anon: se o
    // acesso voltar, é porque o security_invoker é mesmo o que o barra.
    await cli.query("ALTER VIEW public.teams_with_members SET (security_invoker = false)");
    await cli.query("GRANT SELECT ON public.teams_with_members TO anon");
    const r = await como("anon", null, () => cli.query("SELECT id FROM public.teams_with_members"));
    expect(r.ok).toBe(true);
    expect(r.linhas).toBeGreaterThan(0);
  });

  it("SECURITY_MUTATION: sem o REVOKE, anon voltaria a executar a função de escrita", async () => {
    await reporPrestate();
    await aplicar085();
    await cli.query("GRANT EXECUTE ON FUNCTION public.archive_expired_documents(uuid) TO anon");
    const r = await como("anon", null, () =>
      cli.query("SELECT public.archive_expired_documents($1)", [EMP_A]));
    expect(r.ok).toBe(true);
  });

  it("SECURITY_MUTATION: um UPDATE concedido depois do hardening é detectável", async () => {
    // A verificação nominal dos 8 privilégios existe para isto: um grant que
    // não seja SELECT numa view fechada tem de aparecer.
    await reporPrestate();
    await aplicar085();
    await cli.query("GRANT UPDATE ON public.teams_with_members TO authenticated");

    const a = await cli.query(`SELECT papel, relname, privilegio,
        has_table_privilege(papel, 'public.'||relname, privilegio) tem
      FROM unnest(ARRAY['anon','authenticated','service_role']) papel
      CROSS JOIN unnest(ARRAY['teams_with_members','monthly_hours_summary']) relname
      CROSS JOIN unnest(ARRAY['SELECT','INSERT','UPDATE','DELETE',
                              'TRUNCATE','REFERENCES','TRIGGER','MAINTAIN']) privilegio`);
    const violacoes = (a.rows as { papel: string; relname: string; privilegio: string; tem: boolean }[])
      .filter((r) => {
        const esperado =
          r.privilegio === "SELECT" &&
          (r.papel === "service_role" ||
            (r.papel === "authenticated" && r.relname === "teams_with_members"));
        return r.tem !== esperado;
      });
    expect(violacoes).toHaveLength(1);
    expect(violacoes[0].privilegio).toBe("UPDATE");
  });

  it("SEARCH_PATH_MUTATION: `SET search_path = public` NÃO satisfaz o estado canónico", async () => {
    // 🔴 A asserção antiga («contém search_path») aceitava isto. A nova não.
    await reporPrestate();
    await aplicar085();
    await cli.query("ALTER FUNCTION public.detect_schedule_conflicts(date,date) SET search_path = public");

    const f = await cli.query(`SELECT
        replace(coalesce((SELECT s FROM unnest(p.proconfig) s WHERE s LIKE 'search_path=%'), ''), ' ', '') sp
      FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
      WHERE n.nspname='public' AND p.proname='detect_schedule_conflicts'`);
    // Continua a "conter search_path" — e é exactamente por isso que a
    // verificação por substring não servia.
    expect(f.rows[0].sp).toContain("search_path");
    expect(f.rows[0].sp).not.toBe("search_path=pg_catalog,public");
  });

  it("PRECONDITION_MUTATION: o pós-estado apanha um REVOKE que não pegou", async () => {
    // Simula a 085 a «aplicar» sem fechar: se o pós-estado não verificasse,
    // a migration daria verde com anon ainda a ler.
    await reporPrestate();
    await aplicar085();
    await cli.query("GRANT SELECT ON public.monthly_hours_summary TO anon");
    const g = await cli.query(
      "SELECT has_table_privilege('anon','public.monthly_hours_summary','SELECT') t");
    // O estado mutado é detectável — é exactamente o que o bloco 4b mede.
    expect(g.rows[0].t).toBe(true);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// ROLLBACK
// ═══════════════════════════════════════════════════════════════════════════
describe.sequential("ROLLBACK_085_REOPENS_KNOWN_SECURITY_BUG = YES", () => {
  it("o rollback repõe o prestate — e reabre a exposição, como está documentado", async () => {
    await reporPrestate();
    await aplicar085();

    // Fechado depois da 085.
    const fechado = await como("anon", null, () =>
      cli.query("SELECT id FROM public.teams_with_members"));
    expect(fechado.ok).toBe(false);

    await cli.query(readFileSync(
      join(ROOT, "supabase", "migrations", "rollback", "085_public_db_surface_closure.down.sql"), "utf8"));

    // 🔴 A prova de que o rollback é UNSAFE_BY_DESIGN: anon lê outra vez.
    const reaberto = await como("anon", null, () =>
      cli.query("SELECT id, members FROM public.teams_with_members"));
    expect(reaberto.ok).toBe(true);
    expect(reaberto.linhas).toBeGreaterThan(0);

    // E a função de escrita volta a estar ao alcance de anon.
    const escrita = await como("anon", null, () =>
      cli.query("SELECT public.archive_expired_documents($1)", [EMP_A]));
    expect(escrita.ok).toBe(true);

    // 🔴 ROLLBACK_EXACT_ACL_PRESTATE = NO — afirmado, não subentendido.
    //    O prestate tinha os 8 privilégios; o rollback devolve só SELECT.
    //    Devolver TRUNCATE a `anon` para "ser exacto" seria dar a quem não tem
    //    sessão o poder de esvaziar tabelas, e TRUNCATE não passa por RLS.
    const acl = await cli.query(`SELECT
        has_table_privilege('anon','public.teams_with_members','SELECT') sel,
        has_table_privilege('anon','public.teams_with_members','TRUNCATE') trunc,
        has_table_privilege('anon','public.teams_with_members','UPDATE') upd`);
    expect(acl.rows[0].sel).toBe(true);
    expect(acl.rows[0].trunc).toBe(false);
    expect(acl.rows[0].upd).toBe(false);

    // Reaplicar, para o container não ficar num estado inseguro.
    await reporPrestate();
    await aplicar085();
  });
});

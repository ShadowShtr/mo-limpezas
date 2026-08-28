/**
 * 083 — mutação de pagamento só pelo caminho canónico.
 *
 * O defeito que esta migration fecha foi provado, não suposto: uma colaboradora
 * autenticada fazia `UPDATE fixed_variable_payments SET status='pago'` e o
 * movimento de caixa nunca nascia. Pagamento pago, dinheiro por sair.
 *
 * 🔴 As duas camadas provam-se SEPARADAMENTE. Um teste que passe só porque o
 *    grant de tabela bloqueou aquilo que a policy devia bloquear — ou o inverso
 *    — não prova nada sobre a camada que ficou por verificar. Por isso há um
 *    bloco que remove os grants da equação (dando-os de volta) e mede só o RLS,
 *    e outro que mede o privilégio de tabela em si, pelo catálogo.
 *
 * Postgres 17 real, em Docker: é a versão de produção.
 */
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const ROOT = process.cwd();
const CONTAINER = `authz-083-${process.pid}`;
const IMAGEM = "postgres:17-alpine";
let port = 0;
let cli: pg.Client;

const EMP_A = "11111111-1111-4111-8111-111111111111";
const EMP_B = "22222222-2222-4222-8222-222222222222";
const COLAB_A = "aaaaaaaa-0000-4000-8000-000000000001";
const GESTOR_A = "aaaaaaaa-0000-4000-8000-000000000002";
const ADMIN_A = "aaaaaaaa-0000-4000-8000-000000000003";
const ADMIN_B = "bbbbbbbb-0000-4000-8000-000000000001";
let PAG_A = "";

function docker(args: string[]) {
  return spawnSync("docker", args, { cwd: ROOT, encoding: "utf8" });
}
const sql = (f: string) => readFileSync(join(ROOT, "supabase", "migrations", f), "utf8");

/** Schema mínimo, igual ao usado pelos outros ensaios desta frente. */
const BASELINE = `
  DROP SCHEMA IF EXISTS public CASCADE;
  CREATE SCHEMA public;
  CREATE TABLE public.companies (id uuid PRIMARY KEY, name text NOT NULL);
  CREATE TABLE public.profiles (id uuid PRIMARY KEY, company_id uuid, role text);
  CREATE TABLE public.expense_categories (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    company_id uuid NOT NULL, name text NOT NULL, color text);
  CREATE TABLE public.financial_periods (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(), company_id uuid NOT NULL,
    year smallint NOT NULL, month smallint NOT NULL CHECK (month BETWEEN 1 AND 12),
    status text NOT NULL DEFAULT 'open' CHECK (status IN ('open','closed')),
    CONSTRAINT financial_periods_unique UNIQUE (company_id, year, month));
  CREATE TABLE public.cash_flow_entries (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(), company_id uuid NOT NULL,
    type text NOT NULL CHECK (type IN ('entrada','saida')),
    amount numeric(10,2) NOT NULL, description text NOT NULL,
    category text DEFAULT 'outro'
      CHECK (category IN ('faturacao','salario','despesa','fornecedor','outro')),
    date date NOT NULL, reference_id uuid, reference_type text,
    status text NOT NULL DEFAULT 'confirmado' CHECK (status IN ('pendente','confirmado')),
    notes text, created_by uuid, created_at timestamptz DEFAULT now(),
    expense_category_id uuid);
  CREATE TABLE public.fixed_variable_payments (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(), company_id uuid NOT NULL,
    kind text NOT NULL CHECK (kind IN ('fixo','variavel')),
    description text NOT NULL, amount numeric(10,2), due_date date,
    status text NOT NULL DEFAULT 'pendente' CHECK (status IN ('pago','pendente')),
    recurring boolean NOT NULL DEFAULT false,
    period_year integer NOT NULL,
    period_month integer NOT NULL CHECK (period_month BETWEEN 1 AND 12),
    paid_at timestamptz, notes text, created_at timestamptz DEFAULT now(),
    expense_category_id uuid);
  CREATE OR REPLACE FUNCTION public.get_my_company_id() RETURNS uuid
    LANGUAGE sql SECURITY DEFINER STABLE SET search_path = public
    AS $g$ SELECT company_id FROM profiles WHERE id = auth.uid() LIMIT 1 $g$;
  -- Ambas vêm da 014 e são SECURITY DEFINER: sem elas, uma policy que leia
  -- profiles directamente rebenta por falta de privilegio do chamador.
  CREATE OR REPLACE FUNCTION public.get_my_role() RETURNS text
    LANGUAGE sql SECURITY DEFINER STABLE SET search_path = public
    AS $r$ SELECT role FROM profiles WHERE id = auth.uid() LIMIT 1 $r$;
`;

/** Corre `fn` sob um papel/identidade e devolve se passou ou foi barrado. */
async function como<T>(role: string, uid: string | null, fn: () => Promise<T>) {
  await cli.query("BEGIN");
  await cli.query(`SET LOCAL ROLE ${role}`);
  if (uid) await cli.query("SELECT set_config('request.jwt.claim.sub',$1,true)", [uid]);
  let r: { ok: boolean; err?: string };
  try { await fn(); r = { ok: true }; }
  catch (e) { r = { ok: false, err: (e as Error).message.split("\n")[0] }; }
  await cli.query("ROLLBACK");
  return r;
}

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
  await cli.query(BASELINE);
  await cli.query(`CREATE TABLE IF NOT EXISTS public._migrations(
    name text PRIMARY KEY, checksum text, applied_at timestamptz DEFAULT now());`);
  for (const m of ["024_cash_flow_reference_integrity.sql",
                   "049_cash_flow_service_payment_reference.sql",
                   "075_cash_flow_fixed_variable_payment_reference.sql",
                   "073_payment_to_cashflow.sql",
                   "079_reuse_pending_cashflow_on_payment.sql",
                   "080_payment_cashflow_provenance.sql"]) {
    await cli.query(sql(m));
    await cli.query("INSERT INTO public._migrations(name,checksum) VALUES($1,'x') ON CONFLICT DO NOTHING", [m]);
  }
  await cli.query(`CREATE TABLE IF NOT EXISTS public.bank_reconciliation_matches(
    id uuid primary key default gen_random_uuid(),
    cash_flow_entry_id uuid REFERENCES public.cash_flow_entries(id) ON DELETE CASCADE,
    status text NOT NULL DEFAULT 'suggested');`);
  await cli.query(sql("081_safe_unmark_payment_paid.sql"));
  await cli.query("INSERT INTO public._migrations(name,checksum) VALUES('081_safe_unmark_payment_paid.sql','x') ON CONFLICT DO NOTHING");

  // Estado PRÉ-083: policy da 037 + grants abertos, como em produção hoje.
  await cli.query(`
    ALTER TABLE public.fixed_variable_payments ENABLE ROW LEVEL SECURITY;
    CREATE POLICY "company members manage fixed variable payments"
      ON public.fixed_variable_payments
      USING (company_id IN (SELECT company_id FROM public.profiles WHERE id = auth.uid()));
    ALTER TABLE public.cash_flow_entries ENABLE ROW LEVEL SECURITY;
    CREATE POLICY "cash_flow_admin" ON public.cash_flow_entries FOR ALL
      USING (company_id = public.get_my_company_id()
             AND (SELECT role FROM public.profiles WHERE id=auth.uid()) IN ('admin','gestor'))
      WITH CHECK (company_id = public.get_my_company_id()
             AND (SELECT role FROM public.profiles WHERE id=auth.uid()) IN ('admin','gestor'));
    GRANT USAGE ON SCHEMA public TO anon, authenticated, service_role;
    GRANT SELECT, INSERT, UPDATE, DELETE ON public.fixed_variable_payments,
      public.cash_flow_entries, public.payment_cashflow_provenance, public.profiles,
      public.companies, public.financial_periods, public.bank_reconciliation_matches
      TO anon, authenticated, service_role;`);

  // 🔴 Privilégios ADVERSARIAIS, plantados de propósito antes da 083.
  //
  //    A fixture anterior começava sem TRUNCATE/REFERENCES/TRIGGER, por isso
  //    uma migration que só revogasse SELECT/INSERT/UPDATE/DELETE passava nos
  //    testes por sorte: não havia resíduo para deixar para trás. Isso não
  //    prova que a migration os remove — prova que nunca lá estiveram.
  //
  //    Aqui damo-los, para que a prova pós-083 seja sobre remoção real. Em
  //    produção podem existir por herança (`GRANT ALL`, um role template, uma
  //    correcção manual antiga) e é exactamente esse o caso que interessa.
  await cli.query(`
    GRANT TRUNCATE, REFERENCES, TRIGGER ON public.fixed_variable_payments TO authenticated;
    GRANT SELECT, INSERT, UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER
      ON public.fixed_variable_payments TO anon;
    GRANT SELECT, INSERT, UPDATE, DELETE ON public.fixed_variable_payments TO PUBLIC;`);

  await cli.query("INSERT INTO public.companies(id,name) VALUES($1,'A'),($2,'B')", [EMP_A, EMP_B]);
  await cli.query(`INSERT INTO public.profiles(id,company_id,role) VALUES
    ($1,$5,'colaboradora'),($2,$5,'gestor'),($3,$5,'admin'),($4,$6,'admin')`,
    [COLAB_A, GESTOR_A, ADMIN_A, ADMIN_B, EMP_A, EMP_B]);
  const p = await cli.query(`INSERT INTO public.fixed_variable_payments
    (company_id,kind,description,amount,status,due_date,period_year,period_month)
    VALUES($1,'fixo','agua',100,'pendente',CURRENT_DATE,2026,8) RETURNING id`, [EMP_A]);
  PAG_A = p.rows[0].id;
}, 300_000);

afterAll(async () => {
  await cli?.end();
  docker(["rm", "-f", CONTAINER]);
});

describe.sequential("083 — o defeito existe ANTES da migration", () => {
  // Sem isto, um erro na fixture (grant que não pegou) tornaria a prova de
  // remoção pós-083 vazia: estaríamos a medir a ausência de algo que nunca
  // chegou a existir.
  it("a fixture tem mesmo os privilégios adversariais por remover", async () => {
    const g = await cli.query(`SELECT
      has_table_privilege('authenticated','public.fixed_variable_payments','TRUNCATE') a_trunc,
      has_table_privilege('authenticated','public.fixed_variable_payments','REFERENCES') a_ref,
      has_table_privilege('authenticated','public.fixed_variable_payments','TRIGGER') a_trg,
      has_table_privilege('anon','public.fixed_variable_payments','SELECT') an_sel,
      has_table_privilege('anon','public.fixed_variable_payments','TRUNCATE') an_trunc`);
    const r = g.rows[0];
    expect(r.a_trunc).toBe(true);
    expect(r.a_ref).toBe(true);
    expect(r.a_trg).toBe(true);
    expect(r.an_sel).toBe(true);
    expect(r.an_trunc).toBe(true);

    // E PUBLIC tem grants residuais — o caso mais fácil de esquecer, porque
    // não aparece ligado a nenhum role nomeado.
    const pub = await cli.query(`SELECT count(*)::int n FROM (
      SELECT (aclexplode(relacl)).grantee g FROM pg_class
       WHERE oid='public.fixed_variable_payments'::regclass) x WHERE g = 0`);
    expect(pub.rows[0].n).toBeGreaterThan(0);
  });

  it("🔴 colaboradora marca como pago por UPDATE directo, sem gerar caixa", async () => {
    const r = await como("authenticated", COLAB_A, async () => {
      const u = await cli.query(
        "UPDATE public.fixed_variable_payments SET status='pago', paid_at=now() WHERE id=$1 RETURNING id",
        [PAG_A]);
      if (u.rowCount === 0) throw new Error("RLS filtrou: 0 linhas");
      const cf = await cli.query(
        "SELECT count(*)::int n FROM public.cash_flow_entries WHERE reference_id=$1", [PAG_A]);
      // O coração do defeito: pagamento mexido, caixa intacto.
      expect(cf.rows[0].n).toBe(0);
    });
    expect(r.ok).toBe(true);
  });
});

describe.sequential("083 aplicada — DML directo fechado para TODOS os papéis", () => {
  it("aplica a migration", async () => {
    await cli.query(sql("083_payment_authorization_hardening.sql"));
    await cli.query("INSERT INTO public._migrations(name,checksum) VALUES($1,'x')",
      ["083_payment_authorization_hardening.sql"]);
  });

  it.each([
    ["colaboradora", COLAB_A],
    ["gestor", GESTOR_A],
    ["admin", ADMIN_A],
  ])("%s: UPDATE directo BLOQUEADO", async (_n, uid) => {
    const r = await como("authenticated", uid, async () => {
      const u = await cli.query(
        "UPDATE public.fixed_variable_payments SET status='pago' WHERE id=$1 RETURNING id", [PAG_A]);
      if (u.rowCount === 0) throw new Error("0 linhas");
      return u;
    });
    expect(r.ok).toBe(false);
  });

  it.each([
    ["colaboradora", COLAB_A],
    ["gestor", GESTOR_A],
    ["admin", ADMIN_A],
  ])("%s: INSERT directo BLOQUEADO", async (_n, uid) => {
    const r = await como("authenticated", uid, () => cli.query(
      `INSERT INTO public.fixed_variable_payments
       (company_id,kind,description,amount,status,period_year,period_month)
       VALUES($1,'fixo','x',10,'pendente',2026,8)`, [EMP_A]));
    expect(r.ok).toBe(false);
  });

  it.each([
    ["colaboradora", COLAB_A],
    ["gestor", GESTOR_A],
    ["admin", ADMIN_A],
  ])("%s: DELETE directo BLOQUEADO", async (_n, uid) => {
    const r = await como("authenticated", uid, async () => {
      const dres = await cli.query("DELETE FROM public.fixed_variable_payments WHERE id=$1 RETURNING id", [PAG_A]);
      if (dres.rowCount === 0) throw new Error("0 linhas");
      return dres;
    });
    expect(r.ok).toBe(false);
  });

  // 🔴 A query tem de nascer DENTRO do callback. Construí-la fora executa-a
  //    já, como `postgres`, e o teste passaria a medir o papel errado.
  it.each([["INSERT"], ["UPDATE"], ["DELETE"]])("anon: %s directo BLOQUEADO", async (op) => {
    const r = await como("anon", null, () =>
      op === "INSERT"
        ? cli.query(`INSERT INTO public.fixed_variable_payments
            (company_id,kind,description,amount,status,period_year,period_month)
            VALUES($1,'fixo','x',10,'pendente',2026,8)`, [EMP_A])
        : op === "UPDATE"
          ? cli.query("UPDATE public.fixed_variable_payments SET status='pago' WHERE id=$1", [PAG_A])
          : cli.query("DELETE FROM public.fixed_variable_payments WHERE id=$1", [PAG_A]));
    expect(r.ok).toBe(false);
  });
});

describe.sequential("083 — SELECT: só gestão da própria empresa", () => {
  const leitura = () => cli.query("SELECT id FROM public.fixed_variable_payments WHERE id=$1", [PAG_A]);

  it("anon: BLOQUEADO", async () => {
    const r = await como("anon", null, leitura);
    expect(r.ok).toBe(false);
  });

  it("colaboradora da empresa A: BLOQUEADO (0 linhas)", async () => {
    await cli.query("BEGIN"); await cli.query("SET LOCAL ROLE authenticated");
    await cli.query("SELECT set_config('request.jwt.claim.sub',$1,true)", [COLAB_A]);
    const q = await leitura();
    await cli.query("ROLLBACK");
    expect(q.rowCount).toBe(0);
  });

  it.each([["gestor", GESTOR_A], ["admin", ADMIN_A]])("%s da empresa A: PERMITIDO", async (_n, uid) => {
    await cli.query("BEGIN"); await cli.query("SET LOCAL ROLE authenticated");
    await cli.query("SELECT set_config('request.jwt.claim.sub',$1,true)", [uid]);
    const q = await leitura();
    await cli.query("ROLLBACK");
    expect(q.rowCount).toBe(1);
  });

  it("🔴 admin da empresa B não lê pagamento da empresa A", async () => {
    await cli.query("BEGIN"); await cli.query("SET LOCAL ROLE authenticated");
    await cli.query("SELECT set_config('request.jwt.claim.sub',$1,true)", [ADMIN_B]);
    const q = await leitura();
    await cli.query("ROLLBACK");
    expect(q.rowCount).toBe(0);
  });
});

describe.sequential("083 — RPC directa fechada por EXECUTE", () => {
  it.each([
    ["colaboradora", COLAB_A],
    ["gestor", GESTOR_A],
    ["admin", ADMIN_A],
  ])("%s: mark_payment_paid recusa por permissão, não por acidente", async (_n, uid) => {
    const r = await como("authenticated", uid, () =>
      cli.query("SELECT public.mark_payment_paid($1,$2,CURRENT_DATE)", [EMP_A, PAG_A]));
    expect(r.ok).toBe(false);
    // 🔴 O motivo importa: tem de ser EXECUTE, não um bloqueio posterior de RLS.
    expect(r.err).toMatch(/permission denied/i);
  });

  it("anon: mark_payment_paid recusa por permissão", async () => {
    const r = await como("anon", null, () =>
      cli.query("SELECT public.mark_payment_paid($1,$2,CURRENT_DATE)", [EMP_A, PAG_A]));
    expect(r.ok).toBe(false);
    expect(r.err).toMatch(/permission denied/i);
  });

  it("unmark_payment_paid também fecha para authenticated", async () => {
    const r = await como("authenticated", ADMIN_A, () =>
      cli.query("SELECT public.unmark_payment_paid($1,$2)", [EMP_A, PAG_A]));
    expect(r.ok).toBe(false);
    expect(r.err).toMatch(/permission denied/i);
  });
});

describe.sequential("083 — as DUAS camadas, medidas em separado", () => {
  // ── TABLE_GRANT_PROOF ─────────────────────────────────────────────────────
  //
  // 🔴 Os SETE privilégios de tabela, um a um, pelo catálogo. A versão
  //    anterior media quatro (SELECT/INSERT/UPDATE/DELETE) e por isso não
  //    podia sustentar a conclusão «authenticated = SOMENTE SELECT»:
  //    TRUNCATE, REFERENCES e TRIGGER ficavam por medir. A fixture agora
  //    concede-os antes da 083, portanto estes `false` são prova de REMOÇÃO,
  //    não de ausência histórica.
  const PRIVILEGIOS = ["SELECT", "INSERT", "UPDATE", "DELETE", "TRUNCATE", "REFERENCES", "TRIGGER"] as const;

  async function acl(role: string) {
    const cols = PRIVILEGIOS.map(
      (pv) => `has_table_privilege('${role}','public.fixed_variable_payments','${pv}') "${pv}"`,
    ).join(", ");
    const r = await cli.query(`SELECT ${cols}`);
    return r.rows[0] as Record<string, boolean>;
  }

  it("TABLE_GRANT_PROOF — authenticated: SOMENTE SELECT", async () => {
    const a = await acl("authenticated");
    // Quem decide as LINHAS é a policy; o privilégio só abre a porta da leitura.
    expect(a.SELECT).toBe(true);
    expect(a.INSERT).toBe(false);
    expect(a.UPDATE).toBe(false);
    expect(a.DELETE).toBe(false);
    expect(a.TRUNCATE).toBe(false);
    expect(a.REFERENCES).toBe(false);
    expect(a.TRIGGER).toBe(false);
  });

  it("TABLE_GRANT_PROOF — anon: NADA", async () => {
    const a = await acl("anon");
    for (const pv of PRIVILEGIOS) expect(a[pv], `anon ${pv}`).toBe(false);
  });

  it("TABLE_GRANT_PROOF — PUBLIC sem grants residuais", async () => {
    // 🔴 PUBLIC não é um role nomeado: aparece na ACL com grantee = 0. Um
    //    grant a PUBLIC chega a TODOS os roles, incluindo anon, e escapava a
    //    qualquer verificação feita só sobre nomes.
    const r = await cli.query(`SELECT coalesce(string_agg(DISTINCT x.priv, ','), '') AS privs
      FROM (SELECT (aclexplode(relacl)).grantee AS g,
                   (aclexplode(relacl)).privilege_type AS priv
              FROM pg_class WHERE oid = 'public.fixed_variable_payments'::regclass) x
     WHERE x.g = 0`);
    expect(r.rows[0].privs).toBe("");
  });

  it("TABLE_GRANT_PROOF — service_role: o DML canónico, e nada de excesso", async () => {
    const a = await acl("service_role");
    expect(a.SELECT).toBe(true);
    expect(a.INSERT).toBe(true);
    expect(a.UPDATE).toBe(true);
    expect(a.DELETE).toBe(true);
    // Não foi `GRANT ALL`: nada no caminho canónico precisa destes três.
    expect(a.TRUNCATE).toBe(false);
    expect(a.REFERENCES).toBe(false);
    expect(a.TRIGGER).toBe(false);
  });

  // ── RLS_PROOF ─────────────────────────────────────────────────────────────
  it("RLS_PROOF — sem os grants na equação, o RLS sozinho barra a escrita", async () => {
    // Devolver o privilégio de tabela isola o RLS: se a escrita passar agora,
    // é porque só o grant a estava a suster — e a policy não protegia nada.
    await cli.query("GRANT INSERT, UPDATE, DELETE ON public.fixed_variable_payments TO authenticated");
    const r = await como("authenticated", ADMIN_A, async () => {
      const u = await cli.query(
        "UPDATE public.fixed_variable_payments SET status='pago' WHERE id=$1 RETURNING id", [PAG_A]);
      if (u.rowCount === 0) throw new Error("RLS: 0 linhas");
      return u;
    });
    await cli.query("REVOKE INSERT, UPDATE, DELETE ON public.fixed_variable_payments FROM authenticated");
    expect(r.ok).toBe(false);
  });

  it("nenhuma policy de escrita existe em fixed_variable_payments", async () => {
    const p = await cli.query(`SELECT policyname, cmd FROM pg_policies
      WHERE schemaname='public' AND tablename='fixed_variable_payments' ORDER BY policyname`);
    expect(p.rows.map((r: { policyname: string }) => r.policyname)).toEqual(["payments_manager_select"]);
    expect(p.rows[0].cmd).toBe("SELECT");
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// TASK 4 — a policy depende do helper SECURITY DEFINER, não de SELECT directo
// ═══════════════════════════════════════════════════════════════════════════
//
// 🔴 A migration afirma que `get_my_role()` foi escolhido em vez de
//    `(SELECT role FROM profiles WHERE id = auth.uid())` porque
//    `authenticated` não tem SELECT em `profiles` e a subconsulta rebentaria.
//
//    A fixture, porém, CONCEDE SELECT em `profiles` a authenticated. Com esse
//    grant no lugar, a policy passaria de qualquer das duas formas — e o teste
//    não distinguia a afirmação da sua negação. Aqui retira-se o grant e
//    mede-se outra vez: se o SELECT continuar a decidir correctamente, é
//    porque quem lê `profiles` é o helper, sob o dono, não o chamador.
describe.sequential("083 — get_my_role sem SELECT directo em profiles", () => {
  const leitura = () => cli.query("SELECT id FROM public.fixed_variable_payments WHERE id=$1", [PAG_A]);

  async function selectComo(uid: string) {
    await cli.query("BEGIN");
    await cli.query("SET LOCAL ROLE authenticated");
    await cli.query("SELECT set_config('request.jwt.claim.sub',$1,true)", [uid]);
    let r: { rowCount: number | null; err?: string };
    try { const q = await leitura(); r = { rowCount: q.rowCount }; }
    catch (e) { r = { rowCount: null, err: (e as Error).message.split("\n")[0] }; }
    await cli.query("ROLLBACK");
    return r;
  }

  beforeAll(async () => {
    await cli.query("REVOKE SELECT ON public.profiles FROM authenticated");
  });

  afterAll(async () => {
    // Reposto para as verificações seguintes da fixture não mudarem de terreno
    // a meio — a prova acima já foi feita sem ele.
    await cli.query("GRANT SELECT ON public.profiles TO authenticated");
  });

  it("o grant foi mesmo retirado (senão a prova seguinte não vale nada)", async () => {
    const g = await cli.query(
      "SELECT has_table_privilege('authenticated','public.profiles','SELECT') s");
    expect(g.rows[0].s).toBe(false);
  });

  it("GESTOR_A_PAYMENT_SELECT_A = ALLOWED", async () => {
    const r = await selectComo(GESTOR_A);
    expect(r.err).toBeUndefined();
    expect(r.rowCount).toBe(1);
  });

  it("ADMIN_A_PAYMENT_SELECT_A = ALLOWED", async () => {
    const r = await selectComo(ADMIN_A);
    expect(r.err).toBeUndefined();
    expect(r.rowCount).toBe(1);
  });

  it("COLLABORATOR_SELECT = BLOCKED", async () => {
    const r = await selectComo(COLAB_A);
    // Bloqueado pela policy (0 linhas), não por erro de permissão em profiles:
    // um "permission denied for table profiles" aqui provaria o contrário.
    expect(r.err).toBeUndefined();
    expect(r.rowCount).toBe(0);
  });

  it("CROSS_COMPANY_SELECT = BLOCKED", async () => {
    const r = await selectComo(ADMIN_B);
    expect(r.err).toBeUndefined();
    expect(r.rowCount).toBe(0);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// TASK 5 — policy desconhecida = FAIL_CLOSED
// ═══════════════════════════════════════════════════════════════════════════
describe.sequential("083 — policy desconhecida faz a migration falhar fechada", () => {
  it("🔴 083 recusa aplicar sobre estado de policies inesperado, sem alterar nada", async () => {
    // Cenário adversarial: alguém criou uma policy fora do versionamento.
    // Note-se que ela é `FOR ALL` — isto é, se a 083 prosseguisse em silêncio,
    // a escrita ficava reaberta por baixo da policy nova.
    await cli.query(`CREATE POLICY "policy_fantasma_fora_do_versionamento"
      ON public.fixed_variable_payments FOR ALL USING (true) WITH CHECK (true)`);

    const antes = await cli.query(`SELECT policyname FROM pg_policies
      WHERE schemaname='public' AND tablename='fixed_variable_payments' ORDER BY policyname`);

    let erro = "";
    try {
      await cli.query(sql("083_payment_authorization_hardening.sql"));
    } catch (e) { erro = (e as Error).message; }

    // 083 = FAIL, com código estável.
    expect(erro).toContain("083_UNEXPECTED_PAYMENT_POLICY_STATE");

    // 🔴 Nenhuma alteração parcial persiste: a migration corre numa transação
    //    implícita, e o RAISE aborta-a inteira. A prova é o estado das
    //    policies estar exactamente como antes da tentativa — em particular,
    //    os DROP POLICY que a 083 faz ANTES do RAISE foram desfeitos.
    const depois = await cli.query(`SELECT policyname FROM pg_policies
      WHERE schemaname='public' AND tablename='fixed_variable_payments' ORDER BY policyname`);
    expect(depois.rows.map((r: { policyname: string }) => r.policyname))
      .toEqual(antes.rows.map((r: { policyname: string }) => r.policyname));

    // E a policy desconhecida NÃO foi apagada pela migration.
    expect(depois.rows.map((r: { policyname: string }) => r.policyname))
      .toContain("policy_fantasma_fora_do_versionamento");

    // Limpar o cenário à mão — é o operador humano a decidir, que é
    // precisamente o que o fail-closed exige — e reaplicar a 083 limpa.
    await cli.query('DROP POLICY "policy_fantasma_fora_do_versionamento" ON public.fixed_variable_payments');
    await cli.query(sql("083_payment_authorization_hardening.sql"));

    const final = await cli.query(`SELECT policyname FROM pg_policies
      WHERE schemaname='public' AND tablename='fixed_variable_payments'`);
    expect(final.rows.map((r: { policyname: string }) => r.policyname)).toEqual(["payments_manager_select"]);
  });
});

describe.sequential("083 — o caminho canónico continua intacto", () => {
  it("service_role: mark cria pagamento pago + caixa + proveniência", async () => {
    await cli.query("BEGIN"); await cli.query("SET LOCAL ROLE service_role");
    await cli.query("SELECT public.mark_payment_paid($1,$2,CURRENT_DATE)", [EMP_A, PAG_A]);
    const pg2 = await cli.query("SELECT status, paid_at FROM public.fixed_variable_payments WHERE id=$1", [PAG_A]);
    const cf = await cli.query(
      `SELECT status, type, amount FROM public.cash_flow_entries
        WHERE reference_type='fixed_variable_payment' AND reference_id=$1`, [PAG_A]);
    const pr = await cli.query(
      "SELECT origin FROM public.payment_cashflow_provenance WHERE payment_id=$1", [PAG_A]);
    expect(pg2.rows[0].status).toBe("pago");
    expect(pg2.rows[0].paid_at).not.toBeNull();
    expect(cf.rowCount).toBe(1);
    expect(cf.rows[0].status).toBe("confirmado");
    expect(cf.rows[0].type).toBe("saida");
    expect(pr.rows[0].origin).toBe("created_by_mark");

    // ...e o unmark devolve tudo ao estado anterior.
    await cli.query("SELECT public.unmark_payment_paid($1,$2)", [EMP_A, PAG_A]);
    const dep = await cli.query("SELECT status, paid_at FROM public.fixed_variable_payments WHERE id=$1", [PAG_A]);
    const cf2 = await cli.query(
      `SELECT count(*)::int n FROM public.cash_flow_entries
        WHERE reference_type='fixed_variable_payment' AND reference_id=$1`, [PAG_A]);
    const pr2 = await cli.query(
      "SELECT count(*)::int n FROM public.payment_cashflow_provenance WHERE payment_id=$1", [PAG_A]);
    expect(dep.rows[0].status).toBe("pendente");
    expect(dep.rows[0].paid_at).toBeNull();
    expect(cf2.rows[0].n).toBe(0);
    expect(pr2.rows[0].n).toBe(0);
    await cli.query("ROLLBACK");
  });

  it("service_role: cria e edita pagamento pelo caminho do servidor", async () => {
    await cli.query("BEGIN"); await cli.query("SET LOCAL ROLE service_role");
    const novo = await cli.query(`INSERT INTO public.fixed_variable_payments
      (company_id,kind,description,amount,status,period_year,period_month)
      VALUES($1,'fixo','novo',10,'pendente',2026,8) RETURNING id, status`, [EMP_A]);
    expect(novo.rows[0].status).toBe("pendente");
    const upd = await cli.query(
      "UPDATE public.fixed_variable_payments SET amount=20 WHERE id=$1 RETURNING amount",
      [novo.rows[0].id]);
    expect(Number(upd.rows[0].amount)).toBe(20);
    await cli.query("ROLLBACK");
  });

  it("🔴 cross-company continua impossível mesmo pelo service_role", async () => {
    await cli.query("BEGIN"); await cli.query("SET LOCAL ROLE service_role");
    let erro = "";
    try {
      await cli.query("SELECT public.mark_payment_paid($1,$2,CURRENT_DATE)", [EMP_B, PAG_A]);
    } catch (e) { erro = (e as Error).message; }
    await cli.query("ROLLBACK");
    expect(erro).toMatch(/inexistente ou de outra empresa/i);
  });
});

describe.sequential("083 — ACL final das funções", () => {
  it("mark/unmark/helpers: sem PUBLIC, sem anon, sem authenticated", async () => {
    const r = await cli.query(`SELECT p.proname,
        has_function_privilege('anon', p.oid, 'EXECUTE') anon_x,
        has_function_privilege('authenticated', p.oid, 'EXECUTE') auth_x,
        has_function_privilege('service_role', p.oid, 'EXECUTE') svc_x
      FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
      WHERE n.nspname='public' AND p.proname IN
        ('mark_payment_paid','unmark_payment_paid','assert_payment_cashflow_link','is_financial_period_open')
      ORDER BY p.proname`);
    expect(r.rowCount).toBe(4);
    for (const f of r.rows) {
      expect(f.anon_x, `${f.proname} anon`).toBe(false);
      expect(f.auth_x, `${f.proname} authenticated`).toBe(false);
      expect(f.svc_x, `${f.proname} service_role`).toBe(true);
    }
  });
});

describe.sequential("083 — rollback repõe o prestate (e reabre o buraco)", () => {
  it("o rollback devolve policy e grants, e o defeito volta", async () => {
    await cli.query(readFileSync(
      join(ROOT, "supabase", "migrations", "rollback", "083_payment_authorization_hardening.down.sql"), "utf8"));

    const p = await cli.query(`SELECT policyname FROM pg_policies
      WHERE schemaname='public' AND tablename='fixed_variable_payments'`);
    expect(p.rows.map((r: { policyname: string }) => r.policyname))
      .toEqual(["company members manage fixed variable payments"]);

    // 🔴 A prova de que ROLLBACK_083_REOPENS_KNOWN_SECURITY_BUG = YES.
    const r = await como("authenticated", COLAB_A, async () => {
      const u = await cli.query(
        "UPDATE public.fixed_variable_payments SET status='pago' WHERE id=$1 RETURNING id", [PAG_A]);
      if (u.rowCount === 0) throw new Error("0 linhas");
      return u;
    });
    expect(r.ok).toBe(true);

    // Reaplicar, para o container não ficar num estado inseguro.
    await cli.query(sql("083_payment_authorization_hardening.sql"));
  });
});

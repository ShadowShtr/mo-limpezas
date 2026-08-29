// ============================================================================
// 084 — fecho do ACL residual de fixed_variable_payments
// ============================================================================
//
// 🔴 A fixture da 083 fabricava um prestate mais seguro do que a produção.
//
//    Ela concedia `SELECT, INSERT, UPDATE, DELETE` aos papéis da API e mais
//    nada. Produção corre o `GRANT ALL ON ALL TABLES IN SCHEMA public TO anon,
//    authenticated, service_role` que o Supabase aplica por omissão — os oito
//    privilégios de tabela, não quatro. A 083 revogava por enumeração e por
//    isso os outros quatro sobreviveram-lhe; a fixture nunca os teve, e por
//    isso a 083 ficou verde sobre um defeito que continuava lá.
//
//    Um ensaio que constrói um mundo mais seguro do que o real não prova nada
//    sobre o real. Este ficheiro reproduz o `GRANT ALL` e mede os OITO
//    privilégios, MAINTAIN incluído — o privilégio que o PostgreSQL 17 trouxe
//    e que a matriz antiga não conhecia.
//
// A prova tem três degraus, e é a sequência que interessa:
//
//     ANTES_083   os oito privilégios estão lá, para toda a gente
//     DEPOIS_083  o CRUD fecha — e TRUNCATE/REFERENCES/TRIGGER/MAINTAIN ficam
//     DEPOIS_084  só sobra o ACL final
//
// Tudo em PostgreSQL 17 real, com a versão perguntada ao servidor.
// ============================================================================

import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const ROOT = process.cwd();
const CONTAINER = `acl084-${process.pid}`;
let port = 0;
let pool: pg.Pool;

const docker = (a: string[]) => spawnSync("docker", a, { cwd: ROOT, encoding: "utf8" });
const sql = (nome: string) => fs.readFileSync(path.join(ROOT, "supabase", "migrations", nome), "utf8");
const rollbackSql = (nome: string) =>
  fs.readFileSync(path.join(ROOT, "supabase", "migrations", "rollback", nome), "utf8");

const M073 = "073_payment_to_cashflow.sql";
const M079 = "079_reuse_pending_cashflow_on_payment.sql";
const M080 = "080_payment_cashflow_provenance.sql";
const M081 = "081_safe_unmark_payment_paid.sql";
const M082 = "082_atomic_finance_mutations.sql";
const M083 = "083_payment_authorization_hardening.sql";
const M084 = "084_payment_table_acl_closure.sql";

/** Checksum canónico da 083 no ledger de produção — o mesmo que a 084 exige. */
const CHECKSUM_083 = "056763d8307f70bfe60534b94aed1e78e4e72c3ed8c65aa37bf945579f581f5a";

const EMPRESA = "11111111-1111-4111-8111-111111111111";

/** As seis funções que a 082 cria, mais as duas da 083. */
const FUNCOES_MUTACAO = [
  "public.update_payment_atomic(uuid, uuid, jsonb)",
  "public.delete_payment_atomic(uuid, uuid)",
  "public.lock_cashflow_for_manual_mutation(uuid, uuid)",
  "public.update_cashflow_entry_atomic(uuid, uuid, jsonb)",
  "public.delete_cashflow_entry_atomic(uuid, uuid)",
  "public.confirm_bank_match_atomic(uuid, uuid, uuid)",
  "public.mark_payment_paid(uuid, uuid, date)",
  "public.unmark_payment_paid(uuid, uuid)",
];

const PAPEIS = ["public", "anon", "authenticated", "service_role"] as const;

/**
 * 🔴 Os OITO privilégios de tabela do PostgreSQL 17, não quatro.
 *
 *    MAINTAIN é o que faltava, e não é uma curiosidade de catálogo: produção
 *    tem-no concedido hoje. Uma matriz que o omite mede o ACL de um PostgreSQL
 *    que não é aquele onde o código corre.
 */
const PRIVILEGIOS = [
  "SELECT", "INSERT", "UPDATE", "DELETE",
  "TRUNCATE", "REFERENCES", "TRIGGER", "MAINTAIN",
] as const;

const BASE = `
  DROP SCHEMA IF EXISTS public CASCADE; CREATE SCHEMA public;
  DROP SCHEMA IF EXISTS auth CASCADE; CREATE SCHEMA auth;
  CREATE FUNCTION auth.uid() RETURNS uuid LANGUAGE sql STABLE
    AS $a$ SELECT NULLIF(current_setting('request.jwt.claim.sub', true), '')::uuid $a$;
  DO $p$ BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname='anon') THEN CREATE ROLE anon; END IF;
    IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname='authenticated') THEN CREATE ROLE authenticated; END IF;
    IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname='service_role') THEN CREATE ROLE service_role BYPASSRLS; END IF;
  END $p$;
  GRANT USAGE ON SCHEMA public TO anon, authenticated, service_role;
  GRANT USAGE ON SCHEMA auth TO anon, authenticated, service_role;

  CREATE TABLE public.companies (id uuid PRIMARY KEY, name text NOT NULL);
  CREATE TABLE public.profiles (id uuid PRIMARY KEY, company_id uuid, auth_user_id uuid, role text);
  CREATE TABLE public.expense_categories (
    id uuid PRIMARY KEY, company_id uuid NOT NULL, name text NOT NULL, color text);
  CREATE TABLE public.financial_periods (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(), company_id uuid NOT NULL,
    year integer NOT NULL, month integer NOT NULL,
    status text NOT NULL CHECK (status IN ('open','closed')), UNIQUE(company_id, year, month));
  CREATE TABLE public.fixed_variable_payments (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(), company_id uuid NOT NULL,
    kind text NOT NULL CHECK (kind IN ('fixo','variavel')), description text NOT NULL,
    amount numeric(10,2), due_date date,
    status text NOT NULL DEFAULT 'pendente' CHECK (status IN ('pago','pendente')),
    recurring boolean NOT NULL DEFAULT false, period_year integer NOT NULL,
    period_month integer NOT NULL, paid_at timestamptz, notes text,
    expense_category_id uuid, attachment_url text, attachment_name text,
    direct_debit boolean,
    created_at timestamptz NOT NULL DEFAULT now(),
    updated_at timestamptz NOT NULL DEFAULT now());
  CREATE TABLE public.cash_flow_entries (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(), company_id uuid NOT NULL,
    type text NOT NULL CHECK (type IN ('entrada','saida')), amount numeric(10,2) NOT NULL,
    description text NOT NULL, category text, date date NOT NULL,
    reference_id uuid, reference_type text,
    status text NOT NULL CHECK (status IN ('pendente','confirmado')),
    expense_category_id uuid, notes text, created_by uuid,
    created_at timestamptz NOT NULL DEFAULT now());
  CREATE UNIQUE INDEX cash_flow_entries_reference_unique
    ON public.cash_flow_entries(company_id, reference_type, reference_id)
    WHERE reference_type IS NOT NULL AND reference_id IS NOT NULL;
  CREATE TABLE public.bank_transactions (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(), company_id uuid NOT NULL,
    status text NOT NULL DEFAULT 'pending', updated_at timestamptz);
  CREATE TABLE public.bank_reconciliation_matches (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(), company_id uuid NOT NULL,
    bank_transaction_id uuid NOT NULL REFERENCES public.bank_transactions(id) ON DELETE CASCADE,
    cash_flow_entry_id uuid REFERENCES public.cash_flow_entries(id) ON DELETE CASCADE,
    match_score integer NOT NULL DEFAULT 0, match_reason text,
    status text NOT NULL DEFAULT 'confirmed'
      CHECK (status IN ('suggested','confirmed','rejected')),
    confirmed_by uuid, confirmed_at timestamptz,
    created_at timestamptz NOT NULL DEFAULT now());
  CREATE TABLE public._migrations (
    name text PRIMARY KEY, checksum text, applied_at timestamptz NOT NULL DEFAULT now());
  CREATE FUNCTION public.get_my_role() RETURNS text
    LANGUAGE sql SECURITY DEFINER STABLE
    AS $r$ SELECT role FROM public.profiles WHERE auth_user_id = auth.uid() LIMIT 1 $r$;
  CREATE FUNCTION public.get_my_company_id() RETURNS uuid
    LANGUAGE sql SECURITY DEFINER STABLE
    AS $c$ SELECT company_id FROM public.profiles WHERE auth_user_id = auth.uid() LIMIT 1 $c$;
`;

/**
 * 🔴 O prestate REAL, e é aqui que este ficheiro difere do da 083.
 *
 *    `GRANT ALL PRIVILEGES ON ALL TABLES` é literalmente o que o Supabase corre
 *    numa base nova. Reproduzi-lo é a única forma de a 083 poder ficar
 *    vermelha por aquilo que lhe escapou — e de a 084 poder provar que fecha
 *    alguma coisa em vez de confirmar um estado já limpo.
 *
 *    A policy `FOR ALL` da 037 entra pelo mesmo motivo: é o que a 083 substitui.
 */
const PRESTATE_SUPABASE = `
  ALTER TABLE public.fixed_variable_payments ENABLE ROW LEVEL SECURITY;
  DROP POLICY IF EXISTS "company members manage fixed variable payments"
    ON public.fixed_variable_payments;
  CREATE POLICY "company members manage fixed variable payments"
    ON public.fixed_variable_payments
    USING (company_id IN (SELECT company_id FROM public.profiles WHERE auth_user_id = auth.uid()));
  GRANT ALL PRIVILEGES ON ALL TABLES IN SCHEMA public TO anon, authenticated, service_role;
`;

async function esperar() {
  const limite = Date.now() + 90_000;
  while (Date.now() < limite) {
    if (docker(["exec", CONTAINER, "pg_isready", "-U", "postgres", "-d", "acl"]).status === 0) {
      const c = new pg.Client({ host: "127.0.0.1", port, user: "postgres", database: "acl" });
      try { await c.connect(); await c.query("SELECT 1"); await c.end(); return; }
      catch { try { await c.end(); } catch { /* nunca abriu */ } }
    }
    await new Promise((r) => setTimeout(r, 300));
  }
  throw new Error("PostgreSQL descartável não ficou pronto.");
}

beforeAll(async () => {
  docker(["rm", "-f", CONTAINER]);
  const r = docker(["run", "-d", "--name", CONTAINER,
    "-e", "POSTGRES_HOST_AUTH_METHOD=trust", "-e", "POSTGRES_DB=acl",
    "-p", "127.0.0.1::5432", "postgres:17-alpine"]);
  if (r.status !== 0) throw new Error(`contentor: ${r.stderr || r.stdout}`);
  const m = docker(["port", CONTAINER, "5432/tcp"]).stdout.trim();
  port = Number(m.slice(m.lastIndexOf(":") + 1));
  if (!Number.isInteger(port) || port < 1) throw new Error(`Porta inválida: ${m}`);
  await esperar();
  pool = new pg.Pool({ host: "127.0.0.1", port, user: "postgres", database: "acl", max: 4 });
}, 180_000);

afterAll(async () => {
  try { await pool?.end(); } catch { /* já fechada */ }
  docker(["rm", "-f", CONTAINER]);
});

// ─── Utilitários ────────────────────────────────────────────────────────────

/** Reproduz o que o runner faz por cada migration: tudo numa transacção. */
async function aplicarComoRunner(c: pg.PoolClient, nome: string, checksum: string) {
  await c.query("BEGIN");
  await c.query(sql(nome));
  await c.query("INSERT INTO public._migrations(name, checksum) VALUES($1,$2)", [nome, checksum]);
  await c.query("COMMIT");
}

/** Aplica texto SQL arbitrário (mutações) do mesmo modo que o runner. */
async function aplicarTexto(c: pg.PoolClient, texto: string) {
  await c.query("BEGIN");
  try { await c.query(texto); await c.query("COMMIT"); }
  catch (e) { await c.query("ROLLBACK"); throw e; }
}

/**
 * Devolve a ligação à pool sem transacção aberta.
 *
 * 🔴 O `pg.Pool` não repõe o estado da sessão no `release()`. Um teste que
 *    rebente dentro de um `BEGIN` devolve a ligação em transacção abortada, e
 *    o teste seguinte que a apanhe falha com «current transaction is aborted»
 *    — um erro que não tem nada que ver com o que ele mede. Um `ROLLBACK` fora
 *    de transacção é inofensivo (só emite um aviso), por isso corre sempre.
 */
async function limpar(c: pg.PoolClient) {
  try { await c.query("ROLLBACK"); } catch { /* ligação já morta */ }
  c.release();
}

/** Base + 073→081 + o prestate largo do Supabase. Ainda sem 082/083/084. */
async function preparar(c: pg.PoolClient) {
  await c.query(BASE);
  for (const m of [M073, M079, M080, M081]) {
    await c.query("BEGIN");
    await c.query(sql(m));
    await c.query("INSERT INTO public._migrations(name, checksum) VALUES($1,'ensaio')", [m]);
    await c.query("COMMIT");
  }
  await c.query(PRESTATE_SUPABASE);
  await c.query("INSERT INTO public.companies(id,name) VALUES($1,'Ensaio')", [EMPRESA]);
  await c.query(
    "INSERT INTO public.financial_periods(company_id, year, month, status) VALUES($1,2026,8,'open')",
    [EMPRESA]);
}

/** A matriz completa: 4 papéis × 8 privilégios, perguntada ao catálogo. */
async function matriz(c: pg.PoolClient | pg.Pool): Promise<Record<string, boolean>> {
  const m: Record<string, boolean> = {};
  for (const papel of PAPEIS) {
    for (const p of PRIVILEGIOS) {
      const { rows } = await c.query(
        "SELECT has_table_privilege($1,'public.fixed_variable_payments',$2) AS tem", [papel, p]);
      m[`${papel}:${p}`] = rows[0].tem as boolean;
    }
  }
  return m;
}

/** O ACL final exacto que a 084 tem de deixar (nada mais, nada menos). */
function matrizEsperada(): Record<string, boolean> {
  const m: Record<string, boolean> = {};
  for (const papel of PAPEIS) {
    for (const p of PRIVILEGIOS) {
      m[`${papel}:${p}`] =
        (papel === "authenticated" && p === "SELECT") ||
        (papel === "service_role" && ["SELECT", "INSERT", "UPDATE", "DELETE"].includes(p));
    }
  }
  return m;
}

async function podeExecutar(c: pg.PoolClient | pg.Pool, papel: string, f: string) {
  const { rows } = await c.query("SELECT has_function_privilege($1,$2,'EXECUTE') AS p", [papel, f]);
  return rows[0].p as boolean;
}

// ═══════════════════════════════════════════════════════════════════════════
// 0 — o motor
// ═══════════════════════════════════════════════════════════════════════════

describe.sequential("084 — o motor", () => {
  it("🔴 corre em PostgreSQL 17, perguntado ao servidor", async () => {
    const { rows } = await pool.query(
      "SELECT version() AS v, current_setting('server_version') AS sv");
    expect(rows[0].v).toMatch(/^PostgreSQL 17\./);
    expect(String(rows[0].sv).split(".")[0]).toBe("17");
  });

  it("🔴 MAINTAIN existe mesmo neste motor — a matriz não mede um nome vazio", async () => {
    // Se `has_table_privilege` não conhecesse MAINTAIN, rebentava em vez de
    // devolver `false`. A distinção importa: uma matriz que devolvesse `false`
    // por ignorância dava verde exactamente onde é preciso vermelho.
    const c = await pool.connect();
    try {
      await preparar(c);
      const { rows } = await c.query(
        "SELECT has_table_privilege('anon','public.fixed_variable_payments','MAINTAIN') AS tem");
      expect(typeof rows[0].tem).toBe("boolean");
    } finally { await limpar(c); }
  }, 120_000);

  it("o ficheiro não abre nem fecha transacção própria — a transacção é do runner", () => {
    const linhas = sql(M084).split("\n").map((l) => l.trim());
    expect(linhas.filter((l) => l === "BEGIN;")).toHaveLength(0);
    expect(linhas.filter((l) => l === "COMMIT;")).toHaveLength(0);
  });

  it("🔴 083_FILE_CHANGED = NO — o checksum do repo é o do ledger de produção", () => {
    // A 084 hard-codeia este valor na precondição. Se alguém editar a 083, esta
    // asserção fica vermelha aqui, e não a meio de uma aplicação em produção.
    const bruto = fs.readFileSync(path.join(ROOT, "supabase", "migrations", M083), "utf8");
    const lf = bruto.replace(/\r\n/g, "\n").replace(/\r/g, "\n");
    const hex = createHash("sha256").update(lf).digest("hex");
    expect(hex).toBe(CHECKSUM_083);
    expect(sql(M084)).toContain(CHECKSUM_083);
  });
});


// ═══════════════════════════════════════════════════════════════════════════
// 1 — a fixture reproduz o defeito real (TASK 7)
// ═══════════════════════════════════════════════════════════════════════════

describe.sequential("PROD_BUG_REPRODUCED_IN_FIXTURE — os três degraus", () => {
  let antes083: Record<string, boolean>;
  let depois083: Record<string, boolean>;
  let depois084: Record<string, boolean>;

  it("ANTES_083: os oito privilégios estão concedidos, como em produção", async () => {
    const c = await pool.connect();
    try {
      await preparar(c);
      antes083 = await matriz(c);
    } finally { await limpar(c); }

    for (const papel of ["anon", "authenticated", "service_role"]) {
      for (const p of PRIVILEGIOS) {
        expect(antes083[`${papel}:${p}`], `${papel}:${p}`).toBe(true);
      }
    }
  }, 120_000);

  it("🔴 DEPOIS_083: o CRUD fecha — e os outros quatro sobrevivem", async () => {
    const c = await pool.connect();
    try {
      await aplicarComoRunner(c, M083, CHECKSUM_083);
      depois083 = await matriz(c);
    } finally { await limpar(c); }

    // O que a 083 prometeu, e cumpriu.
    for (const papel of ["anon", "authenticated"]) {
      for (const p of ["INSERT", "UPDATE", "DELETE"]) {
        expect(depois083[`${papel}:${p}`], `${papel}:${p}`).toBe(false);
      }
    }
    expect(depois083["anon:SELECT"]).toBe(false);
    expect(depois083["authenticated:SELECT"]).toBe(true);

    // 🔴 E o que lhe escapou. Este bloco É o bug da 083: quatro privilégios
    //    intactos, `anon` incluído, sobre a tabela financeira.
    for (const papel of ["anon", "authenticated", "service_role"]) {
      for (const p of ["TRUNCATE", "REFERENCES", "TRIGGER", "MAINTAIN"]) {
        expect(depois083[`${papel}:${p}`], `083 devia ter fechado ${papel}:${p}`).toBe(true);
      }
    }
  }, 120_000);

  it("🔴 TRUNCATE não passa por RLS — o privilégio residual não é decorativo", async () => {
    // A 083 fecha o DML e a policy só cobre SELECT. TRUNCATE não é DML e o RLS
    // não se lhe aplica: com o privilégio concedido, `anon` apagava a tabela
    // financeira inteira sem gerar um único movimento de caixa.
    const c = await pool.connect();
    try {
      await c.query("INSERT INTO public.fixed_variable_payments" +
        "(company_id,kind,description,amount,period_year,period_month)" +
        " VALUES($1,'fixo','Fornecedor',100,2026,8)", [EMPRESA]);

      await c.query("BEGIN");
      await c.query("SET LOCAL ROLE anon");
      // 🔴 CASCADE porque a 080 pendurou uma chave estrangeira nesta tabela.
      //    Não é um detalhe de fixture: significa que o mesmo TRUNCATE leva
      //    atrás a proveniência dos movimentos, e a 083 concedeu a `anon`
      //    privilégio de TRUNCATE em todas elas.
      await c.query("TRUNCATE public.fixed_variable_payments CASCADE");
      // 🔴 A contagem volta a ser feita como `postgres`. `anon` acabou de
      //    apagar a tabela inteira e não tem sequer SELECT para a ler — a 083
      //    fechou-lhe a leitura e deixou-lhe a destruição.
      await c.query("RESET ROLE");
      const { rows } = await c.query("SELECT count(*)::int n FROM public.fixed_variable_payments");
      expect(rows[0].n, "TRUNCATE por anon devia ter passado no estado pós-083").toBe(0);
      await c.query("ROLLBACK");
    } finally { await limpar(c); }
  }, 120_000);

  it("🔴 DEPOIS_084: sobra exactamente o ACL final, e mais nada", async () => {
    const c = await pool.connect();
    try {
      await aplicarComoRunner(c, M084, "ensaio");
      depois084 = await matriz(c);
    } finally { await limpar(c); }

    expect(depois084).toEqual(matrizEsperada());
  }, 120_000);

  it("a progressão é monótona: a 084 só retira privilégios, nunca acrescenta", async () => {
    // Uma migration de fecho que concedesse alguma coisa nova seria outra coisa
    // qualquer. A única entrada que pode ser `true` no fim tinha de ser `true`
    // antes — e a 084 nem sequer devolve o SELECT do gestor, herda-o.
    for (const chave of Object.keys(depois084)) {
      if (depois084[chave]) {
        expect(depois083[chave], `${chave} nasceu na 084`).toBe(true);
      }
    }
  });

  it("🔴 depois da 084, `anon` já não trunca nada", async () => {
    const c = await pool.connect();
    try {
      let erro = "";
      await c.query("BEGIN");
      await c.query("SET LOCAL ROLE anon");
      try { await c.query("TRUNCATE public.fixed_variable_payments CASCADE"); }
      catch (e) { erro = (e as Error).message; }
      await c.query("ROLLBACK");
      expect(erro).toMatch(/permission denied/i);
    } finally { await limpar(c); }
  }, 120_000);
});

// ═══════════════════════════════════════════════════════════════════════════
// 2 — precondições fail-closed (TASK 4)
// ═══════════════════════════════════════════════════════════════════════════

describe.sequential("084 — UNKNOWN_STATE = FAIL_CLOSED", () => {
  /** Monta o estado pós-083 e devolve a matriz de ACL nesse ponto. */
  async function estadoPos083(c: pg.PoolClient) {
    await preparar(c);
    await aplicarComoRunner(c, M083, CHECKSUM_083);
    return matriz(c);
  }

  it("🔴 083 ausente do ledger: recusa, e não altera nada", async () => {
    const c = await pool.connect();
    try {
      const antes = await estadoPos083(c);
      await c.query("DELETE FROM public._migrations WHERE name=$1", [M083]);

      await expect(aplicarTexto(c, sql(M084)))
        .rejects.toThrow(/084_UNEXPECTED_PAYMENT_AUTHORIZATION_STATE/);

      // 🔴 «Nenhuma alteração antes da guarda» tem de ser medido, não assumido.
      expect(await matriz(c)).toEqual(antes);
    } finally { await limpar(c); }
  }, 120_000);

  it("🔴 083 duplicada no ledger: recusa", async () => {
    const c = await pool.connect();
    try {
      const antes = await estadoPos083(c);
      // A chave primária do ledger torna a duplicação impossível por acidente.
      // Retira-se de propósito, porque a guarda foi escrita para um ledger
      // reconciliado à mão — e é aí que a duplicação aparece de verdade.
      await c.query("ALTER TABLE public._migrations DROP CONSTRAINT _migrations_pkey");
      await c.query("INSERT INTO public._migrations(name,checksum) VALUES($1,$2)",
        [M083, CHECKSUM_083]);

      await expect(aplicarTexto(c, sql(M084)))
        .rejects.toThrow(/084_UNEXPECTED_PAYMENT_AUTHORIZATION_STATE/);
      expect(await matriz(c)).toEqual(antes);
    } finally { await limpar(c); }
  }, 120_000);

  /**
   * 🔴 O checksum da 083 é exigido por igualdade exacta — sem excepções.
   *
   *    A primeira versão desta guarda só comparava quando o valor tinha forma
   *    de sha256, para deixar as fixtures gravarem um checksum de conveniência.
   *    Era um fail-OPEN: `NULL`, texto, ou um valor truncado passavam sem
   *    verificação — e um ledger nesse estado é justamente o sinal de que
   *    alguém lhe mexeu à mão, que é o caso para o qual a precondição existe.
   *
   *    Os três cenários abaixo são a prova de que a excepção morreu. As
   *    fixtures gravam o checksum canónico, como produção: uma migration que
   *    se comporta de outra maneira debaixo do ensaio não é a migration que se
   *    está a ensaiar.
   */
  it.each([
    ["sha256 válido mas errado", "f".repeat(64)],
    ["texto sem forma de sha256", "ensaio"],
    ["sha256 truncado", "056763d8"],
    ["NULL", null],
  ])("🔴 checksum da 083 %s: recusa, e não altera nada", async (_n, valor) => {
    const c = await pool.connect();
    try {
      const antes = await estadoPos083(c);
      await c.query("UPDATE public._migrations SET checksum=$2 WHERE name=$1", [M083, valor]);

      await expect(aplicarTexto(c, sql(M084)))
        .rejects.toThrow(/084_UNEXPECTED_PAYMENT_AUTHORIZATION_STATE/);
      expect(await matriz(c)).toEqual(antes);
    } finally { await limpar(c); }
  }, 120_000);

  it("🔴 e o `NULL` recusa por `IS DISTINCT FROM`, não por acaso", async () => {
    // Com `<>` o PostgreSQL devolveria `NULL` na comparação, o `IF` não
    // disparava, e a guarda voltava a falhar aberta pela porta do lado — o
    // mesmo defeito com outra roupa. A asserção é sobre o texto da migration
    // porque é ali que a escolha vive.
    //
    // 🔴 E mede o SQL, não os comentários. A migration explica a forma antiga
    //    à letra para que se perceba o que mudou; uma varredura que confundisse
    //    as duas coisas dava vermelho a quem documenta e verde a quem
    //    reintroduzisse a comparação frouxa sem uma palavra.
    const codigo = sql(M084)
      .split("\n")
      .filter((l) => !l.trimStart().startsWith("--"))
      .join("\n");

    expect(codigo).toContain("v_checksum IS DISTINCT FROM c_083_checksum");
    expect(codigo).not.toMatch(/v_checksum\s*<>\s*c_083_checksum/);
    expect(codigo).not.toMatch(/v_checksum\s*~\s*'\^\[0-9a-f\]\{64\}\$'/);
  });

  it("o checksum canónico exacto deixa a 084 aplicar-se", async () => {
    // O contra-exemplo dos quatro acima. Sem ele, uma guarda que recusasse
    // tudo passaria por «fail-closed» e ninguém dava por isso.
    const c = await pool.connect();
    try {
      await preparar(c);
      await aplicarComoRunner(c, M083, CHECKSUM_083);
      await aplicarTexto(c, sql(M084));
      expect(await matriz(c)).toEqual(matrizEsperada());
    } finally { await limpar(c); }
  }, 120_000);

  it("🔴 policy inesperada presente: recusa, e NÃO a apaga", async () => {
    const c = await pool.connect();
    try {
      const antes = await estadoPos083(c);
      await c.query(`CREATE POLICY "intrusa" ON public.fixed_variable_payments
                     FOR UPDATE USING (true) WITH CHECK (true)`);

      await expect(aplicarTexto(c, sql(M084)))
        .rejects.toThrow(/084_UNEXPECTED_PAYMENT_AUTHORIZATION_STATE/);

      // 🔴 Não «normalizar» é metade da guarda. Apagar uma policy que não
      //    reconhecemos seria decidir em silêncio sobre uma intenção alheia.
      const { rows } = await c.query(
        `SELECT policyname FROM pg_policies
          WHERE schemaname='public' AND tablename='fixed_variable_payments'
          ORDER BY policyname`);
      expect(rows.map((r: { policyname: string }) => r.policyname))
        .toEqual(["intrusa", "payments_manager_select"]);
      expect(await matriz(c)).toEqual(antes);
    } finally { await limpar(c); }
  }, 120_000);

  it("🔴 083 revertida (policy da 037 de volta): recusa", async () => {
    const c = await pool.connect();
    try {
      await preparar(c);
      await aplicarComoRunner(c, M083, CHECKSUM_083);
      const antes = await matriz(c);
      await c.query(rollbackSql("083_payment_authorization_hardening.down.sql"));

      await expect(aplicarTexto(c, sql(M084)))
        .rejects.toThrow(/084_UNEXPECTED_PAYMENT_AUTHORIZATION_STATE/);
      // O rollback da 083 já mexeu no ACL; o que se exige aqui é que a 084 não
      // tenha mexido mais — a matriz é a de depois do rollback, não a de antes.
      expect(await matriz(c)).not.toEqual(antes);
      expect((await matriz(c))["authenticated:UPDATE"]).toBe(true);
    } finally { await limpar(c); }
  }, 120_000);
});

// ═══════════════════════════════════════════════════════════════════════════
// 3 — provas de mutação (TASK 6/7)
// ═══════════════════════════════════════════════════════════════════════════

describe.sequential("084 — provas de mutação", () => {
  const M084_TEXTO = sql(M084);

  /** A 084 escrita como a 083: revogar por enumeração em vez de por conjunto. */
  const MUTACAO_ENUMERADA = M084_TEXTO.replace(
    /REVOKE ALL PRIVILEGES ON TABLE public\.fixed_variable_payments FROM/g,
    "REVOKE SELECT, INSERT, UPDATE, DELETE ON TABLE public.fixed_variable_payments FROM");

  /** A 084 a devolver tudo ao service_role, que é o atalho tentador. */
  const MUTACAO_GRANT_ALL = M084_TEXTO.replace(
    "GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.fixed_variable_payments TO service_role;",
    "GRANT ALL PRIVILEGES ON TABLE public.fixed_variable_payments TO service_role;");

  /** A mesma 084, sem a auto-verificação final. */
  const SEM_POSESTADO = M084_TEXTO.slice(0, M084_TEXTO.indexOf("DO $posestado$"));

  it("as três mutações são mesmo diferentes do original", () => {
    expect(MUTACAO_ENUMERADA).not.toBe(M084_TEXTO);
    expect(MUTACAO_GRANT_ALL).not.toBe(M084_TEXTO);
    expect(SEM_POSESTADO).not.toBe(M084_TEXTO);
    expect(SEM_POSESTADO.length).toBeLessThan(M084_TEXTO.length);
  });

  async function pos083(c: pg.PoolClient) {
    await preparar(c);
    await aplicarComoRunner(c, M083, CHECKSUM_083);
  }

  it("🔴 revogar por enumeração: a própria migration recusa-se a confirmar", async () => {
    const c = await pool.connect();
    try {
      await pos083(c);
      await expect(aplicarTexto(c, MUTACAO_ENUMERADA))
        .rejects.toThrow(/084_ACL_CLOSURE_POSTSTATE_FAILED/);
    } finally { await limpar(c); }
  }, 120_000);

  it("🔴 e se a auto-verificação também fosse removida, a matriz apanha-a", async () => {
    // Duas mutações ao mesmo tempo — a defesa da migration e a do ensaio. Se
    // este teste ficasse verde, a prova do ACL dependeria só do bloco de
    // pós-estado, e uma migration não deve ser a única testemunha de si mesma.
    const c = await pool.connect();
    try {
      await pos083(c);
      const duplaMutacao = SEM_POSESTADO.replace(
        /REVOKE ALL PRIVILEGES ON TABLE public\.fixed_variable_payments FROM/g,
        "REVOKE SELECT, INSERT, UPDATE, DELETE ON TABLE public.fixed_variable_payments FROM");
      await aplicarTexto(c, duplaMutacao);

      const m = await matriz(c);
      expect(m).not.toEqual(matrizEsperada());
      // E o que sobrevive é exactamente o defeito de origem.
      for (const papel of ["anon", "authenticated"]) {
        for (const p of ["TRUNCATE", "REFERENCES", "TRIGGER", "MAINTAIN"]) {
          expect(m[`${papel}:${p}`], `${papel}:${p}`).toBe(true);
        }
      }
    } finally { await limpar(c); }
  }, 120_000);

  it("🔴 GRANT ALL ao service_role: recusado, mesmo sendo o papel de confiança", async () => {
    const c = await pool.connect();
    try {
      await pos083(c);
      await expect(aplicarTexto(c, MUTACAO_GRANT_ALL))
        .rejects.toThrow(/084_ACL_CLOSURE_POSTSTATE_FAILED/);
    } finally { await limpar(c); }
  }, 120_000);

  it("🔴 sem a auto-verificação, o GRANT ALL passa — e a matriz apanha-o", async () => {
    const c = await pool.connect();
    try {
      await pos083(c);
      await aplicarTexto(c, SEM_POSESTADO.replace(
        "GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.fixed_variable_payments TO service_role;",
        "GRANT ALL PRIVILEGES ON TABLE public.fixed_variable_payments TO service_role;"));
      const m = await matriz(c);
      expect(m["service_role:TRUNCATE"]).toBe(true);
      expect(m).not.toEqual(matrizEsperada());
    } finally { await limpar(c); }
  }, 120_000);

  it("a 084 intacta, no mesmo cenário, fica verde", async () => {
    // O contra-exemplo das mutações. Sem isto, um teste que ficasse vermelho
    // por qualquer motivo daria a impressão de estar a provar alguma coisa.
    const c = await pool.connect();
    try {
      await pos083(c);
      await aplicarTexto(c, M084_TEXTO);
      expect(await matriz(c)).toEqual(matrizEsperada());
    } finally { await limpar(c); }
  }, 120_000);
});

// ═══════════════════════════════════════════════════════════════════════════
// 4 — as duas ordens históricas, com a 082 no meio (TASK 8)
// ═══════════════════════════════════════════════════════════════════════════

describe.sequential("084 — as duas ordens dão a mesma superfície", () => {
  /** Fotografia completa da autorização: tabela (8 privilégios) + funções. */
  async function superficie(c: pg.PoolClient) {
    const funcoes: Record<string, boolean> = {};
    for (const f of FUNCOES_MUTACAO) {
      for (const papel of PAPEIS) {
        funcoes[`${f}|${papel}`] = await podeExecutar(c, papel, f);
      }
    }
    return { tabela: await matriz(c), funcoes };
  }

  /** O caminho canónico completo, corrido como service_role. */
  async function caminhoCanonico(c: pg.PoolClient) {
    await c.query("BEGIN");
    await c.query("SET LOCAL ROLE service_role");

    // createPayment — INSERT directo, que é o que a Server Action faz.
    const { rows: novo } = await c.query(
      `INSERT INTO public.fixed_variable_payments
         (company_id,kind,description,amount,period_year,period_month)
       VALUES($1,'fixo','Fornecedor',100.00,2026,8) RETURNING id::text`, [EMPRESA]);
    const id = novo[0].id as string;

    // update_payment_atomic — a RPC da 082.
    await c.query("SELECT * FROM public.update_payment_atomic($1,$2,$3::jsonb)",
      [EMPRESA, id, JSON.stringify({ amount: "150.00" })]);

    // mark_payment_paid — a RPC da 079/081, com o movimento de caixa a nascer.
    await c.query("SELECT * FROM public.mark_payment_paid($1,$2,$3)", [EMPRESA, id, "2026-08-15"]);
    const { rows: pago } = await c.query(
      `SELECT p.status, count(cf.id)::int AS movimentos
         FROM public.fixed_variable_payments p
         LEFT JOIN public.cash_flow_entries cf
           ON cf.reference_type='fixed_variable_payment' AND cf.reference_id=p.id
        WHERE p.id=$1 GROUP BY p.status`, [id]);

    // unmark_payment_paid — e o movimento a desaparecer com ele.
    await c.query("SELECT * FROM public.unmark_payment_paid($1,$2)", [EMPRESA, id]);
    const { rows: pendente } = await c.query(
      `SELECT p.status, count(cf.id)::int AS movimentos
         FROM public.fixed_variable_payments p
         LEFT JOIN public.cash_flow_entries cf
           ON cf.reference_type='fixed_variable_payment' AND cf.reference_id=p.id
        WHERE p.id=$1 GROUP BY p.status`, [id]);

    // delete_payment_atomic — a RPC da 082.
    const { rows: apagou } = await c.query(
      "SELECT apagados FROM public.delete_payment_atomic($1,$2)", [EMPRESA, id]);

    await c.query("ROLLBACK");
    return {
      criou: Boolean(id),
      pago: pago[0]?.status as string,
      movimentosDepoisDeMarcar: pago[0]?.movimentos as number,
      pendente: pendente[0]?.status as string,
      movimentosDepoisDeDesmarcar: pendente[0]?.movimentos as number,
      apagados: Number(apagou[0]?.apagados),
    };
  }

  let limpa: Awaited<ReturnType<typeof superficie>>;
  let producao: Awaited<ReturnType<typeof superficie>>;
  let canonicaLimpa: Awaited<ReturnType<typeof caminhoCanonico>>;
  let canonicaProducao: Awaited<ReturnType<typeof caminhoCanonico>>;

  it("CLEAN_ORDER_082_083_084: instalação limpa", async () => {
    const c = await pool.connect();
    try {
      await preparar(c);
      await aplicarComoRunner(c, M082, "ensaio");
      await aplicarComoRunner(c, M083, CHECKSUM_083);
      await aplicarComoRunner(c, M084, "ensaio");
      limpa = await superficie(c);
      canonicaLimpa = await caminhoCanonico(c);
    } finally { await limpar(c); }
    expect(limpa.tabela).toEqual(matrizEsperada());
  }, 180_000);

  it("PRODUCTION_ORDER_083_082_084: a ordem que produção viveu", async () => {
    // Produção aplicou a 083 primeiro e só depois a 082 (PR #108). A 084 entra
    // sobre esse histórico, e não sobre o de uma instalação limpa.
    const c = await pool.connect();
    try {
      await preparar(c);
      await aplicarComoRunner(c, M083, CHECKSUM_083);
      await aplicarComoRunner(c, M082, "ensaio");
      await aplicarComoRunner(c, M084, "ensaio");
      producao = await superficie(c);
      canonicaProducao = await caminhoCanonico(c);
    } finally { await limpar(c); }
    expect(producao.tabela).toEqual(matrizEsperada());
  }, 180_000);

  it("🔴 FINAL_AUTH_EQUIVALENCE: as duas ordens terminam iguais", async () => {
    // Sem isto, os dois `undefined` de um cenário que rebentou antes davam
    // verde a esta asserção — a pior forma de a ter.
    expect(limpa, "o cenário limpo não correu").toBeDefined();
    expect(producao, "o cenário de produção não correu").toBeDefined();
    expect(producao).toEqual(limpa);
  });

  it("🔴 SERVICE_ROLE_CANONICAL_PATH: continua a funcionar nas duas ordens", async () => {
    for (const r of [canonicaLimpa, canonicaProducao]) {
      expect(r.criou).toBe(true);
      expect(r.pago).toBe("pago");
      expect(r.movimentosDepoisDeMarcar).toBe(1);
      expect(r.pendente).toBe("pendente");
      expect(r.movimentosDepoisDeDesmarcar).toBe(0);
      expect(r.apagados).toBe(1);
    }
    expect(canonicaProducao).toEqual(canonicaLimpa);
  });

  it("🔴 as RPC atómicas da 082 continuam EXECUTE só para service_role", async () => {
    // A 084 não toca em funções. Isto existe para provar que não tocou — uma
    // migration de ACL de tabela que mexesse no ACL de funções teria saído do
    // seu âmbito sem ninguém dar por isso.
    for (const f of FUNCOES_MUTACAO) {
      for (const papel of ["public", "anon", "authenticated"]) {
        expect(producao.funcoes[`${f}|${papel}`], `${f} / ${papel}`).toBe(false);
      }
      expect(producao.funcoes[`${f}|service_role`], f).toBe(true);
    }
  });

  it("a policy de leitura da 083 continua a ser a única, e continua a filtrar", async () => {
    const c = await pool.connect();
    try {
      const { rows } = await c.query(
        `SELECT policyname, cmd FROM pg_policies
          WHERE schemaname='public' AND tablename='fixed_variable_payments'`);
      expect(rows).toHaveLength(1);
      expect(rows[0].policyname).toBe("payments_manager_select");
      expect(rows[0].cmd).toBe("SELECT");
    } finally { await limpar(c); }
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// 5 — rollback honesto (TASK 9)
// ═══════════════════════════════════════════════════════════════════════════

describe.sequential("ROLLBACK_084_REOPENS_KNOWN_PRIVILEGE_BUG = YES", () => {
  it("🔴 o rollback repõe o prestate exacto da 083 — buraco incluído", async () => {
    const c = await pool.connect();
    try {
      await preparar(c);
      await aplicarComoRunner(c, M083, CHECKSUM_083);

      // A fotografia do prestate, tirada antes de a 084 correr.
      const prestate = await matriz(c);

      await aplicarComoRunner(c, M084, "ensaio");
      expect(await matriz(c)).toEqual(matrizEsperada());

      await c.query(rollbackSql("084_payment_table_acl_closure.down.sql"));

      // 🔴 A igualdade é a prova de honestidade. Um rollback que repusesse um
      //    estado *melhor* que o prestate não seria um rollback — e esconderia
      //    que a 084 é a única coisa entre produção e este ACL.
      expect(await matriz(c)).toEqual(prestate);

      // E o defeito volta mesmo, medido pelo comportamento e não pelo catálogo.
      await c.query("INSERT INTO public.fixed_variable_payments" +
        "(company_id,kind,description,amount,period_year,period_month)" +
        " VALUES($1,'fixo','Fornecedor',100,2026,8)", [EMPRESA]);
      await c.query("BEGIN");
      await c.query("SET LOCAL ROLE anon");
      await c.query("TRUNCATE public.fixed_variable_payments CASCADE");
      await c.query("RESET ROLE");
      const { rows } = await c.query("SELECT count(*)::int n FROM public.fixed_variable_payments");
      expect(rows[0].n, "o rollback devia ter devolvido TRUNCATE a anon").toBe(0);
      await c.query("ROLLBACK");
    } finally { await limpar(c); }
  }, 180_000);

  it("🔴 e a 084 volta a fechar tudo depois do rollback — é idempotente no fim", async () => {
    const c = await pool.connect();
    try {
      await aplicarTexto(c, sql(M084));
      expect(await matriz(c)).toEqual(matrizEsperada());
      await aplicarTexto(c, sql(M084));
      expect(await matriz(c)).toEqual(matrizEsperada());
    } finally { await limpar(c); }
  }, 120_000);

  it("o ficheiro de rollback declara o que reabre, por escrito", () => {
    const texto = rollbackSql("084_payment_table_acl_closure.down.sql");
    expect(texto).toContain("ROLLBACK_084_REOPENS_KNOWN_PRIVILEGE_BUG = YES");
    expect(texto).toContain("NENHUM ROLLBACK DE PRODUÇÃO ESTÁ AUTORIZADO");
  });
});

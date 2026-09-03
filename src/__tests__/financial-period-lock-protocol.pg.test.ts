// ============================================================================
// 090 — o protocolo do período financeiro, com duas ligações a sério
// ============================================================================
//
// Uma corrida não se prova com uma ligação. Este ficheiro abre duas, segura
// transações abertas de propósito, e obriga cada cenário a acontecer na ordem
// que interessa — não na ordem que calhar.
//
// O que se exige, em cada caso:
//
//   writer primeiro → o writer termina inteiro, e o fecho decide depois com o
//                     mês como ele ficou;
//   fecho primeiro  → o mês fecha, o writer acorda e recusa, e não fica
//                     metade de escrita nenhuma.
// ============================================================================

import { readFileSync } from "node:fs";
import { join } from "node:path";
import pg from "pg";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { startPostgresContainer, type PostgresContainer } from "./helpers/pg-container";

const ROOT = process.cwd();
const CONTAINER = `finperiod-${process.pid}`;
const EMPRESA = "11111111-1111-4111-8111-111111111111";
const OUTRA = "22222222-2222-4222-8222-222222222222";
const ACTOR = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";

let container: PostgresContainer;
let pool: pg.Pool;

/** Uma ligação própria, para segurar uma transação sem bloquear as outras. */
async function ligacao() {
  const c = new pg.Client({ ...container.connection });
  await c.connect();
  return c;
}

/** O mínimo do esquema financeiro que o protocolo toca. */
async function baseline() {
  await pool.query(`
    DROP SCHEMA IF EXISTS public CASCADE;
    CREATE SCHEMA public;

    CREATE TABLE public.financial_periods (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      company_id uuid NOT NULL,
      year integer NOT NULL,
      month integer NOT NULL,
      status text NOT NULL DEFAULT 'open',
      closed_at timestamptz, closed_by uuid,
      reopened_at timestamptz, reopened_by uuid, reopen_reason text,
      created_at timestamptz NOT NULL DEFAULT now(),
      updated_at timestamptz NOT NULL DEFAULT now(),
      UNIQUE (company_id, year, month)
    );

    CREATE TABLE public.fixed_variable_payments (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      company_id uuid NOT NULL, kind text NOT NULL, description text NOT NULL,
      amount numeric, due_date date, status text NOT NULL DEFAULT 'pendente',
      period_year integer NOT NULL, period_month integer NOT NULL
    );
    CREATE TABLE public.cash_flow_entries (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      company_id uuid NOT NULL, type text NOT NULL, amount numeric NOT NULL,
      date date NOT NULL, expense_category_id uuid
    );
    CREATE TABLE public.invoices (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      company_id uuid NOT NULL, status text NOT NULL, period_start date
    );
    CREATE TABLE public.bank_transactions (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      company_id uuid NOT NULL, status text NOT NULL, transaction_date date
    );
    CREATE TABLE public.manual_charges (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      company_id uuid NOT NULL, charge_date date NOT NULL, amount numeric NOT NULL
    );

    -- A 090 grava a auditoria do fecho/reabertura na MESMA transação, por isso
    -- a tabela faz parte do palco mínimo. As chaves estrangeiras reais (025)
    -- apontam a companies e profiles; aqui interessa a forma das colunas e a
    -- atomicidade, não a integridade referencial de um esquema completo.
    CREATE TABLE public.audit_logs (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      company_id uuid NOT NULL,
      actor_id uuid NOT NULL,
      action text NOT NULL,
      entity_type text NOT NULL DEFAULT 'timesheet',
      entity_id text,
      meta jsonb NOT NULL DEFAULT '{}',
      created_at timestamptz NOT NULL DEFAULT now()
    );

    -- A semântica da 071: sem linha 'closed', o mês está aberto.
    CREATE FUNCTION public.is_financial_period_open(p_company_id uuid, p_year integer, p_month integer)
    RETURNS boolean LANGUAGE sql STABLE AS $$
      SELECT NOT EXISTS (
        SELECT 1 FROM public.financial_periods
         WHERE company_id = p_company_id
           AND year = p_year AND month = p_month
           AND status = 'closed'
      );
    $$;
  `);

  const sql = readFileSync(join(ROOT, "supabase/migrations/090_financial_period_lock_protocol.sql"), "utf8");
  await pool.query(sql);
}

const aberto = async (ano: number, mes: number, empresa = EMPRESA) =>
  (await pool.query("select public.is_financial_period_open($1, $2, $3) as v", [empresa, ano, mes])).rows[0].v;

const nPagamentos = async () =>
  Number((await pool.query("select count(*) n from public.fixed_variable_payments")).rows[0].n);

beforeAll(async () => {
  container = await startPostgresContainer({
    name: CONTAINER, database: "finperiod",
    serverFlags: ["shared_buffers=16MB", "max_connections=25", "work_mem=1MB", "maintenance_work_mem=8MB"],
  });
  pool = new pg.Pool({ ...container.connection, max: 4 });
  // Um PostgreSQL simples não tem os papéis do Supabase, e a migration
  // revoga/concede sobre eles. Sem isto, falha em «role "anon" does not exist»
  // e o teste diria que o protocolo está partido quando o que falta é o palco.
  await pool.query(`
    DO $$ BEGIN CREATE ROLE anon; EXCEPTION WHEN duplicate_object THEN NULL; END $$;
    DO $$ BEGIN CREATE ROLE authenticated; EXCEPTION WHEN duplicate_object THEN NULL; END $$;
    DO $$ BEGIN CREATE ROLE service_role; EXCEPTION WHEN duplicate_object THEN NULL; END $$;
  `);
}, 180_000);

afterAll(async () => {
  await pool?.end();
  container?.stop();
});

beforeEach(async () => { await baseline(); });

describe("090 — writer e fecho serializam pelo mesmo recurso", () => {
  it("A · writer primeiro: termina inteiro, e o fecho decide depois com o mês como ficou", async () => {
    const writer = await ligacao();
    const fecho = await ligacao();

    // O writer entra, bloqueia o mês e insere — sem confirmar ainda.
    await writer.query("BEGIN");
    await writer.query("SELECT public.assert_financial_period_open_locked($1, 2026, 9)", [EMPRESA]);
    await writer.query(
      `INSERT INTO public.fixed_variable_payments (company_id, kind, description, amount, status, period_year, period_month)
       VALUES ($1, 'fixo', 'escrita do writer', 10, 'pendente', 2026, 9)`, [EMPRESA]);

    // O fecho tenta ao mesmo tempo e fica à espera do lock.
    const promessaFecho = fecho.query(
      "SELECT * FROM public.close_financial_period_atomic($1, 2026, 9, $2)", [EMPRESA, ACTOR]);
    await new Promise((r) => setTimeout(r, 400));

    await writer.query("COMMIT");
    const resultado = await promessaFecho;

    // A escrita do writer entrou inteira…
    expect(await nPagamentos()).toBe(1);
    // …e o fecho, ao acordar, viu-a: o pagamento pendente é bloqueador.
    expect(resultado.rows[0].fechado).toBe(false);
    expect(resultado.rows[0].bloqueadores.pagamentos_pendentes).toBe(1);
    expect(await aberto(2026, 9)).toBe(true);

    await writer.end();
    await fecho.end();
  }, 120_000);

  it("B · fecho primeiro: o mês fecha, o writer recusa, e não escreve nada", async () => {
    const fecho = await ligacao();
    const writer = await ligacao();

    await fecho.query("BEGIN");
    await fecho.query("SELECT * FROM public.close_financial_period_atomic($1, 2026, 9, $2)", [EMPRESA, ACTOR]);

    // O writer chega e fica à espera do lock que o fecho tem.
    const promessaWriter = (async () => {
      await writer.query("BEGIN");
      try {
        await writer.query("SELECT public.assert_financial_period_open_locked($1, 2026, 9)", [EMPRESA]);
        await writer.query(
          `INSERT INTO public.fixed_variable_payments (company_id, kind, description, amount, status, period_year, period_month)
           VALUES ($1, 'fixo', 'não devia entrar', 10, 'pendente', 2026, 9)`, [EMPRESA]);
        await writer.query("COMMIT");
        return "escreveu";
      } catch (erro) {
        await writer.query("ROLLBACK").catch(() => {});
        return String((erro as Error).message);
      }
    })();
    await new Promise((r) => setTimeout(r, 400));

    await fecho.query("COMMIT");
    const resultado = await promessaWriter;

    expect(resultado).toMatch(/FINANCIAL_PERIOD_CLOSED/);
    expect(await nPagamentos()).toBe(0);
    expect(await aberto(2026, 9)).toBe(false);

    await fecho.end();
    await writer.end();
  }, 120_000);

  it("C · reabrir participa do mesmo protocolo", async () => {
    await pool.query("SELECT * FROM public.close_financial_period_atomic($1, 2026, 9, $2)", [EMPRESA, ACTOR]);
    expect(await aberto(2026, 9)).toBe(false);

    const reabre = await ligacao();
    const writer = await ligacao();

    await reabre.query("BEGIN");
    await reabre.query(
      "SELECT public.reopen_financial_period_atomic($1, 2026, 9, $2, 'correcção de fecho')", [EMPRESA, ACTOR]);

    // Enquanto a reabertura não confirmar, o writer não pode passar.
    const promessaWriter = (async () => {
      await writer.query("BEGIN");
      try {
        await writer.query("SELECT public.assert_financial_period_open_locked($1, 2026, 9)", [EMPRESA]);
        await writer.query("COMMIT");
        return "passou";
      } catch (erro) {
        await writer.query("ROLLBACK").catch(() => {});
        return String((erro as Error).message);
      }
    })();
    await new Promise((r) => setTimeout(r, 400));

    await reabre.query("COMMIT");
    expect(await promessaWriter).toBe("passou");
    expect(await aberto(2026, 9)).toBe(true);

    await reabre.end();
    await writer.end();
  }, 120_000);

  it("D · dois fechos ao mesmo tempo: um fecha, o outro vê que já estava fechado", async () => {
    const a = await ligacao();
    const b = await ligacao();

    await a.query("BEGIN");
    const ra = await a.query("SELECT * FROM public.close_financial_period_atomic($1, 2026, 9, $2)", [EMPRESA, ACTOR]);

    const pb = b.query("SELECT * FROM public.close_financial_period_atomic($1, 2026, 9, $2)", [EMPRESA, ACTOR]);
    await new Promise((r) => setTimeout(r, 400));
    await a.query("COMMIT");
    const rb = await pb;

    expect(ra.rows[0].fechado).toBe(true);
    expect(rb.rows[0].fechado).toBe(false);
    expect(rb.rows[0].bloqueadores.ja_fechado).toBe(true);
    expect(Number((await pool.query("select count(*) n from public.financial_periods")).rows[0].n)).toBe(1);

    await a.end();
    await b.end();
  }, 120_000);

  it("E · empresas diferentes não competem pelo mesmo recurso", async () => {
    const a = await ligacao();
    const b = await ligacao();

    await a.query("BEGIN");
    await a.query("SELECT public.lock_financial_period($1, 2026, 9)", [EMPRESA]);

    // A outra empresa não pode ficar à espera desta.
    await b.query("BEGIN");
    const inicio = Date.now();
    await b.query("SELECT public.assert_financial_period_open_locked($1, 2026, 9)", [OUTRA]);
    const demorou = Date.now() - inicio;
    await b.query("COMMIT");
    await a.query("ROLLBACK");

    expect(demorou).toBeLessThan(1000);
    await a.end();
    await b.end();
  }, 120_000);

  it("F · meses diferentes da mesma empresa não competem", async () => {
    const a = await ligacao();
    const b = await ligacao();

    await a.query("BEGIN");
    await a.query("SELECT public.lock_financial_period($1, 2026, 9)", [EMPRESA]);

    await b.query("BEGIN");
    const inicio = Date.now();
    await b.query("SELECT public.assert_financial_period_open_locked($1, 2026, 10)", [EMPRESA]);
    const demorou = Date.now() - inicio;
    await b.query("COMMIT");
    await a.query("ROLLBACK");

    expect(demorou).toBeLessThan(1000);
    await a.end();
    await b.end();
  }, 120_000);

  it("I · mover entre dois meses bloqueia em ordem canónica, e não dá deadlock", async () => {
    // Duas sessões a fazer o movimento inverso ao mesmo tempo. Sem ordem
    // canónica, isto é o exemplo de manual de deadlock.
    const a = await ligacao();
    const b = await ligacao();

    const mover = async (c: pg.Client, de: [number, number], para: [number, number]) => {
      await c.query("BEGIN");
      await c.query("SELECT public.lock_financial_periods_pair($1, $2, $3, $4, $5)",
        [EMPRESA, de[0], de[1], para[0], para[1]]);
      await new Promise((r) => setTimeout(r, 150));
      await c.query("COMMIT");
      return "ok";
    };

    const [ra, rb] = await Promise.all([
      mover(a, [2026, 9], [2026, 10]),
      mover(b, [2026, 10], [2026, 9]),
    ]);

    expect(ra).toBe("ok");
    expect(rb).toBe("ok");
    await a.end();
    await b.end();
  }, 120_000);

  it("J · estado ilegível falha fechado", async () => {
    await expect(pool.query("SELECT public.lock_financial_period($1, 2026, NULL)", [EMPRESA]))
      .rejects.toThrow(/FINANCIAL_PERIOD_LOCK_INVALID_ARGS/);
    await expect(pool.query("SELECT public.lock_financial_period($1, 2026, 13)", [EMPRESA]))
      .rejects.toThrow(/FINANCIAL_PERIOD_LOCK_INVALID_MONTH/);
    await expect(pool.query(
      "SELECT public.reopen_financial_period_atomic($1, 2026, 9, $2, '  ')", [EMPRESA, ACTOR]))
      .rejects.toThrow(/REOPEN_REQUIRES_REASON/);
  }, 120_000);

  it("K · rollback a meio não deixa efeito parcial nem lock pendurado", async () => {
    const c = await ligacao();
    await c.query("BEGIN");
    await c.query("SELECT public.assert_financial_period_open_locked($1, 2026, 9)", [EMPRESA]);
    await c.query(
      `INSERT INTO public.fixed_variable_payments (company_id, kind, description, amount, status, period_year, period_month)
       VALUES ($1, 'fixo', 'vai ser desfeita', 10, 'pendente', 2026, 9)`, [EMPRESA]);
    await c.query("ROLLBACK");

    expect(await nPagamentos()).toBe(0);

    // O lock morre com a transação: outra sessão entra sem esperar.
    const outra = await ligacao();
    const inicio = Date.now();
    await outra.query("SELECT public.lock_financial_period($1, 2026, 9)", [EMPRESA]);
    expect(Date.now() - inicio).toBeLessThan(1000);

    await c.end();
    await outra.end();
  }, 120_000);

  it("L · repetição concorrida não gera deadlock nem starvation", async () => {
    const ciclo = async () => {
      const c = await ligacao();
      for (let i = 0; i < 6; i += 1) {
        await c.query("BEGIN");
        await c.query("SELECT public.assert_financial_period_open_locked($1, 2026, 9)", [EMPRESA]);
        await c.query(
          `INSERT INTO public.fixed_variable_payments (company_id, kind, description, amount, status, period_year, period_month)
           VALUES ($1, 'variavel', 'ciclo', 1, 'pago', 2026, 9)`, [EMPRESA]);
        await c.query("COMMIT");
      }
      await c.end();
    };

    await Promise.all([ciclo(), ciclo(), ciclo()]);
    expect(await nPagamentos()).toBe(18);
  }, 180_000);

  it("G · close vs manual_charge: a cobrança recusa depois do fecho", async () => {
    // 🔴 `manual_charges` NAO tem guarda de período hoje — nem na action nem na
    //    086. Este teste prova o protocolo, e serve de forma ao writer quando
    //    ele passar a usá-lo. Enquanto não passar, uma cobrança entra num mês
    //    fechado sem nada a impedir.
    const fecho = await ligacao();
    const writer = await ligacao();

    await fecho.query("BEGIN");
    await fecho.query("SELECT * FROM public.close_financial_period_atomic($1, 2026, 9, $2)", [EMPRESA, ACTOR]);

    const promessa = (async () => {
      await writer.query("BEGIN");
      try {
        await writer.query("SELECT public.assert_financial_period_open_locked($1, 2026, 9)", [EMPRESA]);
        await writer.query(
          `INSERT INTO public.manual_charges (company_id, charge_date, amount)
           VALUES ($1, date '2026-09-15', 100)`, [EMPRESA]);
        await writer.query("COMMIT");
        return "escreveu";
      } catch (erro) {
        await writer.query("ROLLBACK").catch(() => {});
        return String((erro as Error).message);
      }
    })();
    await new Promise((r) => setTimeout(r, 400));
    await fecho.query("COMMIT");

    expect(await promessa).toMatch(/FINANCIAL_PERIOD_CLOSED/);
    expect(Number((await pool.query("select count(*) n from public.manual_charges")).rows[0].n)).toBe(0);

    await fecho.end();
    await writer.end();
  }, 120_000);

  it("H · close vs pagamento: zero escrita parcial", async () => {
    const fecho = await ligacao();
    const writer = await ligacao();

    await fecho.query("BEGIN");
    await fecho.query("SELECT * FROM public.close_financial_period_atomic($1, 2026, 9, $2)", [EMPRESA, ACTOR]);

    const promessa = (async () => {
      await writer.query("BEGIN");
      try {
        await writer.query("SELECT public.assert_financial_period_open_locked($1, 2026, 9)", [EMPRESA]);
        await writer.query(
          `INSERT INTO public.cash_flow_entries (company_id, type, amount, date)
           VALUES ($1, 'saida', 50, date '2026-09-20')`, [EMPRESA]);
        await writer.query(
          `INSERT INTO public.fixed_variable_payments (company_id, kind, description, amount, status, period_year, period_month)
           VALUES ($1, 'fixo', 'pago', 50, 'pago', 2026, 9)`, [EMPRESA]);
        await writer.query("COMMIT");
        return "escreveu";
      } catch (erro) {
        await writer.query("ROLLBACK").catch(() => {});
        return String((erro as Error).message);
      }
    })();
    await new Promise((r) => setTimeout(r, 400));
    await fecho.query("COMMIT");

    expect(await promessa).toMatch(/FINANCIAL_PERIOD_CLOSED/);
    // Nem o caixa, nem o pagamento: o par entra inteiro ou não entra.
    expect(await nPagamentos()).toBe(0);
    expect(Number((await pool.query("select count(*) n from public.cash_flow_entries")).rows[0].n)).toBe(0);

    await fecho.end();
    await writer.end();
  }, 120_000);

  it("período sem linha em financial_periods é aberto, e o lock funciona na mesma", async () => {
    // A semântica é «sem linha = aberto». Um SELECT ... FOR UPDATE não teria
    // linha para bloquear, e duas sessões inseririam a primeira em paralelo.
    expect(Number((await pool.query("select count(*) n from public.financial_periods")).rows[0].n)).toBe(0);
    expect(await aberto(2027, 3)).toBe(true);

    const a = await ligacao();
    await a.query("BEGIN");
    await a.query("SELECT public.assert_financial_period_open_locked($1, 2027, 3)", [EMPRESA]);

    const b = await ligacao();
    const promessa = b.query("SELECT * FROM public.close_financial_period_atomic($1, 2027, 3, $2)", [EMPRESA, ACTOR]);
    await new Promise((r) => setTimeout(r, 300));
    await a.query("COMMIT");
    const r = await promessa;

    expect(r.rows[0].fechado).toBe(true);
    expect(Number((await pool.query("select count(*) n from public.financial_periods")).rows[0].n)).toBe(1);

    await a.end();
    await b.end();
  }, 120_000);

  it("o checklist é recontado sob o lock, não aceite de fora", async () => {
    // Um bloqueador que aparece DEPOIS de alguém ter olhado para o checklist
    // tem de impedir o fecho na mesma.
    const r1 = await pool.query("SELECT * FROM public.close_financial_period_atomic($1, 2026, 9, $2)", [EMPRESA, ACTOR]);
    expect(r1.rows[0].fechado).toBe(true);

    await pool.query("SELECT public.reopen_financial_period_atomic($1, 2026, 9, $2, 'para o teste')", [EMPRESA, ACTOR]);
    await pool.query(
      `INSERT INTO public.invoices (company_id, status, period_start) VALUES ($1, 'rascunho', date '2026-09-10')`, [EMPRESA]);

    const r2 = await pool.query("SELECT * FROM public.close_financial_period_atomic($1, 2026, 9, $2)", [EMPRESA, ACTOR]);
    expect(r2.rows[0].fechado).toBe(false);
    expect(r2.rows[0].bloqueadores.faturas_rascunho).toBe(1);
  }, 120_000);
});

// ============================================================================
// A superfície da fundação — assinaturas e permissões
// ============================================================================
//
// Uma função com o nome certo e os argumentos errados passa qualquer
// verificação por nome, e só falha na primeira chamada a sério. E uma função
// correcta exposta ao `anon` é uma porta aberta no browser. Nenhuma das duas
// coisas se vê a ler o SQL — só se prova a perguntar ao catálogo.
describe("090 — superfície: assinaturas exactas e permissões", () => {
  /** As doze funções da fundação, com a assinatura que o contrato fixa. */
  const ASSINATURAS: ReadonlyArray<readonly [string, string]> = [
    ["financial_period_lock_key", "p_year integer, p_month integer"],
    ["financial_period_lock_keys", "p_dates date[]"],
    ["lock_financial_periods_many", "p_company_id uuid, p_keys integer[]"],
    ["assert_financial_periods_open_locked_many", "p_company_id uuid, p_keys integer[]"],
    ["assert_financial_period_dates_open_locked", "p_company_id uuid, p_dates date[]"],
    ["lock_financial_period", "p_company_id uuid, p_year integer, p_month integer"],
    [
      "lock_financial_periods_pair",
      "p_company_id uuid, p_year_a integer, p_month_a integer, p_year_b integer, p_month_b integer",
    ],
    ["assert_financial_period_open_locked", "p_company_id uuid, p_year integer, p_month integer"],
    [
      "assert_financial_periods_open_locked_pair",
      "p_company_id uuid, p_year_a integer, p_month_a integer, p_year_b integer, p_month_b integer",
    ],
    ["financial_period_blockers", "p_company_id uuid, p_year integer, p_month integer"],
    ["close_financial_period_atomic", "p_company_id uuid, p_year integer, p_month integer, p_actor uuid"],
    [
      "reopen_financial_period_atomic",
      "p_company_id uuid, p_year integer, p_month integer, p_actor uuid, p_reason text",
    ],
  ];

  it("cada função existe com a assinatura EXACTA do contrato", async () => {
    for (const [nome, assinatura] of ASSINATURAS) {
      const { rows } = await pool.query(
        `SELECT pg_get_function_identity_arguments(p.oid) AS args
           FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
          WHERE n.nspname = 'public' AND p.proname = $1`,
        [nome],
      );
      expect(rows.map((r) => r.args), `${nome} tem de existir`).toContain(assinatura);
    }
  }, 120_000);

  it("a precondição exige `is_financial_period_open(uuid, integer, integer)` e não só o nome", async () => {
    // Trocar a função por uma com o nome certo e outros argumentos tem de
    // fazer a migration recusar — é isso que impede a fundação de assentar na
    // função errada e só dar erro na primeira escrita em produção.
    await pool.query("DROP FUNCTION IF EXISTS public.is_financial_period_open(uuid, integer, integer)");
    await pool.query(
      "CREATE FUNCTION public.is_financial_period_open(p_company_id uuid, p_date date) " +
        "RETURNS boolean LANGUAGE sql STABLE AS 'SELECT true'",
    );

    const sql = readFileSync(join(ROOT, "supabase/migrations/090_financial_period_lock_protocol.sql"), "utf8");
    await expect(pool.query(sql)).rejects.toThrow(/090_PRECONDITION_FAILED/);
  }, 120_000);

  it("nenhuma função da fundação é SECURITY DEFINER", async () => {
    // DEFINER aqui seria contornar o RLS por baixo do protocolo. A fundação
    // serializa; não eleva privilégio nenhum.
    const { rows } = await pool.query(
      `SELECT p.proname FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
        WHERE n.nspname = 'public' AND p.prosecdef
          AND p.proname = ANY($1::text[])`,
      [ASSINATURAS.map(([nome]) => nome)],
    );
    expect(rows.map((r) => r.proname)).toEqual([]);
  }, 120_000);

  it("anon e authenticated não executam nada; service_role executa tudo", async () => {
    for (const [nome, assinatura] of ASSINATURAS) {
      // `has_function_privilege` quer os TIPOS, não os nomes dos parâmetros.
      const tipos = assinatura
        .split(", ")
        .map((a) => a.split(" ").slice(1).join(" "))
        .join(", ");
      const alvo = `public.${nome}(${tipos})`;

      for (const papel of ["anon", "authenticated", "public"]) {
        const { rows } = await pool.query("SELECT has_function_privilege($1, $2, 'EXECUTE') AS pode", [papel, alvo]);
        expect(rows[0].pode, `${papel} NÃO pode executar ${nome}`).toBe(false);
      }

      const { rows } = await pool.query("SELECT has_function_privilege('service_role', $1, 'EXECUTE') AS pode", [alvo]);
      expect(rows[0].pode, `service_role tem de poder executar ${nome}`).toBe(true);
    }
  }, 120_000);
});

// ============================================================================
// O par de períodos — mover uma data entre dois meses
// ============================================================================
describe("090 — source e target: os dois meses protegidos", () => {
  it("recusa quando o mês de ORIGEM está fechado", async () => {
    await pool.query("SELECT * FROM public.close_financial_period_atomic($1, 2026, 7, $2)", [EMPRESA, ACTOR]);

    await expect(
      pool.query("SELECT public.assert_financial_periods_open_locked_pair($1, 2026, 7, 2026, 8)", [EMPRESA]),
    ).rejects.toThrow(/FINANCIAL_PERIOD_CLOSED: 2026-07/);
  }, 120_000);

  it("recusa quando o mês de DESTINO está fechado", async () => {
    await pool.query("SELECT * FROM public.close_financial_period_atomic($1, 2026, 8, $2)", [EMPRESA, ACTOR]);

    await expect(
      pool.query("SELECT public.assert_financial_periods_open_locked_pair($1, 2026, 7, 2026, 8)", [EMPRESA]),
    ).rejects.toThrow(/FINANCIAL_PERIOD_CLOSED: 2026-08/);
  }, 120_000);

  it("aceita quando os dois estão abertos, e o mesmo mês duas vezes é um lock só", async () => {
    await pool.query("SELECT public.assert_financial_periods_open_locked_pair($1, 2026, 7, 2026, 8)", [EMPRESA]);
    // Mesmo período dos dois lados: não pode auto-bloquear.
    await pool.query("SELECT public.assert_financial_periods_open_locked_pair($1, 2026, 7, 2026, 7)", [EMPRESA]);
  }, 120_000);

  it("movimentos inversos concorrentes com asserção: deadlock zero", async () => {
    const a = await ligacao();
    const b = await ligacao();

    const mover = async (c: pg.Client, de: [number, number], para: [number, number]) => {
      await c.query("BEGIN");
      await c.query("SELECT public.assert_financial_periods_open_locked_pair($1, $2, $3, $4, $5)", [
        EMPRESA,
        de[0],
        de[1],
        para[0],
        para[1],
      ]);
      await c.query(
        `INSERT INTO public.cash_flow_entries (company_id, type, amount, date)
         VALUES ($1, 'saida', 5, make_date($2, $3, 15))`,
        [EMPRESA, para[0], para[1]],
      );
      await new Promise((r) => setTimeout(r, 150));
      await c.query("COMMIT");
      return "ok";
    };

    const [ra, rb] = await Promise.all([mover(a, [2026, 7], [2026, 8]), mover(b, [2026, 8], [2026, 7])]);

    expect(ra).toBe("ok");
    expect(rb).toBe("ok");
    expect(Number((await pool.query("select count(*) n from public.cash_flow_entries")).rows[0].n)).toBe(2);

    await a.end();
    await b.end();
  }, 120_000);

  it("o par recusa ANTES de escrever: zero alteração parcial", async () => {
    await pool.query("SELECT * FROM public.close_financial_period_atomic($1, 2026, 7, $2)", [EMPRESA, ACTOR]);

    const c = await ligacao();
    await c.query("BEGIN");
    let recusou = false;
    try {
      await c.query("SELECT public.assert_financial_periods_open_locked_pair($1, 2026, 7, 2026, 8)", [EMPRESA]);
      await c.query(
        `INSERT INTO public.cash_flow_entries (company_id, type, amount, date)
         VALUES ($1, 'saida', 5, date '2026-08-15')`,
        [EMPRESA],
      );
      await c.query("COMMIT");
    } catch {
      recusou = true;
      await c.query("ROLLBACK").catch(() => {});
    }

    expect(recusou).toBe(true);
    expect(Number((await pool.query("select count(*) n from public.cash_flow_entries")).rows[0].n)).toBe(0);
    await c.end();
  }, 120_000);
});

// ============================================================================
// N períodos — o conjunto inteiro conhecido ANTES da primeira aquisição
// ============================================================================
//
// O par prova o par. Não prova três, e é em três que o defeito volta: uma
// transação que adquire um subconjunto, descobre mais um período e o pede
// fora de ordem reintroduz o ciclo de espera que a ordem canónica existia
// para eliminar.
//
// Estes casos exigem a regra inteira: descobrir todos → ordenar → adquirir
// todos → validar todos → só então escrever.
describe("090 — protocolo de N períodos", () => {
  /** As chaves efectivamente adquiridas, pela ordem em que o foram. */
  const bloquear = async (chaves: number[], empresa = EMPRESA) =>
    (await pool.query("SELECT public.lock_financial_periods_many($1, $2::integer[]) AS chaves", [empresa, chaves]))
      .rows[0].chaves as number[];

  it("1 · três períodos na mesma operação ficam todos protegidos", async () => {
    const c = await ligacao();
    await c.query("BEGIN");
    await c.query("SELECT public.assert_financial_periods_open_locked_many($1, ARRAY[202607, 202608, 202609])", [
      EMPRESA,
    ]);

    // Enquanto a transação vive, nenhum dos TRÊS fecha.
    const fechos = [7, 8, 9].map(async (mes) => {
      const f = await ligacao();
      const p = f.query("SELECT * FROM public.close_financial_period_atomic($1, 2026, $2, $3)", [EMPRESA, mes, ACTOR]);
      return { f, p };
    });
    const pendentes = await Promise.all(fechos);
    await new Promise((r) => setTimeout(r, 400));

    expect(await aberto(2026, 7)).toBe(true);
    expect(await aberto(2026, 8)).toBe(true);
    expect(await aberto(2026, 9)).toBe(true);

    await c.query("COMMIT");
    await Promise.all(pendentes.map(({ p }) => p));
    await Promise.all(pendentes.map(({ f }) => f.end()));
    await c.end();
  }, 120_000);

  it("2 · duplicados à entrada dão um lock lógico só", async () => {
    expect(await bloquear([202608, 202608, 202608])).toEqual([202608]);

    // O conjunto devolvido podia estar certo e a aquisição repetida na mesma.
    // Quem responde é o catálogo, e tem de responder DENTRO da transação.
    const c = await ligacao();
    await c.query("BEGIN");
    await c.query("SELECT public.lock_financial_periods_many($1, ARRAY[202608, 202608, 202608])", [EMPRESA]);
    const { rows } = await c.query(
      `SELECT count(*)::int AS n FROM pg_locks
        WHERE locktype = 'advisory' AND pid = pg_backend_pid() AND objid = 202608`,
    );
    expect(rows[0].n).toBe(1);
    await c.query("ROLLBACK");
    await c.end();
  }, 120_000);

  it("3 · entrada fora de ordem é adquirida por ordem canónica", async () => {
    expect(await bloquear([202612, 202601, 202607])).toEqual([202601, 202607, 202612]);
    // Anos diferentes ordenam pelo ano, não pelo mês.
    expect(await bloquear([202701, 202612])).toEqual([202612, 202701]);
  }, 120_000);

  it("4/5/6 · T1 Jul-Ago-Set e T2 Set-Ago-Jul em simultâneo: deadlock zero", async () => {
    const a = await ligacao();
    const b = await ligacao();

    const operar = async (c: pg.Client, chaves: number[], marca: string) => {
      await c.query("BEGIN");
      await c.query("SELECT public.assert_financial_periods_open_locked_many($1, $2::integer[])", [EMPRESA, chaves]);
      // Trabalho a sério entre a aquisição e o COMMIT: sem isto as duas
      // transações podiam nem se cruzar, e o teste não provava nada.
      await new Promise((r) => setTimeout(r, 200));
      await c.query(
        `INSERT INTO public.cash_flow_entries (company_id, type, amount, date)
         VALUES ($1, 'saida', 5, date '2026-08-15')`,
        [EMPRESA],
      );
      await c.query("COMMIT");
      return marca;
    };

    const [ra, rb] = await Promise.all([
      operar(a, [202607, 202608, 202609], "T1"),
      operar(b, [202609, 202608, 202607], "T2"),
    ]);

    expect([ra, rb]).toEqual(["T1", "T2"]);
    expect(Number((await pool.query("select count(*) n from public.cash_flow_entries")).rows[0].n)).toBe(2);

    await a.end();
    await b.end();
  }, 120_000);

  it("6b · quatro transações com subconjuntos sobrepostos e ordens diferentes: deadlock zero", async () => {
    // O caso do mundo real não é o par simétrico: é meia dúzia de operações
    // com listas parcialmente sobrepostas, cada uma construída por um call
    // site diferente. Se a ordem canónica não for global, é aqui que parte.
    const listas = [
      [202607, 202608, 202609],
      [202609, 202607],
      [202608, 202610, 202607],
      [202610, 202609, 202608, 202607],
    ];

    const correr = async (chaves: number[], i: number) => {
      const c = await ligacao();
      try {
        await c.query("BEGIN");
        await c.query("SELECT public.assert_financial_periods_open_locked_many($1, $2::integer[])", [EMPRESA, chaves]);
        await new Promise((r) => setTimeout(r, 120));
        await c.query(
          `INSERT INTO public.cash_flow_entries (company_id, type, amount, date)
           VALUES ($1, 'saida', $2, date '2026-08-15')`,
          [EMPRESA, i + 1],
        );
        await c.query("COMMIT");
        return "ok";
      } finally {
        await c.end();
      }
    };

    const resultados = await Promise.all(listas.map(correr));
    expect(resultados).toEqual(["ok", "ok", "ok", "ok"]);
    expect(Number((await pool.query("select count(*) n from public.cash_flow_entries")).rows[0].n)).toBe(4);
  }, 120_000);

  it("7/8/9 · qualquer um dos três fechado ⇒ zero escrita", async () => {
    for (const mesFechado of [7, 8, 9]) {
      await pool.query("DELETE FROM public.cash_flow_entries");
      await pool.query("DELETE FROM public.financial_periods");
      await pool.query("SELECT * FROM public.close_financial_period_atomic($1, 2026, $2, $3)", [
        EMPRESA,
        mesFechado,
        ACTOR,
      ]);

      const c = await ligacao();
      await c.query("BEGIN");
      let erro = "";
      try {
        await c.query("SELECT public.assert_financial_periods_open_locked_many($1, ARRAY[202607, 202608, 202609])", [
          EMPRESA,
        ]);
        await c.query(
          `INSERT INTO public.cash_flow_entries (company_id, type, amount, date)
           VALUES ($1, 'saida', 5, date '2026-08-15')`,
          [EMPRESA],
        );
        await c.query("COMMIT");
      } catch (e) {
        erro = String((e as Error).message);
        await c.query("ROLLBACK").catch(() => {});
      }
      await c.end();

      expect(erro, `mês ${mesFechado} fechado tem de recusar`).toMatch(
        new RegExp(`FINANCIAL_PERIOD_CLOSED: 2026-0${mesFechado}`),
      );
      expect(Number((await pool.query("select count(*) n from public.cash_flow_entries")).rows[0].n)).toBe(0);
    }
  }, 180_000);

  it("10 · rollback depois de TODOS os locks não deixa efeito nem lock pendurado", async () => {
    const c = await ligacao();
    await c.query("BEGIN");
    await c.query("SELECT public.assert_financial_periods_open_locked_many($1, ARRAY[202607, 202608, 202609])", [
      EMPRESA,
    ]);
    await c.query(
      `INSERT INTO public.cash_flow_entries (company_id, type, amount, date)
       VALUES ($1, 'saida', 5, date '2026-08-15')`,
      [EMPRESA],
    );
    await c.query("ROLLBACK");

    expect(Number((await pool.query("select count(*) n from public.cash_flow_entries")).rows[0].n)).toBe(0);

    // `pg_advisory_xact_lock` liberta no fim da transação, commit ou rollback.
    // Se ficasse pendurado, este fecho ficaria a esperar para sempre.
    const r = await pool.query("SELECT * FROM public.close_financial_period_atomic($1, 2026, 8, $2)", [EMPRESA, ACTOR]);
    expect(r.rows[0].fechado).toBe(true);
    await c.end();
  }, 120_000);

  it("11 · empresas diferentes com a mesma lista não competem", async () => {
    const a = await ligacao();
    await a.query("BEGIN");
    await a.query("SELECT public.assert_financial_periods_open_locked_many($1, ARRAY[202607, 202608, 202609])", [
      EMPRESA,
    ]);

    // A outra empresa passa sem esperar. Um timeout curto prova-o: se
    // competisse, isto expirava em vez de devolver.
    const b = await ligacao();
    await b.query("BEGIN");
    await b.query("SET LOCAL lock_timeout = '2s'");
    await b.query("SELECT public.assert_financial_periods_open_locked_many($1, ARRAY[202607, 202608, 202609])", [
      OUTRA,
    ]);
    await b.query("COMMIT");

    await a.query("COMMIT");
    await a.end();
    await b.end();
  }, 120_000);

  it("12 · períodos diferentes da mesma empresa não competem", async () => {
    const a = await ligacao();
    await a.query("BEGIN");
    await a.query("SELECT public.assert_financial_periods_open_locked_many($1, ARRAY[202601, 202602])", [EMPRESA]);

    const b = await ligacao();
    await b.query("BEGIN");
    await b.query("SET LOCAL lock_timeout = '2s'");
    await b.query("SELECT public.assert_financial_periods_open_locked_many($1, ARRAY[202611, 202612])", [EMPRESA]);
    await b.query("COMMIT");

    await a.query("COMMIT");
    await a.end();
    await b.end();
  }, 120_000);

  it("13 · entrada inválida falha FECHADO, e não silenciosamente aberta", async () => {
    // Mês fora de 1..12: a chave 202613 é aritmeticamente possível e
    // semanticamente lixo. Aceitá-la daria um recurso de lock que writer
    // nenhum voltaria a calcular da mesma maneira.
    await expect(bloquear([202613])).rejects.toThrow(/FINANCIAL_PERIOD_LOCK_INVALID_MONTH: 13/);
    await expect(bloquear([202600])).rejects.toThrow(/FINANCIAL_PERIOD_LOCK_INVALID_MONTH: 0/);
    await expect(bloquear([-5])).rejects.toThrow(/FINANCIAL_PERIOD_LOCK_INVALID_MONTH/);

    // Conjunto vazio é recusa, não no-op: escrever sem período protegido é
    // exactamente o que o protocolo existe para impedir.
    await expect(bloquear([])).rejects.toThrow(/FINANCIAL_PERIOD_LOCK_EMPTY_SET/);
    await expect(
      pool.query("SELECT public.lock_financial_periods_many($1, NULL::integer[])", [EMPRESA]),
    ).rejects.toThrow(/FINANCIAL_PERIOD_LOCK_INVALID_ARGS/);
    await expect(
      pool.query("SELECT public.lock_financial_periods_many($1, ARRAY[202608, NULL]::integer[])", [EMPRESA]),
    ).rejects.toThrow(/FINANCIAL_PERIOD_LOCK_INVALID_ARGS/);
    await expect(
      pool.query("SELECT public.lock_financial_periods_many(NULL, ARRAY[202608])"),
    ).rejects.toThrow(/FINANCIAL_PERIOD_LOCK_INVALID_ARGS/);

    // Uma chave inválida NO MEIO recusa antes de adquirir seja o que for.
    await expect(bloquear([202607, 202699, 202609])).rejects.toThrow(/INVALID_MONTH: 99/);
  }, 120_000);

  it("13b · uma chave inválida no meio não deixa nenhum lock adquirido", async () => {
    const c = await ligacao();
    await c.query("BEGIN");
    await c.query("SELECT public.lock_financial_periods_many($1, ARRAY[202607, 202699])", [EMPRESA]).catch(() => {});
    // A transação está em estado de erro; o que interessa é que Julho não
    // ficou trancado por ninguém depois do ROLLBACK.
    await c.query("ROLLBACK");
    await c.end();

    const r = await pool.query("SELECT * FROM public.close_financial_period_atomic($1, 2026, 7, $2)", [EMPRESA, ACTOR]);
    expect(r.rows[0].fechado).toBe(true);
  }, 120_000);
});

// ============================================================================
// Datas → períodos: a ponte que os writers usam
// ============================================================================
describe("090 — datas como entrada do protocolo", () => {
  const chaves = async (datas: (string | null)[]) =>
    (await pool.query("SELECT public.financial_period_lock_keys($1::date[]) AS k", [datas])).rows[0].k as number[];

  it("converte, deduplica e ordena", async () => {
    expect(await chaves(["2026-09-30", "2026-07-01", "2026-09-02"])).toEqual([202607, 202609]);
  }, 120_000);

  it("datas NULL são descartadas — uma data que não existe não nomeia período", async () => {
    expect(await chaves([null, "2026-08-10", null])).toEqual([202608]);
    expect(await chaves([null, null])).toEqual([]);
    expect((await pool.query("SELECT public.financial_period_lock_keys(NULL::date[]) AS k")).rows[0].k).toEqual([]);
  }, 120_000);

  it("lista só de NULLs falha FECHADO na hora de bloquear", async () => {
    await expect(
      pool.query("SELECT public.assert_financial_period_dates_open_locked($1, ARRAY[NULL]::date[])", [EMPRESA]),
    ).rejects.toThrow(/FINANCIAL_PERIOD_LOCK_EMPTY_SET/);
  }, 120_000);

  it("o atalho por datas dá a mesma garantia que as chaves", async () => {
    await pool.query("SELECT * FROM public.close_financial_period_atomic($1, 2026, 7, $2)", [EMPRESA, ACTOR]);

    await expect(
      pool.query("SELECT public.assert_financial_period_dates_open_locked($1, ARRAY['2026-08-10','2026-07-20']::date[])", [
        EMPRESA,
      ]),
    ).rejects.toThrow(/FINANCIAL_PERIOD_CLOSED: 2026-07/);

    await pool.query("SELECT public.assert_financial_period_dates_open_locked($1, ARRAY['2026-08-10','2026-09-20']::date[])", [
      EMPRESA,
    ]);
  }, 120_000);
});

// ============================================================================
// Uma convenção só: par e singular são invocações da primitiva
// ============================================================================
//
// Duas implementações da ordem de aquisição seriam duas ordens, e bastava isso
// para o deadlock voltar entre um writer que usa o par e outro que usa a lista.
describe("090 — o par e o singular não têm ordem própria", () => {
  it("o par produz exactamente a ordem canónica da lista", async () => {
    // Se o par tivesse implementação própria, esta equivalência era acidental.
    const c = await ligacao();
    await c.query("BEGIN");
    await c.query("SELECT public.lock_financial_periods_pair($1, 2026, 9, 2026, 7)", [EMPRESA]);
    const { rows } = await c.query(
      `SELECT objid FROM pg_locks
        WHERE locktype = 'advisory' AND pid = pg_backend_pid() AND objid IN (202607, 202609)
        ORDER BY objid`,
    );
    expect(rows.map((r) => Number(r.objid))).toEqual([202607, 202609]);
    await c.query("ROLLBACK");
    await c.end();
  }, 120_000);

  it("o par com o mesmo mês dos dois lados adquire um recurso só", async () => {
    const c = await ligacao();
    await c.query("BEGIN");
    await c.query("SELECT public.lock_financial_periods_pair($1, 2026, 7, 2026, 7)", [EMPRESA]);
    const { rows } = await c.query(
      `SELECT count(*)::int AS n FROM pg_locks
        WHERE locktype = 'advisory' AND pid = pg_backend_pid() AND objid = 202607`,
    );
    expect(rows[0].n).toBe(1);
    await c.query("ROLLBACK");
    await c.end();
  }, 120_000);

  it("o singular continua a recusar mês inválido", async () => {
    await expect(pool.query("SELECT public.lock_financial_period($1, 2026, 13)", [EMPRESA])).rejects.toThrow(
      /FINANCIAL_PERIOD_LOCK_INVALID_MONTH/,
    );
    await expect(pool.query("SELECT public.assert_financial_period_open_locked($1, 2026, 0)", [EMPRESA])).rejects.toThrow(
      /FINANCIAL_PERIOD_LOCK_INVALID_MONTH/,
    );
  }, 120_000);
});

// ============================================================================
// Auditoria do fecho e da reabertura, na mesma transação
// ============================================================================
//
// O requisito do domínio é que um fecho tenha autoria registada. Com o
// `auditLog` depois do COMMIT, uma falha de rede deixava o mês fechado e sem
// registo de quem o fechou — e não há forma de o descobrir depois.
describe("090 — CLOSE_AUDIT_ATOMIC / REOPEN_AUDIT_ATOMIC", () => {
  const auditoria = async (accao: string) =>
    (await pool.query("select * from public.audit_logs where action = $1 order by created_at", [accao])).rows;

  it("fechar grava estado e auditoria na mesma transação", async () => {
    await pool.query("SELECT * FROM public.close_financial_period_atomic($1, 2026, 9, $2)", [EMPRESA, ACTOR]);

    const linhas = await auditoria("financial_period_closed");
    expect(linhas).toHaveLength(1);
    expect(linhas[0].company_id).toBe(EMPRESA);
    expect(linhas[0].actor_id).toBe(ACTOR);
    expect(linhas[0].entity_type).toBe("financial_period");
    expect(linhas[0].entity_id).toBe("2026-09");
    expect(linhas[0].meta.year).toBe(2026);
    expect(linhas[0].meta.month).toBe(9);
    expect(linhas[0].created_at).toBeInstanceOf(Date);
  }, 120_000);

  it("reabrir grava o motivo na auditoria, na mesma transação", async () => {
    await pool.query("SELECT * FROM public.close_financial_period_atomic($1, 2026, 9, $2)", [EMPRESA, ACTOR]);
    await pool.query("SELECT public.reopen_financial_period_atomic($1, 2026, 9, $2, 'erro na fatura 12')", [
      EMPRESA,
      ACTOR,
    ]);

    const linhas = await auditoria("financial_period_reopened");
    expect(linhas).toHaveLength(1);
    expect(linhas[0].actor_id).toBe(ACTOR);
    expect(linhas[0].entity_id).toBe("2026-09");
    expect(linhas[0].meta.reason).toBe("erro na fatura 12");
  }, 120_000);

  it("rollback desfaz estado E auditoria — nunca uma sem a outra", async () => {
    const c = await ligacao();
    await c.query("BEGIN");
    await c.query("SELECT * FROM public.close_financial_period_atomic($1, 2026, 9, $2)", [EMPRESA, ACTOR]);
    await c.query("ROLLBACK");
    await c.end();

    expect(await aberto(2026, 9)).toBe(true);
    expect(await auditoria("financial_period_closed")).toHaveLength(0);
  }, 120_000);

  it("fecho bloqueado não deixa auditoria de um fecho que não aconteceu", async () => {
    await pool.query(
      `INSERT INTO public.invoices (company_id, status, period_start) VALUES ($1, 'rascunho', date '2026-09-10')`,
      [EMPRESA],
    );

    const r = await pool.query("SELECT * FROM public.close_financial_period_atomic($1, 2026, 9, $2)", [EMPRESA, ACTOR]);
    expect(r.rows[0].fechado).toBe(false);
    expect(await auditoria("financial_period_closed")).toHaveLength(0);
  }, 120_000);

  it("fechar duas vezes não duplica a auditoria", async () => {
    await pool.query("SELECT * FROM public.close_financial_period_atomic($1, 2026, 9, $2)", [EMPRESA, ACTOR]);
    await pool.query("SELECT * FROM public.close_financial_period_atomic($1, 2026, 9, $2)", [EMPRESA, ACTOR]);

    expect(await auditoria("financial_period_closed")).toHaveLength(1);
  }, 120_000);
});

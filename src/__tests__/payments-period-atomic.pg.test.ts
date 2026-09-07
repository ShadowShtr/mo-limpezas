// ============================================================================
// 092 — pagamentos fixos e variáveis dentro do protocolo de período
// ============================================================================
//
// Este domínio tinha os dois defeitos ao mesmo tempo: RPCs que perguntavam
// `is_financial_period_open` sem adquirir o lock — protecção aparente — e
// caminhos que não perguntavam nada.
//
// O que se exige de cada operação, com qualquer um dos meses envolvidos
// fechado: ZERO ESCRITA. E com todos abertos: exactamente o comportamento que a
// 079/080/081/082/088 já tinham, à letra.
// ============================================================================

import { readFileSync } from "node:fs";
import { join } from "node:path";
import pg from "pg";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { startPostgresContainer, type PostgresContainer } from "./helpers/pg-container";

const ROOT = process.cwd();
const CONTAINER = `pagper-${process.pid}`;
const EMPRESA = "11111111-1111-4111-8111-111111111111";
const OUTRA = "22222222-2222-4222-8222-222222222222";
const ACTOR = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";

let container: PostgresContainer;
let pool: pg.Pool;

async function ligacao() {
  const c = new pg.Client({ ...container.connection });
  await c.connect();
  return c;
}

/**
 * O palco mínimo: as tabelas que estas RPCs tocam, a fundação da 090, as
 * versões pré-092 das funções (para o `CREATE OR REPLACE` ter o que
 * substituir), e a 092 por cima.
 */
async function baseline() {
  await pool.query(`
    DROP SCHEMA IF EXISTS public CASCADE;
    CREATE SCHEMA public;

    CREATE TABLE public.financial_periods (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      company_id uuid NOT NULL, year integer NOT NULL, month integer NOT NULL,
      status text NOT NULL DEFAULT 'open',
      closed_at timestamptz, closed_by uuid,
      reopened_at timestamptz, reopened_by uuid, reopen_reason text,
      created_at timestamptz NOT NULL DEFAULT now(),
      updated_at timestamptz NOT NULL DEFAULT now(),
      UNIQUE (company_id, year, month)
    );

    CREATE TABLE public.audit_logs (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      company_id uuid NOT NULL, actor_id uuid NOT NULL, action text NOT NULL,
      entity_type text NOT NULL DEFAULT 'timesheet', entity_id text,
      meta jsonb NOT NULL DEFAULT '{}',
      created_at timestamptz NOT NULL DEFAULT now()
    );

    CREATE TABLE public.companies (id uuid PRIMARY KEY, name text NOT NULL);
    CREATE TABLE public.profiles (id uuid PRIMARY KEY, company_id uuid, full_name text);

    CREATE TABLE public.invoices (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      company_id uuid NOT NULL, status text NOT NULL, period_start date
    );
    CREATE TABLE public.bank_transactions (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      company_id uuid NOT NULL, status text NOT NULL, transaction_date date
    );

    CREATE TABLE public.cash_flow_entries (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      company_id uuid NOT NULL, type text NOT NULL, amount numeric NOT NULL,
      description text, category text, date date NOT NULL,
      expense_category_id uuid,
      reference_id uuid, reference_type text,
      status text NOT NULL DEFAULT 'confirmado'
        CHECK (status IN ('pendente', 'confirmado')),
      notes text,
      created_at timestamptz NOT NULL DEFAULT now()
    );
    -- O índice PARCIAL da 024, que o ON CONFLICT das RPCs precisa de inferir.
    CREATE UNIQUE INDEX cash_flow_ref_unico
      ON public.cash_flow_entries (company_id, reference_type, reference_id)
      WHERE reference_type IS NOT NULL AND reference_id IS NOT NULL;

    CREATE TABLE public.fixed_variable_payments (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      company_id uuid NOT NULL REFERENCES public.companies(id) ON DELETE CASCADE,
      kind text NOT NULL, description text NOT NULL,
      amount numeric(10,2), due_date date,
      expense_category_id uuid, direct_debit boolean NOT NULL DEFAULT false,
      status text NOT NULL DEFAULT 'pendente',
      recurring boolean NOT NULL DEFAULT false,
      period_year integer NOT NULL,
      period_month integer NOT NULL CHECK (period_month BETWEEN 1 AND 12),
      notes text, sort_order integer NOT NULL DEFAULT 0,
      paid_at timestamptz,
      created_by uuid REFERENCES public.profiles(id) ON DELETE SET NULL,
      created_at timestamptz NOT NULL DEFAULT now(),
      updated_at timestamptz NOT NULL DEFAULT now()
    );

    -- A 080. RESTRICT de propósito: ninguém apaga um movimento com origem
    -- registada sem passar pelo unmark.
    CREATE TABLE public.payment_cashflow_provenance (
      cash_flow_entry_id uuid PRIMARY KEY
        REFERENCES public.cash_flow_entries(id) ON DELETE RESTRICT,
      company_id uuid NOT NULL,
      payment_id uuid NOT NULL
        REFERENCES public.fixed_variable_payments(id) ON DELETE RESTRICT,
      origin text NOT NULL CHECK (origin IN ('created_by_mark', 'adopted_existing')),
      prestate_date date,
      prestate_expense_category_id uuid,
      created_at timestamptz NOT NULL DEFAULT now()
    );

    CREATE TABLE public.bank_reconciliation_matches (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      company_id uuid NOT NULL,
      bank_transaction_id uuid,
      cash_flow_entry_id uuid REFERENCES public.cash_flow_entries(id) ON DELETE CASCADE,
      status text NOT NULL DEFAULT 'suggested'
    );

    CREATE FUNCTION public.is_financial_period_open(p_company_id uuid, p_year integer, p_month integer)
    RETURNS boolean LANGUAGE sql STABLE AS 'SELECT NOT EXISTS (SELECT 1 FROM public.financial_periods WHERE company_id = p_company_id AND year = p_year AND month = p_month AND status = ''closed'')';
  `);

  await pool.query(readFileSync(join(ROOT, "src/__tests__/fixtures/pre-092-payment-rpcs.sql"), "utf8"));
  await pool.query(readFileSync(join(ROOT, "supabase/migrations/090_financial_period_lock_protocol.sql"), "utf8"));
  await pool.query(readFileSync(join(ROOT, "supabase/migrations/092_payments_period_atomic.sql"), "utf8"));

  await pool.query("INSERT INTO public.companies (id, name) VALUES ($1, 'A'), ($2, 'B')", [EMPRESA, OUTRA]);
  await pool.query("INSERT INTO public.profiles (id, company_id, full_name) VALUES ($1, $2, 'Gestora')", [
    ACTOR,
    EMPRESA,
  ]);
}

/**
 * Fecha o mês DIRECTAMENTE, para preparar cenários.
 *
 * 🔴 Não passa por `close_financial_period_atomic` de propósito. Quase todos
 *    estes cenários semeiam um pagamento `pendente` no mês que querem fechado —
 *    e `pagamentos_pendentes` é um dos quatro BLOQUEADORES do fecho. Fechar pela
 *    RPC devolveria `fechado = false`, o mês ficaria aberto, e o teste diria
 *    «a guarda não recusou» quando o que falhou foi o palco.
 *
 *    Os testes que provam o fecho em si — bloqueadores, concorrência, auditoria
 *    — usam a RPC, e é lá que ela tem de ser exercitada.
 */
const fechar = (ano: number, mes: number, empresa = EMPRESA) =>
  pool.query(
    `INSERT INTO public.financial_periods (company_id, year, month, status, closed_at, closed_by)
     VALUES ($1, $2, $3, 'closed', now(), $4)`,
    [empresa, ano, mes, ACTOR],
  );

const nPagamentos = async () =>
  Number((await pool.query("select count(*) n from public.fixed_variable_payments")).rows[0].n);

const nCaixa = async () =>
  Number((await pool.query("select count(*) n from public.cash_flow_entries")).rows[0].n);

const pagamento = async (id: string) =>
  (await pool.query("SELECT * FROM public.fixed_variable_payments WHERE id = $1", [id])).rows[0];

const movimento = async (pagId: string) =>
  (
    await pool.query(
      `SELECT *, to_char(date, 'YYYY-MM-DD') AS d FROM public.cash_flow_entries
        WHERE reference_type = 'fixed_variable_payment' AND reference_id = $1`,
      [pagId],
    )
  ).rows[0];

/** Um pagamento semeado por baixo do protocolo, para preparar cenários. */
async function semearPagamento(opts?: {
  ano?: number;
  mes?: number;
  amount?: number;
  status?: string;
  vencimento?: string;
}) {
  const { rows } = await pool.query(
    `INSERT INTO public.fixed_variable_payments
       (company_id, kind, description, amount, due_date, status, period_year, period_month)
     VALUES ($1, 'fixo', 'semeado', $2, $3::date, $4, $5, $6) RETURNING id`,
    [
      EMPRESA,
      opts?.amount ?? 100,
      opts?.vencimento ?? null,
      opts?.status ?? "pendente",
      opts?.ano ?? 2026,
      opts?.mes ?? 7,
    ],
  );
  return rows[0].id as string;
}

/** Um movimento pendente já existente e ligado ao pagamento — o caso legado. */
const semearMovimentoPendente = (pagId: string, data: string, valor = 100) =>
  pool.query(
    `INSERT INTO public.cash_flow_entries
       (company_id, type, amount, description, category, date, reference_type, reference_id, status)
     VALUES ($1, 'saida', $2, 'legado', 'despesa', $3::date, 'fixed_variable_payment', $4, 'pendente')`,
    [EMPRESA, valor, data, pagId],
  );

beforeAll(async () => {
  container = await startPostgresContainer({
    name: CONTAINER,
    database: "pagper",
    serverFlags: ["shared_buffers=16MB", "max_connections=25", "work_mem=1MB", "maintenance_work_mem=8MB"],
  });
  pool = new pg.Pool({ ...container.connection, max: 4 });
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

beforeEach(async () => {
  await baseline();
});

// ============================================================================
describe("092 — CREATE", () => {
  it("mês aberto: cria com a competência pedida", async () => {
    const { rows } = await pool.query(
      "SELECT * FROM public.create_payment_atomic($1, 'fixo', 'Renda', 500, '2026-07-10'::date, 2026, 7, NULL, false, NULL, $2)",
      [EMPRESA, ACTOR],
    );
    expect(rows[0].payment_id).toBeTruthy();
    const p = await pagamento(rows[0].payment_id);
    expect(p.status).toBe("pendente");
    expect(p.period_year).toBe(2026);
    expect(p.period_month).toBe(7);
    expect(p.recurring).toBe(true); // kind = 'fixo'
  }, 120_000);

  it("🔴 mês fechado: ZERO ESCRITA", async () => {
    await fechar(2026, 7);
    await expect(
      pool.query(
        "SELECT * FROM public.create_payment_atomic($1, 'fixo', 'Renda', 500, '2026-07-10'::date, 2026, 7, NULL, false, NULL, $2)",
        [EMPRESA, ACTOR],
      ),
    ).rejects.toThrow(/FINANCIAL_PERIOD_CLOSED: 2026-07/);
    expect(await nPagamentos()).toBe(0);
  }, 120_000);

  it("o período é o da COMPETÊNCIA, não o do vencimento", async () => {
    // Um pagamento de competência de Julho com vencimento em Agosto pertence a
    // Julho. Fechar Agosto não pode impedir a criação.
    await fechar(2026, 8);
    const { rows } = await pool.query(
      "SELECT * FROM public.create_payment_atomic($1, 'variavel', 'Luz', 80, '2026-08-05'::date, 2026, 7, NULL, false, NULL, $2)",
      [EMPRESA, ACTOR],
    );
    expect(rows[0].payment_id).toBeTruthy();
    expect(await nPagamentos()).toBe(1);
  }, 120_000);

  it("`sort_order` é calculado dentro da transação, por `kind`", async () => {
    for (let i = 0; i < 3; i++) {
      await pool.query(
        "SELECT * FROM public.create_payment_atomic($1, 'fixo', $2, 10, NULL, 2026, 7, NULL, false, NULL, $3)",
        [EMPRESA, `F${i}`, ACTOR],
      );
    }
    await pool.query(
      "SELECT * FROM public.create_payment_atomic($1, 'variavel', 'V0', 10, NULL, 2026, 7, NULL, false, NULL, $2)",
      [EMPRESA, ACTOR],
    );
    const { rows } = await pool.query(
      "SELECT kind, array_agg(sort_order ORDER BY sort_order) o FROM public.fixed_variable_payments GROUP BY kind ORDER BY kind",
    );
    expect(rows.find((r) => r.kind === "fixo").o).toEqual([1, 2, 3]);
    expect(rows.find((r) => r.kind === "variavel").o).toEqual([1]);
  }, 120_000);

  it("valida os argumentos antes de tocar na base", async () => {
    const casos: [string, RegExp][] = [
      ["SELECT public.create_payment_atomic($1, 'fixo', '   ', 10, NULL, 2026, 7)", /PAYMENT_DESCRIPTION_REQUIRED/],
      ["SELECT public.create_payment_atomic($1, 'fixo', 'x', -1, NULL, 2026, 7)", /PAYMENT_AMOUNT_INVALID/],
      ["SELECT public.create_payment_atomic($1, 'fixo', 'x', 10, NULL, NULL, 7)", /PAYMENT_INVALID_ARGS/],
      ["SELECT public.create_payment_atomic($1, 'fixo', 'x', 10, NULL, 2026, 13)", /INVALID_MONTH/],
    ];
    for (const [sql, erro] of casos) {
      await expect(pool.query(sql, [EMPRESA]), sql).rejects.toThrow(erro);
    }
    expect(await nPagamentos()).toBe(0);
  }, 120_000);
});

// ============================================================================
describe("092 — UPDATE e movimento de competência", () => {
  it("mês aberto: edita e mantém as regras da 088", async () => {
    const id = await semearPagamento({ ano: 2026, mes: 7 });
    await pool.query("SELECT * FROM public.update_payment_atomic($1, $2, $3::jsonb)", [
      EMPRESA,
      id,
      JSON.stringify({ description: "novo nome" }),
    ]);
    expect((await pagamento(id)).description).toBe("novo nome");
  }, 120_000);

  it("mudar o vencimento move a competência — e os DOIS meses ficam protegidos", async () => {
    const id = await semearPagamento({ ano: 2026, mes: 7 });
    await pool.query("SELECT * FROM public.update_payment_atomic($1, $2, $3::jsonb)", [
      EMPRESA,
      id,
      JSON.stringify({ due_date: "2026-08-20" }),
    ]);
    const p = await pagamento(id);
    expect([p.period_year, p.period_month]).toEqual([2026, 8]);
  }, 120_000);

  it("🔴 competência de ORIGEM fechada: ZERO ESCRITA", async () => {
    const id = await semearPagamento({ ano: 2026, mes: 7 });
    await fechar(2026, 7);
    await expect(
      pool.query("SELECT * FROM public.update_payment_atomic($1, $2, $3::jsonb)", [
        EMPRESA,
        id,
        JSON.stringify({ due_date: "2026-08-20" }),
      ]),
    ).rejects.toThrow(/FINANCIAL_PERIOD_CLOSED: 2026-07/);
    const p = await pagamento(id);
    expect([p.period_year, p.period_month]).toEqual([2026, 7]);
    expect(p.due_date).toBeNull();
  }, 120_000);

  it("🔴 competência de DESTINO fechada: ZERO ESCRITA", async () => {
    const id = await semearPagamento({ ano: 2026, mes: 7 });
    await fechar(2026, 8);
    await expect(
      pool.query("SELECT * FROM public.update_payment_atomic($1, $2, $3::jsonb)", [
        EMPRESA,
        id,
        JSON.stringify({ due_date: "2026-08-20" }),
      ]),
    ).rejects.toThrow(/FINANCIAL_PERIOD_CLOSED: 2026-08/);
    const p = await pagamento(id);
    expect([p.period_year, p.period_month]).toEqual([2026, 7]);
  }, 120_000);

  it("as guardas da 088 continuam todas lá", async () => {
    const id = await semearPagamento({ ano: 2026, mes: 7, amount: 100 });

    await expect(
      pool.query("SELECT * FROM public.update_payment_atomic($1, $2, $3::jsonb)", [
        EMPRESA,
        id,
        JSON.stringify({ status: "pago" }),
      ]),
    ).rejects.toThrow(/PAYMENT_FIELD_NOT_EDITABLE/);

    await expect(
      pool.query("SELECT * FROM public.update_payment_atomic($1, $2, $3::jsonb)", [
        EMPRESA,
        id,
        JSON.stringify({ amount: -5 }),
      ]),
    ).rejects.toThrow(/PAYMENT_AMOUNT_INVALID/);

    // Valor bloqueado quando já há movimento ligado.
    await semearMovimentoPendente(id, "2026-07-15");
    await expect(
      pool.query("SELECT * FROM public.update_payment_atomic($1, $2, $3::jsonb)", [
        EMPRESA,
        id,
        JSON.stringify({ amount: 999 }),
      ]),
    ).rejects.toThrow(/PAYMENT_LINKED_TO_CASHFLOW/);

    await expect(
      pool.query("SELECT * FROM public.update_payment_atomic($1, $2, $3::jsonb)", [
        EMPRESA,
        "99999999-9999-4999-8999-999999999999",
        "{}",
      ]),
    ).rejects.toThrow(/PAYMENT_NOT_FOUND/);
  }, 120_000);

  it("editar a descrição continua a passar mesmo com o mês do movimento fechado", async () => {
    // O movimento não é tocado por esta função: o mês dele não muda de
    // conteúdo, e alargar o lock a ele recusaria uma correcção legítima.
    const id = await semearPagamento({ ano: 2026, mes: 7 });
    await semearMovimentoPendente(id, "2026-05-15");
    await fechar(2026, 5);

    await pool.query("SELECT * FROM public.update_payment_atomic($1, $2, $3::jsonb)", [
      EMPRESA,
      id,
      JSON.stringify({ description: "corrigido" }),
    ]);
    expect((await pagamento(id)).description).toBe("corrigido");
  }, 120_000);
});

// ============================================================================
describe("092 — MARK: competência, dia do pagamento e mês do movimento", () => {
  it("mês aberto: pagamento e caixa coerentes, na mesma transação", async () => {
    const id = await semearPagamento({ ano: 2026, mes: 7, amount: 100 });
    const { rows } = await pool.query("SELECT * FROM public.mark_payment_paid($1, $2, '2026-07-20'::date)", [
      EMPRESA,
      id,
    ]);
    expect(rows[0].ja_estava_pago).toBe(false);

    expect((await pagamento(id)).status).toBe("pago");
    const m = await movimento(id);
    expect(m.type).toBe("saida");
    expect(Number(m.amount)).toBe(100);
    expect(m.d).toBe("2026-07-20");
    expect(m.status).toBe("confirmado");

    const { rows: prov } = await pool.query("SELECT * FROM public.payment_cashflow_provenance");
    expect(prov).toHaveLength(1);
    expect(prov[0].origin).toBe("created_by_mark");
  }, 120_000);

  it("🔴 competência fechada: ZERO ESCRITA nos dois lados", async () => {
    const id = await semearPagamento({ ano: 2026, mes: 7 });
    await fechar(2026, 7);
    await expect(
      pool.query("SELECT * FROM public.mark_payment_paid($1, $2, '2026-08-20'::date)", [EMPRESA, id]),
    ).rejects.toThrow(/FINANCIAL_PERIOD_CLOSED: 2026-07/);
    expect((await pagamento(id)).status).toBe("pendente");
    expect(await nCaixa()).toBe(0);
  }, 120_000);

  it("🔴 mês do DIA DE PAGAMENTO fechado: ZERO ESCRITA — a competência não chega", async () => {
    const id = await semearPagamento({ ano: 2026, mes: 7 });
    await fechar(2026, 8);
    await expect(
      pool.query("SELECT * FROM public.mark_payment_paid($1, $2, '2026-08-20'::date)", [EMPRESA, id]),
    ).rejects.toThrow(/FINANCIAL_PERIOD_CLOSED: 2026-08/);
    expect((await pagamento(id)).status).toBe("pendente");
    expect(await nCaixa()).toBe(0);
  }, 120_000);

  it("reutiliza o movimento pendente pela MESMA linha, e regista o prestate", async () => {
    const id = await semearPagamento({ ano: 2026, mes: 7, amount: 100 });
    await semearMovimentoPendente(id, "2026-07-02");
    const antes = await movimento(id);

    await pool.query("SELECT * FROM public.mark_payment_paid($1, $2, '2026-07-20'::date)", [EMPRESA, id]);

    const depois = await movimento(id);
    expect(depois.id).toBe(antes.id); // mesma linha — o histórico fica
    expect(depois.status).toBe("confirmado");
    expect(depois.d).toBe("2026-07-20");
    expect(await nCaixa()).toBe(1);

    const { rows: prov } = await pool.query(
      "SELECT origin, to_char(prestate_date, 'YYYY-MM-DD') d FROM public.payment_cashflow_provenance",
    );
    expect(prov[0].origin).toBe("adopted_existing");
    expect(prov[0].d).toBe("2026-07-02");
  }, 120_000);

  it("🔴 o mês de ORIGEM do movimento reutilizado é protegido — três períodos", async () => {
    // A cobertura que a versão anterior não tinha: um movimento pendente de
    // Maio, arrastado para Agosto por um pagamento de competência de Julho.
    // Maio muda de conteúdo, e fechar Maio tem de parar a operação inteira.
    const id = await semearPagamento({ ano: 2026, mes: 7, amount: 100 });
    await semearMovimentoPendente(id, "2026-05-02");
    await fechar(2026, 5);

    await expect(
      pool.query("SELECT * FROM public.mark_payment_paid($1, $2, '2026-08-20'::date)", [EMPRESA, id]),
    ).rejects.toThrow(/FINANCIAL_PERIOD_CLOSED: 2026-05/);

    expect((await pagamento(id)).status).toBe("pendente");
    const m = await movimento(id);
    expect(m.d).toBe("2026-05-02");
    expect(m.status).toBe("pendente");
  }, 120_000);

  it("os TRÊS meses ficam trancados durante a operação", async () => {
    const id = await semearPagamento({ ano: 2026, mes: 7, amount: 100 });
    await semearMovimentoPendente(id, "2026-05-02");

    const c = await ligacao();
    await c.query("BEGIN");
    await c.query("SELECT * FROM public.mark_payment_paid($1, $2, '2026-08-20'::date)", [EMPRESA, id]);
    const { rows } = await c.query(
      `SELECT objid::bigint chave FROM pg_locks
        WHERE locktype = 'advisory' AND pid = pg_backend_pid() ORDER BY objid`,
    );
    expect(rows.map((r) => Number(r.chave))).toEqual([202605, 202607, 202608]);
    await c.query("ROLLBACK");
    await c.end();
  }, 120_000);

  it("idempotência: repetir não duplica nem mexe em nada", async () => {
    const id = await semearPagamento({ ano: 2026, mes: 7, amount: 100 });
    await pool.query("SELECT * FROM public.mark_payment_paid($1, $2, '2026-07-20'::date)", [EMPRESA, id]);
    const { rows } = await pool.query("SELECT * FROM public.mark_payment_paid($1, $2, '2026-07-25'::date)", [
      EMPRESA,
      id,
    ]);
    expect(rows[0].ja_estava_pago).toBe(true);
    expect(await nCaixa()).toBe(1);
    expect((await movimento(id)).d).toBe("2026-07-20"); // não foi reescrito
  }, 120_000);

  it("as guardas da 079 continuam todas lá", async () => {
    const semValor = await semearPagamento({ ano: 2026, mes: 7, amount: 0 });
    await expect(
      pool.query("SELECT * FROM public.mark_payment_paid($1, $2, '2026-07-20'::date)", [EMPRESA, semValor]),
    ).rejects.toThrow(/sem valor/);

    await expect(
      pool.query("SELECT * FROM public.mark_payment_paid($1, $2, '2026-07-20'::date)", [
        EMPRESA,
        "99999999-9999-4999-8999-999999999999",
      ]),
    ).rejects.toThrow(/inexistente ou de outra empresa/);

    // Valor diferente entre movimento e pagamento: falha fechado.
    const id = await semearPagamento({ ano: 2026, mes: 7, amount: 100 });
    await semearMovimentoPendente(id, "2026-07-02", 55);
    await expect(
      pool.query("SELECT * FROM public.mark_payment_paid($1, $2, '2026-07-20'::date)", [EMPRESA, id]),
    ).rejects.toThrow(/CASHFLOW_LINK_AMOUNT_MISMATCH/);
  }, 120_000);
});

// ============================================================================
describe("092 — UNMARK: o mês onde está e o mês para onde volta", () => {
  it("desfaz o que o mark criou, e limpa a proveniência", async () => {
    const id = await semearPagamento({ ano: 2026, mes: 7, amount: 100 });
    await pool.query("SELECT * FROM public.mark_payment_paid($1, $2, '2026-07-20'::date)", [EMPRESA, id]);

    const { rows } = await pool.query("SELECT * FROM public.unmark_payment_paid($1, $2)", [EMPRESA, id]);
    expect(rows[0].movimentos_removidos).toBe(1);
    expect(await nCaixa()).toBe(0);
    expect((await pagamento(id)).status).toBe("pendente");
    expect(Number((await pool.query("select count(*) n from public.payment_cashflow_provenance")).rows[0].n)).toBe(0);
  }, 120_000);

  it("restaura o movimento adoptado em vez de o apagar", async () => {
    const id = await semearPagamento({ ano: 2026, mes: 7, amount: 100 });
    await semearMovimentoPendente(id, "2026-07-02");
    const antes = await movimento(id);
    await pool.query("SELECT * FROM public.mark_payment_paid($1, $2, '2026-07-20'::date)", [EMPRESA, id]);

    const { rows } = await pool.query("SELECT * FROM public.unmark_payment_paid($1, $2)", [EMPRESA, id]);
    expect(rows[0].movimentos_removidos).toBe(0);

    const depois = await movimento(id);
    expect(depois.id).toBe(antes.id);
    expect(depois.status).toBe("pendente");
    expect(depois.d).toBe("2026-07-02");
  }, 120_000);

  it("🔴 o mês para onde o movimento VOLTA é protegido — o terceiro período", async () => {
    // Adoptado com prestate em Maio, confirmado em Agosto, competência em
    // Julho. Desmarcar devolve-o a Maio: Maio muda de conteúdo, e fechá-lo tem
    // de parar a operação.
    const id = await semearPagamento({ ano: 2026, mes: 7, amount: 100 });
    await semearMovimentoPendente(id, "2026-05-02");
    await pool.query("SELECT * FROM public.mark_payment_paid($1, $2, '2026-08-20'::date)", [EMPRESA, id]);
    await fechar(2026, 5);

    await expect(pool.query("SELECT * FROM public.unmark_payment_paid($1, $2)", [EMPRESA, id])).rejects.toThrow(
      /FINANCIAL_PERIOD_CLOSED: 2026-05/,
    );

    expect((await pagamento(id)).status).toBe("pago");
    const m = await movimento(id);
    expect(m.d).toBe("2026-08-20");
    expect(m.status).toBe("confirmado");
  }, 120_000);

  it("🔴 o mês ONDE o movimento está é protegido", async () => {
    const id = await semearPagamento({ ano: 2026, mes: 7, amount: 100 });
    await pool.query("SELECT * FROM public.mark_payment_paid($1, $2, '2026-08-20'::date)", [EMPRESA, id]);
    await fechar(2026, 8);

    await expect(pool.query("SELECT * FROM public.unmark_payment_paid($1, $2)", [EMPRESA, id])).rejects.toThrow(
      /FINANCIAL_PERIOD_CLOSED: 2026-08/,
    );
    expect(await nCaixa()).toBe(1);
    expect((await pagamento(id)).status).toBe("pago");
  }, 120_000);

  it("as guardas da 081 continuam todas lá", async () => {
    // Conciliado: recusa.
    const id = await semearPagamento({ ano: 2026, mes: 7, amount: 100 });
    await pool.query("SELECT * FROM public.mark_payment_paid($1, $2, '2026-07-20'::date)", [EMPRESA, id]);
    const m = await movimento(id);
    await pool.query(
      "INSERT INTO public.bank_reconciliation_matches (company_id, cash_flow_entry_id, status) VALUES ($1, $2, 'confirmed')",
      [EMPRESA, m.id],
    );
    await expect(pool.query("SELECT * FROM public.unmark_payment_paid($1, $2)", [EMPRESA, id])).rejects.toThrow(
      /UNMARK_BLOCKED_RECONCILED_CASHFLOW/,
    );

    // Proveniência desconhecida: falha fechado, e NÃO apaga.
    const id2 = await semearPagamento({ ano: 2026, mes: 7, amount: 100 });
    await pool.query(
      `INSERT INTO public.cash_flow_entries
         (company_id, type, amount, description, category, date, reference_type, reference_id, status)
       VALUES ($1, 'saida', 100, 'legado', 'despesa', '2026-07-02'::date, 'fixed_variable_payment', $2, 'confirmado')`,
      [EMPRESA, id2],
    );
    await expect(pool.query("SELECT * FROM public.unmark_payment_paid($1, $2)", [EMPRESA, id2])).rejects.toThrow(
      /UNMARK_BLOCKED_UNKNOWN_CASHFLOW_PROVENANCE/,
    );
    expect(await movimento(id2)).toBeTruthy();
  }, 120_000);

  it("um pagamento sem movimento nenhum desmarca-se na mesma", async () => {
    const id = await semearPagamento({ ano: 2026, mes: 7, status: "pago" });
    const { rows } = await pool.query("SELECT * FROM public.unmark_payment_paid($1, $2)", [EMPRESA, id]);
    expect(rows[0].movimentos_removidos).toBe(0);
    expect((await pagamento(id)).status).toBe("pendente");
  }, 120_000);
});

// ============================================================================
describe("092 — DELETE e outros estados", () => {
  it("mês aberto: apaga", async () => {
    const id = await semearPagamento({ ano: 2026, mes: 7 });
    const { rows } = await pool.query("SELECT * FROM public.delete_payment_atomic($1, $2)", [EMPRESA, id]);
    expect(rows[0].apagados).toBe(1);
    expect(await nPagamentos()).toBe(0);
  }, 120_000);

  it("🔴 mês fechado: ZERO ESCRITA", async () => {
    const id = await semearPagamento({ ano: 2026, mes: 7 });
    await fechar(2026, 7);
    await expect(pool.query("SELECT * FROM public.delete_payment_atomic($1, $2)", [EMPRESA, id])).rejects.toThrow(
      /FINANCIAL_PERIOD_CLOSED: 2026-07/,
    );
    expect(await nPagamentos()).toBe(1);
  }, 120_000);

  it("as guardas da 082 continuam lá, e apagar o inexistente continua a ser sucesso", async () => {
    const pago = await semearPagamento({ ano: 2026, mes: 7, status: "pago" });
    await expect(pool.query("SELECT * FROM public.delete_payment_atomic($1, $2)", [EMPRESA, pago])).rejects.toThrow(
      /PAYMENT_ALREADY_PAID/,
    );

    const ligado = await semearPagamento({ ano: 2026, mes: 7 });
    await semearMovimentoPendente(ligado, "2026-07-15");
    await expect(pool.query("SELECT * FROM public.delete_payment_atomic($1, $2)", [EMPRESA, ligado])).rejects.toThrow(
      /PAYMENT_LINKED_TO_CASHFLOW/,
    );

    const { rows } = await pool.query("SELECT * FROM public.delete_payment_atomic($1, $2)", [
      EMPRESA,
      "99999999-9999-4999-8999-999999999999",
    ]);
    expect(rows[0].apagados).toBe(0);
  }, 120_000);

  it("cancelar remove um BLOQUEADOR do fecho — e por isso passa a exigir o mês aberto", async () => {
    const id = await semearPagamento({ ano: 2026, mes: 7 });
    await pool.query("SELECT * FROM public.set_payment_status_atomic($1, $2, 'cancelado', $3)", [EMPRESA, id, ACTOR]);
    expect((await pagamento(id)).status).toBe("cancelado");

    const id2 = await semearPagamento({ ano: 2026, mes: 8 });
    await fechar(2026, 8);
    await expect(
      pool.query("SELECT * FROM public.set_payment_status_atomic($1, $2, 'cancelado', $3)", [EMPRESA, id2, ACTOR]),
    ).rejects.toThrow(/FINANCIAL_PERIOD_CLOSED: 2026-08/);
    expect((await pagamento(id2)).status).toBe("pendente");
  }, 120_000);

  it("🔴 `pago` e `pendente` não passam por aqui", async () => {
    const id = await semearPagamento({ ano: 2026, mes: 7 });
    for (const estado of ["pago", "pendente"]) {
      await expect(
        pool.query("SELECT * FROM public.set_payment_status_atomic($1, $2, $3, $4)", [EMPRESA, id, estado, ACTOR]),
      ).rejects.toThrow(/PAYMENT_STATUS_NOT_HANDLED_HERE/);
    }
    expect((await pagamento(id)).status).toBe("pendente");
  }, 120_000);
});

// ============================================================================
describe("092 — concorrência writer vs fecho", () => {
  it("writer primeiro: o pagamento entra inteiro, e o fecho decide depois", async () => {
    const writer = await ligacao();
    const fecho = await ligacao();

    await writer.query("BEGIN");
    await writer.query(
      "SELECT * FROM public.create_payment_atomic($1, 'fixo', 'Renda', 500, NULL, 2026, 9, NULL, false, NULL, $2)",
      [EMPRESA, ACTOR],
    );

    const promessa = fecho.query("SELECT * FROM public.close_financial_period_atomic($1, 2026, 9, $2)", [
      EMPRESA,
      ACTOR,
    ]);
    await new Promise((r) => setTimeout(r, 400));
    await writer.query("COMMIT");
    const r = await promessa;

    expect(await nPagamentos()).toBe(1);
    // O pagamento nasceu `pendente`, e pendente é bloqueador.
    expect(r.rows[0].fechado).toBe(false);
    expect(r.rows[0].bloqueadores.pagamentos_pendentes).toBe(1);

    await writer.end();
    await fecho.end();
  }, 120_000);

  it("🔴 fecho primeiro: o writer acorda, encontra fechado e não escreve", async () => {
    const id = await semearPagamento({ ano: 2026, mes: 9, amount: 100, status: "cancelado" });
    const fecho = await ligacao();
    const writer = await ligacao();

    await fecho.query("BEGIN");
    await fecho.query("SELECT * FROM public.close_financial_period_atomic($1, 2026, 9, $2)", [EMPRESA, ACTOR]);

    const promessa = (async () => {
      await writer.query("BEGIN");
      try {
        await writer.query("SELECT * FROM public.mark_payment_paid($1, $2, '2026-09-20'::date)", [EMPRESA, id]);
        await writer.query("COMMIT");
        return "escreveu";
      } catch (e) {
        await writer.query("ROLLBACK").catch(() => {});
        return String((e as Error).message);
      }
    })();
    await new Promise((r) => setTimeout(r, 400));
    await fecho.query("COMMIT");

    expect(await promessa).toMatch(/FINANCIAL_PERIOD_CLOSED/);
    expect((await pagamento(id)).status).toBe("cancelado");
    expect(await nCaixa()).toBe(0);

    await fecho.end();
    await writer.end();
  }, 120_000);

  it("marcar e desmarcar em sentidos inversos ao mesmo tempo: deadlock zero", async () => {
    // Dois pagamentos com conjuntos de meses sobrepostos e descobertos por
    // ordens opostas.
    const a = await semearPagamento({ ano: 2026, mes: 5, amount: 100 });
    await semearMovimentoPendente(a, "2026-08-02");
    const b = await semearPagamento({ ano: 2026, mes: 8, amount: 100 });
    await semearMovimentoPendente(b, "2026-05-02");

    const marcar = async (id: string, marca: string) => {
      const c = await ligacao();
      try {
        await c.query("BEGIN");
        await c.query("SELECT * FROM public.mark_payment_paid($1, $2, '2026-07-20'::date)", [EMPRESA, id]);
        await new Promise((r) => setTimeout(r, 200));
        await c.query("COMMIT");
        return marca;
      } finally {
        await c.end();
      }
    };

    expect(await Promise.all([marcar(a, "A"), marcar(b, "B")])).toEqual(["A", "B"]);
    expect(await nCaixa()).toBe(2);
  }, 120_000);

  it("empresas diferentes não competem", async () => {
    const c1 = await ligacao();
    await c1.query("BEGIN");
    await c1.query(
      "SELECT * FROM public.create_payment_atomic($1, 'fixo', 'A', 10, NULL, 2026, 9, NULL, false, NULL, NULL)",
      [EMPRESA],
    );

    const c2 = await ligacao();
    await c2.query("BEGIN");
    await c2.query("SET LOCAL lock_timeout = '2s'");
    await c2.query(
      "SELECT * FROM public.create_payment_atomic($1, 'fixo', 'B', 10, NULL, 2026, 9, NULL, false, NULL, NULL)",
      [OUTRA],
    );
    await c2.query("COMMIT");
    await c1.query("COMMIT");

    expect(await nPagamentos()).toBe(2);
    await c1.end();
    await c2.end();
  }, 120_000);
});

// ============================================================================
describe("092 — superfície", () => {
  const ASSINATURAS: ReadonlyArray<readonly [string, string]> = [
    [
      "create_payment_atomic",
      "p_company_id uuid, p_kind text, p_description text, p_amount numeric, p_due_date date, p_period_year integer, p_period_month integer, p_expense_category_id uuid, p_direct_debit boolean, p_notes text, p_actor uuid",
    ],
    ["update_payment_atomic", "p_company_id uuid, p_payment_id uuid, p_patch jsonb"],
    ["mark_payment_paid", "p_company_id uuid, p_payment_id uuid, p_paid_on date"],
    ["unmark_payment_paid", "p_company_id uuid, p_payment_id uuid"],
    ["delete_payment_atomic", "p_company_id uuid, p_payment_id uuid"],
    ["set_payment_status_atomic", "p_company_id uuid, p_payment_id uuid, p_status text, p_actor uuid"],
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

  it("nenhuma é SECURITY DEFINER", async () => {
    const { rows } = await pool.query(
      `SELECT p.proname FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
        WHERE n.nspname = 'public' AND p.prosecdef AND p.proname = ANY($1::text[])`,
      [ASSINATURAS.map(([n]) => n)],
    );
    expect(rows.map((r) => r.proname)).toEqual([]);
  }, 120_000);

  it("anon e authenticated não executam; service_role executa", async () => {
    for (const [nome, assinatura] of ASSINATURAS) {
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

  it("a precondição recusa se a fundação 090 não estiver aplicada", async () => {
    await pool.query("DROP FUNCTION IF EXISTS public.assert_financial_periods_open_locked_many(uuid, integer[]) CASCADE");
    const sql = readFileSync(join(ROOT, "supabase/migrations/092_payments_period_atomic.sql"), "utf8");
    await expect(pool.query(sql)).rejects.toThrow(/092_PRECONDITION_FAILED/);
  }, 120_000);
});

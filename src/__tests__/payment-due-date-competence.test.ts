// ============================================================================
// COMPETÊNCIA POR VENCIMENTO — os resíduos, fechados
// ============================================================================
//
// O que estes ensaios protegem, em três frases:
//
//   1. O mês escolhido no topo do ecrã vale em TODOS os separadores, e um
//      pagamento pertence ao mês da sua competência — não ao dia em que o
//      dinheiro saiu.
//   2. «Por pagar» é a única excepção, e é deliberada: mostra também o que
//      ficou por pagar antes. Nenhum outro separador ganha atrasados.
//   3. Uma data de vencimento impossível não chega à base de dados, nem pelo
//      formulário nem pela Server Action.
// ============================================================================

import { describe, expect, it, vi, beforeEach } from "vitest";
import {
  buildFinanceLedger,
  type FinanceLedgerCashflowSource,
  type FinanceLedgerPaymentSource,
} from "@/domain/finance/ledger";
import {
  filterFinanceLedger,
  financeLedgerCounts,
  belongsToPeriod,
  type FinanceLedgerFilter,
} from "@/domain/finance/ledger-presentation";
import { loadFinanceLedger, type FinanceLedgerSource } from "@/lib/finance-ledger-query";

const pagamento = (patch: Partial<FinanceLedgerPaymentSource> = {}): FinanceLedgerPaymentSource => ({
  id: "pag-1",
  kind: "variavel",
  description: "Seguro",
  amount: 100,
  due_date: "2026-09-10",
  status: "pendente",
  period_year: 2026,
  period_month: 9,
  paid_at: null,
  expense_category_id: null,
  category_name: null,
  created_at: "2026-09-01T10:00:00Z",
  updated_at: "2026-09-01T10:00:00Z",
  ...patch,
});

const caixa = (patch: Partial<FinanceLedgerCashflowSource> = {}): FinanceLedgerCashflowSource => ({
  id: "cx-1",
  type: "saida",
  amount: 100,
  description: "Seguro",
  category: "despesa",
  date: "2026-09-15",
  reference_type: null,
  reference_id: null,
  status: "confirmado",
  expense_category_id: null,
  category_name: null,
  created_at: "2026-09-15T10:00:00Z",
  ...patch,
});

const SETEMBRO = { year: 2026, month: 9 };
const OUTUBRO = { year: 2026, month: 10 };

// O caso que motivou tudo isto: a obrigação é de Outubro, o dinheiro saiu em
// Setembro. São dois meses diferentes porque são dois eixos diferentes.
function outubroPagoEmSetembro() {
  const pag = pagamento({
    id: "pag-outubro",
    due_date: "2026-10-05",
    period_year: 2026,
    period_month: 10,
    status: "pago",
    paid_at: "2026-09-28T09:00:00Z",
  });
  const cx = caixa({
    id: "cx-outubro",
    date: "2026-09-28",
    reference_type: "fixed_variable_payment",
    reference_id: "pag-outubro",
  });
  return { pag, cx, rows: buildFinanceLedger({ payments: [pag], cashflows: [cx] }) };
}

const TODOS_OS_SEPARADORES: FinanceLedgerFilter[] =
  ["todos", "fixos", "variaveis", "por_pagar", "pagos", "manuais"];

describe("A/B — a competência decide o mês, a data de caixa não o move", () => {
  it("A: pagamento de Outubro pago em Setembro não aparece em Setembro", () => {
    const { rows } = outubroPagoEmSetembro();
    for (const separador of TODOS_OS_SEPARADORES) {
      const visiveis = filterFinanceLedger(rows, separador, SETEMBRO);
      expect(
        visiveis.some((r) => r.payment_id === "pag-outubro"),
        `separador ${separador} mostrou a obrigação de Outubro em Setembro`,
      ).toBe(false);
    }
  });

  it("B: o mesmo pagamento aparece em Outubro, como pagamento de Outubro", () => {
    const { rows } = outubroPagoEmSetembro();
    expect(filterFinanceLedger(rows, "todos", OUTUBRO).map((r) => r.payment_id)).toContain("pag-outubro");
    expect(filterFinanceLedger(rows, "pagos", OUTUBRO).map((r) => r.payment_id)).toContain("pag-outubro");
  });

  it("a linha continua a saber quando o dinheiro saiu, só não é isso que a coloca no mês", () => {
    const { rows } = outubroPagoEmSetembro();
    const linha = rows.find((r) => r.payment_id === "pag-outubro");
    expect(linha?.cash_date).toBe("2026-09-28");
    expect(linha?.competence_month).toBe(10);
  });
});

describe("C/D/E — «Por pagar» transita, e só ele", () => {
  const doMes = pagamento({ id: "pag-set", period_month: 9, due_date: "2026-09-20" });
  const atrasado = pagamento({
    id: "pag-ago", kind: "fixo", period_month: 8, due_date: "2026-08-15",
  });
  const rows = buildFinanceLedger({ payments: [doMes, atrasado], cashflows: [] });

  it("C: pendente do mês seleccionado aparece em Por pagar", () => {
    expect(filterFinanceLedger(rows, "por_pagar", SETEMBRO).map((r) => r.payment_id)).toContain("pag-set");
  });

  it("D: pendente de mês anterior também aparece em Por pagar", () => {
    expect(filterFinanceLedger(rows, "por_pagar", SETEMBRO).map((r) => r.payment_id)).toContain("pag-ago");
  });

  it("E: o atrasado NÃO contamina Todos, Fixos, Variáveis nem Pagos", () => {
    for (const separador of ["todos", "fixos", "variaveis", "pagos"] as FinanceLedgerFilter[]) {
      expect(
        filterFinanceLedger(rows, separador, SETEMBRO).some((r) => r.payment_id === "pag-ago"),
        `separador ${separador} ganhou um atrasado de Agosto`,
      ).toBe(false);
    }
  });

  it("uma obrigação FUTURA não é dívida: Novembro não entra no Por pagar de Setembro", () => {
    const futuro = pagamento({ id: "pag-nov", period_month: 11, due_date: "2026-11-03" });
    const comFuturo = buildFinanceLedger({ payments: [doMes, futuro], cashflows: [] });
    expect(filterFinanceLedger(comFuturo, "por_pagar", SETEMBRO).map((r) => r.payment_id))
      .not.toContain("pag-nov");
  });
});

describe("F/G — a coluna «Data» passa a ser o eixo da linha", () => {
  it("F: pendente com vencimento mostra o vencimento, não o created_at", () => {
    const rows = buildFinanceLedger({
      payments: [pagamento({ due_date: "2026-09-20", created_at: "2026-09-01T10:00:00Z" })],
      cashflows: [],
    });
    expect(rows[0].date).toBe("2026-09-20");
  });

  it("G: pago e ligado mostra a data do movimento de caixa", () => {
    const { rows } = outubroPagoEmSetembro();
    expect(rows.find((r) => r.payment_id === "pag-outubro")?.date).toBe("2026-09-28");
  });

  it("pago sem movimento cai em paid_at, não no vencimento", () => {
    const rows = buildFinanceLedger({
      payments: [pagamento({ status: "pago", paid_at: "2026-09-22T08:00:00Z", due_date: "2026-09-10" })],
      cashflows: [],
    });
    expect(rows[0].date).toBe("2026-09-22");
  });

  it("sem vencimento e sem caixa, o fallback deliberado para created_at mantém-se", () => {
    const rows = buildFinanceLedger({
      payments: [pagamento({ due_date: null, created_at: "2026-09-03T10:00:00Z" })],
      cashflows: [],
    });
    expect(rows[0].date).toBe("2026-09-03");
  });
});

describe("K — um movimento manual pertence ao mês da sua própria data", () => {
  const rows = buildFinanceLedger({
    payments: [],
    cashflows: [caixa({ id: "cx-set", date: "2026-09-15" }), caixa({ id: "cx-out", date: "2026-10-02" })],
  });

  it("entra no mês da data de caixa", () => {
    expect(filterFinanceLedger(rows, "manuais", SETEMBRO).map((r) => r.cashflow_id)).toEqual(["cx-set"]);
  });

  it("e sai dele no mês seguinte", () => {
    expect(filterFinanceLedger(rows, "manuais", OUTUBRO).map((r) => r.cashflow_id)).toEqual(["cx-out"]);
  });

  it("um movimento não tem competência: é a data civil que o situa", () => {
    const manual = rows.find((r) => r.cashflow_id === "cx-set");
    expect(manual?.competence_year).toBeNull();
    expect(belongsToPeriod(manual!, SETEMBRO)).toBe(true);
    expect(belongsToPeriod(manual!, OUTUBRO)).toBe(false);
  });
});

describe("L — as contagens não podem discordar da lista", () => {
  const rows = buildFinanceLedger({
    payments: [
      pagamento({ id: "p1", kind: "fixo", period_month: 9 }),
      pagamento({ id: "p2", kind: "variavel", period_month: 9, status: "pago", paid_at: "2026-09-11T10:00:00Z" }),
      pagamento({ id: "p3", kind: "fixo", period_month: 8, due_date: "2026-08-02" }),
      pagamento({ id: "p4", period_month: 10, due_date: "2026-10-02" }),
    ],
    cashflows: [caixa({ id: "cx-set" }), caixa({ id: "cx-out", date: "2026-10-09" })],
  });

  for (const separador of TODOS_OS_SEPARADORES) {
    it(`«${separador}» conta exactamente o que mostra`, () => {
      const contagens = financeLedgerCounts(rows, SETEMBRO);
      expect(contagens[separador]).toBe(filterFinanceLedger(rows, separador, SETEMBRO).length);
    });
  }

  it("«Todos» deixou de contar linhas de outros meses carregadas para resolver ligações", () => {
    // p3 (Agosto) e p4 (Outubro) estão no razão; nenhum deles é de Setembro.
    expect(financeLedgerCounts(rows, SETEMBRO).todos).toBe(3);
    expect(rows.length).toBe(6);
  });
});

describe("M — os atrasados entram sem duplicar", () => {
  const atrasado = pagamento({ id: "pag-ago", period_month: 8, due_date: "2026-08-15" });

  function fonte(overrides: Partial<FinanceLedgerSource> = {}): FinanceLedgerSource {
    return {
      paymentsByCompetence: async () => ({ ok: true, data: [] }),
      cashflowsByCashPeriod: async () => ({ ok: true, data: [] }),
      paymentsByIds: async () => ({ ok: true, data: [] }),
      cashflowsByPaymentIds: async () => ({ ok: true, data: [] }),
      pendingPaymentsBeforeCompetence: async () => ({ ok: true, data: [] }),
      ...overrides,
    };
  }

  it("o mesmo pendente vindo por duas portas produz UMA linha", async () => {
    const resultado = await loadFinanceLedger(fonte({
      // A mesma linha chega pela fonte de atrasados e pela resolução de
      // referências: é o caso em que a contagem duplicaria o dinheiro.
      pendingPaymentsBeforeCompetence: async () => ({ ok: true, data: [atrasado] }),
      paymentsByIds: async () => ({ ok: true, data: [atrasado] }),
      cashflowsByCashPeriod: async () => ({ ok: true, data: [caixa({
        reference_type: "fixed_variable_payment", reference_id: "pag-ago",
      })] }),
    }), SETEMBRO);
    expect(resultado.ok && resultado.rows.filter((r) => r.payment_id === "pag-ago")).toHaveLength(1);
  });

  it("uma falha a ler os atrasados não vira lista vazia", async () => {
    const resultado = await loadFinanceLedger(
      fonte({ pendingPaymentsBeforeCompetence: async () => ({ ok: false, error: "sem rede" }) }),
      SETEMBRO,
    );
    expect(resultado.ok).toBe(false);
  });

  it("os pendentes anteriores são pedidos para o período que está a ser visto", async () => {
    const espia = vi.fn(async () => ({ ok: true as const, data: [] }));
    await loadFinanceLedger(fonte({ pendingPaymentsBeforeCompetence: espia }), SETEMBRO);
    expect(espia).toHaveBeenCalledWith(SETEMBRO);
  });
});

// ── H/I/J — a fronteira do servidor ─────────────────────────────────────────
//
// 🔴 Estes ensaios contam as chamadas à RPC. Não basta ver a mensagem de erro:
//    o que está em causa é que NADA chegue à base de dados quando a data é
//    impossível, e uma acção pode devolver erro depois de já ter escrito.

const rpc = vi.fn();
const revalidatePath = vi.fn();

vi.mock("next/cache", () => ({ revalidatePath: (...a: unknown[]) => revalidatePath(...a) }));
vi.mock("@/lib/auth-guard", () => ({
  requireProfile: async () => ({
    ok: true,
    admin: { rpc: (...a: unknown[]) => rpc(...a) },
    profile: { id: "perfil-1", company_id: "empresa-1" },
  }),
}));

describe("H/I/J — um vencimento impossível não chega à base de dados", () => {
  beforeEach(() => { rpc.mockReset(); rpc.mockResolvedValue({ error: null }); });

  const baseCriacao = {
    kind: "variavel" as const,
    description: "Seguro",
    amount: 100,
    expense_category_id: null,
    direct_debit: null,
    notes: null,
    year: 2026,
    month: 9,
  };

  it("H: criação com vencimento inválido devolve erro e faz ZERO chamadas à RPC", async () => {
    const { createPayment } = await import("@/app/actions/payments");
    // 30 de Fevereiro passa numa regex de formato e não existe no calendário.
    const r = await createPayment({ ...baseCriacao, due_date: "2026-02-30" });
    expect(r.ok).toBe(false);
    expect(r.error).toBe("Vencimento inválido.");
    expect(rpc).toHaveBeenCalledTimes(0);
  });

  it("H: o ano corrompido que já partiu páginas também é barrado", async () => {
    const { createPayment } = await import("@/app/actions/payments");
    const r = await createPayment({ ...baseCriacao, due_date: "72026-01-01" });
    expect(r.ok).toBe(false);
    expect(rpc).toHaveBeenCalledTimes(0);
  });

  it("I: edição com vencimento inválido devolve erro e faz ZERO chamadas à RPC", async () => {
    const { updatePayment } = await import("@/app/actions/payments");
    const r = await updatePayment("pag-1", { due_date: "2026-13-01" });
    expect(r.ok).toBe(false);
    expect(r.error).toBe("Vencimento inválido.");
    expect(rpc).toHaveBeenCalledTimes(0);
  });

  it("I: limpar o vencimento (null) continua a ser legítimo e passa", async () => {
    const { updatePayment } = await import("@/app/actions/payments");
    const r = await updatePayment("pag-1", { due_date: null });
    expect(r.ok).toBe(true);
    expect(rpc).toHaveBeenCalledTimes(1);
  });

  it("I: um campo não tocado (undefined) não é validado nem impede a edição", async () => {
    const { updatePayment } = await import("@/app/actions/payments");
    const r = await updatePayment("pag-1", { description: "Outro nome" });
    expect(r.ok).toBe(true);
    expect(rpc).toHaveBeenCalledTimes(1);
  });

  it("J: criação SEM vencimento usa o mês do ecrã, o fallback continua permitido", async () => {
    const { createPayment } = await import("@/app/actions/payments");
    const r = await createPayment({ ...baseCriacao, due_date: null });
    expect(r.ok).toBe(true);
    expect(rpc).toHaveBeenCalledTimes(1);
    expect(rpc.mock.calls[0][1]).toMatchObject({ p_period_year: 2026, p_period_month: 9 });
  });

  it("criação COM vencimento válido deriva a competência do vencimento, não do ecrã", async () => {
    const { createPayment } = await import("@/app/actions/payments");
    const r = await createPayment({ ...baseCriacao, due_date: "2026-11-03" });
    expect(r.ok).toBe(true);
    expect(rpc.mock.calls[0][1]).toMatchObject({ p_period_year: 2026, p_period_month: 11 });
  });
});

// ── A fronteira que só existe à entrada ─────────────────────────────────────
//
// 🔴 `due_date: ""` e `due_date: null` significam a mesma coisa para quem usa
//    o produto — «esta conta não tem vencimento» — e significavam coisas
//    diferentes para o PostgreSQL. O ensaio com `null` não cobria isto: passava
//    sem nunca exercer a string vazia, que é a forma que um formulário produz.
//
//    Por isso este bloco não verifica só que a criação corre bem. Verifica o
//    VALOR que chega à RPC, porque era exactamente aí que a tradução faltava.

describe("due_date vazia é ausência, até à RPC", () => {
  beforeEach(() => { rpc.mockReset(); rpc.mockResolvedValue({ error: null }); });

  const base = {
    kind: "variavel" as const,
    description: "IVA",
    amount: 100,
    expense_category_id: null,
    direct_debit: null,
    notes: null,
    year: 2026,
    month: 9,
  };

  it("string vazia grava, chama a RPC uma vez e manda null como vencimento", async () => {
    const { createPayment } = await import("@/app/actions/payments");
    const r = await createPayment({ ...base, due_date: "" });
    expect(r.ok).toBe(true);
    expect(rpc).toHaveBeenCalledTimes(1);
    expect(rpc.mock.calls[0][1]).toMatchObject({
      p_due_date: null,
      p_period_year: 2026,
      p_period_month: 9,
    });
  });

  it("string vazia e null produzem a MESMA chamada à RPC", async () => {
    const { createPayment } = await import("@/app/actions/payments");
    await createPayment({ ...base, due_date: "" });
    const comVazia = rpc.mock.calls[0][1];
    rpc.mockReset();
    rpc.mockResolvedValue({ error: null });
    await createPayment({ ...base, due_date: null });
    expect(rpc.mock.calls[0][1]).toEqual(comVazia);
  });

  it("só o vazio é traduzido: uma data válida chega inteira à RPC", async () => {
    const { createPayment } = await import("@/app/actions/payments");
    await createPayment({ ...base, due_date: "2026-11-03" });
    expect(rpc.mock.calls[0][1]).toMatchObject({
      p_due_date: "2026-11-03",
      p_period_year: 2026,
      p_period_month: 11,
    });
  });
});

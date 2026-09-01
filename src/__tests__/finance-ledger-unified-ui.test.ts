import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  buildFinanceLedger,
  type FinanceLedgerCashflowSource,
  type FinanceLedgerPaymentSource,
  type FinanceLedgerRow,
} from "@/domain/finance/ledger";
import {
  categorySlices,
  filterFinanceLedger,
  financeLedgerMetrics,
  originLabelFor,
  paginateFinanceLedger,
  presentationStatus,
  sortFinanceLedgerForView,
} from "@/domain/finance/ledger-presentation";

const ROOT = process.cwd();
const read = (file: string) => fs.readFileSync(path.join(ROOT, file), "utf8");

const payment = (patch: Partial<FinanceLedgerPaymentSource> = {}): FinanceLedgerPaymentSource => ({
  id: "p1", kind: "variavel", description: "Material", amount: 150,
  due_date: "2026-08-20", status: "pendente", period_year: 2026, period_month: 8,
  paid_at: null, direct_debit: false, notes: null, expense_category_id: "cat-a",
  category_name: "Materiais", created_at: "2026-08-01T10:00:00Z",
  updated_at: "2026-08-01T10:00:00Z", ...patch,
});

const cashflow = (patch: Partial<FinanceLedgerCashflowSource> = {}): FinanceLedgerCashflowSource => ({
  id: "c1", type: "saida", amount: 150, description: "Material", category: "despesa",
  date: "2026-08-21", reference_type: null, reference_id: null, status: "confirmado",
  expense_category_id: "cat-b", category_name: "Operação",
  created_at: "2026-08-21T10:00:00Z", notes: null, ...patch,
});

const linked = (p: FinanceLedgerPaymentSource = payment(), c: FinanceLedgerCashflowSource = cashflow()): FinanceLedgerRow =>
  buildFinanceLedger({ payments: [p], cashflows: [{ ...c, reference_type: "fixed_variable_payment", reference_id: p.id }] })[0];

describe("UNI15–UNI30 — métricas e apresentação unificadas", () => {
  it("UNI15: gráfico Competência usa obligations elegíveis", () => {
    const rows = buildFinanceLedger({ payments: [payment()], cashflows: [] });
    // `category_key` entrou na fatia para o React ter identidade estável: duas
    // categorias legadas distintas têm ambas `category_id = null`, e uma key
    // derivada dele colidia. Numa categoria estruturada, a chave É o id.
    expect(categorySlices(rows, { year: 2026, month: 8 }, "competencia")).toEqual([
      { category_key: "cat-a", category_id: "cat-a", name: "Materiais", amount_cents: 15_000 },
    ]);
  });

  it("UNI16: gráfico Caixa usa cash outputs pela data de caixa", () => {
    const rows = buildFinanceLedger({ payments: [], cashflows: [cashflow()] });
    expect(categorySlices(rows, { year: 2026, month: 8 }, "caixa")[0].amount_cents).toBe(15_000);
    expect(categorySlices(rows, { year: 2026, month: 7 }, "caixa")).toEqual([]);
  });

  it("UNI17: €150 payment + €150 linked não vira €300", () => {
    const row = linked(payment({ status: "pago" }));
    expect(categorySlices([row], { year: 2026, month: 8 }, "competencia")[0].amount_cents).toBe(15_000);
    expect(categorySlices([row], { year: 2026, month: 8 }, "caixa")[0].amount_cents).toBe(15_000);
  });

  it("UNI18: categoria atual do payment governa competência e caixa ligado", () => {
    const row = linked(
      payment({ expense_category_id: "new", category_name: "Nova" }),
      cashflow({ expense_category_id: "old", category_name: "Antiga" }),
    );
    expect(categorySlices([row], { year: 2026, month: 8 }, "competencia")[0].name).toBe("Nova");
    expect(categorySlices([row], { year: 2026, month: 8 }, "caixa")[0].name).toBe("Nova");
  });

  it("UNI19: ausência de categoria é explícita", () => {
    const rows = buildFinanceLedger({ payments: [payment({ expense_category_id: null, category_name: null })], cashflows: [] });
    expect(categorySlices(rows, { year: 2026, month: 8 }, "competencia")[0].name).toBe("Sem categoria");
  });

  it("cash pendente não é dinheiro já saído", () => {
    const rows = buildFinanceLedger({ payments: [], cashflows: [cashflow({ status: "pendente" })] });
    expect(categorySlices(rows, { year: 2026, month: 8 }, "caixa")).toEqual([]);
    expect(financeLedgerMetrics(rows, { year: 2026, month: 8 }, "2026-08-30").cash_output_cents).toBe(0);
  });

  it("UNI22: entrada manual permanece na tabela, mas não entra em gastos", () => {
    const rows = buildFinanceLedger({ payments: [], cashflows: [cashflow({ type: "entrada" })] });
    expect(rows).toHaveLength(1);
    expect(categorySlices(rows, { year: 2026, month: 8 }, "caixa")).toEqual([]);
  });

  it("UNI23: por pagar preserva o valor das obrigações", () => {
    const rows = buildFinanceLedger({ payments: [payment({ amount: 123.45 })], cashflows: [] });
    expect(financeLedgerMetrics(rows, { year: 2026, month: 8 }, "2026-08-10").due_cents).toBe(12_345);
  });

  it("conta pendentes e atrasados sem perder métricas em euros", () => {
    const rows = buildFinanceLedger({
      payments: [
        payment({ id: "p1", amount: 10, due_date: "2026-08-01", status: "pendente" }),
        payment({ id: "p2", amount: null, due_date: "2026-08-30", status: "pendente" }),
        payment({ id: "p3", amount: 20, status: "pago" }),
      ],
      cashflows: [],
    });
    expect(financeLedgerMetrics(rows, { year: 2026, month: 8 }, "2026-08-15")).toMatchObject({
      due_cents: 1_000,
      paid_cents: 2_000,
      overdue_cents: 1_000,
      pending_count: 2,
      overdue_count: 1,
    });
  });

  it("pago mede competência sem depender do cashflow", () => {
    const rows = buildFinanceLedger({ payments: [payment({ status: "pago" })], cashflows: [] });
    expect(financeLedgerMetrics(rows, { year: 2026, month: 8 }, "2026-08-30").paid_cents).toBe(15_000);
  });

  it("due_date nula nunca inventa atraso", () => {
    const rows = buildFinanceLedger({ payments: [payment({ due_date: null })], cashflows: [] });
    expect(financeLedgerMetrics(rows, { year: 2026, month: 8 }, "2099-01-01").overdue_cents).toBe(0);
    expect(presentationStatus(rows[0], "2099-01-01")).toBe("Pendente");
  });

  it("filtros separam obrigação aberta, paga e manual", () => {
    const rows = buildFinanceLedger({
      payments: [payment(), payment({ id: "p2", status: "pago" })],
      cashflows: [cashflow()],
    });
    expect(filterFinanceLedger(rows, "por_pagar").map((row) => row.row_id)).toEqual(["payment:p1"]);
    expect(filterFinanceLedger(rows, "pagos").map((row) => row.row_id)).toEqual(["payment:p2"]);
    expect(filterFinanceLedger(rows, "manuais").map((row) => row.row_id)).toEqual(["cashflow:c1"]);
  });

  it("Fixos/Variáveis filtram por competência, não por caixa do mês", () => {
    const rows = buildFinanceLedger({
      payments: [
        payment({ id: "p-ago", kind: "fixo", period_month: 8 }),
        payment({ id: "p-jul", kind: "fixo", period_month: 7 }),
      ],
      cashflows: [
        cashflow({ id: "c-jul", date: "2026-08-05", reference_type: "fixed_variable_payment", reference_id: "p-jul" }),
      ],
    });
    expect(filterFinanceLedger(rows, "fixos", { year: 2026, month: 8 }).map((row) => row.row_id))
      .toEqual(["payment:p-ago"]);
  });

  it("Fixos/Variáveis ordenam por sort_order, descrição e identidade", () => {
    const rows = buildFinanceLedger({
      payments: [
        payment({ id: "p3", kind: "fixo", description: "Zoo", sort_order: 2 }),
        payment({ id: "p2", kind: "fixo", description: "Alfa", sort_order: 1 }),
        payment({ id: "p1", kind: "fixo", description: "Beta", sort_order: 1 }),
      ],
      cashflows: [],
    });
    expect(sortFinanceLedgerForView(rows, "fixos").map((row) => row.description))
      .toEqual(["Alfa", "Beta", "Zoo"]);
  });

  it("origens técnicas têm rótulos humanos", () => {
    expect(originLabelFor("fixed_variable_payment")).toBe("Pagamento");
    expect(originLabelFor("payroll")).toBe("Folha");
    expect(originLabelFor("invoice")).toBe("Cobrança");
  });

  it("estado em atraso exige obrigação aberta e vencimento real", () => {
    expect(presentationStatus(buildFinanceLedger({ payments: [payment()], cashflows: [] })[0], "2026-08-21")).toBe("Em atraso");
    expect(presentationStatus(linked(payment({ status: "pago" })), "2026-08-21")).toBe("Pago");
  });

  it("UNI27: página 1 mantém a ordenação canónica", () => {
    const rows = buildFinanceLedger({ payments: [], cashflows: [cashflow({ id: "c1", date: "2026-08-01" }), cashflow({ id: "c2", date: "2026-08-02" })] });
    expect(paginateFinanceLedger(rows, 1, 1)[0].row_id).toBe("cashflow:c2");
  });

  it("paginação não repete uma row entre páginas", () => {
    const rows = buildFinanceLedger({ payments: [], cashflows: [cashflow({ id: "c1" }), cashflow({ id: "c2" })] });
    expect(paginateFinanceLedger(rows, 1, 1)[0].row_id).not.toBe(paginateFinanceLedger(rows, 2, 1)[0].row_id);
  });

  // 🔴 Estes dois testes foram REESCRITOS, e o motivo importa.
  //
  //    Na versão original desta vista, provavam um guard em TypeScript: ler o
  //    pagamento, ler o `cash_flow_entries`, decidir, e só depois `.delete()`.
  //    Essa arquitectura foi SUPERADA pela #108 — entre o `select` e o
  //    `delete` existia uma janela TOCTOU, e a garantia mudou-se para dentro
  //    da base, nas RPCs atómicas da 082, onde a decisão e a escrita são o
  //    mesmo acto.
  //
  //    A invariante que estes testes protegiam continua viva; o que mudou foi
  //    onde ela vive. Manter as asserções antigas obrigaria a reintroduzir o
  //    padrão antigo só para as satisfazer — que é exactamente o contrário do
  //    que se quer.

  it("UNI28/UNI29: eliminar pagamento entra pela RPC atómica, sem read-decide-delete", () => {
    const source = read("src/app/actions/payments.ts");
    const body = source.slice(
      source.indexOf("export async function deletePayment"),
      source.indexOf("// ─── Anexo"),
    );
    // A decisão e a escrita são um só acto, dentro da base.
    expect(body).toContain("delete_payment_atomic");
    // E nenhum caminho directo sobreviveu por baixo.
    expect(body).not.toContain(".delete()");
    expect(body).not.toMatch(/from\("cash_flow_entries"\)/);
  });

  it("UNI28/UNI29: editar pagamento entra pela RPC atómica", () => {
    const source = read("src/app/actions/payments.ts");
    const body = source.slice(
      source.indexOf("export async function updatePayment"),
      source.indexOf("export async function setPaymentStatus"),
    );
    expect(body).toContain("update_payment_atomic");
    // O corpo do update é a RPC e nada mais: sem escrita directa por baixo.
    expect(body).not.toMatch(/from\("fixed_variable_payments"\)[\s\S]{0,200}?\.update\(/);
  });

  it("movimento manual: update e delete entram pelas RPCs atómicas", () => {
    const source = read("src/app/actions/cash-flow.ts");
    expect(source).toContain("update_cashflow_entry_atomic");
    expect(source).toContain("delete_cashflow_entry_atomic");
  });

  it("🔴 P25: nenhuma mutação financeira directa regressou", () => {
    // Um caminho directo sobre VALOR ou ESTADO seria um segundo caminho de
    // escrita a competir com as RPCs — a dessincronização entre pagamento e
    // caixa que toda esta onda existe para impedir.
    //
    // 🔴 O que NÃO conta: os `.update()` de anexo (`attachment_*`) e o ramo
    //    dos outros estados (`cancelado`, …). São pré-existentes no master,
    //    não tocam no par valor/estado-ligado-a-caixa, e apagá-los aqui seria
    //    inventar uma regra que o master nunca teve.
    const financeiras = /\.update\(\{[^}]*\b(amount|status|paid_at)\b/;

    const payments = read("src/app/actions/payments.ts");
    const updateBody = payments.slice(
      payments.indexOf("export async function updatePayment"),
      payments.indexOf("export async function setPaymentStatus"),
    );
    expect(updateBody).not.toMatch(financeiras);
    expect(updateBody).toContain("update_payment_atomic");

    const deleteBody = payments.slice(
      payments.indexOf("export async function deletePayment"),
      payments.indexOf("// ─── Anexo"),
    );
    expect(deleteBody).not.toContain(".delete()");
    expect(deleteBody).toContain("delete_payment_atomic");

    // E o caixa: nenhuma escrita directa sobre `cash_flow_entries` fora das RPCs.
    const cash = read("src/app/actions/cash-flow.ts");
    const directasCaixa = cash.match(
      /from\("cash_flow_entries"\)[\s\S]{0,200}?\.(update|delete)\(/g,
    ) ?? [];
    expect(directasCaixa).toEqual([]);
  });

  it("a página expõe colunas e tipos de criação definidos pelo produto", () => {
    const source = read("src/app/(dashboard)/dashboard/financeiro/pagamentos/_components/unified-payments-client.tsx");
    for (const label of ["Data", "Descrição", "Vencimento", "Categoria", "Origem", "Débito direto", "Valor", "Estado", "Ações"]) {
      expect(source).toContain(`"${label}"`);
    }
    for (const type of ["Conta a pagar", "Saída manual", "Entrada manual"]) expect(source).toContain(type);
    expect(source).not.toContain("Categoria de despesa");
  });

  it("edição de pagamento não permite alterar Natureza nem força valor preenchido", () => {
    const source = read("src/app/(dashboard)/dashboard/financeiro/pagamentos/_components/unified-payments-client.tsx");
    expect(source).toContain('disabled={Boolean(form.row)} value={form.kind}');
    expect(source).toContain('const amount = amountText === "" ? null');
    expect(source).toContain('form.type === "payment" ? "Valor (€)" : "Valor (€) *"');
  });

  it("Fixos/Variáveis mostram todos os registos do período sem paginação implícita", () => {
    const source = read("src/app/(dashboard)/dashboard/financeiro/pagamentos/_components/unified-payments-client.tsx");
    expect(source).toContain('const specializedMode = filter === "fixos" || filter === "variaveis"');
    expect(source).toContain("const unpaginated = specializedMode");
    expect(source).toContain("const visible = unpaginated ? filtered");
  });
});

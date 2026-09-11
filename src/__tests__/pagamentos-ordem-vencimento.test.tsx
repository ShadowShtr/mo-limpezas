// @vitest-environment jsdom
// ============================================================================
// PAGAMENTOS — ORDEM DE VENCIMENTO
// ============================================================================
//
// O dono abriu o mês em Pagamentos e leu isto, de cima para baixo:
//
//     10/09 · 10/09 · 10/09 · 18/09 · 16/09 · 15/09 · 10/09 · 11/09 · 10/09 ·
//     10/08 · 09/09 · 25/09 · 02/09 · 02/09 · 01/09
//
// Não estava baralhado por acaso. As vistas «Todos», «Por pagar» e «Pagos»
// não ordenavam nada: herdavam a ordem do read model, que é por data
// DESCENDENTE. Essa ordem é a certa para um extracto de movimentos — «o que
// aconteceu agora» — e é a errada para uma lista de contas a pagar, onde põe
// o fim do mês no topo e esconde o que está prestes a vencer.
//
// 🔴 A prova principal é feita no DOM, e não sobre a função de ordenação.
//    Entre `sortFinanceLedgerForView` e a coluna que o dono lê há um filtro
//    de categoria, um de origem, uma pesquisa e uma paginação — qualquer um
//    deles podia desfazer a ordem sem que um teste de unidade desse por isso.
//
// 🔴 A primeira versão desta correcção deixou «Fixos» e «Variáveis» de fora,
//    para não destruir o que se julgava ser uma ordem manual. Não era: o
//    `sort_order` é atribuído por `create_payment_atomic` como
//    `max(sort_order) + 1` (092_payments_period_atomic.sql) e não há em toda
//    a aplicação forma de reordenar pagamentos à mão. Era a ordem por que
//    foram escritos — e o dono voltou com a fotografia de «Variáveis» ainda
//    desordenado. Hoje a regra é uma só, igual nos cinco separadores.
// ============================================================================

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import {
  buildFinanceLedger,
  type FinanceLedgerCashflowSource,
  type FinanceLedgerPaymentSource,
} from "@/domain/finance/ledger";
import {
  filterFinanceLedger,
  sortFinanceLedgerForView,
} from "@/domain/finance/ledger-presentation";

vi.mock("next/navigation", () => ({
  useRouter: () => ({ refresh: () => {}, push: () => {}, replace: () => {} }),
}));

vi.mock("@/components/attachments/attachments-field", () => ({
  AttachmentsField: () => <div data-testid="attachments-field" />,
}));

vi.mock("@/app/actions/payments", () => ({
  createPayment: vi.fn(async () => ({ ok: true })),
  deletePayment: vi.fn(async () => ({ ok: true })),
  setPaymentStatus: vi.fn(async () => ({ ok: true })),
  updatePayment: vi.fn(async () => ({ ok: true })),
}));

let container: HTMLDivElement;
let root: Root;

beforeEach(() => {
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
});

const pagamento = (patch: Partial<FinanceLedgerPaymentSource> = {}): FinanceLedgerPaymentSource => ({
  id: "p1", kind: "variavel", description: "Conta", amount: 100,
  due_date: "2026-09-10", status: "pendente", period_year: 2026, period_month: 9,
  paid_at: null, direct_debit: false, notes: null,
  expense_category_id: "cat-a", category_name: "Instalações",
  created_at: "2026-09-01T10:00:00Z", updated_at: "2026-09-01T10:00:00Z", ...patch,
});

const movimento = (patch: Partial<FinanceLedgerCashflowSource> = {}): FinanceLedgerCashflowSource => ({
  id: "c1", type: "saida", amount: 80, description: "Combustível", category: "despesa",
  date: "2026-09-12", reference_type: null, reference_id: null, status: "confirmado",
  notes: null, expense_category_id: "cat-b", category_name: "Deslocações",
  created_at: "2026-09-12T10:00:00Z", ...patch,
});

async function mostrar(
  rows: ReturnType<typeof buildFinanceLedger>,
  period = { year: 2026, month: 9 },
) {
  const { UnifiedPaymentsClient } = await import(
    "@/app/(dashboard)/dashboard/financeiro/pagamentos/_components/unified-payments-client"
  );
  await act(async () => {
    root.render(
      <UnifiedPaymentsClient
        rows={rows}
        error={null}
        categories={[]}
        companyId="11111111-1111-4111-8111-111111111111"
        year={period.year}
        month={period.month}
      />,
    );
  });
  return container;
}

/** Os separadores identificam-se pelo texto que o utilizador lê. */
async function clickText(text: string) {
  const button = [...document.querySelectorAll("button")]
    .find((item) => item.textContent?.includes(text));
  if (!button) throw new Error(`botao nao encontrado: ${text}`);
  await act(async () => button.click());
}

/** Os botões de paginação são só ícones — identificam-se pelo `aria-label`. */
async function clickAriaLabel(label: string) {
  const button = [...document.querySelectorAll<HTMLButtonElement>("button[aria-label]")]
    .find((item) => item.getAttribute("aria-label") === label);
  if (!button) throw new Error(`botao nao encontrado: ${label}`);
  await act(async () => button.click());
}

/** A coluna «Vencimento» é a terceira: Data · Descrição · Vencimento · … */
const colunaVencimento = (el: HTMLElement) =>
  [...el.querySelectorAll("tbody tr")].map((row) => row.children[2]?.textContent);

// ═══════════════════════════════════════════════════════════════════════════
// A. O ECRÃ REAL, COM AS DATAS QUE O DONO VIU
// ═══════════════════════════════════════════════════════════════════════════

/** As quinze linhas do mês fotografado, pela ordem em que lhe apareceram. */
const COMO_APARECEU = [
  "2026-09-10", "2026-09-10", "2026-09-10", "2026-09-18", "2026-09-16",
  "2026-09-15", "2026-09-10", "2026-09-11", "2026-09-10", "2026-08-10",
  "2026-09-09", "2026-09-25", "2026-09-02", "2026-09-02", "2026-09-01",
];

const mesFotografado = () => buildFinanceLedger({
  payments: COMO_APARECEU.map((due, index) => pagamento({
    id: `p-foto-${index + 1}`,
    description: `Conta ${String(index + 1).padStart(2, "0")}`,
    due_date: due,
  })),
  cashflows: [],
});

describe("A. o mês fotografado pelo dono", () => {
  it("🔴 lê-se do vencimento mais antigo ao mais recente, sem perder linhas", async () => {
    const el = await mostrar(mesFotografado());
    const vencimentos = colunaVencimento(el);

    // Quinze entraram, quinze aparecem. Uma mudança de ordenação que perca
    // uma linha é pior do que a desordem que veio corrigir: a conta some do
    // ecrã sem ninguém dar por isso, e o mês fecha-se sem ela.
    expect(vencimentos).toHaveLength(COMO_APARECEU.length);
    expect(vencimentos).toEqual([
      "10/08/2026",
      "01/09/2026",
      "02/09/2026", "02/09/2026",
      "09/09/2026",
      "10/09/2026", "10/09/2026", "10/09/2026", "10/09/2026", "10/09/2026",
      "11/09/2026",
      "15/09/2026",
      "16/09/2026",
      "18/09/2026",
      "25/09/2026",
    ]);
  });

  it("nenhuma das quinze descrições se perde pelo caminho", async () => {
    const el = await mostrar(mesFotografado());
    const descricoes = [...el.querySelectorAll("tbody tr")]
      .map((row) => row.children[1]?.textContent?.trim());
    expect([...descricoes].sort()).toEqual(
      COMO_APARECEU.map((_, index) => `Conta ${String(index + 1).padStart(2, "0")}`).sort(),
    );
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// B. ORDENAR ANTES DE PAGINAR
// ═══════════════════════════════════════════════════════════════════════════
//
// 🔴 A armadilha desta correcção seria ordenar só as linhas da página actual.
//    O mês pareceria arrumado e o mais urgente continuaria escondido na
//    página 2 — o pior resultado possível, porque passa despercebido.
describe("B. a ordenação acontece antes da paginação", () => {
  it("🔴 o vencimento mais antigo vem no fim dos dados e aparece na 1ª linha", async () => {
    // 18 linhas para haver segunda página (a vista mostra 15 por página).
    // O dia 1 é o ÚLTIMO do input de propósito: sem ordenação global ficaria
    // na página 2.
    const dias = [
      ...Array.from({ length: 17 }, (_, index) => `2026-09-${String(index + 10).padStart(2, "0")}`),
      "2026-09-01",
    ];
    const el = await mostrar(buildFinanceLedger({
      payments: dias.map((due, index) => pagamento({
        id: `p-pag-${index + 1}`,
        description: `Conta ${String(index + 1).padStart(2, "0")}`,
        due_date: due,
      })),
      cashflows: [],
    }));

    const primeiraPagina = colunaVencimento(el);
    expect(primeiraPagina).toHaveLength(15);
    // Dia 1 primeiro, depois os dias 10 a 23 — as quinze que cabem.
    expect(primeiraPagina[0]).toBe("01/09/2026");
    expect(primeiraPagina.at(-1)).toBe("23/09/2026");

    // E a página 2 continua a sequência, em vez de recomeçar do zero.
    await clickAriaLabel("Página seguinte");
    expect(colunaVencimento(el)).toEqual(["24/09/2026", "25/09/2026", "26/09/2026"]);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// C+D. FIXOS E VARIÁVEIS TAMBÉM SE LEEM POR VENCIMENTO
// ═══════════════════════════════════════════════════════════════════════════
//
// 🔴 Os dados abaixo têm `sort_order` DELIBERADAMENTE ao contrário do
//    `due_date` — que é a forma real como estas listas aparecem, já que o
//    `sort_order` é a ordem de criação e ninguém cria as contas pela ordem
//    em que elas vencem. Se a ordem de criação voltasse a mandar, estes dois
//    testes viam-no imediatamente.
describe("C+D. Fixos e Variáveis ordenam por vencimento, não por criação", () => {
  const ordemDeCriacaoAoContrario = (kind: "fixo" | "variavel") => buildFinanceLedger({
    payments: [
      pagamento({ id: "p1", kind, description: "Criado primeiro", sort_order: 1, due_date: "2026-09-28" }),
      pagamento({ id: "p2", kind, description: "Criado segundo", sort_order: 2, due_date: "2026-09-15" }),
      pagamento({ id: "p3", kind, description: "Criado terceiro", sort_order: 3, due_date: "2026-09-01" }),
    ],
    cashflows: [],
  });

  it("🔴 Fixos: o vencimento manda, mesmo com a ordem de criação ao contrário", () => {
    const rows = ordemDeCriacaoAoContrario("fixo");
    const ordenadas = sortFinanceLedgerForView(rows, "fixos");
    expect(ordenadas).toHaveLength(3);
    expect(ordenadas.map((row) => row.due_date))
      .toEqual(["2026-09-01", "2026-09-15", "2026-09-28"]);
  });

  it("🔴 Variáveis: o vencimento manda, mesmo com a ordem de criação ao contrário", () => {
    const rows = ordemDeCriacaoAoContrario("variavel");
    const ordenadas = sortFinanceLedgerForView(rows, "variaveis");
    expect(ordenadas).toHaveLength(3);
    expect(ordenadas.map((row) => row.due_date))
      .toEqual(["2026-09-01", "2026-09-15", "2026-09-28"]);
  });

  // A fotografia que o dono enviou do separador «Variáveis», no DOM real.
  it("🔴 o separador Variáveis, no ecrã, lê-se do dia mais cedo ao mais tarde", async () => {
    const el = await mostrar(buildFinanceLedger({
      payments: [
        pagamento({ id: "v1", kind: "variavel", description: "HIGIAPROL FT2026/605", sort_order: 1, due_date: "2026-09-28" }),
        pagamento({ id: "v2", kind: "variavel", description: "Mecanico - FT FIZ2026/116", sort_order: 2, due_date: "2026-09-18" }),
        pagamento({ id: "v3", kind: "variavel", description: "Endesa - garagem 1", sort_order: 3, due_date: "2026-09-04" }),
        pagamento({ id: "v4", kind: "variavel", description: "Plano de pagamento - Corte real 56", sort_order: 4, due_date: "2026-09-28" }),
      ],
      cashflows: [],
    }));
    await clickText("Variáveis");
    const vencimentos = colunaVencimento(el);
    expect(vencimentos).toHaveLength(4);
    expect(vencimentos).toEqual(["04/09/2026", "18/09/2026", "28/09/2026", "28/09/2026"]);
  });

  it("no mesmo dia, desempata por descrição e identidade", () => {
    const rows = buildFinanceLedger({
      payments: [
        pagamento({ id: "p3", kind: "fixo", description: "Zoo", sort_order: 2, due_date: "2026-09-10" }),
        pagamento({ id: "p2", kind: "fixo", description: "Alfa", sort_order: 1, due_date: "2026-09-10" }),
        pagamento({ id: "p1", kind: "fixo", description: "Beta", sort_order: 1, due_date: "2026-09-10" }),
      ],
      cashflows: [],
    });
    expect(sortFinanceLedgerForView(rows, "fixos").map((row) => row.description))
      .toEqual(["Alfa", "Beta", "Zoo"]);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// E+F. POR PAGAR E PAGOS
// ═══════════════════════════════════════════════════════════════════════════
describe("E+F. Por pagar e Pagos ordenam por vencimento", () => {
  const misturado = (status: "pendente" | "pago") => buildFinanceLedger({
    payments: [
      pagamento({ id: "p-25", description: "Impostos", status, due_date: "2026-09-25" }),
      pagamento({ id: "p-02", description: "Água", status, due_date: "2026-09-02" }),
      pagamento({ id: "p-11", description: "Luz", status, due_date: "2026-09-11" }),
    ],
    cashflows: [],
  });

  it("Por pagar: do vencimento mais antigo ao mais recente", () => {
    const rows = filterFinanceLedger(misturado("pendente"), "por_pagar");
    expect(sortFinanceLedgerForView(rows, "por_pagar").map((row) => row.due_date))
      .toEqual(["2026-09-02", "2026-09-11", "2026-09-25"]);
  });

  it("Pagos: do vencimento mais antigo ao mais recente", () => {
    const rows = filterFinanceLedger(misturado("pago"), "pagos");
    expect(sortFinanceLedgerForView(rows, "pagos").map((row) => row.due_date))
      .toEqual(["2026-09-02", "2026-09-11", "2026-09-25"]);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// G. SEM VENCIMENTO
// ═══════════════════════════════════════════════════════════════════════════
describe("G. uma linha sem vencimento vai para o fim, nunca desaparece", () => {
  it("🔴 fica depois das que têm data, e não intercalada no meio delas", () => {
    const rows = buildFinanceLedger({
      payments: [
        pagamento({ id: "p-sem", description: "Sem data", due_date: null }),
        pagamento({ id: "p-28", description: "Luz", due_date: "2026-09-28" }),
        pagamento({ id: "p-01", description: "Renda", due_date: "2026-09-01" }),
      ],
      cashflows: [],
    });
    const ordenadas = sortFinanceLedgerForView(rows, "todos");
    expect(ordenadas).toHaveLength(3);
    expect(ordenadas.map((row) => row.row_id))
      .toEqual(["payment:p-01", "payment:p-28", "payment:p-sem"]);
  });

  it("🔴 aparece mesmo no ecrã, com o vencimento vazio — e não some da tabela", async () => {
    const el = await mostrar(buildFinanceLedger({
      payments: [
        pagamento({ id: "p-sem", description: "Sem data", due_date: null }),
        pagamento({ id: "p-01", description: "Renda", due_date: "2026-09-01" }),
      ],
      cashflows: [],
    }));
    const linhas = [...el.querySelectorAll("tbody tr")];
    expect(linhas).toHaveLength(2);
    expect(linhas[1]?.children[1]?.textContent).toContain("Sem data");
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// H. EMPATES E ESTABILIDADE
// ═══════════════════════════════════════════════════════════════════════════
describe("H. o mesmo vencimento produz sempre a mesma ordem", () => {
  const mesmoDia = () => [
    pagamento({ id: "p3", description: "Zoo", due_date: "2026-09-10" }),
    pagamento({ id: "p2", description: "Alfa", due_date: "2026-09-10" }),
    pagamento({ id: "p1", description: "Beta", due_date: "2026-09-10" }),
  ];

  it("🔴 a ordem não depende da ordem de entrada — a lista não se mexe entre renders", () => {
    const ordem = (payments: ReturnType<typeof mesmoDia>) =>
      sortFinanceLedgerForView(buildFinanceLedger({ payments, cashflows: [] }), "todos")
        .map((row) => row.description);
    expect(ordem(mesmoDia())).toEqual(["Alfa", "Beta", "Zoo"]);
    expect(ordem([...mesmoDia()].reverse())).toEqual(["Alfa", "Beta", "Zoo"]);
  });

  it("descrições iguais desempatam pela identidade da linha", () => {
    const rows = buildFinanceLedger({
      payments: [
        pagamento({ id: "p-b", description: "Igual", due_date: "2026-09-10" }),
        pagamento({ id: "p-a", description: "Igual", due_date: "2026-09-10" }),
      ],
      cashflows: [],
    });
    expect(sortFinanceLedgerForView(rows, "todos").map((row) => row.row_id))
      .toEqual(["payment:p-a", "payment:p-b"]);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// MOVIMENTOS MANUAIS — «qualquer coisa de pagamentos e registos tem de estar
// em ordem»
// ═══════════════════════════════════════════════════════════════════════════
//
// Um movimento de caixa não tem vencimento: já aconteceu. Entra pelo dia em
// que aconteceu — a única data que tem — e não amontoado no fim da lista.
describe("movimentos manuais entram pela data em que aconteceram", () => {
  it("«Manuais» lê-se do mais antigo ao mais recente", () => {
    const rows = filterFinanceLedger(buildFinanceLedger({
      payments: [],
      cashflows: [
        movimento({ id: "c-05", date: "2026-09-05" }),
        movimento({ id: "c-20", date: "2026-09-20" }),
        movimento({ id: "c-12", date: "2026-09-12" }),
      ],
    }), "manuais");
    const ordenadas = sortFinanceLedgerForView(rows, "manuais");
    expect(ordenadas).toHaveLength(3);
    expect(ordenadas.map((row) => row.row_id))
      .toEqual(["cashflow:c-05", "cashflow:c-12", "cashflow:c-20"]);
  });

  it("em «Todos», pagamentos e movimentos intercalam-se por data, como um calendário", () => {
    const ledger = buildFinanceLedger({
      payments: [pagamento({ id: "p-20", description: "Seguro", due_date: "2026-09-20" })],
      cashflows: [
        movimento({ id: "c-05", date: "2026-09-05" }),
        movimento({ id: "c-28", date: "2026-09-28" }),
      ],
    });
    const ordenadas = sortFinanceLedgerForView(ledger, "todos");

    // Nada se perde: o pagamento e os dois movimentos continuam todos lá.
    expect(ordenadas).toHaveLength(ledger.length);
    expect(ordenadas.map((row) => row.row_id))
      .toEqual(["cashflow:c-05", "payment:p-20", "cashflow:c-28"]);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// CONSERVAÇÃO — ordenar não é filtrar
// ═══════════════════════════════════════════════════════════════════════════
describe("ordenar nunca remove uma linha", () => {
  it("🔴 cada separador mostra exactamente as linhas que o filtro escolheu", () => {
    const rows = buildFinanceLedger({
      payments: [
        pagamento({ id: "p-f1", kind: "fixo", description: "Renda", due_date: "2026-09-01" }),
        pagamento({ id: "p-f2", kind: "fixo", description: "Seguro", due_date: null }),
        pagamento({ id: "p-v1", kind: "variavel", description: "Material", due_date: "2026-09-09" }),
        pagamento({ id: "p-v2", kind: "variavel", description: "Extra", status: "pago", due_date: "2026-09-02" }),
        pagamento({ id: "p-sem-valor", description: "Sem valor", amount: null, due_date: "2026-09-12" }),
      ],
      cashflows: [movimento({ id: "c-1", date: "2026-09-04" })],
    });
    const period = { year: 2026, month: 9 };
    for (const filtro of ["todos", "fixos", "variaveis", "por_pagar", "pagos", "manuais"] as const) {
      const filtradas = filterFinanceLedger(rows, filtro, period);
      const ordenadas = sortFinanceLedgerForView(filtradas, filtro);
      expect(ordenadas).toHaveLength(filtradas.length);
      expect(ordenadas.map((row) => row.row_id).sort())
        .toEqual(filtradas.map((row) => row.row_id).sort());
    }
  });
});

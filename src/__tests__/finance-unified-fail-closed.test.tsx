// @vitest-environment jsdom
// ============================================================================
// PAGAMENTOS UNIFICADOS — fail-closed na leitura e nas linhas degradadas
// ============================================================================
//
// Dois defeitos que os testes de domínio NÃO apanhavam, porque ambos vivem na
// fronteira entre o read model e o que a pessoa vê:
//
//   1. `getFinanceLedger` podia falhar e a página montava a vista mutável na
//      mesma, com `rows={[]}` e `companyId=""`. Lista vazia e erro de leitura
//      são estados diferentes:
//
//          rows = []   → «não há movimentos neste mês»
//          ok = false  → «não sabemos que movimentos existem»
//
//      Colapsá-los no primeiro é a versão perigosa: alguém vê um mês
//      aparentemente vazio e cria de novo um pagamento que já lá está.
//
//   2. O read model já detectava `linked_amount_mismatch`,
//      `orphan_payment_reference` e `duplicate_payment_link` — e ninguém os
//      mostrava. Uma linha corrompida aparecia como "Pago" ou "Confirmado" e
//      continuava a oferecer Editar / Marcar / Eliminar.
//
// 🔴 Estes testes exercitam a SUPERFÍCIE, não o modelo. Um teste que só
//    verificasse `integrity_issue !== null` no objecto provaria que o campo
//    existe, não que alguém o vê — e era exactamente essa a falha.
// ============================================================================

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import fs from "node:fs";
import path from "node:path";
import {
  buildFinanceLedger,
  type FinanceLedgerCashflowSource,
  type FinanceLedgerPaymentSource,
} from "@/domain/finance/ledger";
import {
  canMutateRow,
  integrityWarning,
  presentationStatus,
} from "@/domain/finance/ledger-presentation";

// A vista chama `router.refresh()` depois de cada mutacao propria. Em jsdom
// nao ha App Router montado, e o que se mede aqui e o que fica no ecra.
vi.mock("next/navigation", () => ({
  useRouter: () => ({ refresh: () => {}, push: () => {}, replace: () => {} }),
}));

const ROOT = process.cwd();
const ler = (rel: string) => fs.readFileSync(path.join(ROOT, rel), "utf8");

/**
 * O ramo que corre quando a leitura falha — e nada do que vem depois.
 *
 * Normaliza os fins de linha antes de cortar: no checkout Windows o ficheiro
 * está em CRLF, e um corte que procurasse apenas LF nunca acertaria.
 */
function ramoDeErro(page: string): string {
  const texto = page.split(String.fromCharCode(13)).join("");
  const nl = String.fromCharCode(10);
  const i = texto.indexOf("if (!res.ok) {");
  const fim = texto.indexOf(nl + "  }" + nl, i);
  if (i < 0 || fim < 0) throw new Error("ramo de erro nao encontrado na page");
  return texto.slice(i, fim);
}

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
  id: "p1", kind: "variavel", description: "Fornecedor A", amount: 150,
  due_date: "2026-08-20", status: "pago", period_year: 2026, period_month: 8,
  paid_at: "2026-08-21T10:00:00Z", direct_debit: false, notes: null,
  expense_category_id: "cat-a", category_name: "Materiais",
  created_at: "2026-08-01T10:00:00Z", updated_at: "2026-08-01T10:00:00Z", ...patch,
});

const movimento = (patch: Partial<FinanceLedgerCashflowSource> = {}): FinanceLedgerCashflowSource => ({
  id: "c1", type: "saida", amount: 150, description: "Fornecedor A", category: "despesa",
  date: "2026-08-21", reference_type: null, reference_id: null, status: "confirmado",
  notes: null, expense_category_id: "cat-a", category_name: "Materiais",
  created_at: "2026-08-21T10:00:00Z", ...patch,
});

/** Renderiza a vista unificada com as linhas dadas. */
async function mostrar(rows: ReturnType<typeof buildFinanceLedger>) {
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
        year={2026}
        month={8}
      />,
    );
  });
  return container.textContent ?? "";
}

// ═══════════════════════════════════════════════════════════════════════════
// A. LEITURA FALHADA → SEM SUPERFÍCIE DE ESCRITA
// ═══════════════════════════════════════════════════════════════════════════
describe("A. leitura do ledger falhada é fail-closed", () => {
  const PAGE = ler("src/app/(dashboard)/dashboard/financeiro/pagamentos/page.tsx");

  it("READ_ERROR_VISIBLE: o erro é mostrado, e não silenciado", () => {
    const ramo = ramoDeErro(PAGE);
    expect(ramo).toContain("res.error");
    expect(ramo).toMatch(/role="alert"/);
  });

  it("🔴 a vista mutável NÃO é montada quando a leitura falha", () => {
    // O ramo de erro devolve antes de chegar ao componente mutável.
    const ramo = ramoDeErro(PAGE);
    expect(ramo).not.toContain("UnifiedPaymentsClient");
    // NEW_RECORD / EDIT / STATUS / DELETE vivem todos dentro desse componente.
    expect(ramo).not.toMatch(/createPayment|setPaymentStatus|deletePayment/);
  });

  it("🔴 COMPANY_ID_EMPTY_SENT_TO_MUTABLE_CLIENT = NO", () => {
    // A versão anterior passava `companyId={res.ok ? res.companyId : ""}` —
    // um cliente mutável com identidade vazia. Já não existe.
    expect(PAGE).not.toMatch(/companyId=\{res\.ok \? res\.companyId : ""\}/);
    expect(PAGE).not.toMatch(/companyId=\{""\}/);
    expect(PAGE).toContain("companyId={res.companyId}");
  });

  it("🔴 rows=[] não é usado como substituto de um erro", () => {
    // Lista vazia significa «não há movimentos»; erro significa «não sabemos».
    expect(PAGE).not.toMatch(/rows=\{res\.ok \? res\.rows : \[\]\}/);
    expect(PAGE).toContain("rows={res.rows}");
  });

  it("o período e o FinanceShell continuam — recarregar é seguro", () => {
    const ramo = ramoDeErro(PAGE);
    expect(ramo).toContain("FinanceShell");
    expect(ramo).toContain("period={period}");
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// B–D. LINHAS DEGRADADAS: AVISO VISÍVEL E MUTAÇÃO BLOQUEADA
// ═══════════════════════════════════════════════════════════════════════════
describe("B. linked_amount_mismatch", () => {
  const rows = buildFinanceLedger({
    payments: [pagamento({ amount: 150 })],
    cashflows: [movimento({ amount: 90, reference_type: "fixed_variable_payment", reference_id: "p1" })],
  });

  it("o read model continua a detectar", () => {
    expect(rows[0].integrity_issue).toBe("linked_amount_mismatch");
  });

  it("🔴 o aviso aparece no ecrã, em linguagem de quem gere", async () => {
    const texto = await mostrar(rows);
    expect(texto).toContain("Valor do pagamento diferente do movimento de caixa");
    // E nunca o nome técnico.
    expect(texto).not.toContain("linked_amount_mismatch");
  });

  it("🔴 o estado deixa de afirmar «Pago» sobre uma linha que não fecha", () => {
    expect(presentationStatus(rows[0], "2026-08-30")).toBe("Verificar");
  });

  it("🔴 nenhuma mutação financeira é permitida nesta linha", () => {
    expect(canMutateRow(rows[0])).toBe(false);
  });
});

describe("C. orphan_payment_reference", () => {
  // Movimento que aponta para um pagamento que não existe no período.
  const rows = buildFinanceLedger({
    payments: [],
    cashflows: [movimento({ reference_type: "fixed_variable_payment", reference_id: "p-desaparecido" })],
  });

  it("o read model continua a detectar", () => {
    expect(rows[0].integrity_issue).toBe("orphan_payment_reference");
  });

  it("🔴 o aviso aparece no ecrã", async () => {
    const texto = await mostrar(rows);
    expect(texto).toContain("Movimento ligado a um pagamento que já não existe");
    expect(texto).not.toContain("orphan_payment_reference");
  });

  it("🔴 nenhuma mutação financeira é permitida", () => {
    expect(canMutateRow(rows[0])).toBe(false);
    expect(presentationStatus(rows[0], "2026-08-30")).toBe("Verificar");
  });
});

describe("D. duplicate_payment_link", () => {
  const rows = buildFinanceLedger({
    payments: [pagamento()],
    cashflows: [
      movimento({ id: "c1", reference_type: "fixed_variable_payment", reference_id: "p1" }),
      movimento({ id: "c2", reference_type: "fixed_variable_payment", reference_id: "p1" }),
    ],
  });

  it("🔴 NENHUMA linha desaparece — o dinheiro não se esconde", () => {
    // Duas ligações ao mesmo pagamento: o utilizador tem de ver as duas.
    const ids = rows.map((row) => row.row_id);
    expect(ids.length).toBeGreaterThanOrEqual(2);
    expect(new Set(ids).size).toBe(ids.length);
    expect(rows.some((row) => row.integrity_issue === "duplicate_payment_link")).toBe(true);
  });

  it("🔴 o aviso aparece no ecrã", async () => {
    const texto = await mostrar(rows);
    expect(texto).toContain("Mais de um movimento ligado ao mesmo pagamento");
    expect(texto).not.toContain("duplicate_payment_link");
  });

  it("🔴 a linha degradada não aceita mutação", () => {
    const degradada = rows.find((row) => row.integrity_issue !== null)!;
    expect(canMutateRow(degradada)).toBe(false);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// E. LINHA SÃ MANTÉM AS ACÇÕES LEGÍTIMAS
// ═══════════════════════════════════════════════════════════════════════════
describe("E. linha saudável não perde nada", () => {
  const rows = buildFinanceLedger({
    payments: [pagamento({ status: "pendente", paid_at: null })],
    cashflows: [],
  });

  it("sem anomalia, sem aviso", () => {
    expect(rows[0].integrity_issue).toBeNull();
    expect(integrityWarning(rows[0])).toBeNull();
  });

  it("continua a permitir mutação e a mostrar o estado real", () => {
    expect(canMutateRow(rows[0])).toBe(true);
    expect(presentationStatus(rows[0], "2026-08-10")).toBe("Pendente");
  });

  it("🔴 o ecrã mostra as acções legítimas e nenhum aviso de inconsistência", async () => {
    const texto = await mostrar(rows);
    expect(texto).toContain("Fornecedor A");
    expect(texto).not.toContain("inconsistência entre Pagamentos e Caixa");
    expect(texto).not.toContain("Verificar inconsistência");
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// F. O ÂMBITO NÃO ALARGOU
// ═══════════════════════════════════════════════════════════════════════════
describe("F. a correcção fica na UI e na apresentação", () => {
  it("🔴 payments.ts não foi tocado por esta correcção", () => {
    const source = ler("src/app/actions/payments.ts");
    // Nada de integridade entrou na action: a decisão é de apresentação, e a
    // garantia de escrita continua a ser das RPCs atómicas.
    expect(source).not.toContain("integrity_issue");
    expect(source).not.toContain("canMutateRow");
    // E os caminhos atómicos continuam lá.
    expect(source).toContain("update_payment_atomic");
    expect(source).toContain("delete_payment_atomic");
  });

  it("a UI bloqueia por dupla barreira: menu e função de eliminação", () => {
    const ui = ler(
      "src/app/(dashboard)/dashboard/financeiro/pagamentos/_components/unified-payments-client.tsx",
    );
    expect(ui).toContain("canMutateRow");
    expect(ui).toContain("INTEGRITY_BLOCK_REASON");
    // A segunda barreira vive dentro de `remove`, não só no menu.
    const remover = ui.slice(ui.indexOf("function remove("), ui.indexOf("return (", ui.indexOf("function remove(")));
    expect(remover).toContain("canMutateRow");
  });
});

import { describe, expect, it } from "vitest";
import { buildPaymentUpdatePatch } from "@/domain/finance/payment-edit-patch";

const source = {
  description: "Renda",
  amount_cents: 12345,
  due_date: "2026-09-15",
  expense_category_id: null,
  direct_debit: null,
  notes: null,
};

const draft = {
  description: "Renda",
  amount: 123.45,
  dueDate: "2026-09-15",
  categoryId: "",
  directDebit: "" as const,
  notes: "",
};

describe("buildPaymentUpdatePatch", () => {
  it("não envia campos inalterados, incluindo NULL", () => {
    expect(buildPaymentUpdatePatch(source, draft, true)).toEqual({});
  });

  it("envia apenas a descrição quando só ela muda", () => {
    expect(buildPaymentUpdatePatch(source, { ...draft, description: "Nova renda" }, true))
      .toEqual({ description: "Nova renda" });
  });

  it("preserva distinções intencionais de NULL e valores", () => {
    expect(buildPaymentUpdatePatch(source, { ...draft, dueDate: "" }, true))
      .toEqual({ due_date: null });
    expect(buildPaymentUpdatePatch(source, { ...draft, directDebit: "nao" }, true))
      .toEqual({ direct_debit: false });
    expect(buildPaymentUpdatePatch(source, { ...draft, amount: null }, true))
      .toEqual({ amount: null });
  });

  it("não inclui amount de pagamento já pago", () => {
    expect(buildPaymentUpdatePatch(source, { ...draft, amount: 999 }, false)).toEqual({});
  });
});

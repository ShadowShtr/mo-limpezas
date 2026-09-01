export interface PaymentEditSource {
  description: string;
  amount_cents: number | null;
  due_date: string | null;
  expense_category_id: string | null;
  direct_debit: boolean | null;
  notes: string | null;
}

export interface PaymentEditDraft {
  description: string;
  amount: number | null;
  dueDate: string;
  categoryId: string;
  directDebit: "" | "sim" | "nao";
  notes: string;
}

export type PaymentUpdatePatch = Partial<{
  description: string;
  amount: number | null;
  due_date: string | null;
  expense_category_id: string | null;
  direct_debit: boolean | null;
  notes: string | null;
}>;

const nullableText = (value: string): string | null => value === "" ? null : value;
const cents = (value: number | null): number | null => value === null ? null : Math.round(value * 100);

/**
 * Produz apenas os campos que mudaram no formulário de pagamento.
 * Valores vazios representam NULL apenas no campo correspondente; um valor
 * inalterado nunca é enviado e, portanto, nunca pode regridar a competência.
 */
export function buildPaymentUpdatePatch(
  source: PaymentEditSource,
  draft: PaymentEditDraft,
  allowAmount: boolean,
): PaymentUpdatePatch {
  const patch: PaymentUpdatePatch = {};
  const description = draft.description.trim();
  const dueDate = nullableText(draft.dueDate);
  const categoryId = nullableText(draft.categoryId);
  const directDebit = draft.directDebit === "" ? null : draft.directDebit === "sim";
  const notes = draft.notes.trim() === "" ? null : draft.notes.trim();

  if (description !== source.description) patch.description = description;
  if (allowAmount && cents(draft.amount) !== source.amount_cents) patch.amount = draft.amount;
  if (dueDate !== source.due_date) patch.due_date = dueDate;
  if (categoryId !== source.expense_category_id) patch.expense_category_id = categoryId;
  if (directDebit !== source.direct_debit) patch.direct_debit = directDebit;
  if (notes !== source.notes) patch.notes = notes;

  return patch;
}

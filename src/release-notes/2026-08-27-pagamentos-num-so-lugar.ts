import type { ReleaseNote } from "@/domain/update-notices/types";

export const nota: ReleaseNote = {
  key: "2026-08-27-pagamentos-num-so-lugar",
  publishedAt: "2026-08-27T15:30:00.000Z",
  kind: "novidade",
  title: "Pagamentos e movimentos num só lugar",
  message:
    "A página Pagamentos passa a reunir contas a pagar, saídas e entradas " +
    "manuais. O mesmo pagamento aparece uma única vez, mesmo depois de pago. " +
    "Também pode comparar gastos por competência e pelo dinheiro que saiu " +
    "efetivamente da caixa, filtrar a lista e criar ou editar cada tipo no " +
    "formulário adequado.",
};

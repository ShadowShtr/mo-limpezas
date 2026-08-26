// ============================================================================
// 🔴 PUBLICADA — IMUTÁVEL
// ============================================================================
// Não alterar `key`, `publishedAt`, `title` nem `message`.
// ============================================================================

import type { ReleaseNote } from "@/domain/update-notices/types";

export const nota: ReleaseNote = {
  key: "2026-08-26-categoria-das-saidas",
  publishedAt: "2026-08-26T20:00:00.000Z",
  kind: "correcao",
  title: "Categoria dos pagamentos aparece no gráfico",
  message:
    "Quando um pagamento é marcado como pago, a saída de caixa passa a mostrar " +
    "a categoria escolhida no pagamento. Mudar a categoria do pagamento " +
    "atualiza o gráfico. O gráfico passou a chamar-se «Saídas registadas por " +
    "categoria», que é o que mostra: o dinheiro que saiu, não as contas por pagar.",
};

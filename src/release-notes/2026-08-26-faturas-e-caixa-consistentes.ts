import type { ReleaseNote } from "@/domain/update-notices/types";

export const nota: ReleaseNote = {
  key: "2026-08-26-faturas-e-caixa-consistentes",
  publishedAt: "2026-08-26T16:00:00.000Z",
  kind: "correcao",
  title: "Faturas e caixa ficam sincronizados",
  message:
    "Alterar o estado de uma fatura passa a atualizar o respetivo recebimento " +
    "na mesma operacao. Se uma das alteracoes falhar, nenhuma fica gravada.",
};

import type { ReleaseNote } from "@/domain/update-notices/types";

export const nota: ReleaseNote = {
  key: "2026-09-09-folha-vencimento-base",
  publishedAt: "2026-09-09T09:00:00.000Z",
  kind: "novidade",
  title: "Folha: vencimento base e valor final editável",
  message:
    "Cada colaboradora passa a poder ter um vencimento base mensal. Com ele preenchido, o bruto " +
    "é esse valor e deixa de mudar com as horas do ponto — as horas continuam a contar para " +
    "assiduidade e horas extra. E o valor final a pagar já pode ser escrito à mão: basta dizer " +
    "porquê, e fica registado ao lado do valor calculado. Quem não preencher o vencimento base " +
    "continua exatamente como antes.",
};

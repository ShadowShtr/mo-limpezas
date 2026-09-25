import type { ReleaseNote } from "@/domain/update-notices/types";

export const nota: ReleaseNote = {
  key: "2026-09-25-pagamentos-mes-e-vencimento",
  publishedAt: "2026-09-25T17:00:00.000Z",
  kind: "correcao",
  title: "Pagamentos: o mês certo e as contas por pagar de trás",
  message:
    "O mês escolhido nos Pagamentos passa a valer em todos os separadores: uma conta pertence "
    + "ao mês do seu vencimento, mesmo que tenha sido paga noutro. «Por pagar» mostra agora "
    + "também o que ficou por pagar em meses anteriores. A coluna «Data» mostra o vencimento "
    + "enquanto está por pagar, e o dia em que o dinheiro saiu depois de pago. Uma data de "
    + "vencimento impossível deixa de ser aceite.",
};

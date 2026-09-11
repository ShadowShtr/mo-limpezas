import type { ReleaseNote } from "@/domain/update-notices/types";

export const nota: ReleaseNote = {
  key: "2026-09-11-pagamentos-ordem-vencimento",
  publishedAt: "2026-09-11T12:00:00.000Z",
  kind: "correcao",
  title: "Pagamentos agora aparecem pela data de vencimento",
  message:
    "Na lista de pagamentos, os vencimentos passam a aparecer por ordem de data, dos mais antigos "
    + "para os mais recentes. Assim vês primeiro o que vence antes, sem perder nenhum pagamento: "
    + "os que ainda não têm data ficam no fim da lista, nunca escondidos. Nos separadores Fixos e "
    + "Variáveis nada muda — continuam na ordem que já tinham.",
};

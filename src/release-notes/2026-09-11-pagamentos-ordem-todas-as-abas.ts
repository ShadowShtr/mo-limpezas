import type { ReleaseNote } from "@/domain/update-notices/types";

export const nota: ReleaseNote = {
  key: "2026-09-11-pagamentos-ordem-todas-as-abas",
  publishedAt: "2026-09-11T16:00:00.000Z",
  kind: "correcao",
  title: "Pagamentos: agora todos os separadores estão por data",
  message:
    "A ordem por data já estava em Todos, Por pagar e Pagos, mas Fixos, Variáveis e Movimentos "
    + "manuais continuavam pela ordem em que tinham sido criados. Já não: os cinco separadores "
    + "leem-se agora do dia mais antigo para o mais recente, do 1 ao 31. Nada se perde — o que "
    + "ainda não tem data fica no fim da lista, à vista.",
};

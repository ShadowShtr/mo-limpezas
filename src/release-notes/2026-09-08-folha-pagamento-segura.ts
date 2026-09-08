import type { ReleaseNote } from "@/domain/update-notices/types";

export const nota: ReleaseNote = {
  key: "2026-09-08-folha-pagamento-segura",
  publishedAt: "2026-09-08T12:30:00.000Z",
  kind: "correcao",
  title: "Folha: o pagamento e o movimento de caixa passam a andar juntos",
  message:
    "Marcar a folha como paga cria o movimento de caixa no mesmo instante. Antes eram dois " +
    "passos, e uma falha a meio podia deixar a folha paga sem o movimento, ou o movimento sem " +
    "a folha. Carregar duas vezes também deixa de criar o movimento repetido. E se o mês já " +
    "estiver fechado, nada é gravado — aparece um aviso.",
};

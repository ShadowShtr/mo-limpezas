import type { ReleaseNote } from "@/domain/update-notices/types";

export const nota: ReleaseNote = {
  key: "2026-09-24-corrigir-orcamento-em-rascunho",
  // 🔴 Nunca uma hora no futuro: `releaseElegivel` usa `publishedAt` só como
  //    limite inferior face à criação do perfil, e não filtra o que ainda não
  //    aconteceu.
  publishedAt: "2026-09-24T16:00:00.000Z",
  kind: "novidade",
  title: "CRM: corrigir um orçamento ainda em rascunho",
  message:
    "Um orçamento em rascunho deixa de ter de ser anulado por causa de uma gralha. Abra-o e "
    + "carregue em «Editar rascunho»: pode corrigir datas, linhas, desconto, condições e notas, "
    + "e fica o mesmo documento, com o mesmo número. Se outra pessoa o tiver alterado enquanto o "
    + "tinha aberto, nada é guardado e é avisado para o recarregar primeiro.",
};

import type { ReleaseNote } from "@/domain/update-notices/types";

export const nota: ReleaseNote = {
  key: "2026-09-24-corrigir-orcamento-em-rascunho",
  // 🔴 Nunca uma hora no futuro: `releaseElegivel` usa `publishedAt` só como
  //    limite inferior face à criação do perfil, e NÃO filtra o que ainda não
  //    aconteceu — uma nota datada de logo à tarde aparece já.
  //
  //    Esta nota chegou a estar em `2026-09-24T16:00:00.000Z`, com o relógio
  //    nas 14:16Z: quase duas horas no futuro, e o comentário acima já o
  //    proibia. O CI não apanhou porque o guard das notas só verificava que a
  //    data existe e é parseável. Passou a haver ensaio para isso.
  publishedAt: "2026-09-24T14:00:00.000Z",
  kind: "novidade",
  title: "CRM: corrigir um orçamento ainda em rascunho",
  message:
    "Um orçamento em rascunho deixa de ter de ser anulado por causa de uma gralha. Abra-o e "
    + "carregue em «Editar rascunho»: pode corrigir datas, linhas, desconto, condições e notas, "
    + "e fica o mesmo documento, com o mesmo número. Se outra pessoa o tiver alterado enquanto o "
    + "tinha aberto, nada é guardado e é avisado para o recarregar primeiro.",
};

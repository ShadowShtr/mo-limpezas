import type { ReleaseNote } from "@/domain/update-notices/types";

export const nota: ReleaseNote = {
  key: "2026-09-09-folha-ponto-e-mao",
  publishedAt: "2026-09-09T17:00:00.000Z",
  kind: "novidade",
  title: "Folha: as horas vêm do ponto, mas podes sempre corrigir",
  message:
    "Ao abrir o ajuste de um registo, as horas aparecem já com o que o ponto marcou, e o ecrã " +
    "diz o que o ponto tem. Se corrigires alguma coisa, fica assinalado e o botão «Recalcular " +
    "folha» deixa de mexer nesses valores — a tua correção não se perde. Há um botão para voltar " +
    "aos valores do ponto quando quiseres. E se ainda não houver ponto no mês, escreves tudo à mão.",
};

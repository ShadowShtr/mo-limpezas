import type { ReleaseNote } from "@/domain/update-notices/types";

export const nota: ReleaseNote = {
  key: "2026-09-25-saida-de-colaborador",
  // 🔴 13:00Z com o relógio nas 13:48Z — no passado, como o guard exige.
  publishedAt: "2026-09-25T13:00:00.000Z",
  kind: "novidade",
  title: "Tirar o acesso a quem sai passa a valer de imediato",
  message:
    "Quando põe alguém em «Inativo» ou «Suspenso», a pessoa deixa de ver dados na mesma hora, "
    + "mesmo com a aplicação aberta. Antes, só ficava impedida de entrar de novo. Reativar "
    + "devolve tudo como estava: a mesma conta, a equipa, os documentos e o histórico. Nada se "
    + "apaga. O estado «Suspenso» já aparecia no formulário mas não podia ser gravado na "
    + "criação; passa a funcionar.",
};

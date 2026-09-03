import type { ReleaseNote } from "@/domain/update-notices/types";

export const nota: ReleaseNote = {
  key: "2026-09-03-intervencoes-pontuais",
  publishedAt: "2026-09-03T09:00:00.000Z",
  kind: "correcao",
  title: "Intervenções guardadas em conjunto",
  message:
    "Alterações de equipa, datas e planeamento de uma intervenção são guardadas em conjunto. " +
    "Os serviços pontuais continuam independentes e sem criar uma série recorrente.",
};

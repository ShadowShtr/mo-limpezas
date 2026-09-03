import type { ReleaseNote } from "@/domain/update-notices/types";

export const nota: ReleaseNote = {
  key: "2026-09-03-correcao-guardar-intervencoes",
  publishedAt: "2026-09-03T16:00:00.000Z",
  kind: "correcao",
  title: "Correção ao guardar intervenções",
  message:
    "Ao mudar o horário ou a equipa de uma intervenção, aparecia um erro a dizer que a alteração não tinha sido confirmada — e as visitas seguintes ficavam com a equipa antiga. " +
    "A alteração passa a ser guardada normalmente e as visitas futuras acompanham-na.",
};

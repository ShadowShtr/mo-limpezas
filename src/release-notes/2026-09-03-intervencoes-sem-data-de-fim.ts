import type { ReleaseNote } from "@/domain/update-notices/types";

export const nota: ReleaseNote = {
  key: "2026-09-03-intervencoes-sem-data-de-fim",
  publishedAt: "2026-09-03T10:00:00.000Z",
  kind: "correcao",
  title: "Intervenções sem data de fim",
  message:
    "Já é possível retirar a data de fim de uma intervenção e guardar normalmente. " +
    "Antes, deixar esse campo em branco fazia aparecer um aviso a dizer que faltavam dados e impedia gravar.",
};

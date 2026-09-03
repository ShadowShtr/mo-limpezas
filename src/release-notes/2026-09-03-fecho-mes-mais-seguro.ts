import type { ReleaseNote } from "@/domain/update-notices/types";

export const nota: ReleaseNote = {
  key: "2026-09-03-fecho-mes-mais-seguro",
  publishedAt: "2026-09-03T09:00:00.000Z",
  kind: "manutencao",
  title: "Fechar e reabrir o mês ficou mais seguro",
  message:
    "Fechar um mês passa a confirmar as pendências no momento exato em que grava, " +
    "para que nada lançado entretanto fique de fora. Quem fechou ou reabriu, e porquê, " +
    "fica sempre registado junto com a alteração.",
};

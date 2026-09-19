import type { ReleaseNote } from "@/domain/update-notices/types";

export const nota: ReleaseNote = {
  key: "2026-09-19-crm-visitas",
  publishedAt: "2026-09-19T14:00:00.000Z",
  kind: "novidade",
  title: "CRM: agenda de visitas comerciais",
  message:
    "O CRM tem um separador novo, Visitas. Marca a deslocação para ir ver o local — a uma "
    + "lead ou a um cliente que já tem —, com dia, hora e quem vai. Depois regista o que "
    + "aconteceu: realizada, não compareceu ou cancelada, e no caso de ter ido, a área, as "
    + "horas estimadas e as notas do local. É daí que sai o orçamento, sem segunda viagem. "
    + "Uma visita não entra no calendário das equipas nem na faturação.",
};

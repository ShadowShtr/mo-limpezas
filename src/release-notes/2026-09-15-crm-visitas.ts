import type { ReleaseNote } from "@/domain/update-notices/types";

export const nota: ReleaseNote = {
  key: "2026-09-15-crm-visitas",
  publishedAt: "2026-09-15T14:00:00.000Z",
  kind: "novidade",
  title: "CRM: marcar visitas para ir ver o local",
  message:
    "No CRM há agora um separador Visitas, para marcar quando se vai ver o local de uma "
    + "lead e quem lá vai — essa pessoa recebe aviso. Depois da visita regista-se o que se "
    + "mediu: área, horas estimadas e periodicidade. Fica tudo no diário da lead. Estas "
    + "visitas não aparecem no calendário das equipas nem contam como serviço.",
};

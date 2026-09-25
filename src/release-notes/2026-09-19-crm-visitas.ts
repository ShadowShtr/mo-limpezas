import type { ReleaseNote } from "@/domain/update-notices/types";

export const nota: ReleaseNote = {
  key: "2026-09-19-crm-visitas",
  // 🔴 Nunca uma hora no futuro: `releaseElegivel` usa `publishedAt` só como
  //    limite inferior face à criação do perfil, e não filtra o que ainda não
  //    aconteceu. Uma nota datada de logo à tarde apareceria na mesma agora.
  publishedAt: "2026-09-19T11:00:00.000Z",
  kind: "novidade",
  title: "CRM: agenda de visitas comerciais",
  message:
    "O CRM tem um separador novo, Visitas. Marca a deslocação para ir ver o local — a uma "
    + "lead ou a um cliente que já tem —, com dia, hora e quem vai. Quando a visita é "
    + "realizada, pode guardar a área, as horas estimadas e as notas do local, que ficam "
    + "registadas na ficha. Também regista quem não compareceu ou cancelou. Uma visita não "
    + "entra no calendário das equipas nem na faturação.",
};

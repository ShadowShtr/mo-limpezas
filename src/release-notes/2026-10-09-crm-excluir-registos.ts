import type { ReleaseNote } from "@/domain/update-notices/types";

export const nota: ReleaseNote = {
  key: "2026-10-09-crm-excluir-registos",
  publishedAt: "2026-10-09T00:00:00.000Z",
  kind: "novidade",
  title: "CRM: excluir registos de teste",
  message: "Pode excluir leads, visitas e orçamentos com confirmação. Ao excluir uma lead, também são removidos os contactos, as visitas e os orçamentos associados; leads já convertidas em cliente ficam protegidas.",
};

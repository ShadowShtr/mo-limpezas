import type { ReleaseNote } from "@/domain/update-notices/types";

export const nota: ReleaseNote = {
  key: "2026-10-09-crm-excluir-registos",
  publishedAt: "2026-10-09T00:00:00.000Z",
  kind: "novidade",
  title: "CRM: excluir registos de teste",
  message: "Pode excluir cartões do CRM em qualquer coluna, pelo quadro ou pelo cartão aberto, com confirmação. Ao excluir uma lead, também são removidos os contactos, as visitas e os orçamentos associados; o cliente e os locais mantêm-se.",
};

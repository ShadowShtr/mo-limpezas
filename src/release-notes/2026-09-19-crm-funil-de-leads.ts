import type { ReleaseNote } from "@/domain/update-notices/types";

export const nota: ReleaseNote = {
  key: "2026-09-19-crm-funil-de-leads",
  publishedAt: "2026-09-19T10:00:00.000Z",
  kind: "novidade",
  title: "Novo: CRM, para acompanhar quem ainda não é cliente",
  message:
    "Há um separador novo, o CRM, com um quadro onde cada pedido de orçamento é um cartão "
    + "que arrasta entre colunas, de Novo até Ganho ou Perdido. Guarda o contacto, o "
    + "responsável, quanto vale e o que falta fazer — se essa data já passou, o cartão fica "
    + "assinalado. Cada chamada ou email fica no diário da lead. Nada disto mexe nos "
    + "clientes, contratos ou calendário.",
};

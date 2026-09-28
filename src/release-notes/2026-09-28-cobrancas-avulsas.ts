import type { ReleaseNote } from "@/domain/update-notices/types";

export const nota: ReleaseNote = {
  key: "2026-09-28-cobrancas-avulsas",
  publishedAt: "2026-09-28T00:00:00.000Z",
  kind: "novidade",
  title: "Cobranças: notas de cobrança avulsas e recebimento no editor",
  message:
    "«Adicionar cobrança» pergunta se quer um novo serviço ou uma cobrança avulsa — um valor a "
    + "cobrar sem serviço agendado, que conta no dia, nos pendentes e em «Por cliente». Cada linha "
    + "tem «Editar» e «Excluir»; o recebimento (por pagar, 50%, 100% ou um valor) regista-se em "
    + "«Editar». Com recebimento registado, retire-o antes de excluir ou mudar o valor.",
};

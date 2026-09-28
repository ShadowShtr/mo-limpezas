import type { ReleaseNote } from "@/domain/update-notices/types";

export const nota: ReleaseNote = {
  key: "2026-09-28-cobrancas-avulsas",
  publishedAt: "2026-09-28T10:00:00.000Z",
  kind: "novidade",
  title: "Cobranças: notas de cobrança avulsas e recebimento no editor",
  message:
    "Em Cobranças › Diário, «Adicionar cobrança» pergunta agora o que quer criar: um novo serviço "
    + "ou uma cobrança avulsa — um valor a cobrar a um cliente sem serviço agendado. As cobranças "
    + "avulsas aparecem no dia, nos pendentes, nos totais e no histórico «Por cliente». Cada linha "
    + "passa a ter «Editar» e «Excluir»; o recebimento (por pagar, 50%, 100% ou um valor) regista-se "
    + "dentro de «Editar». Não é possível excluir nem mudar o valor de algo com recebimento "
    + "registado sem retirar primeiro o recebimento, e um mês fechado não aceita alterações.",
};

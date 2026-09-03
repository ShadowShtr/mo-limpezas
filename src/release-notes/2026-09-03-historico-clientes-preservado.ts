import type { ReleaseNote } from "@/domain/update-notices/types";

export const nota: ReleaseNote = {
  key: "2026-09-03-historico-clientes-preservado",
  publishedAt: "2026-09-03T12:00:00.000Z",
  kind: "correcao",
  title: "Histórico de clientes preservado",
  message:
    "Os clientes passam a ser arquivados em vez de eliminados, " +
    "preservando o histórico de serviços e financeiro.",
};

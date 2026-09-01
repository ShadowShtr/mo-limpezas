import type { ReleaseNote } from "@/domain/update-notices/types";

export const nota: ReleaseNote = {
  key: "2026-09-02-pagamentos-recorrencia-explicita",
  publishedAt: "2026-09-02T10:00:00.000Z",
  kind: "melhoria",
  title: "Pagamentos recorrentes deixam de assumir periodicidade",
  message:
    "A preparação de um mês passa a ser uma ação explícita com pré-visualização. " +
    "Pagamentos antigos sem periodicidade conhecida só são repetidos depois de essa informação ser configurada.",
};

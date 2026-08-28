import type { ReleaseNote } from "@/domain/update-notices/types";

export const nota: ReleaseNote = {
  key: "2026-08-27-pagamentos-leitura-unificada",
  publishedAt: "2026-08-27T16:00:00.000Z",
  kind: "novidade",
  title: "Pagamentos com valores consistentes",
  message:
    "A area financeira passou a reunir contas e movimentos sem contar duas vezes " +
    "o mesmo pagamento. Os valores mantem a origem e o periodo corretos.",
};

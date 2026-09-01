import type { ReleaseNote } from "@/domain/update-notices/types";

export const nota: ReleaseNote = {
  key: "2026-09-01-edicao-pagamentos-segura",
  publishedAt: "2026-09-01T15:00:00.000Z",
  kind: "correcao",
  title: "Editar pagamentos sem os mover de mês",
  message:
    "Ao alterar apenas a descrição ou as notas de um pagamento, o sistema " +
    "mantém o vencimento e o mês a que esse pagamento pertence.",
};

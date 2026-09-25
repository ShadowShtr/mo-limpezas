import type { ReleaseNote } from "@/domain/update-notices/types";

export const nota: ReleaseNote = {
  key: "2026-09-12-cobrancas-dia-certo",
  publishedAt: "2026-09-12T10:00:00.000Z",
  kind: "correcao",
  title: "Cobranças mostram sempre o dia certo",
  message:
    "Ao mudar ou atualizar o dia das cobranças, uma resposta mais antiga deixa de substituir os dados mais recentes. Durante a mudança, os serviços do dia anterior também deixam de aparecer como se pertencessem ao novo dia.",
};

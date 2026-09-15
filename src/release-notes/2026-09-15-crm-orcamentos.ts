import type { ReleaseNote } from "@/domain/update-notices/types";

export const nota: ReleaseNote = {
  key: "2026-09-15-crm-orcamentos",
  publishedAt: "2026-09-15T16:00:00.000Z",
  kind: "novidade",
  title: "CRM: orçamentos com PDF e envio por email",
  message:
    "Já pode fazer orçamentos no CRM, linha a linha, com desconto e IVA — o total aparece "
    + "enquanto escreve. Cada um leva número próprio e pode sair em PDF ou seguir por email "
    + "com o PDF anexo. Depois de enviado, alterá-lo cria uma revisão nova, para o documento "
    + "que o cliente recebeu não mudar por baixo dele. As notas internas nunca saem.",
};

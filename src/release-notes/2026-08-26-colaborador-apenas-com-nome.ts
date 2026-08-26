import type { ReleaseNote } from "@/domain/update-notices/types";

export const nota: ReleaseNote = {
  key: "2026-08-26-colaborador-apenas-com-nome",
  publishedAt: "2026-08-26T22:00:00.000Z",
  kind: "correcao",
  title: "Criar colaborador apenas com o nome",
  message:
    "Ao adicionar um colaborador, apenas o nome e obrigatorio. Email, telefone, " +
    "NIF, IBAN e dados do contrato podem ser preenchidos mais tarde no perfil.",
};

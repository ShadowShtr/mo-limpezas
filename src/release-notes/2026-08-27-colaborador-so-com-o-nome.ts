// ============================================================================
// 🔴 PUBLICADA — IMUTÁVEL
// ============================================================================
// Não alterar `key`, `publishedAt`, `title` nem `message`.
//
// A `key` liga ao registo de leitura de cada perfil: mudá-la faz o aviso
// reaparecer a quem já o confirmou. Reescrever o texto muda aquilo que alguém
// disse ter lido.
// ============================================================================

import type { ReleaseNote } from "@/domain/update-notices/types";

export const nota: ReleaseNote = {
  key: "2026-08-27-colaborador-so-com-o-nome",
  publishedAt: "2026-08-27T09:00:00.000Z",
  kind: "novidade",
  title: "Adicionar colaborador só com o nome",
  message:
    "Para adicionar uma pessoa basta agora o nome. NIF, IBAN, email, telefone " +
    "e dados do contrato podem ficar por preencher e ser completados mais " +
    "tarde na ficha dela. Quem for adicionado assim fica na lista, nas equipas " +
    "e na folha, mas ainda não entra na aplicação — o acesso passa a ser dado " +
    "à parte, na própria ficha.",
};

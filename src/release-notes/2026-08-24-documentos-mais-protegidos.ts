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
  key: "2026-08-24-documentos-mais-protegidos",
  publishedAt: "2026-08-24T18:00:00.000Z",
  kind: "correcao",
  title: "Documentos de colaborador mais protegidos",
  message:
    "Reforçámos o acesso aos documentos dos colaboradores e as mensagens " +
    "que aparecem quando um envio ou uma eliminação não é concluída.",
};

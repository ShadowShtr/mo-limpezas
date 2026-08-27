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
  key: "2026-08-27-criar-colaborador-corrigido",
  publishedAt: "2026-08-27T11:30:00.000Z",
  kind: "correcao",
  title: "Criar colaborador voltou a funcionar",
  message:
    "Guardar um colaborador novo dava sempre «company_id inválido» e não " +
    "deixava criar ninguém. Já está corrigido. Continua a bastar o nome — " +
    "email, NIF, IBAN, telefone e datas podem ficar por preencher e ser " +
    "completados depois na ficha da pessoa.",
};

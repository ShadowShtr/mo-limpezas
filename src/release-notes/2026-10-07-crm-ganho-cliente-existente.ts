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
  key: "2026-10-07-crm-ganho-cliente-existente",
  publishedAt: "2026-10-07T12:00:00.000Z",
  kind: "novidade",
  title: "CRM: dar como ganha uma lead que já é cliente",
  message:
    "No orçamento aceite de uma lead há agora o botão «Já é cliente? Associar». " +
    "Escolhe-se o cliente que já existe e onde fica o serviço (um local dele ou " +
    "um local novo), e a lead fica ganha sem criar um cliente repetido. A ficha " +
    "do cliente não é alterada.",
};

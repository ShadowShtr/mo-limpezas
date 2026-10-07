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
  key: "2026-10-07-crm-pesquisa-cliente",
  publishedAt: "2026-10-07T00:00:00.000Z",
  kind: "novidade",
  title: "CRM: pesquisar cliente antes de criar",
  message:
    "Em «Nova lead», «Marcar visita» e «Novo orçamento» há agora uma barra de " +
    "pesquisa que procura nos clientes e nas leads (por nome, email, telefone " +
    "ou NIF). Se a pessoa já for cliente, marca-se a visita ou faz-se o " +
    "orçamento diretamente para ela, sem criar uma lead repetida. Se não " +
    "aparecer ninguém, escolha «Criar nova lead».",
};

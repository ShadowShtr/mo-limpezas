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
  key: "2026-10-01-quadro-pendentes-visual",
  publishedAt: "2026-10-01T00:00:00.000Z",
  kind: "correcao",
  title: "Prazos e pendentes: abas mais fáceis de ler",
  message:
    "As abas do quadro de prazos ocupam agora a largura toda e os nomes " +
    "aparecem inteiros, também no telemóvel. Cada linha mostra a urgência " +
    "com uma cor à esquerda e a data à direita.",
};

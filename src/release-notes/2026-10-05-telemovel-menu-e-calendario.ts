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
  key: "2026-10-05-telemovel-menu-e-calendario",
  publishedAt: "2026-10-05T00:00:00.000Z",
  kind: "correcao",
  title: "Telemóvel: o menu de baixo e o calendário voltam a caber no ecrã",
  message:
    "No telemóvel, a barra de menu do fundo ficava escondida por baixo da " +
    "barra do telefone e não dava para lhe tocar. Já aparece inteira. " +
    "No calendário, o botão «Novo serviço» ficava cortado fora do ecrã, sem " +
    "forma de lá chegar, e a lista de equipas ocupava quase toda a página — " +
    "agora as duas barras deslizam para o lado com o dedo e mostram tudo. " +
    "No computador nada muda.",
};

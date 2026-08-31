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
  key: "2026-08-31-alocacao-de-equipas-so-guarda-quando-guardas",
  publishedAt: "2026-08-31T00:00:00.000Z",
  kind: "novidade",
  title: "Alocação de equipas: arrastar já não grava sozinho",
  message:
    "No calendário, arrastar pessoas entre equipas passou a ser um rascunho: " +
    "nada é gravado até carregar em Guardar alocações. O que mudar aqui vale " +
    "só para o dia escolhido, e pode largar alguém em Disponível para a deixar " +
    "de stand by nesse dia sem a tirar da equipa. Em Equipas, o botão de " +
    "eliminar passou a arquivar — os serviços antigos continuam a saber quem " +
    "os fez.",
};

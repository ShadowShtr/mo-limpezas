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
  key: "2026-10-01-fixos-repetem-sozinhos",
  publishedAt: "2026-10-01T00:00:00.000Z",
  kind: "novidade",
  title: "Pagamentos: os fixos voltam a repetir-se sozinhos",
  message:
    "Os pagamentos fixos passam a aparecer sozinhos nos meses seguintes, " +
    "sempre até quatro meses à frente, a começar em Novembro. Cada fixo tem a " +
    "sua periodicidade — mensal, trimestral, anual — e pode deixar de se " +
    "repetir pelo menu da linha. Os anexos não são copiados para os meses " +
    "novos, e os que já existem ficam onde estão.",
};

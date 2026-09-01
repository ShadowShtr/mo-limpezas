// ============================================================================
// PUBLICADA - IMUTAVEL
// ============================================================================
// Nao alterar `key`, `publishedAt`, `title` nem `message`.
//
// A `key` liga ao registo de leitura de cada perfil: muda-la faz o aviso
// reaparecer a quem ja o confirmou. Reescrever o texto muda aquilo que alguem
// disse ter lido.
// ============================================================================

import type { ReleaseNote } from "@/domain/update-notices/types";

export const nota: ReleaseNote = {
  key: "2026-09-01-pagamentos-fixos-variaveis-paridade",
  publishedAt: "2026-09-01T14:00:00.000Z",
  kind: "correcao",
  title: "Pagamentos: fixos e variaveis mais completos",
  message:
    "Nos pagamentos fixos e variaveis, os valores em branco continuam em " +
    "branco quando editas outros campos. A lista mostra o debito direto, " +
    "respeita a ordem definida e deixa ver todos os registos do mes sem " +
    "cortar a lista.",
};

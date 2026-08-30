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
  key: "2026-08-30-pagamentos-fixos-variaveis-de-volta",
  publishedAt: "2026-08-30T12:00:00.000Z",
  kind: "correcao",
  title: "Pagamentos: fixos e variáveis outra vez separados",
  message:
    "Os separadores de pagamentos fixos e variáveis voltaram, com a contagem " +
    "de cada um, e há atalhos para criar já do tipo certo. O filtro de " +
    "categorias passa a mostrar todas as que aparecem na lista, mesmo as que " +
    "já não estão activas. Um mês sem nada lançado volta a dizê-lo, em vez " +
    "de mostrar totais a zero. Em Cobranças, o Diário ganhou o botão para " +
    "adicionar.",
};

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
  key: "2026-08-27-conciliacao-e-edicoes-em-simultaneo",
  publishedAt: "2026-08-27T18:30:00.000Z",
  kind: "correcao",
  title: "Duas pessoas a mexer no mesmo lançamento ao mesmo tempo",
  message:
    "Se duas pessoas trabalhassem no mesmo pagamento ou movimento ao mesmo " +
    "tempo, uma podia gravar por cima do que a outra tinha acabado de fazer — " +
    "e o valor do pagamento ficava diferente do valor no Fluxo de Caixa, sem " +
    "ninguém dar por isso. Já não acontece: quando há duas alterações em " +
    "simultâneo, a segunda avisa que o lançamento entretanto mudou e não " +
    "grava. Basta voltar a abrir e confirmar.",
};

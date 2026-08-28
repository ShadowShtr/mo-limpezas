// ============================================================================
// 🔴 PUBLICADA — IMUTÁVEL
// ============================================================================
// Não alterar `key`, `publishedAt`, `title` nem `message`.
//
// A `key` liga ao registo de leitura de cada perfil: mudá-la faz o aviso
// reaparecer a quem já o confirmou. Reescrever o texto muda aquilo que alguém
// disse ter lido.
//
// Nota sobre o âmbito: esta nota fala **só da conciliação**, que é o único
// caminho que esta alteração liga. As mesmas garantias para editar e apagar
// pagamentos e movimentos chegam com a nova página de Pagamentos, e terão a
// sua própria nota — prometê-las aqui seria anunciar o que ainda não está
// ligado.
// ============================================================================

import type { ReleaseNote } from "@/domain/update-notices/types";

export const nota: ReleaseNote = {
  key: "2026-08-27-conciliacao-e-edicoes-em-simultaneo",
  publishedAt: "2026-08-27T18:30:00.000Z",
  kind: "correcao",
  title: "Conciliação bancária com duas pessoas ao mesmo tempo",
  message:
    "Se duas pessoas mexessem no mesmo movimento ao mesmo tempo — uma a " +
    "confirmar a conciliação, outra a alterá-lo — uma podia gravar por cima " +
    "do que a outra tinha acabado de fazer, e a conciliação ficava a dizer " +
    "uma coisa que já não era verdade. Já não acontece: a segunda operação " +
    "avisa que o movimento entretanto mudou e não grava. Basta voltar a abrir " +
    "e confirmar.",
};

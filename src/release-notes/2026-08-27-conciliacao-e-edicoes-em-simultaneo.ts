// ============================================================================
// 🔴 PUBLICADA — IMUTÁVEL
// ============================================================================
// Não alterar `key`, `publishedAt`, `title` nem `message`.
//
// A `key` liga ao registo de leitura de cada perfil: mudá-la faz o aviso
// reaparecer a quem já o confirmou. Reescrever o texto muda aquilo que alguém
// disse ter lido.
//
// Âmbito: fala do que esta alteração liga mesmo — editar e eliminar pagamentos,
// editar e eliminar movimentos, e confirmar conciliações. Não promete a nova
// página de Pagamentos, que é outra frente e terá a sua própria nota.
// ============================================================================

import type { ReleaseNote } from "@/domain/update-notices/types";

export const nota: ReleaseNote = {
  key: "2026-08-27-conciliacao-e-edicoes-em-simultaneo",
  publishedAt: "2026-08-27T18:30:00.000Z",
  kind: "correcao",
  title: "Duas pessoas a mexer no mesmo lançamento",
  message:
    "Quando duas pessoas mexiam ao mesmo tempo no mesmo pagamento ou " +
    "movimento, uma podia gravar por cima do que a outra tinha acabado de " +
    "fazer, sem ninguém dar por isso. Já não acontece: a segunda operação " +
    "avisa que o lançamento entretanto mudou e não grava. Basta voltar a " +
    "abrir e confirmar.",
};

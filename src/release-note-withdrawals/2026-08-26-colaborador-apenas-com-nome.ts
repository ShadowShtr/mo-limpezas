// ============================================================================
// 🔴 RETIRADA — IMUTÁVEL
// ============================================================================
// Não alterar nem apagar. Uma retirada é tão imutável quanto a nota que retira:
// desfazê-la faria o aviso reaparecer a quem já não devia recebê-lo, e apagá-la
// perderia o registo de que a nota deixou de ser verdade.
//
// A nota original continua em `src/release-notes/`, byte a byte como foi
// publicada. Isto não a apaga — diz que deixou de ser oferecida.
// ============================================================================

import type { ReleaseNoteWithdrawal } from "@/domain/update-notices/types";

export const retirada: ReleaseNoteWithdrawal = {
  key: "2026-08-26-colaborador-apenas-com-nome",
  withdrawnAt: "2026-08-27T00:00:00.000Z",
  reason:
    "A alteração que esta nota anunciava foi revertida no mesmo dia. Continuar " +
    "a mostrá-la diria às pessoas que podem criar um colaborador só com o nome, " +
    "o que deixou de ser verdade. A nota fica no histórico; o aviso deixa de ser " +
    "oferecido.",
};

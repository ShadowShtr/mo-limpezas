// ============================================================================
// RETIRADAS DE NOTAS — uma retirada, um ficheiro
// ============================================================================
// Uma nota publicada é imutável, e continua a ser. Quando deixa de ser verdade
// — porque a alteração que anunciava foi revertida — não se apaga nem se
// reescreve: acrescenta-se aqui uma retirada com a sua `key`.
//
// O que isto separa:
//
//   · **existiu no histórico** — a nota fica em `src/release-notes/`, byte a
//     byte como foi publicada, e os registos de leitura continuam a apontar
//     para a sua `key`;
//   · **ainda deve ser mostrada** — deixa de ser oferecida a partir daqui.
//
// 🔴 Uma retirada é tão imutável quanto a nota. Desfazê-la faria o aviso
//    reaparecer a quem já não devia recebê-lo; apagá-la perderia o registo de
//    que a nota deixou de ser verdade. O guard recusa `M` e `D` nos dois.
//
// 🔴 Retirar uma nota **não** substitui publicar uma nova. Se o comportamento
//    do sistema mudou, quem o usa tem direito a saber o que é verdade agora —
//    e uma retirada não diz nada a ninguém, por desenho.
// ============================================================================

import type { ReleaseNoteWithdrawal } from "@/domain/update-notices/types";
import { retirada as colaboradorApenasComNome } from "./2026-08-26-colaborador-apenas-com-nome";

export const RELEASE_NOTE_WITHDRAWALS: ReleaseNoteWithdrawal[] = [
  colaboradorApenasComNome,
];

/** As chaves retiradas, para filtrar o que se oferece. */
export function withdrawnKeys(): Set<string> {
  return new Set(RELEASE_NOTE_WITHDRAWALS.map((w) => w.key));
}

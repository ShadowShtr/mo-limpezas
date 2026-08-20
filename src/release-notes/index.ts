// ============================================================================
// NOTAS DE VERSÃO — uma release, um ficheiro
// ============================================================================
// Cada alteração visível para quem usa o sistema traz um ficheiro novo nesta
// pasta. Este `index.ts` apenas agrega — mexer nele não conta como escrever
// uma nota, e `scripts/check-release-note.mjs` sabe disso.
//
// 🔴 Uma nota publicada é imutável. A `key` liga ao registo de leitura de cada
//    perfil: mudá-la faz o aviso reaparecer a quem já o viu, e reescrever o
//    texto muda aquilo que alguém confirmou ter lido. O guard recusa `M` ou
//    `D` sobre ficheiros de nota.
//
// Linguagem de quem usa, não de quem construiu. Sem migrations, RPCs,
// constraints ou nomes de ficheiros.
// ============================================================================

import type { ReleaseNote } from "@/domain/update-notices/types";
import { nota as financeiroEAnexos } from "./2026-08-19-financeiro-e-anexos";
import { nota as avisosDeAtualizacao } from "./2026-08-20-avisos-de-atualizacao";

export const RELEASE_NOTES: ReleaseNote[] = [
  financeiroEAnexos,
  avisosDeAtualizacao,
];

/** As chaves têm de ser únicas — duas notas com a mesma key partilhariam a leitura. */
export function releaseNoteKeys(): string[] {
  return RELEASE_NOTES.map((n) => n.key);
}

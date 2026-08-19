// ============================================================================
// NOTAS DE VERSÃO — versionadas com o código que descrevem
// ============================================================================
// Cada alteração visível para quem usa o sistema traz uma nota aqui. O guard
// em `src/__tests__/release-note-guard.test.ts` recusa um PR que mexa em
// `src/app/**` ou `src/components/**` sem tocar nesta pasta.
//
// 🔴 Uma nota publicada é imutável. A `key` é o que liga à leitura de cada
//    perfil: mudá-la faria o aviso reaparecer a quem já o viu, e reescrever o
//    texto mudaria aquilo que alguém confirmou ter lido.
//
// Linguagem de quem usa, não de quem construiu. Sem migrations, RPCs,
// constraints ou nomes de ficheiros.
// ============================================================================

import type { ReleaseNote } from "@/domain/update-notices/types";

export const RELEASE_NOTES: ReleaseNote[] = [
  {
    key: "2026-08-19-financeiro-e-anexos",
    publishedAt: "2026-08-19T12:00:00.000Z",
    kind: "correcao",
    title: "Financeiro e anexos mais estáveis",
    message:
      "Corrigimos a marcação de pagamentos e a permanência dos anexos. " +
      "Também adicionámos múltiplos anexos em Pagamentos, Tarefas e Faltas.",
  },
];

/** As chaves têm de ser únicas — duas notas com a mesma key partilhariam a leitura. */
export function releaseNoteKeys(): string[] {
  return RELEASE_NOTES.map((n) => n.key);
}

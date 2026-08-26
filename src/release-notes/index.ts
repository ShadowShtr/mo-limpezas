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
import { nota as documentosMaisProtegidos } from "./2026-08-24-documentos-mais-protegidos";
import { nota as recibosSemEliminacao } from "./2026-08-24-recibos-sem-eliminacao";
import { nota as disponibilidadeMaisSegura } from "./2026-08-24-disponibilidade-mais-segura";
import { nota as folhaMaisSegura } from "./2026-08-24-folha-mais-segura";
import { nota as anexosAAbrir } from "./2026-08-25-anexos-a-abrir";
import { nota as financeiroMudaDeMes } from "./2026-08-25-financeiro-muda-de-mes";
import { nota as pagamentosNoMesCerto } from "./2026-08-26-pagamentos-no-mes-certo";
import { nota as categoriasEMenu } from "./2026-08-26-categorias-e-menu-dos-pagamentos";
import { nota as categoriaDasSaidas } from "./2026-08-26-categoria-das-saidas";
// 🔴 Retirada — ver `src/release-note-withdrawals/`. Continua aqui de propósito:
//    a `key` liga aos registos de leitura, e tirá-la do catálogo deixava-os a
//    apontar para coisa nenhuma. Deixou de ser oferecida, não de existir.
import { nota as colaboradorApenasComNome } from "./2026-08-26-colaborador-apenas-com-nome";
import { nota as reposicaoDoAcesso } from "./2026-08-26-reposicao-do-acesso";

export const RELEASE_NOTES: ReleaseNote[] = [
  financeiroEAnexos,
  avisosDeAtualizacao,
  documentosMaisProtegidos,
  recibosSemEliminacao,
  disponibilidadeMaisSegura,
  folhaMaisSegura,
  anexosAAbrir,
  financeiroMudaDeMes,
  pagamentosNoMesCerto,
  categoriasEMenu,
  categoriaDasSaidas,
  colaboradorApenasComNome,
  reposicaoDoAcesso,
];

/** As chaves têm de ser únicas — duas notas com a mesma key partilhariam a leitura. */
export function releaseNoteKeys(): string[] {
  return RELEASE_NOTES.map((n) => n.key);
}

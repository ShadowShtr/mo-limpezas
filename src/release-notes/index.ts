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
import { nota as colaboradorApenasComNome } from "./2026-08-26-colaborador-apenas-com-nome";
import { nota as reposicaoDoAcesso } from "./2026-08-26-reposicao-do-acesso";
import { nota as colaboradorSoComONome } from "./2026-08-27-colaborador-so-com-o-nome";
import { nota as criarColaboradorCorrigido } from "./2026-08-27-criar-colaborador-corrigido";
import { nota as criarColaboradorGuardaTudo } from "./2026-08-27-criar-colaborador-guarda-tudo";
import { nota as pagamentosDiagnosticoDeFalhas } from "./2026-08-28-pagamentos-diagnostico-de-falhas";
import { nota as pagamentosSoPelaAplicacao } from "./2026-08-28-pagamentos-so-pela-aplicacao";
import { nota as conciliacaoEmSimultaneo } from "./2026-08-27-conciliacao-e-edicoes-em-simultaneo";
import { nota as pagamentosVistaUnificada } from "./2026-08-30-pagamentos-vista-unificada";
import { nota as pagamentosFixosVariaveisDeVolta } from "./2026-08-30-pagamentos-fixos-variaveis-de-volta";
import { nota as calendarioCartoesBrancos } from "./2026-08-31-calendario-cartoes-com-fundo-branco";
import { nota as equipasGuardamEmLote } from "./2026-09-01-equipas-guardam-em-lote";
import { nota as pagamentosFixosVariaveisParidade } from "./2026-09-01-pagamentos-fixos-variaveis-paridade";
import { nota as edicaoPagamentosSegura } from "./2026-09-01-edicao-pagamentos-segura";
import { nota as cobrancasAvulsas } from "./2026-09-02-cobrancas-avulsas";

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
  colaboradorSoComONome,
  criarColaboradorCorrigido,
  criarColaboradorGuardaTudo,
  pagamentosDiagnosticoDeFalhas,
  pagamentosSoPelaAplicacao,
  conciliacaoEmSimultaneo,
  pagamentosVistaUnificada,
  pagamentosFixosVariaveisDeVolta,
  calendarioCartoesBrancos,
  equipasGuardamEmLote,
  pagamentosFixosVariaveisParidade,
  edicaoPagamentosSegura,
  cobrancasAvulsas,
];

export function releaseNoteKeys(): string[] {
  return RELEASE_NOTES.map((n) => n.key);
}

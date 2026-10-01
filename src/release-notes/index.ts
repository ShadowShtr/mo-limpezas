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
import { nota as clientesPesquisaContratos } from "./2026-09-02-clientes-pesquisa-contratos";
import { nota as equipasEspelhoAusencias } from "./2026-09-02-equipas-espelho-ausencias";
import { nota as intervencoesSemDataDeFim } from "./2026-09-03-intervencoes-sem-data-de-fim";
import { nota as correcaoGuardarIntervencoes } from "./2026-09-03-correcao-guardar-intervencoes";
import { nota as folhaPagamentoSegura } from "./2026-09-08-folha-pagamento-segura";
import { nota as financeiroMesFechado } from "./2026-09-08-financeiro-mes-fechado";
import { nota as folhaVencimentoBase } from "./2026-09-09-folha-vencimento-base";
import { nota as folhaDiasExtras } from "./2026-09-09-folha-dias-extras";
import { nota as folhaPontoEMao } from "./2026-09-09-folha-ponto-e-mao";
import { nota as locaisPontoNoMapa } from "./2026-09-10-locais-ponto-no-mapa";
import { nota as locaisMapaAVista } from "./2026-09-10-locais-mapa-a-vista";
import { nota as pagamentosOrdemVencimento } from "./2026-09-11-pagamentos-ordem-vencimento";
import { nota as pagamentosOrdemTodasAsAbas } from "./2026-09-11-pagamentos-ordem-todas-as-abas";
import { nota as colaboradoresSemEliminar } from "./2026-09-18-colaboradores-sem-eliminar";
import { nota as crmFunilDeLeads } from "./2026-09-19-crm-funil-de-leads";
import { nota as crmVisitas } from "./2026-09-19-crm-visitas";
import { nota as crmOrcamentos } from "./2026-09-22-crm-orcamentos";
import { nota as crmConversaoCliente } from "./2026-09-23-crm-conversao-cliente";
import { nota as crmEditarRascunho } from "./2026-09-24-corrigir-orcamento-em-rascunho";
import { nota as saidaColaborador } from "./2026-09-25-saida-de-colaborador";
import { nota as pagamentosMesEVencimento } from "./2026-09-25-pagamentos-mes-e-vencimento";
import { nota as avisosDeVencimento } from "./2026-09-26-avisos-de-vencimento";
import { nota as cobrancasAvulsas } from "./2026-09-28-cobrancas-avulsas";
import { nota as gastosPorCategoriaIguais } from "./2026-09-28-gastos-por-categoria-iguais";
import { nota as calendarioTodosOsCartoesBrancos } from "./2026-09-29-calendario-todos-os-cartoes-brancos";
import { nota as calendarioCartoesComoOsPredios } from "./2026-09-29-calendario-cartoes-como-os-predios";
import { nota as calendarioContornoCorDaEquipa } from "./2026-09-29-calendario-contorno-cor-da-equipa";
import { nota as fixosRepetemSozinhos } from "./2026-10-01-fixos-repetem-sozinhos";
import { nota as botaoPrazosPendentes } from "./2026-10-01-botao-prazos-pendentes";
import { nota as quadroPendentesAbas } from "./2026-10-01-quadro-pendentes-abas";
import { nota as quadroPendentesVisual } from "./2026-10-01-quadro-pendentes-visual";

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
  clientesPesquisaContratos,
  equipasEspelhoAusencias,
  intervencoesSemDataDeFim,
  correcaoGuardarIntervencoes,
  folhaPagamentoSegura,
  financeiroMesFechado,
  folhaVencimentoBase,
  folhaDiasExtras,
  folhaPontoEMao,
  locaisPontoNoMapa,
  locaisMapaAVista,
  pagamentosOrdemVencimento,
  pagamentosOrdemTodasAsAbas,
  colaboradoresSemEliminar,
  crmFunilDeLeads,
  crmVisitas,
  crmOrcamentos,
  crmConversaoCliente,
  crmEditarRascunho,
  saidaColaborador,
  pagamentosMesEVencimento,
  avisosDeVencimento,
  cobrancasAvulsas,
  gastosPorCategoriaIguais,
  calendarioTodosOsCartoesBrancos,
  calendarioCartoesComoOsPredios,
  calendarioContornoCorDaEquipa,
  fixosRepetemSozinhos,
  botaoPrazosPendentes,
  quadroPendentesAbas,
  quadroPendentesVisual,
];

/** As chaves têm de ser únicas — duas notas com a mesma key partilhariam a leitura. */
export function releaseNoteKeys(): string[] {
  return RELEASE_NOTES.map((n) => n.key);
}

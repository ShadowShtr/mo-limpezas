// ============================================================================
// Ciclo de vida de um colaborador — a decisão, pura
// ============================================================================
//
// 🔴 O defeito que este módulo fecha.
//
//    `deleteColaborador` corria uma sequência de UPDATEs independentes para
//    anular a autoria da pessoa — serviços, contratos, faltas, férias,
//    faturas, folha — e só depois chamava `deleteUser`. Nove colunas. O
//    catálogo tem quarenta e oito.
//
//    Duas consequências, e a segunda é a grave:
//
//      · as referências que a lista não cobria (conciliação, períodos
//        financeiros, tarefas de gestão, fluxo de caixa, pagamentos fixos,
//        funil de leads) bloqueavam o `deleteUser` no fim;
//
//      · quando bloqueavam, as autorias das nove PRIMEIRAS já tinham sido
//        apagadas. O perfil continuava lá, e o histórico ficava sem quem o
//        tinha feito. Uma falha a meio produzia exactamente o estado que a
//        direcção proíbe: PROFILE_EXISTS e HISTORY_PARTIALLY_CLEARED.
//
//    Não há UPDATE nenhum neste caminho novo, e é assim que o estado proibido
//    deixa de ser possível — não por ser tratado, por não ter onde nascer. Um
//    perfil com relações NUNCA é limpo para caber num DELETE: é desativado, e
//    a autoria fica. Um perfil sem relações não tem nada para limpar.
//
// ----------------------------------------------------------------------------
// Porque é que `ON DELETE CASCADE` também conta como histórico
// ----------------------------------------------------------------------------
//
// É tentador dizer que só as referências que BLOQUEIAM o DELETE interessam —
// são as que fazem a operação falhar. Mas as que não bloqueiam não são as
// inofensivas: são as que desaparecem em silêncio. O ponto, as faltas, as
// férias e a folha de pagamento de uma pessoa estão todas em `CASCADE`.
// Apagar o perfil levava-as, sem erro nenhum, e sem ninguém dar por isso.
//
// `NO_DATA_LOSS` não distingue entre perder autoria e perder o registo
// inteiro. Por isso o inventário é percorrido todo, e uma única linha em
// qualquer uma das quarenta e oito referências chega para recusar.
// ============================================================================

import { INVENTARIO_FK_PERFIS } from "./profile-fk-inventory";
import type {
  ReferenciaPerfil,
  RelacaoEncontrada,
  SondagemRelacao,
  VeredictoRemocao,
} from "./lifecycle-types";

export { INVENTARIO_FK_PERFIS };
export type {
  ReferenciaPerfil,
  RelacaoEncontrada,
  SondagemRelacao,
  VeredictoRemocao,
};

/** Como se nomeia cada área para quem lê o ecrã. */
export const NOME_DA_AREA: Record<string, string> = {
  faltas: "faltas",
  ferias: "férias",
  ponto: "registos de ponto",
  payroll: "folha de pagamento",
  equipas: "equipas",
  servicos: "serviços",
  contratos: "contratos",
  financeiro: "financeiro",
  conciliacao: "conciliação bancária",
  documentos: "documentos",
  tarefas: "tarefas",
  notificacoes: "notificações",
  auditoria: "registo de auditoria",
  crm: "funil de leads",
  plataforma: "administração da plataforma",
  transporte: "transportes",
  outros: "outros registos",
};

export const descreverArea = (area: string): string => NOME_DA_AREA[area] ?? area;

/**
 * O veredito sobre apagar fisicamente um perfil.
 *
 * Fecha para o lado seguro em três situações distintas, e distingue-as porque
 * a interface tem de dizer coisas diferentes:
 *
 *   · `TEM_HISTORICO`      — há registos. Desativar é o caminho.
 *   · `SONDAGEM_FALHADA`   — não se conseguiu ler alguma referência.
 *   · `SONDAGEM_INCOMPLETA`— faltou sondar alguma referência do inventário.
 *
 * As duas últimas não são «provavelmente não há nada»: são «não se sabe». E
 * não se sabe é motivo para não apagar, nunca para apagar na dúvida.
 */
export function avaliarRemocao(sondagens: readonly SondagemRelacao[]): VeredictoRemocao {
  const falhas = sondagens
    .filter((s): s is Extract<SondagemRelacao, { estado: "falhada" }> => s.estado === "falhada")
    .map((s) => ({ tabela: s.ref.tabela, coluna: s.ref.coluna, detalhe: s.detalhe }));

  const relacoes: RelacaoEncontrada[] = sondagens
    .filter((s): s is Extract<SondagemRelacao, { estado: "lida" }> => s.estado === "lida")
    .filter((s) => s.contagem > 0)
    .map((s) => ({
      area: s.ref.area,
      tabela: s.ref.tabela,
      coluna: s.ref.coluna,
      contagem: s.contagem,
    }))
    .sort((a, b) => b.contagem - a.contagem || a.tabela.localeCompare(b.tabela));

  const totalRegistos = relacoes.reduce((soma, r) => soma + r.contagem, 0);

  // A cobertura mede-se por restrição, não por contagem de sondagens: uma
  // sondagem repetida não pode tapar uma referência que ninguém tocou.
  const sondadas = new Set(sondagens.map((s) => s.ref.restricao));
  const porSondar = INVENTARIO_FK_PERFIS.filter((r) => !sondadas.has(r.restricao));

  if (falhas.length > 0) {
    return { elegivel: false, codigo: "SONDAGEM_FALHADA", relacoes, falhas, totalRegistos };
  }
  if (porSondar.length > 0) {
    return {
      elegivel: false,
      codigo: "SONDAGEM_INCOMPLETA",
      relacoes,
      falhas: porSondar.map((r) => ({
        tabela: r.tabela,
        coluna: r.coluna,
        detalhe: "referência do inventário que não chegou a ser sondada",
      })),
      totalRegistos,
    };
  }
  if (relacoes.length > 0) {
    return { elegivel: false, codigo: "TEM_HISTORICO", relacoes, falhas: [], totalRegistos };
  }
  return { elegivel: true, codigo: "SEM_HISTORICO", relacoes: [], falhas: [], totalRegistos: 0 };
}

/** As áreas com histórico, agregadas e por ordem de peso. Para o ecrã. */
export function resumirPorArea(
  relacoes: readonly RelacaoEncontrada[],
): { area: string; nome: string; contagem: number }[] {
  const porArea = new Map<string, number>();
  for (const r of relacoes) porArea.set(r.area, (porArea.get(r.area) ?? 0) + r.contagem);
  return [...porArea.entries()]
    .map(([area, contagem]) => ({ area, nome: descreverArea(area), contagem }))
    .sort((a, b) => b.contagem - a.contagem || a.nome.localeCompare(b.nome));
}

/**
 * A frase que explica a recusa, em linguagem de quem usa o sistema.
 *
 * Fica no domínio, e não no componente, porque é testável aqui e porque a
 * mesma explicação tem de sair igual na interface e no erro da action — duas
 * redacções da mesma recusa seriam duas verdades diferentes.
 */
export function explicarVeredicto(v: VeredictoRemocao, nome: string): string {
  if (v.elegivel) {
    // 🔴 «Elegível» deixou de querer dizer «vai ser eliminada».
    //
    //    O veredicto continua a ser verdade — não há registos — mas a
    //    eliminação física está suspensa enquanto a corrida entre sondar e
    //    apagar não tiver garantia na base (ver `deleteColaborador`). Prometer
    //    aqui uma eliminação que a action recusa seria a interface a discordar
    //    do servidor, que é o defeito que esta alteração inteira veio fechar.
    return `${nome} não tem registos associados no sistema.`;
  }
  if (v.codigo === "TEM_HISTORICO") {
    const areas = resumirPorArea(v.relacoes).map((a) => a.nome);
    const lista =
      areas.length === 1
        ? areas[0]
        : `${areas.slice(0, -1).join(", ")} e ${areas[areas.length - 1]}`;
    return (
      `${nome} tem ${v.totalRegistos} ${v.totalRegistos === 1 ? "registo" : "registos"} ` +
      `no sistema (${lista}). Eliminar a conta apagaria esse histórico, ou deixaria-o ` +
      "sem saber quem o fez. Desativar mantém tudo e tira o acesso."
    );
  }
  return (
    `Não foi possível verificar todos os registos de ${nome}, por isso a eliminação ` +
    "fica suspensa. Desativar continua disponível e é seguro."
  );
}

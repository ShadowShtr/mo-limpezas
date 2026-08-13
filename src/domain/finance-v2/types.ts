// ============================================================================
// Financeiro V2 — o modelo de leitura
// ============================================================================
//
// Uma fotografia financeira de **um período explícito**. Nada aqui pergunta as
// horas ao relógio: se a página mostra Agosto, todos os números são de Agosto.
//
// ---------------------------------------------------------------------------
// Quatro estados, e a diferença entre eles é a coisa mais importante do módulo
// ---------------------------------------------------------------------------
//
//   AVAILABLE     carregou, e o valor é este — **incluindo zero**
//   PARTIAL       carregou parte; o que falta está identificado
//   UNAVAILABLE   não existe fonte para isto
//   ERROR         havia fonte, tentou-se, falhou
//
// `AVAILABLE` com `0` e `UNAVAILABLE` **não são a mesma coisa**, e é por
// confundi-los que um painel financeiro mente. Agosto tem mesmo zero euros
// faturados — isso é um facto, e mostra-se `0,00 €`. Já «recebido» não tem
// fonte conciliada — isso é ignorância, e mostra-se «Indisponível».
//
// E `ERROR` não pode cair em nenhum dos outros: uma query que rebentou e
// devolve `[]` produz um zero que ninguém distingue de um zero verdadeiro. Foi
// esse o padrão que este projecto passou meses a caçar.
// ============================================================================

export type EstadoFonte = "AVAILABLE" | "PARTIAL" | "UNAVAILABLE" | "ERROR";

export interface Medida {
  estado: EstadoFonte;
  /** Só existe quando `estado` é AVAILABLE ou PARTIAL. Nunca inventado. */
  valor: number | null;
  /** Porque não há valor — mostrado ao utilizador quando faz sentido. */
  nota?: string;
}

export const medida = {
  disponivel: (valor: number, nota?: string): Medida => ({ estado: "AVAILABLE", valor, nota }),
  parcial: (valor: number, nota: string): Medida => ({ estado: "PARTIAL", valor, nota }),
  indisponivel: (nota: string): Medida => ({ estado: "UNAVAILABLE", valor: null, nota }),
  erro: (nota: string): Medida => ({ estado: "ERROR", valor: null, nota }),
};

/** Uma fonte que falhou. Nunca se transforma em lista vazia. */
export interface FalhaFonte {
  fonte: string;
  mensagem: string;
}

// ─── Contexto ────────────────────────────────────────────────────────────────

/**
 * Resolvido **uma vez**, no topo, e passado a todos os adaptadores.
 *
 * Existe para que nenhum módulo volte a chamar `new Date()` por sua conta. O
 * processo corre em UTC na Vercel; duas metades da mesma página a decidirem
 * "hoje" em separado acabam a discordar sobre que mês é, durante a primeira
 * hora do dia em hora de verão.
 */
export interface FinanceReadContext {
  companyId: string;
  year: number;
  month: number;
  /** `YYYY-MM-DD`, inclusive. */
  periodStart: string;
  /** `YYYY-MM-DD`, inclusive. */
  periodEnd: string;
  /** `YYYY-MM-DD` em Lisboa — a referência para "vencido" e "próximos 7 dias". */
  todayLisbon: string;
}

/**
 * Constrói o contexto de leitura.
 *
 * 🔴 Vive **aqui**, no domínio, e não na action. É pura — e num ficheiro
 * `"use server"` só podem existir exportações assíncronas: cada export desses
 * ficheiros torna-se um endpoint RPC, e o Next recusa exportar uma função
 * síncrona como server action.
 *
 * Esta regra já mordeu este projecto antes (`CANCEL_TYPE_LABELS`, 2026-06-08,
 * exportado de um ficheiro `"use server"` e a bloquear todas as notificações
 * do calendário). Nem o `tsc` nem o ESLint a apanham — só o `npm run build`.
 */
export function construirContexto(
  companyId: string,
  year: number,
  month: number,
  todayLisbon: string,
): FinanceReadContext {
  const ultimoDia = new Date(Date.UTC(year, month, 0)).getUTCDate();
  return {
    companyId,
    year,
    month,
    periodStart: `${year}-${String(month).padStart(2, "0")}-01`,
    periodEnd: `${year}-${String(month).padStart(2, "0")}-${String(ultimoDia).padStart(2, "0")}`,
    todayLisbon,
  };
}

// ─── Avisos de qualidade de dados ────────────────────────────────────────────

/**
 * O que o motor sabe sobre o estado dos dados.
 *
 * A interface não mostra tudo isto — mas o motor tem de saber, porque explica
 * porque é que metade da página está a zero, e a explicação não é um defeito
 * do código.
 */
export type AvisoSaude =
  | "SERVICES_NOT_COMPLETED"
  | "DRAFT_INVOICES_PRESENT"
  | "PAYROLL_ZERO_VALUES"
  | "NO_ISSUED_INVOICES"
  | "PAYMENT_RECURRENCE_INCIDENT";

// ─── A fotografia ────────────────────────────────────────────────────────────

export interface FinanceKpis {
  faturado: Medida;
  recebido: Medida;
  emAberto: Medida;
  custos: Medida;
  margem: Medida;
  /** Em pontos percentuais. `null` quando não há faturação — nunca Infinity. */
  margemPct: Medida;
}

export interface PontoDiario {
  date: string;
  invoiced: number | null;
  received: number | null;
  expenses: number | null;
}

export type TipoAlerta = "VENCIDO" | "VENCE_7_DIAS" | "POR_FATURAR";

export interface FinanceAlert {
  tipo: TipoAlerta;
  count: number;
  amount: number | null;
  /** `YYYY-MM-DD` da fatura mais antiga em atraso. */
  oldestDueDate?: string | null;
}

export interface BlocoAlertas {
  estado: EstadoFonte;
  alertas: FinanceAlert[];
  nota?: string;
}

export interface FaixaAgingDados {
  faixa: "1-7" | "8-15" | "16-30" | "30+";
  count: number;
  amount: number;
}

export interface BlocoAging {
  estado: EstadoFonte;
  faixas: FaixaAgingDados[];
  nota?: string;
}

export interface ClienteTop {
  rank: number;
  clientId: string;
  clientName: string;
  value: number;
  /** Fracção do total, 0–1. */
  share: number;
}

export interface BlocoTopClientes {
  estado: EstadoFonte;
  metrica: "invoiced";
  clientes: ClienteTop[];
  nota?: string;
}

export interface BlocoSerie {
  estado: EstadoFonte;
  pontos: PontoDiario[];
  /** `dia` quando a série é diária; `mes` quando é o recurso legado. */
  granularidade: "dia" | "mes";
  nota?: string;
}

export interface ResumoOperacao {
  estado: EstadoFonte;
  /** Valor **previsto** da agenda. Nunca chamado faturado nem recebido. */
  previsto: number | null;
  servicos: number;
  concluidos: number;
  nota?: string;
}

export interface FinanceDashboardSnapshot {
  period: { year: number; month: number; start: string; end: string };
  generatedAt: string;
  health: { warnings: AvisoSaude[]; failures: FalhaFonte[] };
  kpis: FinanceKpis;
  dailySeries: BlocoSerie;
  alerts: BlocoAlertas;
  aging: BlocoAging;
  topClients: BlocoTopClientes;
  forecast: { estado: EstadoFonte; nota: string };
  /**
   * Despesas por categoria — substitui «Receita por serviço» no Resumo.
   *
   * A classificação de serviços não existe; a de despesas existe desde sempre
   * em `cash_flow_entries.category`. Trocar um card indisponível por um com
   * dados reais é a diferença entre um painel que informa e um que decora.
   */
  expensesByCategory: {
    estado: EstadoFonte;
    fatias: { categoria: string; chave: string | null; valor: number; share: number; cor: string }[];
    total: number;
    semCategoria: number;
    nota?: string;
  };
  /**
   * Prédios — cadeia própria, `building_cards.monthly_value`.
   *
   * 🔴 Nada daqui entra em Faturado, Recebido, Margem ou Fluxo de Caixa. Um
   *    prédio não é um contrato, e ligá-los por nome ou morada seria
   *    inferência sobre texto livre.
   */
  buildings: {
    estado: EstadoFonte;
    linhas: { id: string; nome: string; morada: string | null; valor: number | null; repetido: boolean }[];
    totalConhecido: number | null;
    contagem: number;
    comValor: number;
    semValor: number;
    nota?: string;
  };
  /** STANDBY — volta quando os serviços tiverem classificação real. */
  revenueByService: { estado: EstadoFonte; nota: string };
  teamEfficiency: { estado: EstadoFonte; nota: string };
  operation: ResumoOperacao;
}

// ============================================================================
// FECHAMENTO MENSAL — regras puras
// ============================================================================
//
// Tudo o que decide "este mês está aberto ou fechado", "esta data cai em que
// período" e "este motivo de reabertura serve" vive aqui, sem cliente de base
// de dados e sem `revalidatePath`. As server actions em
// `src/app/actions/financial-periods.ts` fazem auth, chamam isto e escrevem.
//
// ---------------------------------------------------------------------------
// A semântica vem da 073, não desta camada
// ---------------------------------------------------------------------------
// `public.is_financial_period_open(company, year, month)` está aplicada em
// produção e é assim:
//
//     SELECT NOT EXISTS (
//       SELECT 1 FROM financial_periods
//        WHERE company_id = … AND year = … AND month = …
//          AND status = 'closed'
//     )
//
// Ou seja: **só `status = 'closed'` fecha**. Ausência de linha é aberto, e uma
// linha com `status = 'open'` também. Este módulo repete exactamente essa
// regra — se divergirem, a UI diz uma coisa e a base faz outra, e o utilizador
// fica a olhar para um botão que não corresponde ao que vai acontecer.
//
// Não se cria linha para representar "aberto". Um mês nasce aberto por
// ausência, e criar linhas só para dizer isso enchia a tabela de ruído e
// obrigava a distinguir "aberto explícito" de "aberto por omissão" em todo o
// código a jusante.
//
// ---------------------------------------------------------------------------
// Porque é que o período vem da data civil, e não de `new Date()`
// ---------------------------------------------------------------------------
// O processo corre em UTC na Vercel — não há `TZ` configurada, e isso está
// documentado no CLAUDE.md desde a auditoria de fuso de Julho. Uma despesa de
// `2026-08-31` é de Agosto para quem a lançou em Lisboa, e continuaria a ser
// Agosto mesmo que o servidor já estivesse em Setembro em UTC.
//
// Por isso `periodoDeDataCivil` lê ano e mês **dos caracteres da string**
// `YYYY-MM-DD`, sem nunca construir um `Date`. Um `new Date("2026-08-31")`
// seguido de `.getMonth()` é precisamente o padrão que desalinhou a Folha de
// Pagamento e o Registo de Ponto em Julho.
// ============================================================================

import { isValidIsoDateString } from "@/lib/utils";

export type EstadoPeriodo = "open" | "closed";

export type Periodo = { year: number; month: number };

/** Código único de recusa. A UI e os testes dependem deste literal. */
export const ERRO_PERIODO_FECHADO = "FINANCIAL_PERIOD_CLOSED" as const;

// ⚠️ Estas três constantes vivem aqui, e não em `src/app/actions/**`, por uma
//    razão do Next.js: um ficheiro `"use server"` **só pode exportar funções
//    async**. Exportá-las de uma action dá
//    «A "use server" file can only export async functions, found string» no
//    build — o mesmo erro que em Junho bloqueou todas as notificações do
//    calendário, quando `cancellations.ts` exportava `CANCEL_TYPE_LABELS`
//    (ver `src/lib/cancel-types.ts` e o registo no CLAUDE.md).

/** Acção registada em `audit_logs` quando um período é fechado. */
export const ACAO_PERIODO_FECHADO = "financial_period_closed" as const;

/** Acção registada em `audit_logs` quando um período é reaberto. */
export const ACAO_PERIODO_REABERTO = "financial_period_reopened" as const;

/**
 * Estado devolvido quando a folha de um mês fechado **não** foi materializada.
 * A UI usa-o para explicar porque é que não há registos novos, em vez de
 * mostrar uma folha vazia sem razão aparente.
 */
export const PAYROLL_PERIOD_CLOSED_NO_MATERIALIZATION =
  "PAYROLL_PERIOD_CLOSED_NO_MATERIALIZATION" as const;

/**
 * Estado de um período, tal como sai da leitura.
 *
 * `explicit` distingue "há uma linha na tabela" de "não há linha e portanto
 * está aberto". A UI não precisa da diferença para decidir o que mostrar, mas
 * é ela que permite dizer *quem* fechou e *quando* — e, ao reabrir, saber que
 * havia mesmo algo para reabrir.
 */
export type EstadoPeriodoLido = {
  status: EstadoPeriodo;
  explicit: boolean;
  closedAt: string | null;
  closedBy: string | null;
  reopenedAt: string | null;
  reopenReason: string | null;
};

/** O estado de um período sobre o qual não existe linha nenhuma. */
export const PERIODO_ABERTO_POR_AUSENCIA: EstadoPeriodoLido = Object.freeze({
  status: "open",
  explicit: false,
  closedAt: null,
  closedBy: null,
  reopenedAt: null,
  reopenReason: null,
});

// ─── Período a partir de uma data ────────────────────────────────────────────

/**
 * Ano/mês civis de uma data `YYYY-MM-DD`, por leitura de caracteres.
 *
 * 🔴 Nunca constrói um `Date`. Ver o cabeçalho: `new Date("2026-08-31")`
 *    interpreta a string como UTC, e num servidor a correr em UTC+1 isso pode
 *    dar 30 de Agosto — ou, no fim do mês, Setembro.
 */
export function periodoDeDataCivil(data: string): { ok: true; periodo: Periodo } | { ok: false; error: string } {
  if (!isValidIsoDateString(data)) {
    return { ok: false, error: "Data inválida." };
  }
  const year = Number(data.slice(0, 4));
  const month = Number(data.slice(5, 7));
  if (!Number.isInteger(year) || !Number.isInteger(month) || month < 1 || month > 12) {
    return { ok: false, error: "Data inválida." };
  }
  return { ok: true, periodo: { year, month } };
}

/** Valida um par ano/mês vindo de fora (selector da UI, argumento de action). */
export function validarPeriodo(entrada: { year: unknown; month: unknown }):
  | { ok: true; periodo: Periodo }
  | { ok: false; error: string } {
  const { year, month } = entrada;
  if (!Number.isInteger(year) || !Number.isInteger(month)) {
    return { ok: false, error: "Período inválido." };
  }
  const y = year as number;
  const m = month as number;
  // Limites largos de propósito: o objectivo é apanhar lixo (0, 20260, NaN),
  // não legislar sobre que anos a empresa pode ter tido.
  if (y < 2000 || y > 2100) return { ok: false, error: "Ano fora do intervalo suportado." };
  if (m < 1 || m > 12) return { ok: false, error: "Mês inválido." };
  return { ok: true, periodo: { year: y, month: m } };
}

export function mesmoPeriodo(a: Periodo, b: Periodo): boolean {
  return a.year === b.year && a.month === b.month;
}

const MESES_PT = [
  "janeiro", "fevereiro", "março", "abril", "maio", "junho",
  "julho", "agosto", "setembro", "outubro", "novembro", "dezembro",
];

/** "Agosto de 2026" — para mensagens de erro e para o cabeçalho. */
export function nomePeriodo({ year, month }: Periodo): string {
  const nome = MESES_PT[month - 1] ?? String(month);
  return `${nome.charAt(0).toUpperCase()}${nome.slice(1)} de ${year}`;
}

/** A mensagem única de recusa. Um só sítio, para não divergir entre actions. */
export function mensagemPeriodoFechado(periodo: Periodo): string {
  return `${nomePeriodo(periodo)} está fechado para alterações financeiras.`;
}

// ─── Interpretação da linha lida ─────────────────────────────────────────────

/**
 * Converte a linha de `financial_periods` (ou a sua ausência) em estado.
 *
 * 🔴 `null` significa "não há linha" e devolve **aberto**. Isto só é seguro
 *    porque quem chama distingue "não há linha" de "a leitura falhou" — uma
 *    leitura falhada nunca deve chegar aqui como `null`. Ver
 *    `assertFinancialPeriodOpen`, que falha fechado nesse caso.
 */
export function interpretarLinhaPeriodo(
  linha: {
    status?: unknown;
    closed_at?: unknown;
    closed_by?: unknown;
    reopened_at?: unknown;
    reopen_reason?: unknown;
  } | null,
): EstadoPeriodoLido {
  if (!linha) return { ...PERIODO_ABERTO_POR_AUSENCIA };

  // Qualquer valor que não seja exactamente 'closed' é aberto — a mesma regra
  // da 073. Um `status` inesperado (lixo, valor novo não previsto) não deve
  // fechar o mês por acidente; fechar é sempre um acto explícito.
  const fechado = linha.status === "closed";

  return {
    status: fechado ? "closed" : "open",
    explicit: true,
    closedAt: typeof linha.closed_at === "string" ? linha.closed_at : null,
    closedBy: typeof linha.closed_by === "string" ? linha.closed_by : null,
    reopenedAt: typeof linha.reopened_at === "string" ? linha.reopened_at : null,
    reopenReason: typeof linha.reopen_reason === "string" ? linha.reopen_reason : null,
  };
}

// ─── Motivo de reabertura ────────────────────────────────────────────────────

export const MIN_CARACTERES_MOTIVO = 3;

/**
 * O motivo é obrigatório e tem de ter conteúdo — `"   "` não serve.
 *
 * A base também o exige (`financial_periods_reopen_needs_reason`, na 071).
 * Validar aqui não é redundância inútil: dá a mensagem certa antes do pedido,
 * em vez de traduzir uma violação de CHECK depois. A garantia continua a ser
 * da base.
 */
export function validarMotivoReabertura(motivo: unknown):
  | { ok: true; motivo: string }
  | { ok: false; error: string } {
  if (typeof motivo !== "string") {
    return { ok: false, error: "Indique o motivo da reabertura." };
  }
  const limpo = motivo.trim();
  if (limpo.length === 0) {
    return { ok: false, error: "Indique o motivo da reabertura." };
  }
  if (limpo.length < MIN_CARACTERES_MOTIVO) {
    return {
      ok: false,
      error: `O motivo é demasiado curto — mínimo ${MIN_CARACTERES_MOTIVO} caracteres.`,
    };
  }
  return { ok: true, motivo: limpo };
}

// ─── Checklist ───────────────────────────────────────────────────────────────

export type GravidadeItem = "ok" | "warning" | "blocker";

export type ItemChecklist = {
  chave: string;
  rotulo: string;
  gravidade: GravidadeItem;
  /** Contagem, quando o item é contável. `null` quando não se aplica. */
  contagem: number | null;
  detalhe: string;
};

/**
 * 🔴 Regra conservadora, e deliberadamente conservadora.
 *
 * Só **falha de leitura** é bloqueante. Fechar um mês sem saber o que lá está
 * é o único caso em que a resposta certa é indiscutivelmente "não".
 *
 * Faturas em rascunho, despesas sem categoria, movimentos por conciliar e
 * pagamentos pendentes ficam **avisos**. São situações reais e vale a pena
 * mostrá-las — mas nenhuma delas foi aprovada por ninguém como política de
 * empresa que impede um fecho. Transformá-las em bloqueios seria inventar
 * regras de negócio a partir de código, e o resultado previsível é a gestora
 * não conseguir fechar Agosto por causa de três despesas sem categoria que
 * lhe são indiferentes.
 *
 * Se o dono decidir que alguma passa a bloquear, muda-se aqui.
 */
export function agregarChecklist(itens: ItemChecklist[]): {
  itens: ItemChecklist[];
  bloqueadores: ItemChecklist[];
  avisos: ItemChecklist[];
  podeFechar: boolean;
} {
  const bloqueadores = itens.filter((i) => i.gravidade === "blocker");
  const avisos = itens.filter((i) => i.gravidade === "warning");
  return { itens, bloqueadores, avisos, podeFechar: bloqueadores.length === 0 };
}

/** O item que representa "não consegui ler esta fonte". Sempre bloqueante. */
export function itemFalhaDeLeitura(chave: string, rotulo: string, detalhe: string): ItemChecklist {
  return {
    chave,
    rotulo,
    gravidade: "blocker",
    contagem: null,
    detalhe: detalhe || "Não foi possível ler esta informação.",
  };
}

/** Item contável: 0 é `ok`, qualquer número acima é aviso. */
export function itemContagem(
  chave: string,
  rotulo: string,
  contagem: number,
  detalheQuandoHa: string,
): ItemChecklist {
  return {
    chave,
    rotulo,
    gravidade: contagem > 0 ? "warning" : "ok",
    contagem,
    detalhe: contagem > 0 ? detalheQuandoHa : "Nada a assinalar.",
  };
}

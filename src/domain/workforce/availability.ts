// ============================================================================
// DISPONIBILIDADE — quatro estados, e um deles é "não sei"
// ============================================================================
//
// Regra pura, sem Supabase, sem React. Existe porque o motor de substituição
// só sabia dizer duas coisas — está na lista, não está na lista — e produzia
// a lista a partir de leituras cujo erro era indistinguível de ausência de
// dados:
//
//     const { data } = await admin.from("absences")...
//     const ausentes = new Set((data ?? []).map(...))
//
// Se aquela consulta falhasse, o conjunto de ausentes vinha vazio e **quem
// estava de férias aparecia como substituta disponível**. O mesmo com os
// serviços: falha na consulta, `conflictCount` a zero, e quem tinha o dia
// cheio aparecia livre.
//
// O erro não estava na pontuação. Estava em não haver forma de dizer
// "não consegui confirmar" — a única saída era parecer disponível.
//
// ---------------------------------------------------------------------------
// Os quatro estados
// ---------------------------------------------------------------------------
//
//   AVAILABLE    provado livre no período
//   CONFLICT     livre, mas já tem serviços marcados que se sobrepõem
//   UNAVAILABLE  provado indisponível — ausência, férias, inativa
//   UNKNOWN      alguma fonte necessária não respondeu
//
// `UNKNOWN` é o estado que faltava, e a sua única regra importante é
// negativa: **nunca colapsa para AVAILABLE**. Um sistema que não sabe e diz
// "disponível" é pior do que um sistema que não sabe e o admite, porque a
// pessoa que confia nele vai escalar alguém que não pode ir.
//
// ---------------------------------------------------------------------------
// Âmbito
// ---------------------------------------------------------------------------
// Isto não é o motor de disponibilidade da P5 — não conhece horários, nem
// sobreposição de intervalos, nem escalas. É a semântica mínima para que o
// motor atual deixe de mentir quando não sabe. A P5 constrói por cima; não
// substitui.
// ============================================================================

export const AVAILABILITY_STATES = [
  "available",
  "conflict",
  "unavailable",
  "unknown",
] as const;

export type AvailabilityState = (typeof AVAILABILITY_STATES)[number];

/**
 * As entradas da decisão. `null` significa **indeterminado** — a fonte não
 * respondeu — e é deliberadamente diferente de `false` ou de `0`.
 *
 * É esta distinção que o código antigo não tinha: `data ?? []` transformava
 * "não sei" em "não há", e `?? 0` transformava "não sei" em "nenhum".
 */
export interface AvailabilityInputs {
  /** A colaboradora está ativa? `null` se não se conseguiu determinar. */
  isActive: boolean | null;
  /** Tem ausência que cubra o período? `null` se a consulta de faltas falhou. */
  isAbsent: boolean | null;
  /** Serviços que se sobrepõem. `null` se a consulta de serviços ou de equipas falhou. */
  conflictCount: number | null;
}

/**
 * 🔴 A ordem importa. `unknown` é avaliado **primeiro**: não se pode concluir
 *    "disponível" a partir de um conjunto de factos incompleto, mesmo que os
 *    factos conhecidos sejam todos favoráveis.
 */
export function resolveAvailability(inputs: AvailabilityInputs): AvailabilityState {
  const { isActive, isAbsent, conflictCount } = inputs;

  if (isActive === null || isAbsent === null || conflictCount === null) {
    return "unknown";
  }
  if (!isActive) return "unavailable";
  if (isAbsent) return "unavailable";
  if (conflictCount > 0) return "conflict";
  return "available";
}

/**
 * Pode este estado entrar numa lista de sugestões?
 *
 * `conflict` entra — com o conflito à vista, para quem decide o pesar. O que
 * não entra é `unknown`: uma candidata cuja disponibilidade não se conseguiu
 * confirmar não pode ser proposta como substituta, nem sequer no fim da lista.
 * Aparecer numa lista de sugestões **é** uma afirmação de disponibilidade.
 */
export function isSuggestable(state: AvailabilityState): boolean {
  return state === "available" || state === "conflict";
}

/** Texto para quem lê. O estado é que decide; isto só explica. */
export const AVAILABILITY_LABEL: Record<AvailabilityState, string> = {
  available:   "Disponível",
  conflict:    "Disponível, com serviços marcados",
  unavailable: "Indisponível",
  unknown:     "Não foi possível confirmar a disponibilidade.",
};

// ─── Criticidade das fontes ──────────────────────────────────────────────────

/**
 * Uma fonte é **crítica** quando a sua falha pode fazer alguém parecer mais
 * disponível do que está. É a única pergunta que decide a classificação — não
 * é o quão central a tabela parece.
 *
 * `skills` é o contraste útil: perder as competências torna a *ordenação*
 * pior, mas ninguém passa a parecer livre por causa disso. Degrada, não mente.
 */
export const AVAILABILITY_SOURCES = {
  profiles:     "critical",
  absences:     "critical",
  team_members: "critical",
  services:     "critical",
  skills:       "optional",
} as const satisfies Record<string, "critical" | "optional">;

export type AvailabilitySource = keyof typeof AVAILABILITY_SOURCES;

export function isCriticalSource(source: AvailabilitySource): boolean {
  return AVAILABILITY_SOURCES[source] === "critical";
}

/**
 * Mensagem única para quando uma fonte crítica não respondeu.
 *
 * Distinta de "não há ninguém disponível" de propósito: são conclusões
 * opostas, e confundi-las é exatamente o defeito que esta ronda corrige.
 */
export const AVAILABILITY_UNCONFIRMED_MESSAGE =
  "Não foi possível confirmar a disponibilidade dos colaboradores. Tenta novamente.";

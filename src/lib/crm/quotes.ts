// ============================================================================
// CRM — o vocabulário dos orçamentos
// ============================================================================
//
// 🔴 Sem `"use server"`: são constantes. Ver a nota em `stages.ts`.
//
// Os valores coincidem à letra com os CHECK de `crm_quotes.status`,
// `crm_quotes.pricing_kind` e `crm_quote_items.unit` na migration 103.
// ============================================================================

export const QUOTE_STATUSES = [
  "rascunho",
  "enviado",
  "aceite",
  "recusado",
  "expirado",
  "anulado",
] as const;

export type QuoteStatus = (typeof QUOTE_STATUSES)[number];

export function isQuoteStatus(value: unknown): value is QuoteStatus {
  return typeof value === "string" && (QUOTE_STATUSES as readonly string[]).includes(value);
}

export const QUOTE_STATUS_LABELS: Record<QuoteStatus, string> = {
  rascunho: "Rascunho",
  enviado: "Enviado",
  aceite: "Aceite",
  recusado: "Recusado",
  expirado: "Expirado",
  anulado: "Anulado",
};

export const QUOTE_STATUS_COLORS: Record<QuoteStatus, string> = {
  rascunho: "slate",
  enviado: "blue",
  aceite: "green",
  recusado: "red",
  expirado: "amber",
  anulado: "slate",
};

/**
 * As transições permitidas — as mesmas que `set_crm_quote_status` impõe.
 *
 * Duplicadas aqui para a interface só oferecer o que vai passar. A autoridade
 * é a RPC: uma regra que viva só no ecrã é uma regra que o próximo caminho de
 * escrita ignora. `crm-quotes-status.test.ts` compara as duas listas.
 */
const TRANSICOES: Record<QuoteStatus, readonly QuoteStatus[]> = {
  rascunho: ["enviado", "anulado"],
  enviado: ["aceite", "recusado", "expirado", "anulado"],
  expirado: ["aceite", "recusado", "anulado"],
  recusado: ["anulado"],
  // 🔴 Terminais. Um aceite é a base de um acordo; um anulado acabou.
  aceite: [],
  anulado: [],
};

export function canTransitionQuote(from: QuoteStatus, to: QuoteStatus): boolean {
  return TRANSICOES[from].includes(to);
}

export function allowedQuoteTransitions(from: QuoteStatus): readonly QuoteStatus[] {
  return TRANSICOES[from];
}

/**
 * Um orçamento editável em cima, sem gerar revisão.
 *
 * Só o rascunho: nunca saiu de casa. Tudo o resto já foi visto por alguém de
 * fora, e mudá-lo em silêncio apagaria aquilo que essa pessoa recebeu.
 */
export function isEditableInPlace(status: QuoteStatus): boolean {
  return status === "rascunho";
}

/** Um orçamento que ainda pode ganhar uma revisão nova. */
export function isRevisable(status: QuoteStatus): boolean {
  return status === "enviado" || status === "recusado" || status === "expirado";
}

// ── Unidades das linhas ─────────────────────────────────────────────────────

export const QUOTE_UNITS = ["hora", "m2", "unidade", "mes", "servico"] as const;

export type QuoteUnit = (typeof QUOTE_UNITS)[number];

export const QUOTE_UNIT_LABELS: Record<QuoteUnit, string> = {
  hora: "hora",
  m2: "m²",
  unidade: "unidade",
  mes: "mês",
  servico: "serviço",
};

// ── Natureza do preço ───────────────────────────────────────────────────────

export const QUOTE_PRICING_KINDS = ["pontual", "mensal"] as const;

export type QuotePricingKind = (typeof QUOTE_PRICING_KINDS)[number];

export const QUOTE_PRICING_KIND_LABELS: Record<QuotePricingKind, string> = {
  pontual: "Trabalho pontual",
  mensal: "Avença mensal",
};

/**
 * Um orçamento fora de validade, sem ninguém lhe ter mexido.
 *
 * O estado `expirado` existe na base mas nada o escreve ainda — é derivado na
 * leitura. A migration 103 di-lo por escrito, para ninguém procurar o cron que
 * não existe.
 */
export function isExpired(status: QuoteStatus, validUntil: string, hoje: string): boolean {
  return status === "enviado" && validUntil < hoje;
}

/** Validade por omissão de um orçamento novo, em dias. */
export const QUOTE_DEFAULT_VALIDITY_DAYS = 30;

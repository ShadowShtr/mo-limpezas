// Timestamps no fuso Europe/Lisbon.
//
// O negócio é em Lisboa e o calendário desenha as horas em hora local do browser.
// Por isso os timestamps têm de ser gravados com o offset de Lisboa — nunca
// "naivos" (sem offset), que o PostgreSQL interpreta como UTC e desloca a hora
// ±1h (no verão), fazendo o serviço aparecer na hora errada no calendário.

const LISBON_TZ = "Europe/Lisbon";

/** Offset de Lisboa (ex.: "+01:00" no verão, "+00:00" no inverno) para uma data. */
export function lisbonOffset(dateStr: string): string {
  const midday = new Date(`${dateStr}T12:00:00Z`);
  const name = new Intl.DateTimeFormat("en-GB", {
    timeZone: LISBON_TZ,
    timeZoneName: "shortOffset",
  }).formatToParts(midday).find((p) => p.type === "timeZoneName")?.value ?? "GMT";
  const m = name.match(/GMT([+-])(\d+)(?::(\d+))?/);
  if (!m) return "+00:00";
  return `${m[1]}${m[2].padStart(2, "0")}:${(m[3] ?? "00").padStart(2, "0")}`;
}

/** Constrói um timestamp ISO com o offset de Lisboa para data + hora dadas. */
export function toLisbonTimestamp(dateStr: string, timeStr: string): string {
  return `${dateStr}T${timeStr}:00${lisbonOffset(dateStr)}`;
}

/**
 * Garante que um valor "YYYY-MM-DDTHH:MM[:SS]" sem offset fica com o offset de
 * Lisboa. Se já tiver fuso (Z ou ±hh:mm), devolve inalterado.
 */
export function ensureLisbonOffset(value: string): string {
  if (/(?:[zZ]|[+-]\d{2}:?\d{2})$/.test(value)) return value;
  return toLisbonTimestamp(value.slice(0, 10), value.slice(11, 16));
}

/**
 * Formata um timestamp ISO no fuso de Lisboa. Essencial em Server Components
 * (correm em UTC na Vercel): sem `timeZone` a hora apareceria 1h adiantada/
 * atrasada relativamente ao que o calendário (browser) mostra.
 */
export function fmtLisbon(iso: string, options: Intl.DateTimeFormatOptions): string {
  return new Date(iso).toLocaleString("pt-PT", { timeZone: LISBON_TZ, ...options });
}

/**
 * Data de "hoje" (YYYY-MM-DD) no fuso de Lisboa, não no fuso do servidor nem
 * em UTC. Evita o erro de `new Date().toISOString().slice(0,10)`, que na
 * primeira hora do dia em hora de verão (WEST, UTC+1) ainda devolve a data
 * de ontem.
 */
export function todayInLisbon(): string {
  return new Intl.DateTimeFormat("en-CA", { timeZone: LISBON_TZ }).format(new Date());
}

/**
 * Soma (ou subtrai) dias a uma data "YYYY-MM-DD" por aritmética de calendário
 * pura (Date.UTC), sem passar pelo fuso local do processo — evita o desvio de
 * ±1 dia que ocorre ao interpretar `${data}T00:00:00` como hora local de
 * Lisboa e depois formatar com `.toISOString()` (sempre UTC).
 */
export function addDaysToDateString(dateStr: string, days: number): string {
  const [y, m, d] = dateStr.split("-").map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d + days));
  return dt.toISOString().slice(0, 10);
}

/**
 * A data CIVIL de Lisboa (`YYYY-MM-DD`) de um instante.
 *
 * 🔴 Existe para não haver `iso.slice(0, 10)` sobre um `timestamptz`.
 *
 *    Esse atalho lê a data em UTC, não em Lisboa, e engana-se exactamente nas
 *    bordas que interessam a quem avisa sobre prazos: uma visita marcada para
 *    as 00h30 de dia 8 em Lisboa é, em hora de verão, `2026-07-07T23:30:00Z` —
 *    e o `slice` diz «dia 7». O aviso de hoje falava de ontem.
 *
 *    Mesma família de erro que `todayInLisbon()` resolve para o dia corrente.
 *    `en-CA` porque formata como `YYYY-MM-DD`, que é a forma que o resto do
 *    sistema compara como texto.
 */
export function lisbonDateOf(instant: string | Date): string {
  const d = instant instanceof Date ? instant : new Date(instant);
  return new Intl.DateTimeFormat("en-CA", { timeZone: LISBON_TZ }).format(d);
}

/**
 * O instante do início de um dia civil de Lisboa, com o offset correcto.
 *
 * Serve para recortar janelas sobre colunas `timestamptz` sem fazer aritmética
 * de fuso à mão: o limite inferior de «hoje» é `inicioDoDiaEmLisboa(hoje)` e o
 * superior, exclusivo, é o início do dia seguinte ao último que se quer.
 */
export function inicioDoDiaEmLisboa(dateStr: string): string {
  return toLisbonTimestamp(dateStr, "00:00");
}

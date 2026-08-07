/**
 * Entrada/saída partilhada pelas ferramentas offline da T08.
 *
 * Duas garantias, ambas estruturais e não por disciplina:
 *
 * 1. NUNCA LIGA A NADA. Não há cliente Supabase, não há `fetch`, não há
 *    leitura de `.env`. Estas ferramentas trabalham sobre um JSON exportado à
 *    mão e mais nada.
 *
 * 2. NUNCA COPIA CAMPOS QUE NÃO PEDIU. A leitura faz *pick* explícito dos
 *    campos técnicos. Se o snapshot exportado trouxer nomes, moradas, emails
 *    ou telefones, esses campos não chegam sequer a entrar em memória
 *    estruturada — e por isso não podem aparecer em relatório nenhum.
 */

import { readFileSync, writeFileSync } from "node:fs";

export function fail(message: string): never {
  console.error(`❌ ${message}`);
  process.exit(1);
}

export function readArg(argv: readonly string[], name: string): string | null {
  const withEquals = argv.find((a) => a.startsWith(`--${name}=`));
  if (withEquals) return withEquals.slice(name.length + 3);
  const index = argv.indexOf(`--${name}`);
  if (index >= 0 && index + 1 < argv.length) return argv[index + 1];
  return null;
}

export function hasFlag(argv: readonly string[], name: string): boolean {
  return argv.includes(`--${name}`);
}

/**
 * Recusa qualquer tentativa de escrita. As ferramentas da T08 são de
 * diagnóstico e planeamento; a execução real depende de schema que ainda não
 * existe e de uma base descartável que ainda não foi criada.
 *
 * Fail-closed de propósito: o modo de escrita não está implementado, por isso
 * ninguém o pode ligar por engano contra produção.
 */
export function assertNoWriteFlags(argv: readonly string[]): void {
  for (const flag of ["apply", "execute", "write", "commit", "force"]) {
    if (hasFlag(argv, flag)) {
      fail(
        `--${flag} não existe nesta ferramenta. A T08 só diagnostica e planeia; `
        + "a execução exige a base descartável e uma autorização separada.",
      );
    }
  }
}

export function readJsonInput(path: string | null): unknown {
  if (!path) fail("indique o ficheiro de entrada com --input <ficheiro.json>");
  try {
    return JSON.parse(readFileSync(path, "utf8"));
  } catch (error) {
    fail(`não foi possível ler ${path}: ${(error as Error).message}`);
  }
}

/** Escreve o relatório, ou imprime-o quando não há `--out`. */
export function emit(report: unknown, outPath: string | null): void {
  const json = `${JSON.stringify(report, null, 2)}\n`;
  if (outPath) {
    writeFileSync(outPath, json, "utf8");
    console.error(`✔ relatório gravado em ${outPath}`);
  } else {
    process.stdout.write(json);
  }
}

// ─── leitura defensiva ──────────────────────────────────────────────────────

function asRecord(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === "object" ? (value as Record<string, unknown>) : {};
}

export function str(value: unknown, fallback = ""): string {
  return typeof value === "string" ? value : fallback;
}

export function strOrNull(value: unknown): string | null {
  return typeof value === "string" ? value : null;
}

export function num(value: unknown, fallback: number): number {
  return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}

export function bool(value: unknown): boolean {
  return value === true;
}

export function numberArray(value: unknown): number[] | null {
  if (!Array.isArray(value)) return null;
  return value.filter((v): v is number => typeof v === "number");
}

export function stringArray(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.filter((v): v is string => typeof v === "string");
}

/** Campos técnicos de recorrência — e mais nenhum. */
export function pickContract(raw: unknown): {
  id: string; companyId: string; status: string;
  frequency: string; weekdays: number[] | null; intervalDays: number;
  startsOn: string; endsOn: string | null; excludedDates: string[];
} {
  const r = asRecord(raw);
  return {
    id: str(r.id ?? r.contract_id),
    companyId: str(r.companyId ?? r.company_id),
    status: str(r.status, "ativo"),
    frequency: str(r.frequency),
    weekdays: numberArray(r.weekdays),
    intervalDays: num(r.intervalDays ?? r.interval_days, 1),
    startsOn: str(r.startsOn ?? r.starts_on),
    endsOn: strOrNull(r.endsOn ?? r.ends_on),
    excludedDates: stringArray(r.excludedDates ?? r.excluded_dates),
  };
}

/**
 * Dia civil de Lisboa de um timestamp.
 *
 * Não usar `.slice(0, 10)` sobre o timestamp: isso lê o dia em UTC e, na hora
 * de verão, um serviço marcado para as 00:30 de Lisboa aparece no dia
 * anterior. É a mesma classe de defeito que a T07 corrigiu no motor; repeti-la
 * aqui corromperia o diagnóstico em silêncio.
 */
export function lisbonDateOf(timestamp: string): string {
  if (!timestamp) return "";
  const parsed = new Date(timestamp);
  if (Number.isNaN(parsed.getTime())) return "";
  return new Intl.DateTimeFormat("en-CA", { timeZone: "Europe/Lisbon" }).format(parsed);
}

/** Campos técnicos de um serviço — e mais nenhum. */
export function pickService(raw: unknown): {
  id: string; companyId: string; contractId: string | null;
  occurrenceDate: string | null; scheduledDate: string;
  status: string; isException: boolean; originalDate: string | null; createdAt: string;
} {
  const r = asRecord(raw);
  const scheduled = str(r.scheduledDate ?? r.scheduled_date)
    || lisbonDateOf(str(r.scheduled_start));
  return {
    id: str(r.id),
    companyId: str(r.companyId ?? r.company_id),
    contractId: strOrNull(r.contractId ?? r.contract_id),
    occurrenceDate: strOrNull(r.occurrenceDate ?? r.occurrence_date),
    scheduledDate: scheduled,
    status: str(r.status, "agendado"),
    isException: bool(r.isException ?? r.is_exception),
    originalDate: strOrNull(r.originalDate ?? r.original_date),
    createdAt: str(r.createdAt ?? r.created_at),
  };
}

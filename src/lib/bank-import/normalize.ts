// Normalização de extratos bancários.
// Converte linhas cruas (header → valor) em movimentos normalizados:
//  * datas → ISO yyyy-mm-dd
//  * valores → número decimal (lida com vírgula decimal pt-PT, milhares, sinais)
//  * direção entrada/saída (credit/debit)
//  * descrição normalizada
//
// Não depende de I/O — testável de forma isolada.

export type Direction = "credit" | "debit";

export interface NormalizedTransaction {
  transaction_date: string;        // ISO yyyy-mm-dd
  value_date: string | null;       // ISO yyyy-mm-dd
  description: string;
  counterparty_name: string | null;
  reference: string | null;
  amount: number;                  // valor absoluto (>= 0)
  direction: Direction;
  currency: string;
  raw_data: Record<string, string>;
}

/** Remove acentos e baixa para comparar cabeçalhos de coluna. */
export function deburr(s: string): string {
  return s
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .trim();
}

/** Normaliza descrição: colapsa espaços, remove ruído de espaçamento. */
export function normalizeDescription(s: string): string {
  return (s ?? "").replace(/\s+/g, " ").trim();
}

/**
 * Converte um valor textual de data para ISO (yyyy-mm-dd).
 * Aceita dd/mm/yyyy, dd-mm-yyyy, yyyy-mm-dd, dd.mm.yyyy e variantes com ano a 2 díg.
 * Devolve null se não conseguir interpretar.
 */
export function parseDate(value: unknown): string | null {
  if (value == null) return null;
  if (value instanceof Date && !isNaN(value.getTime())) {
    return toISO(value.getFullYear(), value.getMonth() + 1, value.getDate());
  }
  const raw = String(value).trim();
  if (!raw) return null;

  // ISO já formatado: yyyy-mm-dd (com hora opcional)
  let m = raw.match(/^(\d{4})-(\d{2})-(\d{2})/);
  if (m) return toISO(+m[1], +m[2], +m[3]);

  // dd/mm/yyyy | dd-mm-yyyy | dd.mm.yyyy (com ano 2 ou 4 dígitos)
  m = raw.match(/^(\d{1,2})[/.\-](\d{1,2})[/.\-](\d{2,4})/);
  if (m) {
    const d = +m[1];
    const mo = +m[2];
    let y = +m[3];
    if (y < 100) y += y < 70 ? 2000 : 1900;
    if (d > 31 || mo > 12) return null;
    return toISO(y, mo, d);
  }

  // Excel serial date (número de dias desde 1899-12-30)
  if (/^\d+(\.\d+)?$/.test(raw)) {
    const serial = parseFloat(raw);
    if (serial > 59 && serial < 60000) {
      const base = Date.UTC(1899, 11, 30);
      const dt = new Date(base + serial * 86400000);
      return toISO(dt.getUTCFullYear(), dt.getUTCMonth() + 1, dt.getUTCDate());
    }
  }

  const parsed = new Date(raw);
  if (!isNaN(parsed.getTime())) {
    return toISO(parsed.getFullYear(), parsed.getMonth() + 1, parsed.getDate());
  }
  return null;
}

function toISO(y: number, m: number, d: number): string | null {
  if (!y || !m || !d) return null;
  if (m < 1 || m > 12 || d < 1 || d > 31) return null;
  return `${y}-${String(m).padStart(2, "0")}-${String(d).padStart(2, "0")}`;
}

/**
 * Converte um valor textual monetário para número decimal.
 * Lida com:
 *  * vírgula decimal pt-PT ("1.234,56" → 1234.56)
 *  * ponto decimal en ("1,234.56" → 1234.56)
 *  * símbolos de moeda, espaços, NBSP
 *  * negativos por sinal "-" ou parênteses "(123,45)"
 * Devolve null se não for número.
 */
export function parseAmount(value: unknown): number | null {
  if (value == null) return null;
  if (typeof value === "number") return Number.isFinite(value) ? value : null;

  let s = String(value).trim();
  if (!s) return null;

  let negative = false;
  if (/^\(.*\)$/.test(s)) {
    negative = true;
    s = s.slice(1, -1);
  }

  // remove moeda, espaços, NBSP e tudo o que não for dígito/sinal/separador
  s = s.replace(/[^0-9.,\-+]/g, "").trim();
  if (!s) return null;
  if (s.startsWith("-")) negative = true;
  s = s.replace(/^[+\-]/, "");

  const lastComma = s.lastIndexOf(",");
  const lastDot = s.lastIndexOf(".");

  if (lastComma > -1 && lastDot > -1) {
    // o separador mais à direita é o decimal
    if (lastComma > lastDot) {
      // formato pt-PT: ponto = milhares, vírgula = decimal
      s = s.replace(/\./g, "").replace(",", ".");
    } else {
      // formato en: vírgula = milhares, ponto = decimal
      s = s.replace(/,/g, "");
    }
  } else if (lastComma > -1) {
    // só vírgula: assumir decimal se tiver 1-2 casas após a última vírgula
    const decimals = s.length - lastComma - 1;
    if (decimals <= 2) s = s.replace(/,/g, (_m, i) => (i === lastComma ? "." : ""));
    else s = s.replace(/,/g, "");
  }
  // só ponto, ou nenhum: já está utilizável

  const n = parseFloat(s);
  if (!Number.isFinite(n)) return null;
  return negative ? -n : n;
}

// ─── Mapeamento de colunas → campos ──────────────────────────────────────────

const HEADER_HINTS = {
  date: ["data movimento", "data mov", "data operacao", "data", "date", "transaction date", "booking date"],
  valueDate: ["data valor", "value date", "data-valor"],
  amount: ["valor", "montante", "amount", "importancia", "movimento"],
  debit: ["debito", "debit", "saida", "saidas", "withdrawal", "levantamento"],
  credit: ["credito", "credit", "entrada", "entradas", "deposit", "deposito"],
  description: ["descricao", "descritivo", "description", "designacao", "historico", "detalhe", "memo", "concept"],
  reference: ["referencia", "reference", "ref", "doc", "documento"],
  counterparty: ["beneficiario", "ordenante", "contraparte", "counterparty", "payee", "nome"],
  balance: ["saldo", "balance"],
};

type FieldKey = keyof typeof HEADER_HINTS;

/** Dado os cabeçalhos, devolve o índice da coluna que melhor corresponde a cada campo. */
function mapColumns(headers: string[]): Partial<Record<FieldKey, number>> {
  const norm = headers.map(deburr);
  const out: Partial<Record<FieldKey, number>> = {};
  for (const field of Object.keys(HEADER_HINTS) as FieldKey[]) {
    const hints = HEADER_HINTS[field];
    // correspondência exata primeiro, depois "contém"
    let idx = norm.findIndex((h) => hints.includes(h));
    if (idx === -1) idx = norm.findIndex((h) => hints.some((hint) => h.includes(hint)));
    if (idx !== -1) out[field] = idx;
  }
  return out;
}

export interface MapResult {
  transactions: NormalizedTransaction[];
  skipped: number;
}

/**
 * Converte cabeçalhos + linhas em movimentos normalizados.
 * Linhas sem data ou sem valor válido são ignoradas (contadas em `skipped`).
 */
export function mapRowsToTransactions(
  headers: string[],
  rows: string[][],
  currency = "EUR",
): MapResult {
  const cols = mapColumns(headers);
  const transactions: NormalizedTransaction[] = [];
  let skipped = 0;

  for (const row of rows) {
    const get = (k: FieldKey) => (cols[k] != null ? (row[cols[k]!] ?? "").trim() : "");

    const transaction_date = parseDate(get("date") || get("valueDate"));
    if (!transaction_date) { skipped++; continue; }

    let amount: number | null = null;
    let direction: Direction | null = null;

    if (cols.debit != null || cols.credit != null) {
      const debit = parseAmount(get("debit"));
      const credit = parseAmount(get("credit"));
      if (credit != null && credit !== 0) { amount = Math.abs(credit); direction = "credit"; }
      else if (debit != null && debit !== 0) { amount = Math.abs(debit); direction = "debit"; }
    }
    if (amount == null) {
      const v = parseAmount(get("amount"));
      if (v != null && v !== 0) { amount = Math.abs(v); direction = v >= 0 ? "credit" : "debit"; }
    }
    if (amount == null || direction == null) { skipped++; continue; }

    const raw_data: Record<string, string> = {};
    headers.forEach((h, i) => { if (h) raw_data[h] = (row[i] ?? "").toString(); });

    transactions.push({
      transaction_date,
      value_date: parseDate(get("valueDate")) ?? null,
      description: normalizeDescription(get("description")),
      counterparty_name: normalizeDescription(get("counterparty")) || null,
      reference: get("reference") || null,
      amount: Math.round(amount * 100) / 100,
      direction,
      currency,
      raw_data,
    });
  }

  return { transactions, skipped };
}

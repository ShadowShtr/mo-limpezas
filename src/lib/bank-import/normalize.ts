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

/** Remove acentos e baixa para comparar texto livre (descrições, cabeçalhos). */
export function deburr(s: string): string {
  return s
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .trim();
}

/** Normaliza um cabeçalho de coluna para comparação com HEADER_HINTS. */
export function normalizeHeader(s: string): string {
  return deburr(s).replace(/\s+/g, " ").trim();
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
export function parseBankDate(value: unknown): string | null {
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
 *  * negativos por sinal "-"/"-30,00-" ou parênteses "(123,45)"
 * Devolve null se não for número.
 */
export function parseMoney(value: unknown): number | null {
  if (value == null) return null;
  if (typeof value === "number") return Number.isFinite(value) ? value : null;

  let s = String(value).trim();
  if (!s) return null;

  let negative = false;
  if (/^\(.*\)$/.test(s)) {
    negative = true;
    s = s.slice(1, -1);
  }
  if (s.endsWith("-")) {
    negative = true;
    s = s.slice(0, -1).trim();
  }

  // remove moeda, espaços, NBSP e tudo o que não for dígito/sinal/separador
  s = s.replace(/[^0-9.,\-+]/g, "").trim();
  if (!s) return null;
  if (s.startsWith("-")) negative = true;
  s = s.replace(/^[+\-]/, "");
  if (!s) return null;

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

export const HEADER_HINTS = {
  date: ["data movimento", "data mov", "data operacao", "data", "date", "transaction date", "booking date"],
  valueDate: ["data valor", "value date", "data-valor"],
  amount: ["valor", "montante", "amount", "importancia"],
  debit: ["debito", "debit", "saida", "saidas", "withdrawal", "levantamento"],
  credit: ["credito", "credit", "entrada", "entradas", "deposit", "deposito"],
  description: ["descricao", "descritivo", "description", "designacao", "historico", "detalhe", "memo", "concept", "movimento"],
  reference: ["referencia", "reference", "ref", "doc", "documento"],
  counterparty: ["beneficiario", "ordenante", "contraparte", "counterparty", "payee", "nome"],
  balance: ["saldo", "balance"],
} as const;

export type FieldKey = keyof typeof HEADER_HINTS;

/**
 * Dado os cabeçalhos, devolve o índice da coluna que melhor corresponde a
 * cada campo. `override` permite forçar/corrigir a deteção automática
 * (mapeamento manual escolhido pelo utilizador na pré-visualização) — usar
 * `null` para "ignorar esta coluna" mesmo que tivesse sido auto-detetada.
 */
// Ordem de prioridade na deteção: campos com termos mais específicos primeiro,
// "amount" por último — os seus termos ("valor", "montante") são os mais
// genéricos e são substring de cabeçalhos de OUTROS campos (ex.: "Data valor"),
// por isso nunca pode reivindicar uma coluna já atribuída a outro campo.
const FIELD_PRIORITY: FieldKey[] = [
  "date", "valueDate", "debit", "credit", "description", "reference", "counterparty", "balance", "amount",
];

export function mapBankColumns(
  headers: string[],
  override?: Partial<Record<FieldKey, number | null>>,
): Partial<Record<FieldKey, number>> {
  const norm = headers.map(normalizeHeader);
  const out: Partial<Record<FieldKey, number>> = {};
  const claimed = new Set<number>();

  // Cada coluna só pode ser atribuída a UM campo — uma vez reivindicada
  // (mesmo por correspondência exata de outro campo), fica fora do alcance
  // dos restantes. Sem isto, um termo genérico como "valor" pode "roubar"
  // a coluna "Data valor" só porque a contém como substring.
  function claim(field: FieldKey, hints: readonly string[], exactOnly: boolean): void {
    if (out[field] != null) return;
    const idx = norm.findIndex((h, i) => !claimed.has(i) && hints.includes(h));
    if (idx !== -1) { out[field] = idx; claimed.add(idx); return; }
    if (exactOnly) return;
    const idxSub = norm.findIndex((h, i) => !claimed.has(i) && hints.some((hint) => h.includes(hint)));
    if (idxSub !== -1) { out[field] = idxSub; claimed.add(idxSub); }
  }

  // 1ª passagem: só correspondências exatas, por ordem de prioridade.
  for (const field of FIELD_PRIORITY) claim(field, HEADER_HINTS[field], true);
  // 2ª passagem: correspondência "contém", só em colunas ainda livres.
  for (const field of FIELD_PRIORITY) claim(field, HEADER_HINTS[field], false);

  if (override) {
    for (const field of Object.keys(override) as FieldKey[]) {
      const idx = override[field];
      if (idx == null) delete out[field];
      else out[field] = idx;
    }
  }
  return out;
}

export interface RowValid {
  status: "valid";
  index: number;
  raw: string[];
  debit: number | null;
  credit: number | null;
  tx: NormalizedTransaction;
}

export interface RowError {
  status: "error";
  index: number;
  raw: string[];
  reason: string;
  date: string | null;
  description: string;
  debit: number | null;
  credit: number | null;
}

export type MappedRow = RowValid | RowError;

export interface MapResult {
  rows: MappedRow[];
  validCount: number;
  errorCount: number;
}

/**
 * Converte cabeçalhos + linhas em movimentos normalizados, linha a linha,
 * com motivo de erro explícito quando uma linha não pode ser importada.
 * Nunca usa a coluna Saldo como valor do movimento.
 */
export function mapRowsToTransactions(
  headers: string[],
  rows: string[][],
  columns: Partial<Record<FieldKey, number>>,
  currency = "EUR",
): MapResult {
  const cols = columns;
  const out: MappedRow[] = [];
  let validCount = 0;
  let errorCount = 0;

  rows.forEach((row, index) => {
    const get = (k: FieldKey) => (cols[k] != null ? (row[cols[k]!] ?? "").trim() : "");
    const description = normalizeDescription(get("description"));
    const debit = cols.debit != null ? parseMoney(get("debit")) : null;
    const credit = cols.credit != null ? parseMoney(get("credit")) : null;

    const dateRaw = get("date") || get("valueDate");
    const transaction_date = parseBankDate(dateRaw);

    function fail(reason: string) {
      errorCount++;
      out.push({ status: "error", index, raw: row, reason, date: transaction_date, description, debit, credit });
    }

    if (!dateRaw) return fail("Sem data");
    if (!transaction_date) return fail(`Data inválida: "${dateRaw}"`);
    if (!description) return fail("Sem descrição");

    let amount: number | null = null;
    let direction: Direction | null = null;

    if (cols.debit != null || cols.credit != null) {
      if (credit != null && credit !== 0) { amount = Math.abs(credit); direction = "credit"; }
      else if (debit != null && debit !== 0) { amount = Math.abs(debit); direction = "debit"; }
    }
    if (amount == null) {
      const v = cols.amount != null ? parseMoney(get("amount")) : null;
      if (v != null && v !== 0) { amount = Math.abs(v); direction = v >= 0 ? "credit" : "debit"; }
    }

    if (amount == null || direction == null) {
      const hadAnyValue = get("debit") || get("credit") || get("amount");
      return fail(hadAnyValue ? "Valor zero, não importado" : "Sem valor de movimento (débito/crédito/valor em branco)");
    }

    const raw_data: Record<string, string> = {};
    headers.forEach((h, i) => { if (h) raw_data[h] = (row[i] ?? "").toString(); });

    const tx: NormalizedTransaction = {
      transaction_date,
      value_date: parseBankDate(get("valueDate")) ?? null,
      description,
      counterparty_name: normalizeDescription(get("counterparty")) || null,
      reference: get("reference") || null,
      amount: Math.round(amount * 100) / 100,
      direction,
      currency,
      raw_data,
    };
    validCount++;
    out.push({ status: "valid", index, raw: row, debit, credit, tx });
  });

  return { rows: out, validCount, errorCount };
}

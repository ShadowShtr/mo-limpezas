// ============================================================================
// Formatação financeira — uma só, para toda a aplicação
// ============================================================================
//
// Havia treze cópias de `fmtEur` espalhadas pelas vistas. Eram idênticas, o que
// só significa que ainda não tinham divergido: a décima quarta é que ia estar
// errada, e ninguém saberia qual das treze era a boa.
//
// Formato pt-PT, sempre o mesmo:
//
//     23 624,16 €      não  €23,624   nem  23.624 €   nem  23 624€
//
// O símbolo vem **depois**, com espaço, como se escreve em Portugal.
// ============================================================================

/**
 * Um valor em euros.
 *
 * `null`/`undefined` devolvem `"—"`, nunca `"0,00 €"`. É a mesma regra que
 * atravessa este módulo: ausência de dado não é ausência de valor, e um zero
 * inventado num painel financeiro lê-se como uma afirmação sobre o dinheiro.
 */
export function fmtEur(v: number | null | undefined): string {
  if (v === null || v === undefined || Number.isNaN(v)) return "—";
  return v.toLocaleString("pt-PT", { minimumFractionDigits: 2, maximumFractionDigits: 2 }) + " €";
}

/** Compacto, para caber em barras e legendas: `23,6k €`. */
export function fmtEurCompact(v: number | null | undefined): string {
  if (v === null || v === undefined || Number.isNaN(v)) return "—";
  if (Math.abs(v) >= 1000) {
    return (v / 1000).toLocaleString("pt-PT", { maximumFractionDigits: 1 }) + "k €";
  }
  return fmtEur(v);
}

/**
 * Uma percentagem já em pontos percentuais (`91.5` → `"91,5%"`).
 *
 * Não recebe fracções: `0.915` formataria como `0,9%`, e essa confusão entre
 * fracção e pontos percentuais é das que passa despercebida numa revisão e
 * aparece em produção.
 */
export function fmtPct(v: number | null | undefined, casas = 1): string {
  if (v === null || v === undefined || Number.isNaN(v)) return "—";
  return v.toLocaleString("pt-PT", { minimumFractionDigits: casas, maximumFractionDigits: casas }) + "%";
}

/** Um inteiro simples, com separador de milhares. */
export function fmtNum(v: number | null | undefined): string {
  if (v === null || v === undefined || Number.isNaN(v)) return "—";
  return v.toLocaleString("pt-PT", { maximumFractionDigits: 0 });
}

/**
 * Uma data ISO (`YYYY-MM-DD`), **sempre com ano**.
 *
 * 🔴 O ano não é opcional. `03 mai.` é igual para 2026 e para 2027, e foi
 * precisamente essa ambiguidade que escondeu quatro vencimentos trimestrais
 * esmagados numa data só. Ver
 * `docs/incidents/2026-08-11-pagamentos-materializacao-implicita.md`.
 */
export function fmtDataCurta(iso: string | null | undefined): string {
  if (!iso) return "—";
  const d = new Date(iso + "T00:00:00");
  if (Number.isNaN(d.getTime())) return "—";
  return d.toLocaleDateString("pt-PT", { day: "2-digit", month: "short", year: "numeric" });
}

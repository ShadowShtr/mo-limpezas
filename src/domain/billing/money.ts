// ============================================================================
// T11 — Dinheiro em cêntimos inteiros
// ============================================================================
//
// 🚨 INTEGRIDADE DE DADOS FINANCEIROS
// Este módulo é puro. Não lê a base, não escreve, não conhece o Supabase.
// Nenhuma função aqui altera dados persistidos.
//
// ----------------------------------------------------------------------------
//
// Porquê cêntimos inteiros.
//
// O repositório inteiro representa dinheiro em euros com vírgula flutuante e
// corrige no fim com `Math.round(x * 100) / 100` ou `.toFixed(2)`. Isso funciona
// para um valor isolado e falha para somas e divisões:
//
//   0.1 + 0.2                      → 0.30000000000000004
//   (100 / 3) arredondado × 3      → 99.99  (falta 1 cêntimo)
//   59.985 → toFixed(2)            → "59.98" em vez de "59.99" (o binário mais
//                                     próximo de 59.985 é ligeiramente menor)
//
// O terceiro caso é o mais traiçoeiro: `toFixed` não arredonda o número decimal
// que se lê no código, arredonda o binário que a máquina guardou. Por isso a
// política de arredondamento desta task (ver `roundHalfUp`) é aplicada uma vez,
// à entrada, e a partir daí toda a aritmética é inteira e exata.
//
// Um inteiro em cêntimos cobre ±9 007 199 254 740 991 cêntimos
// (~90 mil biliões de euros) sem perder precisão. Não há risco prático de
// estouro para esta empresa, mas `assertMoneyCents` verifica-o na mesma.

/**
 * Dinheiro em cêntimos inteiros. É um `number`, não um `bigint`: mantém-se
 * serializável em JSON e comparável com o resto do código sem conversões.
 *
 * A marca de tipo (`__brand`) existe só em tempo de compilação — impede passar
 * euros onde se esperam cêntimos sem qualquer custo em runtime.
 */
export type MoneyCents = number & { readonly __brand: "MoneyCents" };

/** Zero canónico. */
export const ZERO_CENTS = 0 as MoneyCents;

/**
 * Política de arredondamento única da T11: **half-up sobre o valor decimal**.
 *
 * Escolhida por ser a que reproduz o comportamento actual seguro. O código
 * existente usa `Math.round(x * 100) / 100`, e `Math.round` em JavaScript é
 * half-up para positivos (0.5 → 1). A diferença está nos negativos, onde
 * `Math.round(-0.5)` dá `-0` (half-up), e nós usamos half-away-from-zero para
 * que um estorno de -0,005 € arredonde para -0,01 € em vez de 0.
 *
 * O `Number.EPSILON` compensa o caso `59.985`: sem ele, o binário guardado fica
 * abaixo do ponto médio e arredonda para baixo, contra a intuição de quem
 * escreveu o valor. A correcção é relativa à magnitude, por isso não distorce
 * valores grandes.
 */
function roundHalfUp(value: number): number {
  if (!Number.isFinite(value)) return NaN;
  const sign = value < 0 ? -1 : 1;
  const abs = Math.abs(value);
  return sign * Math.round(abs + Math.abs(abs) * Number.EPSILON);
}

/** `true` se o valor é um montante em cêntimos válido (inteiro e finito). */
export function isMoneyCents(value: unknown): value is MoneyCents {
  return typeof value === "number" && Number.isSafeInteger(value);
}

/**
 * Valida e marca um inteiro como cêntimos. Lança se não for seguro — um
 * montante inválido a propagar-se em silêncio é pior do que uma falha ruidosa.
 */
export function assertMoneyCents(value: number, label = "montante"): MoneyCents {
  if (!isMoneyCents(value)) {
    throw new RangeError(`${label}: ${value} não é um valor em cêntimos válido (inteiro seguro).`);
  }
  return value as MoneyCents;
}

/**
 * Converte euros (o que está persistido hoje, `numeric(10,2)`) em cêntimos.
 *
 * `null`/`undefined` devolvem `null` de propósito: ver `NULL ≠ ZERO` no
 * documento da T11. "Não há base para calcular" não é "custa zero euros".
 */
export function eurosToCents(value: number | null | undefined): MoneyCents | null {
  if (value == null) return null;
  if (!Number.isFinite(value)) return null;
  const cents = roundHalfUp(value * 100);
  return assertMoneyCents(cents, "eurosToCents");
}

/**
 * Converte cêntimos em euros, para apresentação e para escrever nas colunas
 * `numeric(10,2)` existentes. Nunca usar o resultado em nova aritmética.
 */
export function centsToEuros(cents: MoneyCents | null): number | null {
  if (cents == null) return null;
  return cents / 100;
}

/** Soma exacta. Sem `reduce` sobre floats, sem arredondamento intermédio. */
export function sumCents(values: readonly MoneyCents[]): MoneyCents {
  let total = 0;
  for (const v of values) total += v;
  return assertMoneyCents(total, "sumCents");
}

/** Subtracção que preserva o sinal (usada por `outstanding`). */
export function subtractCents(a: MoneyCents, b: MoneyCents): MoneyCents {
  return assertMoneyCents(a - b, "subtractCents");
}

/**
 * Multiplica um montante por uma fracção e arredonda uma única vez.
 * Usado pelo IVA e por qualquer percentagem futura.
 */
export function multiplyCents(cents: MoneyCents, factor: number): MoneyCents {
  if (!Number.isFinite(factor)) {
    throw new RangeError(`multiplyCents: fator inválido (${factor}).`);
  }
  return assertMoneyCents(roundHalfUp(cents * factor), "multiplyCents");
}

/** Formata para leitura humana em pt-PT. Só apresentação. */
export function formatCents(cents: MoneyCents | null, currency = "€"): string {
  if (cents == null) return "—";
  const euros = (cents / 100).toFixed(2).replace(".", ",");
  return `${euros} ${currency}`;
}

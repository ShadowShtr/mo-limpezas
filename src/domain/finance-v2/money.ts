// ============================================================================
// Validação de valores monetários
// ============================================================================
//
// 🔴 Módulo puro, e **fora de qualquer ficheiro `"use server"`**.
//
// Duas razões, e as duas foram aprendidas à força:
//
//  1. num módulo `"use server"` cada export vira um endpoint RPC, e o Next
//     recusa exportar funções síncronas — foi o que partiu o build quando o
//     `construirContexto` lá estava;
//
//  2. um validador que não se consegue importar só se pode "testar" por
//     inspecção do texto do ficheiro. E foi exactamente isso que deixou passar
//     o erro descrito abaixo: o teste confirmava que a linha existia, não que
//     ela funcionava.
// ============================================================================

/**
 * Um valor em euros com, no máximo, dois decimais.
 *
 * ---------------------------------------------------------------------------
 * 🔴 Porque é que a comparação exacta não serve
 * ---------------------------------------------------------------------------
 * A primeira versão desta função rejeitava dinheiro perfeitamente normal:
 *
 *     0.29  × 100  →    28.999999999999996
 *     10.12 × 100  →  1011.9999999999999
 *     19.99 × 100  →  1998.9999999999998
 *     1.10  × 100  →   110.00000000000001
 *
 * `Math.round(v * 100) !== v * 100` dava verdade em todos, e a avença de
 * 19,99 € era recusada com «só pode ter dois decimais» — uma mensagem que não
 * ajudava ninguém, porque o valor tinha mesmo dois decimais.
 *
 * A causa é o binário: 0,29 não tem representação exacta em vírgula
 * flutuante, e multiplicar por 100 não corrige isso. A comparação certa é com
 * tolerância, e o valor devolvido é **normalizado a cêntimos** para não
 * guardar o ruído na base.
 */
export type ResultadoValor =
  | { ok: true; valor: number | null }
  | { ok: false; error: string };

/** Tolerância. Um valor a menos de um milionésimo de cêntimo do inteiro é o inteiro. */
const EPSILON_CENTIMOS = 1e-6;

export function validarValorMonetario(
  valor: number | null | undefined,
  opcoes: { permitirNegativo?: boolean; nome?: string } = {},
): ResultadoValor {
  const nome = opcoes.nome ?? "O valor";

  // `null` e `undefined` significam a mesma coisa: por preencher. Não se
  // converte para zero, que seria uma afirmação sobre o dinheiro.
  if (valor === null || valor === undefined) return { ok: true, valor: null };

  if (typeof valor !== "number" || !Number.isFinite(valor)) {
    return { ok: false, error: `${nome} tem de ser um número.` };
  }

  if (!opcoes.permitirNegativo && valor < 0) {
    return { ok: false, error: `${nome} não pode ser negativo.` };
  }

  const centimos = valor * 100;
  const arredondado = Math.round(centimos);
  if (Math.abs(centimos - arredondado) > EPSILON_CENTIMOS) {
    return { ok: false, error: `${nome} só pode ter dois decimais.` };
  }

  // Normalizado: guarda-se 0,29 e não 0,28999999999999998.
  return { ok: true, valor: arredondado / 100 };
}

/**
 * Converte para cêntimos inteiros, de forma segura.
 *
 * Útil para somar dinheiro sem acumular erro: somar cêntimos inteiros e
 * dividir uma vez no fim é exacto, somar floats não é.
 */
export function paraCentimos(valor: number): number {
  return Math.round(valor * 100);
}

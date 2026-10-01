// ============================================================================
// Recorrência dos fixos — as regras de calendário, sem base nem rede
// ============================================================================
//
// A geração em si vive na base (`generate_recurring_payments_atomic`, 107).
// Aqui fica só o que o runtime precisa de decidir ANTES de a chamar: que
// janela de meses pedir, e como dizer a periodicidade a quem lê.
//
// As chaves de mês são AAAAMM, as mesmas da 090 e da 107.
// ============================================================================

/** As periodicidades que a 107 aceita — e só estas. */
export const INTERVALOS_RECORRENCIA = [1, 2, 3, 6, 12] as const;
export type IntervaloRecorrencia = (typeof INTERVALOS_RECORRENCIA)[number];

export const ROTULO_INTERVALO: Record<IntervaloRecorrencia, string> = {
  1: "Mensal",
  2: "Bimestral",
  3: "Trimestral",
  6: "Semestral",
  12: "Anual",
};

export function isIntervaloRecorrencia(valor: unknown): valor is IntervaloRecorrencia {
  return typeof valor === "number" && (INTERVALOS_RECORRENCIA as readonly number[]).includes(valor);
}

/** Quantos meses à frente ficam sempre gerados. Decisão do dono, 2026-10-01. */
export const MESES_A_FRENTE = 4;

/**
 * 🔴 Nada é gerado antes de Novembro de 2026. Outubro estava a ser lançado à
 *    mão quando a recorrência voltou, e fica como está. A 107 impõe o mesmo
 *    piso do lado da base; repeti-lo aqui só evita pedir o que vai ser negado.
 */
export const PISO_GERACAO = 202611;

export const chaveMes = (ano: number, mes: number): number => ano * 100 + mes;

export function somarMeses(chave: number, meses: number): number {
  const indice = Math.floor(chave / 100) * 12 + (chave % 100) - 1 + meses;
  return Math.floor(indice / 12) * 100 + (indice % 12) + 1;
}

/**
 * A janela a gerar, a partir de «hoje» em Lisboa (AAAA-MM-DD).
 *
 * Do mês SEGUINTE ao corrente até `MESES_A_FRENTE` meses depois. O mês
 * corrente nunca entra: é de quem o está a preencher, e quando chega a ser
 * corrente já foi gerado há quatro meses.
 */
export function janelaDeGeracao(hoje: string): { de: number; ate: number } {
  const corrente = chaveMes(Number(hoje.slice(0, 4)), Number(hoje.slice(5, 7)));
  return {
    de: Math.max(somarMeses(corrente, 1), PISO_GERACAO),
    ate: somarMeses(corrente, MESES_A_FRENTE),
  };
}

/** A chave do mês corrente — o limite de «parar de repetir». */
export function chaveCorrente(hoje: string): number {
  return chaveMes(Number(hoje.slice(0, 4)), Number(hoje.slice(5, 7)));
}

// Horizontes de geração e reconciliação (Task T09).
//
// Antes desta consolidação havia TRÊS janelas diferentes, cada uma escrita à
// mão no seu ficheiro, sem nada que as relacionasse:
//
// | Onde | Janela | Consequência |
// |---|---|---|
// | criação/atualização do contrato | 3 meses a partir da âncora | gera até ao mês +2 |
// | cron mensal | só o mês seguinte | gera 1 mês de cada vez |
// | reconciliação | 6 meses a partir de hoje | apagava o que os outros dois não previam |
//
// A janela de reconciliação ser maior do que a de criação é o que torna a
// diferença visível: a reconciliação olhava para seis meses, via ocorrências
// que a criação nunca chegou a gerar e serviços que o cron ainda não tinha
// criado, e decidia sobre eles.
//
// Os valores aqui mantêm o comportamento atual — mudá-los altera o que é
// gerado em produção e não é decisão desta task. O que muda é passarem a
// estar num sítio só, nomeados e explicados.

/** Meses gerados de uma vez ao criar ou atualizar um contrato. */
export const CREATION_HORIZON_MONTHS = 3;

/**
 * Meses que a reconciliação examina.
 *
 * Maior do que o de criação de propósito: tem de cobrir o que o cron mensal
 * já foi acrescentando desde a última alteração do contrato.
 */
export const RECONCILIATION_HORIZON_MONTHS = 6;

/** O cron mensal trata de um mês de cada vez. */
export const CRON_HORIZON_MONTHS = 1;

/**
 * Meses que os previews mostram (formulário de contratos).
 * Não gera nada — só afeta o que a pessoa vê.
 */
export const PREVIEW_OCCURRENCES = 12;

/**
 * Invariante da política: a reconciliação nunca pode ser mais curta do que a
 * criação, senão apagaria ocorrências acabadas de gerar.
 */
export function horizonsAreCoherent(): boolean {
  return RECONCILIATION_HORIZON_MONTHS >= CREATION_HORIZON_MONTHS
    && CREATION_HORIZON_MONTHS >= CRON_HORIZON_MONTHS;
}

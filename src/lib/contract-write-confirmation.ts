import { scheduleDaysEqual } from "./schedule-days";

// Confirmação pós-gravação de um contrato (read-after-write).
//
// `updateContrato` relê a linha que acabou de gravar e compara-a com o que
// enviou: se um trigger, uma constraint ou outra sessão mudou o valor pelo
// caminho, quem está a editar fica a saber em vez de ver "sucesso" com outro
// valor na base (Auditoria F, Falha 5). Essa proteção mantém-se.
//
// O que estava errado era a comparação, não a proteção. Os dois lados eram
// montados à mão em dois objetos separados, e bastava um normalizador
// esquecido de um dos lados para inventar uma divergência. Aqui há um único
// mapa de campo → normalizador, aplicado aos dois lados — a simetria passa a
// ser estrutural em vez de depender de quem edita a lista.

/** Normaliza para número, preservando "não preenchido" como `null`. */
const num = (v: unknown): number | null => (v == null ? null : Number(v));
/** `undefined` e `null` são a mesma ausência para efeitos de confirmação. */
const nulo = (v: unknown): unknown => v ?? null;
/** A base grava `false`, o formulário pode omitir. */
const bool = (v: unknown): unknown => v ?? false;

/**
 * Campos confirmados um a um. Não inclui `schedule_days`: esse é JSONB e tem
 * comparação própria (ver `schedule-days.ts`).
 */
const CAMPOS: Record<string, (v: unknown) => unknown> = {
  fixed_price: num,
  fixed_monthly: bool,
  apply_vat: bool,
  cleaning_type: nulo,
  payment_status: nulo,
  upholstery_type: nulo,
  upholstery_notes: nulo,
  upholstery_units: num,
  upholstery_unit_price: num,
  num_people: num,
  status: (v) => v,
};

export const CONTRACT_CONFIRMED_FIELDS = [...Object.keys(CAMPOS), "schedule_days"] as const;

/**
 * Campos em que o valor gravado não corresponde ao enviado. Lista vazia = a
 * gravação corresponde ao pedido e a execução pode seguir para a
 * reconciliação dos serviços.
 */
export function contractWriteDivergences(
  intended: Record<string, unknown>,
  persisted: Record<string, unknown>,
): string[] {
  const divergentes = Object.entries(CAMPOS)
    .filter(([campo, normalizar]) => !Object.is(normalizar(intended[campo]), normalizar(persisted[campo])))
    .map(([campo]) => campo);

  if (!scheduleDaysEqual(intended.schedule_days, persisted.schedule_days)) {
    divergentes.push("schedule_days");
  }
  return divergentes;
}

/**
 * Mensagem mostrada quando a confirmação falha.
 *
 * Não diz "nada foi considerado gravado": nesta arquitetura o `UPDATE` do
 * contrato já foi executado quando esta verificação corre, e prometer uma
 * reversão que não existe manda a pessoa procurar um estado antigo que a base
 * já não tem. O que é verdade é que o valor gravado não é o esperado e que a
 * página está desatualizada.
 */
export function contractWriteMismatchMessage(divergentes: string[]): string {
  return `A alteração gravada não correspondeu ao valor esperado (campos divergentes: ${divergentes.join(", ")}). Atualize a página antes de tentar novamente.`;
}

// Regra de ouro anti-undefined→null (Causa 4 da auditoria de reversões).
//
// Um formulário que carrega MENOS colunas do que aquelas que grava manda
// `undefined` nesses campos ao gravar — e um `campo: input.campo ?? null`
// converte isso em "apagar o valor real" na base. Foi o que aconteceu com
// type/notes de clientes e fixed_price/fixed_monthly/apply_vat de contratos
// (ver cliente-sheet-fields.ts / contrato-sheet-fields.ts). Esta é a segunda
// linha de defesa: mesmo que uma query nova volte a esquecer uma coluna,
// gravar fica bloqueado em vez de apagar silenciosamente.
//
// Convenção: `undefined` = campo não carregado → BLOQUEAR.
//            `null` = o utilizador apagou de propósito → permitido.
export const CRITICAL_FIELDS = {
  clients: ["type", "notes", "vat_exempt", "status"],
  contracts: [
    "fixed_price", "fixed_monthly", "apply_vat", "schedule_days",
    "starts_on", "ends_on", "status", "num_people",
    "upholstery_units", "upholstery_unit_price",
  ],
  locations: [
    "hourly_rate", "fixed_price", "pricing_type", "access_code",
    "instructions", "has_key", "key_label",
  ],
  services: [
    "scheduled_start", "scheduled_end", "team_id", "manual_value",
    "calculated_value", "hourly_rate", "apply_vat", "num_people",
    "is_exception",
  ],
} as const;

export type CriticalFieldsTable = keyof typeof CRITICAL_FIELDS;

export const CRITICAL_FIELDS_BLOCKED_MESSAGE =
  "Não foi possível carregar todos os dados necessários. Guardar agora poderia apagar informações. Atualize a página e tente novamente.";

/**
 * Bloqueia gravações que poderiam apagar campos críticos.
 *
 * - Sem `requireAll` (patch updates, ex.: actions do painel do serviço que só
 *   gravam os campos que leram): bloqueia campos PRESENTES com `undefined`.
 * - Com `requireAll: true` (updates COMPLETOS: updateCliente/updateContrato/
 *   updateLocation, que gravam a linha inteira): além disso, TODOS os campos
 *   críticos têm de EXISTIR no payload. Um campo totalmente ausente num update
 *   completo significa "formulário não carregou esta coluna" — e o
 *   `campo: input.campo ?? null` a jusante apagaria o valor real (foi assim
 *   que se perderam type/notes de clientes e o valor da avença).
 *
 * undefined = "não carregado" (bloquear); null = "apagado de propósito" (ok).
 */
export function assertCriticalFieldsLoaded(
  table: CriticalFieldsTable,
  payload: Record<string, unknown>,
  opts?: { requireAll?: boolean },
): { ok: true } | { ok: false; missing: string[] } {
  const fields = CRITICAL_FIELDS[table] as readonly string[];
  const missing = fields.filter((f) =>
    opts?.requireAll
      ? !(f in payload) || payload[f] === undefined
      : f in payload && payload[f] === undefined,
  );
  return missing.length ? { ok: false, missing } : { ok: true };
}

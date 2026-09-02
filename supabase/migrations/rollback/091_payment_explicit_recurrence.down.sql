-- Rollback 091 — só schema/rotina da recorrência explícita.
--
-- Antes de executar manualmente, confirmar que nenhuma linha tem
-- recurrence_state = 'CONFIGURED'. Se existir, remover as colunas apagaria
-- configuração introduzida depois da migration e o rollback deve recusar.

DO $guard$
BEGIN
  IF EXISTS (
    SELECT 1
    FROM public.fixed_variable_payments
    WHERE recurrence_interval_months IS NOT NULL
       OR recurrence_anchor_date IS NOT NULL
  ) THEN
    RAISE EXCEPTION 'PAYMENT_RECURRENCE_089_ROLLBACK_CONFIGURED_DATA_PRESENT';
  END IF;
END;
$guard$;

DROP FUNCTION IF EXISTS public.prepare_recurring_payments_month_atomic(uuid, integer, integer, uuid);
DROP INDEX IF EXISTS public.fixed_variable_payments_recurrence_period_unique;
ALTER TABLE public.fixed_variable_payments
  DROP CONSTRAINT IF EXISTS fixed_variable_payments_recurrence_pair,
  DROP CONSTRAINT IF EXISTS fixed_variable_payments_recurrence_interval_valid,
  DROP COLUMN IF EXISTS recurrence_state,
  DROP COLUMN IF EXISTS recurrence_anchor_date,
  DROP COLUMN IF EXISTS recurrence_interval_months;

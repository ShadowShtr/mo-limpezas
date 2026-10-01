-- Rollback da 107.
--
-- Remove a capacidade de recorrência. NÃO apaga nenhum pagamento: as linhas
-- que a recorrência já gerou ficam em `fixed_variable_payments` como fixos
-- normais — perdem apenas a ligação ao molde (`recurrence_id`). Nenhum anexo
-- é tocado.
--
-- Antes de correr: parar o cron `/api/cron/generate-recurring-payments`
-- (vercel.json), senão ele passa a falhar todos os dias com «função não
-- existe» — inofensivo, mas ruidoso.

BEGIN;

DROP FUNCTION IF EXISTS public.stop_payment_recurrence_atomic(uuid, uuid, integer, uuid);
DROP FUNCTION IF EXISTS public.create_recurring_payment_atomic(uuid, text, numeric, date, integer, integer, smallint, uuid, boolean, text, uuid);
DROP FUNCTION IF EXISTS public.make_payment_recurring_atomic(uuid, uuid, smallint, uuid);
DROP FUNCTION IF EXISTS public.generate_recurring_payments_atomic(uuid, integer, integer, uuid);
DROP FUNCTION IF EXISTS public.payment_recurrence_due_date(integer, smallint);
DROP FUNCTION IF EXISTS public.payment_period_key_add(integer, integer);

DROP INDEX IF EXISTS public.uq_fvp_recurrence_period;
ALTER TABLE public.fixed_variable_payments DROP COLUMN IF EXISTS recurrence_id;

DROP TABLE IF EXISTS public.payment_recurrences;

COMMIT;

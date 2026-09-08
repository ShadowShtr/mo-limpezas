BEGIN;
DROP FUNCTION IF EXISTS public.mark_payroll_paid_atomic(uuid, uuid[], date, uuid);
DROP FUNCTION IF EXISTS public.approve_payroll_records_atomic(uuid, uuid[], uuid);
DROP FUNCTION IF EXISTS public.adjust_payroll_record_atomic(uuid, uuid, jsonb, uuid);
DROP FUNCTION IF EXISTS public.upsert_payroll_records_atomic(uuid, integer, integer, jsonb, uuid);
DROP FUNCTION IF EXISTS public.assert_payroll_actor(uuid, uuid);
COMMIT;

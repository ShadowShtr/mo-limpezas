-- ROLLBACK 088 — restaura a definição da 082.
-- Este rollback é apenas para ensaio/revisão; não deve ser executado em
-- produção sem autorização explícita. O runner controla a transação.
CREATE OR REPLACE FUNCTION public.update_payment_atomic(
  p_company_id uuid,
  p_payment_id uuid,
  p_patch jsonb
)
RETURNS TABLE (payment_id uuid, valor_alterou boolean)
LANGUAGE plpgsql
SECURITY INVOKER
AS $fn$
DECLARE
  v_pag public.fixed_variable_payments%ROWTYPE;
  v_mov uuid;
  v_proibidas text[];
  v_novo_valor numeric;
  v_muda_valor boolean := false;
  v_venc date;
  v_ano integer;
  v_mes integer;
BEGIN
  SELECT array_agg(k) INTO v_proibidas FROM jsonb_object_keys(p_patch) AS k
   WHERE k NOT IN ('description', 'amount', 'due_date', 'expense_category_id', 'direct_debit', 'notes');
  IF v_proibidas IS NOT NULL THEN
    RAISE EXCEPTION 'PAYMENT_FIELD_NOT_EDITABLE: %', array_to_string(v_proibidas, ', ')
      USING ERRCODE = 'check_violation';
  END IF;
  SELECT * INTO v_pag FROM public.fixed_variable_payments
   WHERE id = p_payment_id AND company_id = p_company_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'PAYMENT_NOT_FOUND' USING ERRCODE = 'no_data_found'; END IF;
  IF p_patch ? 'amount' THEN
    v_novo_valor := (p_patch->>'amount')::numeric;
    IF v_novo_valor IS NOT NULL AND v_novo_valor < 0 THEN
      RAISE EXCEPTION 'PAYMENT_AMOUNT_INVALID' USING ERRCODE = 'check_violation';
    END IF;
    v_muda_valor := v_novo_valor IS DISTINCT FROM v_pag.amount;
  END IF;
  IF v_muda_valor THEN
    IF v_pag.status = 'pago' THEN RAISE EXCEPTION 'PAYMENT_ALREADY_PAID' USING ERRCODE = 'object_not_in_prerequisite_state'; END IF;
    SELECT c.id INTO v_mov FROM public.cash_flow_entries c
     WHERE c.company_id = p_company_id AND c.reference_type = 'fixed_variable_payment'
       AND c.reference_id = p_payment_id LIMIT 1;
    IF v_mov IS NOT NULL THEN RAISE EXCEPTION 'PAYMENT_LINKED_TO_CASHFLOW' USING ERRCODE = 'object_not_in_prerequisite_state'; END IF;
  END IF;
  v_ano := v_pag.period_year; v_mes := v_pag.period_month;
  IF (p_patch ? 'due_date') AND (p_patch->>'due_date') IS NOT NULL THEN
    v_venc := (p_patch->>'due_date')::date;
    v_ano := EXTRACT(YEAR FROM v_venc)::integer; v_mes := EXTRACT(MONTH FROM v_venc)::integer;
  END IF;
  UPDATE public.fixed_variable_payments SET
    description = CASE WHEN p_patch ? 'description' THEN p_patch->>'description' ELSE description END,
    amount = CASE WHEN p_patch ? 'amount' THEN (p_patch->>'amount')::numeric ELSE amount END,
    due_date = CASE WHEN p_patch ? 'due_date' THEN (p_patch->>'due_date')::date ELSE due_date END,
    expense_category_id = CASE WHEN p_patch ? 'expense_category_id' THEN (p_patch->>'expense_category_id')::uuid ELSE expense_category_id END,
    direct_debit = CASE WHEN p_patch ? 'direct_debit' THEN (p_patch->>'direct_debit')::boolean ELSE direct_debit END,
    notes = CASE WHEN p_patch ? 'notes' THEN p_patch->>'notes' ELSE notes END,
    period_year = v_ano, period_month = v_mes, updated_at = now()
   WHERE id = p_payment_id AND company_id = p_company_id;
  RETURN QUERY SELECT p_payment_id, v_muda_valor;
END;
$fn$;

REVOKE EXECUTE ON FUNCTION public.update_payment_atomic(uuid, uuid, jsonb) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.update_payment_atomic(uuid, uuid, jsonb) TO service_role;

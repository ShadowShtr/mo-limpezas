-- GERADO de supabase/migrations/082_atomic_finance_mutations.sql por scripts/gen-093-fixture.mjs. Nao editar a mao.
-- As RPCs de fluxo de caixa COMO ESTAO EM PRODUCAO (guarda de periodo so na
-- server action, uma viagem antes). E sobre estas que a 093 actua.

CREATE OR REPLACE FUNCTION public.lock_cashflow_for_manual_mutation(
  p_company_id uuid,
  p_entry_id   uuid
)
RETURNS public.cash_flow_entries
LANGUAGE plpgsql
SECURITY INVOKER
AS $fn$
DECLARE
  v_mov  public.cash_flow_entries%ROWTYPE;
  v_conc int;
BEGIN
  SELECT * INTO v_mov
    FROM public.cash_flow_entries
   WHERE id = p_entry_id AND company_id = p_company_id
   FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'CASHFLOW_NOT_FOUND' USING ERRCODE = 'no_data_found';
  END IF;

  -- Um movimento com origem é gerido por essa origem, não à mão.
  IF v_mov.reference_type IS NOT NULL THEN
    RAISE EXCEPTION 'CASHFLOW_MANAGED_BY_ORIGIN'
      USING ERRCODE = 'object_not_in_prerequisite_state';
  END IF;

  SELECT count(*) INTO v_conc
    FROM public.bank_reconciliation_matches m
   WHERE m.cash_flow_entry_id = p_entry_id
     AND m.status = 'confirmed';

  IF v_conc > 0 THEN
    RAISE EXCEPTION 'CASHFLOW_RECONCILED'
      USING ERRCODE = 'object_not_in_prerequisite_state';
  END IF;

  RETURN v_mov;
END;
$fn$;

CREATE OR REPLACE FUNCTION public.update_cashflow_entry_atomic(
  p_company_id uuid,
  p_entry_id   uuid,
  p_patch      jsonb
)
RETURNS TABLE (entry_id uuid)
LANGUAGE plpgsql
SECURITY INVOKER
AS $fn$
DECLARE
  v_mov       public.cash_flow_entries%ROWTYPE;
  v_proibidas text[];
BEGIN
  v_mov := public.lock_cashflow_for_manual_mutation(p_company_id, p_entry_id);

  SELECT array_agg(k) INTO v_proibidas
    FROM jsonb_object_keys(p_patch) AS k
   WHERE k NOT IN ('type', 'amount', 'description', 'category', 'date',
                   'status', 'expense_category_id', 'notes');

  IF v_proibidas IS NOT NULL THEN
    RAISE EXCEPTION 'CASHFLOW_FIELD_NOT_EDITABLE: %', array_to_string(v_proibidas, ', ')
      USING ERRCODE = 'check_violation';
  END IF;

  UPDATE public.cash_flow_entries c
     SET type        = COALESCE(p_patch->>'type', c.type),
         amount      = COALESCE((p_patch->>'amount')::numeric, c.amount),
         description = COALESCE(p_patch->>'description', c.description),
         category    = CASE WHEN p_patch ? 'category'
                            THEN p_patch->>'category' ELSE c.category END,
         date        = COALESCE((p_patch->>'date')::date, c.date),
         status      = COALESCE(p_patch->>'status', c.status),
         expense_category_id = CASE WHEN p_patch ? 'expense_category_id'
                                   THEN (p_patch->>'expense_category_id')::uuid
                                   ELSE c.expense_category_id END,
         notes       = CASE WHEN p_patch ? 'notes'
                            THEN p_patch->>'notes' ELSE c.notes END
   WHERE c.id = p_entry_id;

  RETURN QUERY SELECT p_entry_id;
END;
$fn$;

CREATE OR REPLACE FUNCTION public.delete_cashflow_entry_atomic(
  p_company_id uuid,
  p_entry_id   uuid
)
RETURNS TABLE (entry_id uuid, apagados int)
LANGUAGE plpgsql
SECURITY INVOKER
AS $fn$
DECLARE
  v_mov      public.cash_flow_entries%ROWTYPE;
  v_apagados int;
BEGIN
  v_mov := public.lock_cashflow_for_manual_mutation(p_company_id, p_entry_id);

  DELETE FROM public.cash_flow_entries WHERE id = p_entry_id;
  GET DIAGNOSTICS v_apagados = ROW_COUNT;

  RETURN QUERY SELECT p_entry_id, v_apagados;
END;
$fn$;

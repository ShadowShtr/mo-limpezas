-- PAYROLL-SAFETY-01 candidate — estado, locks e efeitos económicos atómicos.
-- Requer 071 e 073. Número de migration ainda não atribuído. DB-first.
BEGIN;

DO $$
BEGIN
  IF to_regclass('public.payroll_records') IS NULL
     OR to_regclass('public.cash_flow_entries') IS NULL
     OR to_regclass('public.financial_periods') IS NULL
     OR to_regclass('public.audit_logs') IS NULL
     OR to_regprocedure('public.is_financial_period_open(uuid,integer,integer)') IS NULL
     OR to_regprocedure('public.assert_financial_period_open_locked(uuid,integer,integer)') IS NULL THEN
    RAISE EXCEPTION 'PAYROLL_SAFETY_PREREQUISITES_MISSING';
  END IF;
END $$;

CREATE OR REPLACE FUNCTION public.assert_payroll_actor(
  p_company_id uuid, p_actor uuid
) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
BEGIN
  IF p_actor IS NULL OR NOT EXISTS (
    SELECT 1 FROM profiles
     WHERE id = p_actor AND company_id = p_company_id AND role IN ('admin', 'gestor')
  ) THEN
    RAISE EXCEPTION 'PAYROLL_ACTOR_NOT_AUTHORIZED' USING ERRCODE = '42501';
  END IF;
END;
$$;

CREATE OR REPLACE FUNCTION public.upsert_payroll_records_atomic(
  p_company_id uuid, p_period_year integer, p_period_month integer,
  p_records jsonb, p_actor uuid DEFAULT NULL
) RETURNS TABLE (written_count integer, preserved_count integer)
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_record jsonb;
  v_existing public.payroll_records%ROWTYPE;
  v_written integer := 0;
  v_changed integer;
  v_preserved integer := 0;
  v_collaborator uuid;
BEGIN
  PERFORM public.assert_payroll_actor(p_company_id, p_actor);
  PERFORM public.assert_financial_period_open_locked(p_company_id, p_period_year, p_period_month);
  IF jsonb_typeof(p_records) <> 'array' THEN RAISE EXCEPTION 'PAYROLL_RECORDS_MUST_BE_ARRAY' USING ERRCODE = '22023'; END IF;

  FOR v_record IN SELECT value FROM jsonb_array_elements(p_records) ORDER BY value->>'collaborator_id' LOOP
    v_collaborator := NULLIF(v_record->>'collaborator_id', '')::uuid;
    IF NOT EXISTS (SELECT 1 FROM profiles p WHERE p.id = v_collaborator AND p.company_id = p_company_id) THEN
      RAISE EXCEPTION 'PAYROLL_COLLABORATOR_COMPANY_MISMATCH' USING ERRCODE = '42501';
    END IF;
    SELECT * INTO v_existing FROM payroll_records
      WHERE company_id = p_company_id AND collaborator_id = v_collaborator
        AND period_year = p_period_year AND period_month = p_period_month FOR UPDATE;
    IF FOUND AND v_existing.status IN ('aprovado', 'pago') THEN
      v_preserved := v_preserved + 1;
      CONTINUE;
    END IF;
    IF FOUND AND v_existing.status <> 'rascunho' THEN RAISE EXCEPTION 'PAYROLL_UNKNOWN_STATUS' USING ERRCODE = '22023'; END IF;
    IF (v_record->>'net_salary') IS NULL OR (v_record->>'net_salary')::numeric <> (v_record->>'net_salary')::numeric
       OR abs((v_record->>'net_salary')::numeric) > 100000000 THEN
      RAISE EXCEPTION 'PAYROLL_INVALID_TOTAL' USING ERRCODE = '22023';
    END IF;
    INSERT INTO payroll_records (
      company_id, collaborator_id, period_year, period_month, contracted_hours,
      worked_hours, overtime_hours, absence_hours, days_worked, hourly_rate,
      gross_salary, meal_allowance, overtime_bonus, absence_deductions,
      other_additions, other_deductions, net_salary, notes, status, paid_at
    ) VALUES (
      p_company_id, v_collaborator, p_period_year, p_period_month,
      (v_record->>'contracted_hours')::numeric, (v_record->>'worked_hours')::numeric,
      (v_record->>'overtime_hours')::numeric, (v_record->>'absence_hours')::numeric,
      (v_record->>'days_worked')::integer, (v_record->>'hourly_rate')::numeric,
      (v_record->>'gross_salary')::numeric, (v_record->>'meal_allowance')::numeric,
      (v_record->>'overtime_bonus')::numeric, (v_record->>'absence_deductions')::numeric,
      (v_record->>'other_additions')::numeric, (v_record->>'other_deductions')::numeric,
      (v_record->>'net_salary')::numeric, v_record->>'notes', 'rascunho', NULL
    )
    ON CONFLICT (company_id, collaborator_id, period_year, period_month) DO UPDATE SET
      contracted_hours = EXCLUDED.contracted_hours, worked_hours = EXCLUDED.worked_hours,
      overtime_hours = EXCLUDED.overtime_hours, absence_hours = EXCLUDED.absence_hours,
      days_worked = EXCLUDED.days_worked, hourly_rate = EXCLUDED.hourly_rate,
      gross_salary = EXCLUDED.gross_salary, meal_allowance = EXCLUDED.meal_allowance,
      overtime_bonus = EXCLUDED.overtime_bonus, absence_deductions = EXCLUDED.absence_deductions,
      other_additions = EXCLUDED.other_additions, other_deductions = EXCLUDED.other_deductions,
      net_salary = EXCLUDED.net_salary, notes = EXCLUDED.notes, updated_at = now()
      WHERE payroll_records.status = 'rascunho';
    GET DIAGNOSTICS v_changed = ROW_COUNT;
    v_written := v_written + v_changed;
  END LOOP;
  IF p_actor IS NOT NULL THEN
    INSERT INTO audit_logs(company_id, actor_id, action, entity_type, meta)
    VALUES (p_company_id, p_actor, 'payroll_recalculated', 'payroll', jsonb_build_object('period_year', p_period_year, 'period_month', p_period_month, 'written_count', v_written));
  END IF;
  RETURN QUERY SELECT v_written, v_preserved;
END;
$$;

CREATE OR REPLACE FUNCTION public.adjust_payroll_record_atomic(
  p_company_id uuid, p_record_id uuid, p_patch jsonb, p_actor uuid
) RETURNS TABLE (record_id uuid, net_salary numeric)
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_row public.payroll_records%ROWTYPE;
  v_period record;
  v_net numeric;
BEGIN
  PERFORM public.assert_payroll_actor(p_company_id, p_actor);
  SELECT period_year, period_month INTO v_period FROM payroll_records WHERE id = p_record_id AND company_id = p_company_id;
  IF NOT FOUND THEN RAISE EXCEPTION 'PAYROLL_RECORD_NOT_FOUND' USING ERRCODE = 'P0002'; END IF;
  PERFORM public.assert_financial_period_open_locked(p_company_id, v_period.period_year, v_period.period_month);
  SELECT * INTO v_row FROM payroll_records WHERE id = p_record_id AND company_id = p_company_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'PAYROLL_RECORD_NOT_FOUND' USING ERRCODE = 'P0002'; END IF;
  IF v_row.status <> 'rascunho' THEN RAISE EXCEPTION 'PAYROLL_MUTATION_NOT_ALLOWED' USING ERRCODE = '55000'; END IF;
  IF p_patch ?| ARRAY['status','paid_at','approved_by','company_id','collaborator_id','period_year','period_month'] THEN
    RAISE EXCEPTION 'PAYROLL_PATCH_FORBIDDEN' USING ERRCODE = '42501';
  END IF;
  v_net := COALESCE((p_patch->>'net_salary')::numeric, v_row.net_salary);
  IF v_net <> v_net OR abs(v_net) > 100000000 THEN RAISE EXCEPTION 'PAYROLL_INVALID_TOTAL' USING ERRCODE = '22023'; END IF;
  UPDATE payroll_records SET
    worked_hours = COALESCE((p_patch->>'worked_hours')::numeric, worked_hours),
    overtime_hours = COALESCE((p_patch->>'overtime_hours')::numeric, overtime_hours),
    absence_hours = COALESCE((p_patch->>'absence_hours')::numeric, absence_hours),
    days_worked = COALESCE((p_patch->>'days_worked')::integer, days_worked),
    hourly_rate = COALESCE((p_patch->>'hourly_rate')::numeric, hourly_rate),
    gross_salary = COALESCE((p_patch->>'gross_salary')::numeric, gross_salary),
    meal_allowance = COALESCE((p_patch->>'meal_allowance')::numeric, meal_allowance),
    overtime_bonus = COALESCE((p_patch->>'overtime_bonus')::numeric, overtime_bonus),
    absence_deductions = COALESCE((p_patch->>'absence_deductions')::numeric, absence_deductions),
    other_additions = COALESCE((p_patch->>'other_additions')::numeric, other_additions),
    other_deductions = COALESCE((p_patch->>'other_deductions')::numeric, other_deductions),
    net_salary = v_net, notes = CASE WHEN p_patch ? 'notes' THEN p_patch->>'notes' ELSE notes END,
    updated_at = now()
  WHERE id = p_record_id AND company_id = p_company_id AND status = 'rascunho';
  IF NOT FOUND THEN RAISE EXCEPTION 'PAYROLL_CONCURRENT_STATE_CHANGE' USING ERRCODE = '40001'; END IF;
  INSERT INTO audit_logs(company_id, actor_id, action, entity_type, entity_id, meta)
  VALUES (p_company_id, p_actor, 'payroll_adjusted', 'payroll', p_record_id::text,
    jsonb_build_object('before', to_jsonb(v_row), 'after', (SELECT to_jsonb(pr) FROM payroll_records pr WHERE pr.id = p_record_id)));
  RETURN QUERY SELECT p_record_id, v_net;
END;
$$;

CREATE OR REPLACE FUNCTION public.approve_payroll_records_atomic(
  p_company_id uuid, p_record_ids uuid[], p_actor uuid
) RETURNS TABLE (approved_count integer, already_approved_count integer)
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_id uuid; v_row public.payroll_records%ROWTYPE; v_period record; v_approved integer := 0; v_already integer := 0;
BEGIN
  PERFORM public.assert_payroll_actor(p_company_id, p_actor);
  IF p_record_ids IS NULL OR cardinality(p_record_ids) = 0 THEN RETURN QUERY SELECT 0, 0; RETURN; END IF;
  FOR v_period IN
    SELECT DISTINCT period_year, period_month FROM payroll_records
     WHERE company_id = p_company_id AND id = ANY(p_record_ids)
     ORDER BY period_year, period_month
  LOOP
    PERFORM public.assert_financial_period_open_locked(p_company_id, v_period.period_year, v_period.period_month);
  END LOOP;
  FOR v_id IN SELECT DISTINCT x FROM unnest(p_record_ids) x ORDER BY x LOOP
    SELECT * INTO v_row FROM payroll_records WHERE id = v_id AND company_id = p_company_id FOR UPDATE;
    IF NOT FOUND THEN RAISE EXCEPTION 'PAYROLL_RECORD_NOT_FOUND' USING ERRCODE = 'P0002'; END IF;
    IF v_row.status = 'aprovado' THEN v_already := v_already + 1;
    ELSIF v_row.status = 'rascunho' THEN NULL;
    ELSE RAISE EXCEPTION 'PAYROLL_APPROVAL_NOT_ALLOWED' USING ERRCODE = '55000'; END IF;
  END LOOP;
  FOR v_id IN SELECT DISTINCT x FROM unnest(p_record_ids) x ORDER BY x LOOP
    UPDATE payroll_records SET status = 'aprovado', approved_by = p_actor, updated_at = now()
      WHERE id = v_id AND company_id = p_company_id AND status = 'rascunho';
    IF FOUND THEN v_approved := v_approved + 1; END IF;
  END LOOP;
  IF v_approved > 0 THEN
    INSERT INTO audit_logs(company_id, actor_id, action, entity_type, meta)
    VALUES (p_company_id, p_actor, 'payroll_approved', 'payroll', jsonb_build_object('count', v_approved));
  END IF;
  RETURN QUERY SELECT v_approved, v_already;
END;
$$;

CREATE OR REPLACE FUNCTION public.mark_payroll_paid_atomic(
  p_company_id uuid, p_record_ids uuid[], p_paid_on date, p_actor uuid
) RETURNS TABLE (paid_count integer, already_paid_count integer, cash_entry_count integer)
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_id uuid; v_row public.payroll_records%ROWTYPE; v_period record; v_cash public.cash_flow_entries%ROWTYPE;
  v_paid integer := 0; v_already integer := 0; v_cash_count integer := 0; v_cash_id uuid;
BEGIN
  PERFORM public.assert_payroll_actor(p_company_id, p_actor);
  IF p_record_ids IS NULL OR cardinality(p_record_ids) = 0 THEN RETURN QUERY SELECT 0, 0, 0; RETURN; END IF;
  FOR v_period IN
    SELECT DISTINCT period_year, period_month FROM payroll_records
     WHERE company_id = p_company_id AND id = ANY(p_record_ids)
     ORDER BY period_year, period_month
  LOOP
    PERFORM public.assert_financial_period_open_locked(p_company_id, v_period.period_year, v_period.period_month);
  END LOOP;
  FOR v_id IN SELECT DISTINCT x FROM unnest(p_record_ids) x ORDER BY x LOOP
    SELECT * INTO v_row FROM payroll_records WHERE id = v_id AND company_id = p_company_id FOR UPDATE;
    IF NOT FOUND THEN RAISE EXCEPTION 'PAYROLL_RECORD_NOT_FOUND' USING ERRCODE = 'P0002'; END IF;
    IF v_row.status NOT IN ('aprovado', 'pago') THEN RAISE EXCEPTION 'PAYROLL_NOT_APPROVED' USING ERRCODE = '55000'; END IF;
    IF v_row.net_salary IS NULL OR v_row.net_salary <= 0 OR v_row.net_salary <> v_row.net_salary OR abs(v_row.net_salary) > 100000000 THEN
      RAISE EXCEPTION 'PAYROLL_INVALID_TOTAL' USING ERRCODE = '22023';
    END IF;
    SELECT * INTO v_cash FROM cash_flow_entries WHERE company_id = p_company_id AND reference_type = 'payroll' AND reference_id = v_id::text FOR UPDATE;
    IF FOUND AND (v_cash.amount <> v_row.net_salary OR v_cash.type <> 'saida' OR v_cash.category <> 'salario' OR v_cash.status <> 'confirmado') THEN
      RAISE EXCEPTION 'PAYROLL_CASHFLOW_CONFLICT' USING ERRCODE = '23514';
    END IF;
    IF v_row.status = 'pago' AND NOT FOUND THEN RAISE EXCEPTION 'PAYROLL_PAID_CASHFLOW_MISSING' USING ERRCODE = '23514'; END IF;
  END LOOP;
  FOR v_id IN SELECT DISTINCT x FROM unnest(p_record_ids) x ORDER BY x LOOP
    SELECT * INTO v_row FROM payroll_records WHERE id = v_id AND company_id = p_company_id FOR UPDATE;
    SELECT id INTO v_cash_id FROM cash_flow_entries WHERE company_id = p_company_id AND reference_type = 'payroll' AND reference_id = v_id::text FOR UPDATE;
    IF v_cash_id IS NULL THEN
      INSERT INTO cash_flow_entries(company_id, type, amount, description, category, date, reference_id, reference_type, status)
      VALUES (p_company_id, 'saida', v_row.net_salary, 'Salario - ' || v_row.collaborator_id::text, 'salario', p_paid_on, v_id::text, 'payroll', 'confirmado')
      ON CONFLICT (company_id, reference_type, reference_id)
        WHERE reference_type IS NOT NULL AND reference_id IS NOT NULL DO NOTHING
      RETURNING id INTO v_cash_id;
      IF v_cash_id IS NOT NULL THEN v_cash_count := v_cash_count + 1; END IF;
    END IF;
    IF v_row.status = 'aprovado' THEN
      UPDATE payroll_records SET status = 'pago', paid_at = COALESCE(paid_at, p_paid_on::timestamptz), updated_at = now()
        WHERE id = v_id AND company_id = p_company_id AND status = 'aprovado';
      IF NOT FOUND THEN RAISE EXCEPTION 'PAYROLL_CONCURRENT_STATE_CHANGE' USING ERRCODE = '40001'; END IF;
      v_paid := v_paid + 1;
    ELSE v_already := v_already + 1;
    END IF;
  END LOOP;
  IF v_paid > 0 THEN
    INSERT INTO audit_logs(company_id, actor_id, action, entity_type, meta)
    VALUES (p_company_id, p_actor, 'payroll_paid', 'payroll', jsonb_build_object('paid_count', v_paid, 'cash_entry_count', v_cash_count));
  END IF;
  RETURN QUERY SELECT v_paid, v_already, v_cash_count;
END;
$$;

REVOKE ALL ON FUNCTION public.assert_payroll_actor(uuid, uuid) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.upsert_payroll_records_atomic(uuid, integer, integer, jsonb, uuid) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.adjust_payroll_record_atomic(uuid, uuid, jsonb, uuid) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.approve_payroll_records_atomic(uuid, uuid[], uuid) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.mark_payroll_paid_atomic(uuid, uuid[], date, uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.upsert_payroll_records_atomic(uuid, integer, integer, jsonb, uuid) TO service_role;
GRANT EXECUTE ON FUNCTION public.adjust_payroll_record_atomic(uuid, uuid, jsonb, uuid) TO service_role;
GRANT EXECUTE ON FUNCTION public.approve_payroll_records_atomic(uuid, uuid[], uuid) TO service_role;
GRANT EXECUTE ON FUNCTION public.mark_payroll_paid_atomic(uuid, uuid[], date, uuid) TO service_role;

COMMIT;

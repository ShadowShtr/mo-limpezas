-- PAYROLL-SAFETY-01 candidate. DB-first: migration number not assigned.
-- Requires the production schema and the canonical 090 period-lock protocol.

DO $$
DECLARE
  v_reference_type text;
  v_reference_index boolean;
BEGIN
  IF to_regclass('public.profiles') IS NULL
     OR to_regclass('public.payroll_records') IS NULL
     OR to_regclass('public.cash_flow_entries') IS NULL
     OR to_regclass('public.financial_periods') IS NULL
     OR to_regprocedure('public.assert_financial_periods_open_locked_many(uuid,integer[])') IS NULL
  THEN
    RAISE EXCEPTION 'PAYROLL_SAFETY_PREREQUISITES_MISSING';
  END IF;

  SELECT format_type(a.atttypid, a.atttypmod)
    INTO v_reference_type
    FROM pg_attribute a
   WHERE a.attrelid = 'public.cash_flow_entries'::regclass
     AND a.attname = 'reference_id'
     AND a.attnum > 0
     AND NOT a.attisdropped;

  SELECT EXISTS (
    SELECT 1
      FROM pg_indexes
     WHERE schemaname = 'public'
       AND tablename = 'cash_flow_entries'
       AND indexdef ILIKE '%CREATE UNIQUE INDEX%'
       AND indexdef ILIKE '%company_id, reference_type, reference_id%'
       AND indexdef ILIKE '%reference_type IS NOT NULL%'
       AND indexdef ILIKE '%reference_id IS NOT NULL%'
  ) INTO v_reference_index;

  IF v_reference_type IS DISTINCT FROM 'uuid' OR NOT v_reference_index THEN
    RAISE EXCEPTION 'PAYROLL_SAFETY_REFERENCE_CONTRACT_INVALID: reference_id=% unique_partial_index=%',
      v_reference_type, v_reference_index;
  END IF;
END;
$$;

CREATE OR REPLACE FUNCTION public.assert_payroll_actor(
  p_company_id uuid, p_actor uuid
) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
BEGIN
  IF p_actor IS NULL OR NOT EXISTS (
    SELECT 1
      FROM public.profiles
     WHERE id = p_actor
       AND company_id = p_company_id
       AND role IN ('admin', 'gestor')
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
  v_net numeric;
BEGIN
  PERFORM public.assert_payroll_actor(p_company_id, p_actor);
  PERFORM public.assert_financial_periods_open_locked_many(
    p_company_id, ARRAY[p_period_year * 100 + p_period_month]
  );
  IF jsonb_typeof(p_records) <> 'array' THEN
    RAISE EXCEPTION 'PAYROLL_RECORDS_MUST_BE_ARRAY' USING ERRCODE = '22023';
  END IF;

  FOR v_record IN
    SELECT value FROM jsonb_array_elements(p_records)
    ORDER BY value->>'collaborator_id'
  LOOP
    v_collaborator := NULLIF(v_record->>'collaborator_id', '')::uuid;
    IF NOT EXISTS (
      SELECT 1 FROM public.profiles p
       WHERE p.id = v_collaborator AND p.company_id = p_company_id
    ) THEN
      RAISE EXCEPTION 'PAYROLL_COLLABORATOR_COMPANY_MISMATCH' USING ERRCODE = '42501';
    END IF;

    SELECT * INTO v_existing
      FROM public.payroll_records
     WHERE company_id = p_company_id
       AND collaborator_id = v_collaborator
       AND period_year = p_period_year
       AND period_month = p_period_month
     FOR UPDATE;

    IF FOUND AND v_existing.status IN ('aprovado', 'pago') THEN
      v_preserved := v_preserved + 1;
      CONTINUE;
    END IF;
    IF FOUND AND v_existing.status <> 'rascunho' THEN
      RAISE EXCEPTION 'PAYROLL_UNKNOWN_STATUS' USING ERRCODE = '22023';
    END IF;
    IF (v_record->>'net_salary') IS NULL THEN
      RAISE EXCEPTION 'PAYROLL_INVALID_TOTAL' USING ERRCODE = '22023';
    END IF;
    v_net := (v_record->>'net_salary')::numeric;
    IF v_net::text IN ('NaN', 'Infinity', '-Infinity') OR abs(v_net) > 100000000 THEN
      RAISE EXCEPTION 'PAYROLL_INVALID_TOTAL' USING ERRCODE = '22023';
    END IF;

    INSERT INTO public.payroll_records (
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
      v_net, v_record->>'notes', 'rascunho', NULL
    )
    ON CONFLICT (company_id, collaborator_id, period_year, period_month) DO UPDATE SET
      contracted_hours = EXCLUDED.contracted_hours, worked_hours = EXCLUDED.worked_hours,
      overtime_hours = EXCLUDED.overtime_hours, absence_hours = EXCLUDED.absence_hours,
      days_worked = EXCLUDED.days_worked, hourly_rate = EXCLUDED.hourly_rate,
      gross_salary = EXCLUDED.gross_salary, meal_allowance = EXCLUDED.meal_allowance,
      overtime_bonus = EXCLUDED.overtime_bonus, absence_deductions = EXCLUDED.absence_deductions,
      other_additions = EXCLUDED.other_additions, other_deductions = EXCLUDED.other_deductions,
      net_salary = EXCLUDED.net_salary, notes = EXCLUDED.notes, updated_at = now()
      WHERE public.payroll_records.status = 'rascunho';
    GET DIAGNOSTICS v_changed = ROW_COUNT;
    v_written := v_written + v_changed;
  END LOOP;

  IF v_written > 0 OR v_preserved > 0 THEN
    INSERT INTO public.audit_logs(company_id, actor_id, action, entity_type, meta)
    VALUES (
      p_company_id, p_actor, 'payroll_recalculated', 'payroll',
      jsonb_build_object(
        'period_year', p_period_year, 'period_month', p_period_month,
        'written_count', v_written, 'preserved_count', v_preserved
      )
    );
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
  v_after public.payroll_records%ROWTYPE;
  v_period_year integer;
  v_period_month integer;
  v_net numeric;
BEGIN
  PERFORM public.assert_payroll_actor(p_company_id, p_actor);
  SELECT period_year, period_month
    INTO v_period_year, v_period_month
    FROM public.payroll_records
   WHERE id = p_record_id AND company_id = p_company_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'PAYROLL_RECORD_NOT_FOUND' USING ERRCODE = 'P0002';
  END IF;

  PERFORM public.assert_financial_periods_open_locked_many(
    p_company_id, ARRAY[v_period_year * 100 + v_period_month]
  );
  SELECT * INTO v_row
    FROM public.payroll_records
   WHERE id = p_record_id AND company_id = p_company_id
   FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'PAYROLL_RECORD_NOT_FOUND' USING ERRCODE = 'P0002';
  END IF;
  IF v_row.status <> 'rascunho' THEN
    RAISE EXCEPTION 'PAYROLL_MUTATION_NOT_ALLOWED' USING ERRCODE = '55000';
  END IF;
  IF p_patch IS NULL OR jsonb_typeof(p_patch) <> 'object' THEN
    RAISE EXCEPTION 'PAYROLL_PATCH_INVALID' USING ERRCODE = '22023';
  END IF;
  IF p_patch ?| ARRAY['status','paid_at','approved_by','company_id','collaborator_id','period_year','period_month'] THEN
    RAISE EXCEPTION 'PAYROLL_PATCH_FORBIDDEN' USING ERRCODE = '42501';
  END IF;

  v_net := COALESCE((p_patch->>'net_salary')::numeric, v_row.net_salary);
  IF v_net IS NULL OR v_net::text IN ('NaN', 'Infinity', '-Infinity') OR abs(v_net) > 100000000 THEN
    RAISE EXCEPTION 'PAYROLL_INVALID_TOTAL' USING ERRCODE = '22023';
  END IF;

  UPDATE public.payroll_records SET
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
    net_salary = v_net,
    notes = CASE WHEN p_patch ? 'notes' THEN p_patch->>'notes' ELSE notes END,
    updated_at = now()
   WHERE id = p_record_id AND company_id = p_company_id AND status = 'rascunho';
  IF NOT FOUND THEN
    RAISE EXCEPTION 'PAYROLL_CONCURRENT_STATE_CHANGE' USING ERRCODE = '40001';
  END IF;
  SELECT * INTO v_after FROM public.payroll_records WHERE id = p_record_id;

  INSERT INTO public.audit_logs(company_id, actor_id, action, entity_type, entity_id, meta)
  VALUES (
    p_company_id, p_actor, 'payroll_adjusted', 'payroll', p_record_id::text,
    jsonb_build_object(
      'payroll_id', p_record_id, 'actor', p_actor, 'company', p_company_id,
      'before_status', v_row.status, 'after_status', v_after.status,
      'amount', v_after.net_salary, 'payroll_period_year', v_after.period_year,
      'payroll_period_month', v_after.period_month,
      'before', to_jsonb(v_row), 'after', to_jsonb(v_after)
    )
  );
  RETURN QUERY SELECT p_record_id, v_after.net_salary;
END;
$$;

CREATE OR REPLACE FUNCTION public.approve_payroll_records_atomic(
  p_company_id uuid, p_record_ids uuid[], p_actor uuid
) RETURNS TABLE (approved_count integer, already_approved_count integer)
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_id uuid;
  v_row public.payroll_records%ROWTYPE;
  v_keys integer[];
  v_found integer;
  v_approved integer := 0;
  v_already integer := 0;
BEGIN
  PERFORM public.assert_payroll_actor(p_company_id, p_actor);
  IF p_record_ids IS NULL OR cardinality(p_record_ids) = 0 THEN
    RETURN QUERY SELECT 0, 0;
    RETURN;
  END IF;
  IF cardinality(p_record_ids) <> (SELECT count(DISTINCT x) FROM unnest(p_record_ids) AS u(x)) THEN
    RAISE EXCEPTION 'PAYROLL_DUPLICATE_IDS' USING ERRCODE = '22023';
  END IF;
  SELECT count(*) INTO v_found
    FROM public.payroll_records
   WHERE company_id = p_company_id AND id = ANY(p_record_ids);
  IF v_found <> cardinality(p_record_ids) THEN
    RAISE EXCEPTION 'PAYROLL_RECORD_NOT_FOUND' USING ERRCODE = 'P0002';
  END IF;
  v_keys := ARRAY(
    SELECT DISTINCT period_year * 100 + period_month
      FROM public.payroll_records
     WHERE company_id = p_company_id AND id = ANY(p_record_ids)
     ORDER BY 1
  );
  PERFORM public.assert_financial_periods_open_locked_many(p_company_id, v_keys);

  FOR v_id IN SELECT x FROM unnest(p_record_ids) AS u(x) ORDER BY x LOOP
    SELECT * INTO v_row FROM public.payroll_records
     WHERE id = v_id AND company_id = p_company_id FOR UPDATE;
    IF v_row.status = 'aprovado' THEN
      v_already := v_already + 1;
      CONTINUE;
    ELSIF v_row.status <> 'rascunho' THEN
      RAISE EXCEPTION 'PAYROLL_APPROVAL_NOT_ALLOWED' USING ERRCODE = '55000';
    END IF;
    UPDATE public.payroll_records
       SET status = 'aprovado', approved_by = p_actor, updated_at = now()
     WHERE id = v_id AND company_id = p_company_id AND status = 'rascunho';
    IF NOT FOUND THEN
      RAISE EXCEPTION 'PAYROLL_CONCURRENT_STATE_CHANGE' USING ERRCODE = '40001';
    END IF;
    v_approved := v_approved + 1;
    INSERT INTO public.audit_logs(company_id, actor_id, action, entity_type, entity_id, meta)
    VALUES (
      p_company_id, p_actor, 'payroll_approved', 'payroll', v_id::text,
      jsonb_build_object(
        'payroll_id', v_id, 'actor', p_actor, 'company', p_company_id,
        'before_status', 'rascunho', 'after_status', 'aprovado'
      )
    );
  END LOOP;
  RETURN QUERY SELECT v_approved, v_already;
END;
$$;

CREATE OR REPLACE FUNCTION public.mark_payroll_paid_atomic(
  p_company_id uuid, p_record_ids uuid[], p_paid_on date, p_actor uuid
) RETURNS TABLE (paid_count integer, already_paid_count integer, cash_entry_count integer)
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_id uuid;
  v_row public.payroll_records%ROWTYPE;
  v_cash public.cash_flow_entries%ROWTYPE;
  v_collaborator_name text;
  v_keys integer[];
  v_cash_keys integer[];
  v_current_cash_key integer;
  v_found integer;
  v_needs_new_cash boolean;
  v_has_cash boolean;
  v_cash_id uuid;
  v_source text;
  v_paid integer := 0;
  v_already integer := 0;
  v_cash_count integer := 0;
BEGIN
  PERFORM public.assert_payroll_actor(p_company_id, p_actor);
  IF p_record_ids IS NULL OR cardinality(p_record_ids) = 0 THEN
    RETURN QUERY SELECT 0, 0, 0;
    RETURN;
  END IF;
  IF cardinality(p_record_ids) <> (SELECT count(DISTINCT x) FROM unnest(p_record_ids) AS u(x)) THEN
    RAISE EXCEPTION 'PAYROLL_DUPLICATE_IDS' USING ERRCODE = '22023';
  END IF;
  SELECT count(*) INTO v_found
    FROM public.payroll_records
   WHERE company_id = p_company_id AND id = ANY(p_record_ids);
  IF v_found <> cardinality(p_record_ids) THEN
    RAISE EXCEPTION 'PAYROLL_RECORD_NOT_FOUND' USING ERRCODE = 'P0002';
  END IF;

  v_keys := ARRAY(
    SELECT DISTINCT period_year * 100 + period_month
      FROM public.payroll_records
     WHERE company_id = p_company_id AND id = ANY(p_record_ids)
     ORDER BY 1
  );
  v_cash_keys := ARRAY(
    SELECT DISTINCT EXTRACT(YEAR FROM c.date)::integer * 100 + EXTRACT(MONTH FROM c.date)::integer
      FROM public.cash_flow_entries c
     WHERE c.company_id = p_company_id
       AND c.reference_type = 'payroll'
       AND c.reference_id = ANY(p_record_ids)
     ORDER BY 1
  );
  SELECT EXISTS (
    SELECT 1
      FROM public.payroll_records pr
     WHERE pr.company_id = p_company_id
       AND pr.id = ANY(p_record_ids)
       AND pr.status = 'aprovado'
       AND NOT EXISTS (
         SELECT 1 FROM public.cash_flow_entries c
          WHERE c.company_id = p_company_id
            AND c.reference_type = 'payroll'
            AND c.reference_id = pr.id
       )
  ) INTO v_needs_new_cash;
  IF v_needs_new_cash AND p_paid_on IS NULL THEN
    RAISE EXCEPTION 'PAYROLL_PAID_DATE_REQUIRED' USING ERRCODE = '22023';
  END IF;
  v_keys := ARRAY(
    SELECT DISTINCT k
      FROM unnest(
        COALESCE(v_keys, ARRAY[]::integer[])
        || COALESCE(v_cash_keys, ARRAY[]::integer[])
        || CASE WHEN v_needs_new_cash THEN ARRAY[
             EXTRACT(YEAR FROM p_paid_on)::integer * 100 + EXTRACT(MONTH FROM p_paid_on)::integer
           ] ELSE ARRAY[]::integer[] END
      ) AS u(k)
     ORDER BY k
  );
  PERFORM public.assert_financial_periods_open_locked_many(p_company_id, v_keys);

  -- All reads below happen after the complete economic lock set is held.
  FOR v_id IN SELECT x FROM unnest(p_record_ids) AS u(x) ORDER BY x LOOP
    SELECT * INTO v_row FROM public.payroll_records
     WHERE id = v_id AND company_id = p_company_id FOR UPDATE;
    IF v_row.status NOT IN ('aprovado', 'pago') THEN
      IF v_row.status IN ('rascunho') THEN
        RAISE EXCEPTION 'PAYROLL_NOT_APPROVED' USING ERRCODE = '55000';
      END IF;
      RAISE EXCEPTION 'PAYROLL_UNKNOWN_STATUS' USING ERRCODE = '22023';
    END IF;
    IF v_row.net_salary IS NULL OR v_row.net_salary::text IN ('NaN', 'Infinity', '-Infinity')
       OR v_row.net_salary <= 0
       OR abs(v_row.net_salary) > 100000000 THEN
      RAISE EXCEPTION 'PAYROLL_INVALID_TOTAL' USING ERRCODE = '22023';
    END IF;

    SELECT * INTO v_cash FROM public.cash_flow_entries
     WHERE company_id = p_company_id
       AND reference_type = 'payroll'
       AND reference_id = v_id
     FOR UPDATE;
    v_has_cash := FOUND;
    IF v_has_cash THEN
      v_current_cash_key := EXTRACT(YEAR FROM v_cash.date)::integer * 100
        + EXTRACT(MONTH FROM v_cash.date)::integer;
      IF NOT (v_current_cash_key = ANY(v_keys)) THEN
        RAISE EXCEPTION 'PAYROLL_CASHFLOW_PERIOD_CHANGED' USING ERRCODE = '40001';
      END IF;
      IF v_cash.company_id IS DISTINCT FROM p_company_id
         OR v_cash.reference_type IS DISTINCT FROM 'payroll'
         OR v_cash.reference_id IS DISTINCT FROM v_id
         OR v_cash.amount IS DISTINCT FROM v_row.net_salary
         OR v_cash.type IS DISTINCT FROM 'saida'
         OR v_cash.category IS DISTINCT FROM 'salario'
         OR v_cash.status IS DISTINCT FROM 'confirmado' THEN
        RAISE EXCEPTION 'PAYROLL_CASHFLOW_CONFLICT' USING ERRCODE = '23514';
      END IF;
    ELSIF v_row.status = 'pago' THEN
      RAISE EXCEPTION 'PAYROLL_PAID_CASHFLOW_MISSING' USING ERRCODE = '23514';
    END IF;
  END LOOP;

  FOR v_id IN SELECT x FROM unnest(p_record_ids) AS u(x) ORDER BY x LOOP
    SELECT * INTO v_row FROM public.payroll_records
     WHERE id = v_id AND company_id = p_company_id FOR UPDATE;
    SELECT p.full_name INTO v_collaborator_name
      FROM public.profiles p
     WHERE p.id = v_row.collaborator_id AND p.company_id = p_company_id;
    IF v_collaborator_name IS NULL THEN
      RAISE EXCEPTION 'PAYROLL_COLLABORATOR_NOT_FOUND' USING ERRCODE = '42501';
    END IF;

    v_cash_id := NULL;
    v_source := NULL;
    SELECT id INTO v_cash_id FROM public.cash_flow_entries
     WHERE company_id = p_company_id
       AND reference_type = 'payroll'
       AND reference_id = v_id
     FOR UPDATE;
    IF v_cash_id IS NULL THEN
      INSERT INTO public.cash_flow_entries(
        company_id, type, amount, description, category, date,
        reference_id, reference_type, status, created_by
      ) VALUES (
        p_company_id, 'saida', v_row.net_salary,
        'Salario ' || v_collaborator_name || ' - ' ||
          lpad(v_row.period_month::text, 2, '0') || '/' || v_row.period_year::text,
        'salario', p_paid_on, v_id, 'payroll', 'confirmado', p_actor
      )
      ON CONFLICT (company_id, reference_type, reference_id)
        WHERE reference_type IS NOT NULL AND reference_id IS NOT NULL
      DO NOTHING
      RETURNING id INTO v_cash_id;
      IF v_cash_id IS NOT NULL THEN
        v_cash_count := v_cash_count + 1;
        v_source := 'created';
      ELSE
        SELECT id INTO v_cash_id FROM public.cash_flow_entries
         WHERE company_id = p_company_id
           AND reference_type = 'payroll'
           AND reference_id = v_id
         FOR UPDATE;
        IF v_cash_id IS NULL THEN
          RAISE EXCEPTION 'PAYROLL_CASHFLOW_INSERT_NOT_CONFIRMED' USING ERRCODE = '40001';
        END IF;
        v_source := 'adopted_existing';
      END IF;
    END IF;

    SELECT * INTO v_cash FROM public.cash_flow_entries WHERE id = v_cash_id FOR UPDATE;
    IF NOT FOUND THEN
      RAISE EXCEPTION 'PAYROLL_CASHFLOW_INSERT_NOT_CONFIRMED' USING ERRCODE = '40001';
    END IF;
    v_current_cash_key := EXTRACT(YEAR FROM v_cash.date)::integer * 100
      + EXTRACT(MONTH FROM v_cash.date)::integer;
    IF NOT (v_current_cash_key = ANY(v_keys)) THEN
      RAISE EXCEPTION 'PAYROLL_CASHFLOW_PERIOD_CHANGED' USING ERRCODE = '40001';
    END IF;
    IF v_cash.company_id IS DISTINCT FROM p_company_id
       OR v_cash.reference_type IS DISTINCT FROM 'payroll'
       OR v_cash.reference_id IS DISTINCT FROM v_id
       OR v_cash.amount IS DISTINCT FROM v_row.net_salary
       OR v_cash.type IS DISTINCT FROM 'saida'
       OR v_cash.category IS DISTINCT FROM 'salario'
       OR v_cash.status IS DISTINCT FROM 'confirmado' THEN
      RAISE EXCEPTION 'PAYROLL_CASHFLOW_CONFLICT' USING ERRCODE = '23514';
    END IF;

    IF v_row.status = 'aprovado' THEN
      UPDATE public.payroll_records
         SET status = 'pago', paid_at = COALESCE(paid_at, p_paid_on::timestamptz), updated_at = now()
       WHERE id = v_id AND company_id = p_company_id AND status = 'aprovado';
      IF NOT FOUND THEN
        RAISE EXCEPTION 'PAYROLL_CONCURRENT_STATE_CHANGE' USING ERRCODE = '40001';
      END IF;
      v_paid := v_paid + 1;
      INSERT INTO public.audit_logs(company_id, actor_id, action, entity_type, entity_id, meta)
      VALUES (
        p_company_id, p_actor, 'payroll_paid', 'payroll', v_id::text,
        jsonb_build_object(
          'payroll_id', v_id, 'cashflow_id', v_cash_id,
          'actor', p_actor, 'company', p_company_id,
          'before_status', 'aprovado', 'after_status', 'pago',
          'amount', v_row.net_salary,
          'payroll_period_year', v_row.period_year,
          'payroll_period_month', v_row.period_month,
          'cashflow_date', v_cash.date,
          'reference_type', v_cash.reference_type,
          'reference_id', v_cash.reference_id,
          'source', COALESCE(v_source, 'adopted_existing'),
          'created_by', v_cash.created_by
        )
      );
    ELSE
      -- A retry validates the existing economic fact but remains read-only.
      v_already := v_already + 1;
    END IF;
  END LOOP;
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

-- ============================================================================
-- ROLLBACK 098 — vencimento base e líquido escrito à mão
-- ============================================================================
--
-- 🔴 LEIA ANTES DE CORRER.
--
--    Este rollback **apaga dados que só existem aqui**: os vencimentos base
--    preenchidos, e todos os líquidos escritos à mão com a respectiva razão.
--    Nenhum deles é reconstruível a partir do resto da folha — o `net_salary`
--    fica com o valor que tinha, mas deixa de se saber que foi decidido por
--    alguém, e porquê.
--
--    Se o problema for a lógica e não as colunas, a saída certa é uma
--    migration nova por cima. Este ficheiro existe para o caso em que a 098
--    tem de sair inteira, e assume que essa perda foi aceite conscientemente.
--
--    As funções voltam à forma da 096: sem `base_salary`, sem override, e sem
--    a cláusula que protegia o override do recálculo mensal.
-- ============================================================================

-- ─── 1. Funções de volta à 096 ──────────────────────────────────────────────

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

CREATE OR REPLACE FUNCTION public.upsert_payroll_records_atomic(
  p_company_id uuid, p_period_year integer, p_period_month integer,
  p_records jsonb, p_actor uuid DEFAULT NULL
) RETURNS TABLE (written_count integer, preserved_count integer)
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_record jsonb;
  v_collaborator uuid;
  v_written integer := 0;
  v_preserved integer := 0;
  v_changed integer;
  v_net numeric;
BEGIN
  PERFORM public.assert_payroll_actor(p_company_id, p_actor);
  PERFORM public.assert_financial_periods_open_locked_many(
    p_company_id, ARRAY[p_period_year * 100 + p_period_month]
  );

  IF p_records IS NULL OR jsonb_typeof(p_records) <> 'array' THEN
    RAISE EXCEPTION 'PAYROLL_RECORDS_INVALID' USING ERRCODE = '22023';
  END IF;

  FOR v_record IN SELECT value FROM jsonb_array_elements(p_records) LOOP
    v_collaborator := (v_record->>'collaborator_id')::uuid;
    IF v_collaborator IS NULL THEN
      RAISE EXCEPTION 'PAYROLL_RECORDS_INVALID' USING ERRCODE = '22023';
    END IF;

    IF NOT EXISTS (
      SELECT 1 FROM public.profiles
       WHERE id = v_collaborator AND company_id = p_company_id
    ) THEN
      RAISE EXCEPTION 'PAYROLL_COLLABORATOR_FOREIGN' USING ERRCODE = '42501';
    END IF;

    IF EXISTS (
      SELECT 1 FROM public.payroll_records
       WHERE company_id = p_company_id AND collaborator_id = v_collaborator
         AND period_year = p_period_year AND period_month = p_period_month
         AND status <> 'rascunho'
    ) THEN
      v_preserved := v_preserved + 1;
      CONTINUE;
    END IF;

    v_net := (v_record->>'net_salary')::numeric;
    IF v_net IS NULL OR v_net::text IN ('NaN', 'Infinity', '-Infinity') OR abs(v_net) > 100000000 THEN
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

-- ─── 2. Colunas — a perda de dados acontece aqui ────────────────────────────

ALTER TABLE public.payroll_records
  DROP CONSTRAINT IF EXISTS payroll_net_override_needs_reason;

ALTER TABLE public.payroll_records
  DROP COLUMN IF EXISTS net_salary_override_reason,
  DROP COLUMN IF EXISTS net_salary_override,
  DROP COLUMN IF EXISTS base_salary;

ALTER TABLE public.company_settings
  DROP COLUMN IF EXISTS default_base_salary_monthly;

ALTER TABLE public.profiles
  DROP COLUMN IF EXISTS base_salary_monthly;

REVOKE ALL ON FUNCTION public.adjust_payroll_record_atomic(uuid, uuid, jsonb, uuid) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.upsert_payroll_records_atomic(uuid, integer, integer, jsonb, uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.adjust_payroll_record_atomic(uuid, uuid, jsonb, uuid) TO service_role;
GRANT EXECUTE ON FUNCTION public.upsert_payroll_records_atomic(uuid, integer, integer, jsonb, uuid) TO service_role;

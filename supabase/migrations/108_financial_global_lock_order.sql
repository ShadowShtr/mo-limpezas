-- 108 — ordem global de locks financeiros

-- Linhas existentes (ordem canónica) -> períodos (ordem canónica) -> escrita.

-- Criações sem linha preexistente: períodos -> INSERT.
--
-- A 090 já declarou este contrato. A 096/100 inverteu-o na folha e a 095
-- deixou as filhas da importação para a cascata. Isso permite os ciclos
-- folha × conciliação e delete-import × ignore reproduzidos com 40P01.

DO $precondicoes$
BEGIN
  IF to_regprocedure('public.assert_financial_periods_open_locked_many(uuid,integer[])') IS NULL
     OR to_regprocedure('public.adjust_payroll_record_atomic(uuid,uuid,jsonb,uuid)') IS NULL
     OR to_regprocedure('public.upsert_payroll_records_atomic(uuid,integer,integer,jsonb,uuid)') IS NULL
     OR to_regprocedure('public.approve_payroll_records_atomic(uuid,uuid[],uuid)') IS NULL
     OR to_regprocedure('public.mark_payroll_paid_atomic(uuid,uuid[],date,uuid)') IS NULL
     OR to_regprocedure('public.delete_bank_import_atomic(uuid,uuid,uuid)') IS NULL
  THEN
    RAISE EXCEPTION '108_PRECONDITION_FAILED: migrations 090, 095, 096 e 100 são obrigatórias';
  END IF;
END;
$precondicoes$;

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
  v_override numeric;
  v_reason text;
  v_tem_override boolean;
  v_horas_manual boolean;
  v_worked numeric;
  v_days integer;
  v_absence numeric;
BEGIN
  PERFORM public.assert_payroll_actor(p_company_id, p_actor);
  -- A data pertence à linha: primeiro estabiliza-se a linha, depois o mês.
  SELECT * INTO v_row
    FROM public.payroll_records
   WHERE id = p_record_id AND company_id = p_company_id
   FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'PAYROLL_RECORD_NOT_FOUND' USING ERRCODE = 'P0002';
  END IF;
  v_period_year := v_row.period_year;
  v_period_month := v_row.period_month;

  PERFORM public.assert_financial_periods_open_locked_many(
    p_company_id, ARRAY[v_period_year * 100 + v_period_month]
  );
  IF v_row.status <> 'rascunho' THEN
    RAISE EXCEPTION 'PAYROLL_MUTATION_NOT_ALLOWED' USING ERRCODE = '55000';
  END IF;
  IF p_patch IS NULL OR jsonb_typeof(p_patch) <> 'object' THEN
    RAISE EXCEPTION 'PAYROLL_PATCH_INVALID' USING ERRCODE = '22023';
  END IF;
  IF p_patch ?| ARRAY['status','paid_at','approved_by','company_id','collaborator_id','period_year','period_month'] THEN
    RAISE EXCEPTION 'PAYROLL_PATCH_FORBIDDEN' USING ERRCODE = '42501';
  END IF;

  -- ── Repor do ponto, ou marcar como corrigido à mão ────────────────────────
  --
  -- `hours_manual = false` no patch é o botão «repor do ponto»: as horas
  -- efectivas passam a ser as do ponto outra vez. Sem esta cópia, repor
  -- deixava a marca a dizer «segue o ponto» com os números da mão ainda lá —
  -- o pior dos dois estados, porque ninguém veria a contradição.
  IF p_patch ? 'hours_manual' AND (p_patch->>'hours_manual')::boolean IS FALSE THEN
    v_horas_manual := false;
    v_worked  := COALESCE(v_row.clock_worked_hours, v_row.worked_hours);
    v_days    := COALESCE(v_row.clock_days_worked, v_row.days_worked);
    v_absence := COALESCE(v_row.clock_absence_hours, v_row.absence_hours);
  ELSE
    v_worked  := COALESCE((p_patch->>'worked_hours')::numeric, v_row.worked_hours);
    v_days    := COALESCE((p_patch->>'days_worked')::integer, v_row.days_worked);
    v_absence := COALESCE((p_patch->>'absence_hours')::numeric, v_row.absence_hours);

    -- Uma edição só conta como manual quando MUDA alguma coisa. Guardar sem
    -- tocar nas horas não devia congelá-las face ao ponto — e congelava, se
    -- bastasse o campo vir no patch.
    v_horas_manual := v_row.hours_manual
      OR (p_patch ? 'hours_manual' AND (p_patch->>'hours_manual')::boolean IS TRUE)
      OR v_worked  IS DISTINCT FROM v_row.worked_hours
      OR v_days    IS DISTINCT FROM v_row.days_worked
      OR v_absence IS DISTINCT FROM v_row.absence_hours;
  END IF;

  IF p_patch ? 'net_salary_override' THEN
    v_override := (p_patch->>'net_salary_override')::numeric;
    v_reason   := p_patch->>'net_salary_override_reason';
  ELSE
    v_override := v_row.net_salary_override;
    v_reason   := v_row.net_salary_override_reason;
  END IF;

  v_tem_override := v_override IS NOT NULL;

  IF v_tem_override THEN
    IF v_override::text IN ('NaN','Infinity','-Infinity') OR abs(v_override) > 100000000 THEN
      RAISE EXCEPTION 'PAYROLL_INVALID_TOTAL' USING ERRCODE = '22023';
    END IF;
    IF length(btrim(coalesce(v_reason, ''))) < 3 THEN
      RAISE EXCEPTION 'PAYROLL_OVERRIDE_REASON_REQUIRED' USING ERRCODE = '22023',
        HINT = 'Um líquido diferente do calculado tem de dizer porquê.';
    END IF;
  ELSE
    v_reason := NULL;
  END IF;

  v_net := COALESCE(v_override, (p_patch->>'net_salary')::numeric, v_row.net_salary);
  IF v_net IS NULL OR v_net::text IN ('NaN', 'Infinity', '-Infinity') OR abs(v_net) > 100000000 THEN
    RAISE EXCEPTION 'PAYROLL_INVALID_TOTAL' USING ERRCODE = '22023';
  END IF;

  UPDATE public.payroll_records SET
    base_salary = COALESCE((p_patch->>'base_salary')::numeric, base_salary),
    worked_hours = v_worked,
    days_worked = v_days,
    absence_hours = v_absence,
    hours_manual = v_horas_manual,
    overtime_hours = COALESCE((p_patch->>'overtime_hours')::numeric, overtime_hours),
    overtime_hour_rate = CASE WHEN p_patch ? 'overtime_hour_rate'
                              THEN (p_patch->>'overtime_hour_rate')::numeric
                              ELSE overtime_hour_rate END,
    extra_days = COALESCE((p_patch->>'extra_days')::integer, extra_days),
    extra_day_rate = COALESCE((p_patch->>'extra_day_rate')::numeric, extra_day_rate),
    extra_days_bonus = COALESCE((p_patch->>'extra_days_bonus')::numeric, extra_days_bonus),
    advance_deduction = COALESCE((p_patch->>'advance_deduction')::numeric, advance_deduction),
    hourly_rate = COALESCE((p_patch->>'hourly_rate')::numeric, hourly_rate),
    gross_salary = COALESCE((p_patch->>'gross_salary')::numeric, gross_salary),
    meal_allowance = COALESCE((p_patch->>'meal_allowance')::numeric, meal_allowance),
    overtime_bonus = COALESCE((p_patch->>'overtime_bonus')::numeric, overtime_bonus),
    absence_deductions = COALESCE((p_patch->>'absence_deductions')::numeric, absence_deductions),
    other_additions = COALESCE((p_patch->>'other_additions')::numeric, other_additions),
    other_deductions = COALESCE((p_patch->>'other_deductions')::numeric, other_deductions),
    net_salary = v_net,
    net_salary_override = v_override,
    net_salary_override_reason = v_reason,
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
      'net_calculado', (p_patch->>'net_salary')::numeric,
      'net_override', v_after.net_salary_override,
      'override_reason', v_after.net_salary_override_reason,
      'horas_manuais', v_after.hours_manual,
      'horas_do_ponto', v_after.clock_worked_hours,
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
  v_existente public.payroll_records%ROWTYPE;
BEGIN
  PERFORM public.assert_payroll_actor(p_company_id, p_actor);
  IF p_records IS NULL OR jsonb_typeof(p_records) <> 'array' THEN
    RAISE EXCEPTION 'PAYROLL_RECORDS_INVALID' USING ERRCODE = '22023';
  END IF;

  -- Valida todo o lote antes do primeiro lock e estabiliza, por UUID, as
  -- linhas que já existem. As que ainda não existem não podem ser trancadas;
  -- para elas o período é o primeiro recurso e a unicidade arbitra a corrida.
  IF EXISTS (
    SELECT 1 FROM jsonb_array_elements(p_records) r
     WHERE NULLIF(r->>'collaborator_id', '') IS NULL
  ) THEN
    RAISE EXCEPTION 'PAYROLL_RECORDS_INVALID' USING ERRCODE = '22023';
  END IF;
  IF EXISTS (
    SELECT 1
      FROM jsonb_array_elements(p_records) r
      LEFT JOIN public.profiles p
        ON p.id = (r->>'collaborator_id')::uuid
       AND p.company_id = p_company_id
     WHERE p.id IS NULL
  ) THEN
    RAISE EXCEPTION 'PAYROLL_COLLABORATOR_FOREIGN' USING ERRCODE = '42501';
  END IF;
  PERFORM 1
    FROM public.payroll_records pr
   WHERE pr.company_id = p_company_id
     AND pr.period_year = p_period_year
     AND pr.period_month = p_period_month
     AND pr.collaborator_id IN (
       SELECT (r->>'collaborator_id')::uuid FROM jsonb_array_elements(p_records) r
     )
   ORDER BY pr.id
   FOR UPDATE;

  PERFORM public.assert_financial_periods_open_locked_many(
    p_company_id, ARRAY[p_period_year * 100 + p_period_month]
  );

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

    SELECT * INTO v_existente
      FROM public.payroll_records
     WHERE company_id = p_company_id AND collaborator_id = v_collaborator
       AND period_year = p_period_year AND period_month = p_period_month;

    IF FOUND AND v_existente.status <> 'rascunho' THEN
      v_preserved := v_preserved + 1;
      CONTINUE;
    END IF;

    v_net := (v_record->>'net_salary')::numeric;
    IF v_net IS NULL OR v_net::text IN ('NaN', 'Infinity', '-Infinity') OR abs(v_net) > 100000000 THEN
      RAISE EXCEPTION 'PAYROLL_INVALID_TOTAL' USING ERRCODE = '22023';
    END IF;

    -- 🔴 Linha com trabalho manual: actualiza-se APENAS a fotografia do ponto.
    --    O resto — horas efectivas, totais, dias extras, adiantamento — fica
    --    como quem o escreveu deixou. Sem este ramo, «Recalcular folha»
    --    apagava correcções sem aviso, que é o defeito que esta migration
    --    existe para fechar.
    IF FOUND AND (
         v_existente.hours_manual
      OR v_existente.net_salary_override IS NOT NULL
      OR v_existente.extra_days > 0
      OR v_existente.advance_deduction > 0
    ) THEN
      UPDATE public.payroll_records SET
        clock_worked_hours  = (v_record->>'worked_hours')::numeric,
        clock_days_worked   = (v_record->>'days_worked')::integer,
        clock_absence_hours = (v_record->>'absence_hours')::numeric,
        updated_at = now()
       WHERE id = v_existente.id;
      v_preserved := v_preserved + 1;
      CONTINUE;
    END IF;

    INSERT INTO public.payroll_records (
      company_id, collaborator_id, period_year, period_month, contracted_hours,
      worked_hours, overtime_hours, absence_hours, days_worked, hourly_rate,
      clock_worked_hours, clock_days_worked, clock_absence_hours, hours_manual,
      base_salary, gross_salary, meal_allowance, overtime_bonus, absence_deductions,
      other_additions, other_deductions, net_salary, notes, status, paid_at
    ) VALUES (
      p_company_id, v_collaborator, p_period_year, p_period_month,
      (v_record->>'contracted_hours')::numeric, (v_record->>'worked_hours')::numeric,
      (v_record->>'overtime_hours')::numeric, (v_record->>'absence_hours')::numeric,
      (v_record->>'days_worked')::integer, (v_record->>'hourly_rate')::numeric,
      (v_record->>'worked_hours')::numeric, (v_record->>'days_worked')::integer,
      (v_record->>'absence_hours')::numeric, false,
      COALESCE((v_record->>'base_salary')::numeric, 0),
      (v_record->>'gross_salary')::numeric, (v_record->>'meal_allowance')::numeric,
      (v_record->>'overtime_bonus')::numeric, (v_record->>'absence_deductions')::numeric,
      (v_record->>'other_additions')::numeric, (v_record->>'other_deductions')::numeric,
      v_net, v_record->>'notes', 'rascunho', NULL
    )
    ON CONFLICT (company_id, collaborator_id, period_year, period_month) DO UPDATE SET
      contracted_hours = EXCLUDED.contracted_hours, worked_hours = EXCLUDED.worked_hours,
      overtime_hours = EXCLUDED.overtime_hours, absence_hours = EXCLUDED.absence_hours,
      days_worked = EXCLUDED.days_worked, hourly_rate = EXCLUDED.hourly_rate,
      clock_worked_hours = EXCLUDED.clock_worked_hours,
      clock_days_worked = EXCLUDED.clock_days_worked,
      clock_absence_hours = EXCLUDED.clock_absence_hours,
      base_salary = EXCLUDED.base_salary,
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
  -- Um lote bloqueia sempre os UUIDs pela mesma ordem antes de pedir meses.
  FOR v_id IN SELECT x FROM unnest(p_record_ids) AS u(x) ORDER BY x LOOP
    PERFORM 1 FROM public.payroll_records
     WHERE id = v_id AND company_id = p_company_id
     FOR UPDATE;
  END LOOP;
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
     WHERE id = v_id AND company_id = p_company_id;
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
  -- Ordem global: folha por UUID, caixa por UUID, meses por AAAAMM.
  FOR v_id IN SELECT x FROM unnest(p_record_ids) AS u(x) ORDER BY x LOOP
    PERFORM 1 FROM public.payroll_records
     WHERE id = v_id AND company_id = p_company_id
     FOR UPDATE;
  END LOOP;
  SELECT count(*) INTO v_found
    FROM public.payroll_records
   WHERE company_id = p_company_id AND id = ANY(p_record_ids);
  IF v_found <> cardinality(p_record_ids) THEN
    RAISE EXCEPTION 'PAYROLL_RECORD_NOT_FOUND' USING ERRCODE = 'P0002';
  END IF;

  FOR v_cash_id IN
    SELECT c.id
      FROM public.cash_flow_entries c
     WHERE c.company_id = p_company_id
       AND c.reference_type = 'payroll'
       AND c.reference_id = ANY(p_record_ids)
     ORDER BY c.id
  LOOP
    PERFORM 1 FROM public.cash_flow_entries WHERE id = v_cash_id FOR UPDATE;
  END LOOP;

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

  -- As releituras abaixo são reentrantes: as linhas já estão bloqueadas.
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

CREATE OR REPLACE FUNCTION public.delete_bank_import_atomic(
  p_company_id uuid,
  p_import_id  uuid,
  p_actor_id   uuid DEFAULT NULL
)
RETURNS TABLE (import_id uuid, apagados int, periodos integer[])
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = pg_catalog, public
AS $fn$
DECLARE
  v_datas     date[];
  v_chaves    integer[];
  v_apagados  int;
  v_child_id  uuid;
BEGIN
  IF p_actor_id IS NOT NULL THEN
    PERFORM set_config('app.actor_id', p_actor_id::text, true);
  END IF;

  PERFORM 1 FROM public.bank_statement_imports
   WHERE id = p_import_id AND company_id = p_company_id
   FOR UPDATE;

  IF NOT FOUND THEN
    -- Já não existe. Apagar o que não existe é sucesso, não erro — é o que a
    -- action já respondia, e repetir um clique não pode dar erro.
    RETURN QUERY SELECT p_import_id, 0, ARRAY[]::integer[];
    RETURN;
  END IF;

  -- O pai bloqueado impede novas filhas por FK; as filhas existentes entram
  -- por UUID antes dos períodos. A cascata já não descobre locks no fim.
  FOR v_child_id IN
    SELECT t.id FROM public.bank_transactions t
     WHERE t.company_id = p_company_id
       AND t.statement_import_id = p_import_id
     ORDER BY t.id
  LOOP
    PERFORM 1 FROM public.bank_transactions
     WHERE id = v_child_id AND company_id = p_company_id
     FOR UPDATE;
  END LOOP;

  SELECT array_agg(DISTINCT t.transaction_date) INTO v_datas
    FROM public.bank_transactions t
   WHERE t.company_id = p_company_id AND t.statement_import_id = p_import_id;

  v_chaves := public.financial_period_lock_keys(COALESCE(v_datas, ARRAY[]::date[]));

  -- 🔴 Uma importação sem transacção nenhuma não toca período nenhum. Não é o
  --    conjunto vazio proibido da 090 — é a ausência de efeito económico, e
  --    apagá-la é seguro. `lock_financial_periods_many` recusaria uma lista
  --    vazia, e com razão: para ela, vazio significa «writer sem protecção».
  --    Aqui significa outra coisa, e a distinção fica explícita em vez de
  --    contornada.
  IF cardinality(v_chaves) > 0 THEN
    PERFORM public.assert_financial_periods_open_locked_many(p_company_id, v_chaves);
  END IF;

  DELETE FROM public.bank_statement_imports
   WHERE id = p_import_id AND company_id = p_company_id;
  GET DIAGNOSTICS v_apagados = ROW_COUNT;

  RETURN QUERY SELECT p_import_id, v_apagados, v_chaves;
END;
$fn$;

COMMENT ON FUNCTION public.adjust_payroll_record_atomic(uuid, uuid, jsonb, uuid) IS
  '108: bloqueia a linha da folha antes do período; preserva o contrato funcional da 100.';
COMMENT ON FUNCTION public.upsert_payroll_records_atomic(uuid, integer, integer, jsonb, uuid) IS
  '108: bloqueia linhas existentes por UUID antes do período; criações sem linha usam período e unicidade.';
COMMENT ON FUNCTION public.approve_payroll_records_atomic(uuid, uuid[], uuid) IS
  '108: bloqueia o lote por UUID antes dos períodos canónicos.';
COMMENT ON FUNCTION public.mark_payroll_paid_atomic(uuid, uuid[], date, uuid) IS
  '108: bloqueia folha e caixa por UUID antes dos períodos canónicos.';
COMMENT ON FUNCTION public.delete_bank_import_atomic(uuid, uuid, uuid) IS
  '108: bloqueia importação e filhas por UUID antes dos períodos e da cascata.';

REVOKE ALL ON FUNCTION public.adjust_payroll_record_atomic(uuid, uuid, jsonb, uuid) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.upsert_payroll_records_atomic(uuid, integer, integer, jsonb, uuid) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.approve_payroll_records_atomic(uuid, uuid[], uuid) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.mark_payroll_paid_atomic(uuid, uuid[], date, uuid) FROM PUBLIC, anon, authenticated;
REVOKE ALL PRIVILEGES ON FUNCTION public.delete_bank_import_atomic(uuid, uuid, uuid) FROM PUBLIC, anon, authenticated;

GRANT EXECUTE ON FUNCTION public.adjust_payroll_record_atomic(uuid, uuid, jsonb, uuid) TO service_role;
GRANT EXECUTE ON FUNCTION public.upsert_payroll_records_atomic(uuid, integer, integer, jsonb, uuid) TO service_role;
GRANT EXECUTE ON FUNCTION public.approve_payroll_records_atomic(uuid, uuid[], uuid) TO service_role;
GRANT EXECUTE ON FUNCTION public.mark_payroll_paid_atomic(uuid, uuid[], date, uuid) TO service_role;
GRANT EXECUTE ON FUNCTION public.delete_bank_import_atomic(uuid, uuid, uuid) TO postgres, service_role;

-- ============================================================================
-- 100 — o ponto propõe, a mão decide
-- ============================================================================
--
-- O que o dono pediu
-- ------------------
--
--     «os pontos serão usados mas também sendo possível fazer essas
--      alterações manuais da mesma forma, por exemplo vai puxar os dados dos
--      pontos na hora que abrir o editor e vão estar lá os dados junto ao
--      ponto mas se caso precisar editar qualquer coisa poderá ser editado,
--      sendo que também pode ser colocado tudo à mão»
--
-- Duas fontes para o mesmo número, e o conflito que daí vem
-- --------------------------------------------------------
--
-- Hoje `worked_hours` é ao mesmo tempo «o que o ponto diz» e «o que vale para
-- o salário». Enquanto ninguém editava, davam no mesmo. A partir do momento
-- em que se pode editar, são coisas diferentes — e uma coluna só não chega:
--
--   · editar as horas à mão e carregar depois em «Recalcular folha»
--     escrevia o ponto por cima, em silêncio. O trabalho de quem corrigiu
--     desaparecia, e o total mudava sem ninguém pedir;
--   · e não havia como voltar atrás: perdido o valor do ponto, «repor» não
--     tinha de onde repor.
--
-- Por isso o ponto passa a ter colunas suas:
--
--   clock_worked_hours   ·  clock_days_worked  ·  clock_absence_hours
--
-- Essas são reescritas em todos os recálculos, sempre — são a fotografia do
-- ponto, e devem seguir o ponto. As colunas de sempre (`worked_hours`,
-- `days_worked`, `absence_hours`) continuam a ser o que conta para o salário.
--
-- `hours_manual` diz qual das duas mandou pela última vez:
--
--   false → o salário segue o ponto. O recálculo actualiza as duas.
--   true  → alguém corrigiu à mão. O recálculo actualiza só as `clock_*`,
--           e deixa as outras em paz.
--
-- 🔴 Repor é uma operação de verdade, e não «apagar o que lá está»: copia-se
--    `clock_*` para as colunas efectivas e volta-se a `hours_manual = false`.
--    Por isso o valor do ponto tem de existir mesmo quando não está a ser
--    usado — é ele que torna o botão possível.
--
-- Quem nunca picar o ponto fica com as `clock_*` a NULL e escreve tudo à mão,
-- que é o outro caso que o pedido nomeia. As duas maneiras convivem, e a
-- coluna diz qual está em vigor em cada linha.
--
-- Compatibilidade: colunas novas, `hours_manual` a `false`. As 140 linhas que
-- existem continuam a seguir o recálculo, tal como hoje.
-- ============================================================================

DO $precondicoes$
BEGIN
  IF to_regclass('public.payroll_records') IS NULL
     OR NOT EXISTS (
       SELECT 1 FROM information_schema.columns
        WHERE table_schema = 'public' AND table_name = 'payroll_records'
          AND column_name = 'extra_days'
     )
     OR to_regprocedure('public.adjust_payroll_record_atomic(uuid,uuid,jsonb,uuid)') IS NULL
  THEN
    RAISE EXCEPTION '100_PRECONDITION_FAILED: a 099 tem de estar aplicada antes desta';
  END IF;
END;
$precondicoes$;

-- ─── 1. Colunas ─────────────────────────────────────────────────────────────

ALTER TABLE public.payroll_records
  ADD COLUMN IF NOT EXISTS clock_worked_hours numeric,
  ADD COLUMN IF NOT EXISTS clock_days_worked integer,
  ADD COLUMN IF NOT EXISTS clock_absence_hours numeric,
  ADD COLUMN IF NOT EXISTS hours_manual boolean NOT NULL DEFAULT false;

COMMENT ON COLUMN public.payroll_records.clock_worked_hours IS
  'O que o ponto diz. Reescrito em cada recálculo, mesmo quando não é o que conta — é ele que torna o «repor do ponto» possível.';
COMMENT ON COLUMN public.payroll_records.hours_manual IS
  'true = as horas foram corrigidas à mão e o recálculo não lhes toca. false = o salário segue o ponto.';

-- ─── 2. O ajuste marca a origem ─────────────────────────────────────────────

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

-- ─── 3. O recálculo guarda sempre o ponto, e respeita a mão ─────────────────

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

-- ─── 4. ACL — reafirmada ────────────────────────────────────────────────────

REVOKE ALL ON FUNCTION public.adjust_payroll_record_atomic(uuid, uuid, jsonb, uuid) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.upsert_payroll_records_atomic(uuid, integer, integer, jsonb, uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.adjust_payroll_record_atomic(uuid, uuid, jsonb, uuid) TO service_role;
GRANT EXECUTE ON FUNCTION public.upsert_payroll_records_atomic(uuid, integer, integer, jsonb, uuid) TO service_role;

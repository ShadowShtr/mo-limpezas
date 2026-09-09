-- ============================================================================
-- 099 — dias extras, hora extra ao valor, e adiantamentos
-- ============================================================================
--
-- O que o dono descreveu, na linguagem dele
-- -----------------------------------------
--
--     «esses valores de horas não têm feito sentido pra nós que pagamos o
--      bruto, preciso de áreas como hora extra - x, dias extras trabalhados
--      x valor como trabalhar sábado e marcar quantos dias extras ela
--      trabalhou, área para colocar e descontar se teve algum adiantamento»
--
-- Três coisas, e nenhuma delas cabia no modelo que existia:
--
--   1. A hora extra era `horas × taxa_horária × percentagem`. Numa empresa
--      que paga o bruto e não usa o ponto, a taxa horária é uma ficção — e a
--      percentagem multiplica essa ficção. O valor da hora extra é sabido, e
--      deve poder ser escrito.
--
--   2. Um sábado trabalhado não é «horas extra». É um dia extra, com um valor
--      combinado por dia. Não havia onde o pôr: quem quisesse pagá-lo tinha
--      de o esconder dentro de «acréscimos», e o recibo perdia a razão.
--
--   3. Um adiantamento é dinheiro já entregue, e desconta-se. Ia parar aos
--      «outros descontos», junto de tudo o resto, sem se distinguir depois.
--
-- As três dão-se ao mesmo remédio: um campo próprio, com o nome que a coisa
-- tem, em vez de um campo genérico a fazer o trabalho de vários.
--
-- O que fica
-- ----------
--
--   payroll_records.overtime_hour_rate  — €/hora extra. NULL mantém o cálculo
--                                          por percentagem, para quem o usa.
--   payroll_records.extra_days          — quantos dias extras (sábados, etc.)
--   payroll_records.extra_day_rate      — quanto vale cada um
--   payroll_records.extra_days_bonus    — o produto, guardado
--   payroll_records.advance_deduction   — adiantamento a descontar
--
--   company_settings.default_overtime_hour_rate
--   company_settings.default_extra_day_rate
--
-- 🔴 `extra_days_bonus` é guardado, e não recalculado na leitura. É a mesma
--    razão de `base_salary` na 098: o valor do sábado pode mudar em Março, e
--    a folha de Janeiro não pode mudar com ele. O produto fica fixado no mês
--    em que foi decidido.
--
-- Compatibilidade: tudo com DEFAULT, nada é reescrito. As linhas que existem
-- ficam com zero dias extras, zero adiantamento e `overtime_hour_rate` NULL —
-- que é exactamente o que descreve o passado.
-- ============================================================================

DO $precondicoes$
BEGIN
  IF to_regclass('public.payroll_records') IS NULL
     OR to_regclass('public.company_settings') IS NULL
     OR NOT EXISTS (
       SELECT 1 FROM information_schema.columns
        WHERE table_schema = 'public' AND table_name = 'payroll_records'
          AND column_name = 'base_salary'
     )
     OR to_regprocedure('public.adjust_payroll_record_atomic(uuid,uuid,jsonb,uuid)') IS NULL
  THEN
    RAISE EXCEPTION '099_PRECONDITION_FAILED: a 098 tem de estar aplicada antes desta';
  END IF;
END;
$precondicoes$;

-- ─── 1. Colunas ─────────────────────────────────────────────────────────────

ALTER TABLE public.payroll_records
  ADD COLUMN IF NOT EXISTS overtime_hour_rate numeric,
  ADD COLUMN IF NOT EXISTS extra_days integer NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS extra_day_rate numeric NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS extra_days_bonus numeric NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS advance_deduction numeric NOT NULL DEFAULT 0;

ALTER TABLE public.company_settings
  ADD COLUMN IF NOT EXISTS default_overtime_hour_rate numeric,
  ADD COLUMN IF NOT EXISTS default_extra_day_rate numeric;

-- Um dia extra negativo não é um dia; um adiantamento negativo é um acréscimo
-- disfarçado, e para isso já existe o campo de acréscimos.
ALTER TABLE public.payroll_records
  DROP CONSTRAINT IF EXISTS payroll_extra_days_non_negative;
ALTER TABLE public.payroll_records
  ADD CONSTRAINT payroll_extra_days_non_negative CHECK (
    extra_days >= 0 AND extra_day_rate >= 0 AND advance_deduction >= 0
  );

COMMENT ON COLUMN public.payroll_records.extra_days IS
  'Dias extras trabalhados (sábados, feriados). Contam à parte das horas: são dias, não horas.';
COMMENT ON COLUMN public.payroll_records.extra_days_bonus IS
  'extra_days × extra_day_rate, fixado no mês. Guardado e não recalculado: mudar o valor do sábado não pode reescrever meses passados.';
COMMENT ON COLUMN public.payroll_records.advance_deduction IS
  'Adiantamento já entregue, a descontar. Separado de other_deductions para que o recibo diga o que é.';
COMMENT ON COLUMN public.payroll_records.overtime_hour_rate IS
  '€ por hora extra. NULL mantém o cálculo antigo (taxa horária × overtime_rate_pct).';

-- ─── 2. A RPC de ajuste aceita os campos novos ──────────────────────────────

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
    worked_hours = COALESCE((p_patch->>'worked_hours')::numeric, worked_hours),
    overtime_hours = COALESCE((p_patch->>'overtime_hours')::numeric, overtime_hours),
    -- 🔴 `p_patch ? 'x'` e não COALESCE: estes campos podem ser postos a NULL
    --    de propósito (voltar ao cálculo por percentagem), e um COALESCE não
    --    distingue «apagou» de «não mexeu».
    overtime_hour_rate = CASE WHEN p_patch ? 'overtime_hour_rate'
                              THEN (p_patch->>'overtime_hour_rate')::numeric
                              ELSE overtime_hour_rate END,
    extra_days = COALESCE((p_patch->>'extra_days')::integer, extra_days),
    extra_day_rate = COALESCE((p_patch->>'extra_day_rate')::numeric, extra_day_rate),
    extra_days_bonus = COALESCE((p_patch->>'extra_days_bonus')::numeric, extra_days_bonus),
    advance_deduction = COALESCE((p_patch->>'advance_deduction')::numeric, advance_deduction),
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
      'before', to_jsonb(v_row), 'after', to_jsonb(v_after)
    )
  );
  RETURN QUERY SELECT p_record_id, v_after.net_salary;
END;
$$;

-- ─── 3. O cálculo mensal grava os campos novos ──────────────────────────────

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
      base_salary, gross_salary, meal_allowance, overtime_bonus, absence_deductions,
      other_additions, other_deductions, net_salary, notes, status, paid_at
    ) VALUES (
      p_company_id, v_collaborator, p_period_year, p_period_month,
      (v_record->>'contracted_hours')::numeric, (v_record->>'worked_hours')::numeric,
      (v_record->>'overtime_hours')::numeric, (v_record->>'absence_hours')::numeric,
      (v_record->>'days_worked')::integer, (v_record->>'hourly_rate')::numeric,
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
      base_salary = EXCLUDED.base_salary,
      gross_salary = EXCLUDED.gross_salary, meal_allowance = EXCLUDED.meal_allowance,
      overtime_bonus = EXCLUDED.overtime_bonus, absence_deductions = EXCLUDED.absence_deductions,
      other_additions = EXCLUDED.other_additions, other_deductions = EXCLUDED.other_deductions,
      net_salary = EXCLUDED.net_salary, notes = EXCLUDED.notes, updated_at = now()
      WHERE public.payroll_records.status = 'rascunho'
        AND public.payroll_records.net_salary_override IS NULL
        -- 🔴 O recálculo mensal vem do ponto, e o ponto não sabe de sábados
        --    nem de adiantamentos. Uma linha onde alguém lançou dias extras
        --    ou um adiantamento tem informação que só existe ali: escrever
        --    por cima apagava-a sem aviso, tal como acontecia com o override.
        AND public.payroll_records.extra_days = 0
        AND public.payroll_records.advance_deduction = 0;
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

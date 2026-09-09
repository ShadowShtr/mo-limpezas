-- ============================================================================
-- 098 — vencimento base mensal, e o líquido escrito à mão
-- ============================================================================
--
-- O que estava errado, e porquê importa
-- -------------------------------------
--
-- A folha calculava o bruto como `worked_hours × hourly_rate`, sempre. Não
-- havia vencimento base em lado nenhum — nem em `profiles`, nem em
-- `company_settings`. Uma pessoa contratada ao salário mínimo só lá chegava
-- por acaso, se as horas do ponto vezes a taxa dessem esse número.
--
-- Não davam. A leitura de produção mostra `hourly_rate` entre 5,23 € e 9,50 €
-- em `payroll_records`: a taxa horária andou a ser torcida para o total bater
-- certo, porque era o único campo que mexia no resultado. Um campo a fazer o
-- trabalho de outro.
--
-- E o líquido nunca foi editável: `net_salary` era sempre recalculado a
-- partir das parcelas. Quando o valor a pagar tinha de ser outro — um acerto
-- combinado, um valor de contrato —, a única saída era forçá-lo por
-- «acréscimos» e «descontos» até o total dar. O número ficava certo e a razão
-- perdia-se.
--
-- O que esta migration muda
-- -------------------------
--
--   · `profiles.base_salary_monthly` — o vencimento base de cada pessoa;
--   · `company_settings.default_base_salary_monthly` — o que vale para quem
--     não tem o seu próprio (o salário mínimo, tipicamente);
--   · `payroll_records.base_salary` — o base efectivamente usado nesse mês,
--     guardado na linha e não deduzido depois. Um aumento em Março não pode
--     reescrever a folha de Janeiro;
--   · `payroll_records.net_salary_override` + `..._reason` — o líquido escrito
--     à mão, e a razão pela qual difere do calculado.
--
-- 🔴 `net_salary` continua a ser o valor pago, e é ele que a saída de caixa
--    usa. O `override` não é um segundo total a competir com o primeiro: é a
--    origem do que ficou em `net_salary`. Quando é NULL, o líquido veio da
--    conta; quando não é, veio da mão de alguém — e a razão está lá ao lado,
--    obrigatoriamente. Duas colunas de total, uma «calculada» e outra «real»,
--    seriam a próxima pergunta sem resposta: qual delas se paga?
--
-- As horas continuam a ser gravadas. Deixam é de decidir o salário: passam a
-- ser assiduidade, que é o que sempre foram na prática.
--
-- Compatibilidade
-- ---------------
--
-- Colunas novas com DEFAULT, nada é reescrito. As 140 linhas de folha que já
-- existem ficam com `base_salary = 0` e `net_salary_override = NULL` — que é
-- exactamente o que descreve o passado: não havia base, e nenhum líquido foi
-- escrito à mão. Nenhum valor histórico muda.
-- ============================================================================

DO $precondicoes$
BEGIN
  IF to_regclass('public.payroll_records') IS NULL
     OR to_regclass('public.profiles') IS NULL
     OR to_regclass('public.company_settings') IS NULL
     OR to_regprocedure('public.adjust_payroll_record_atomic(uuid,uuid,jsonb,uuid)') IS NULL
     OR to_regprocedure('public.upsert_payroll_records_atomic(uuid,integer,integer,jsonb,uuid)') IS NULL
  THEN
    RAISE EXCEPTION '098_PRECONDITION_FAILED: a 096 tem de estar aplicada antes desta';
  END IF;
END;
$precondicoes$;

-- ─── 1. Colunas ─────────────────────────────────────────────────────────────

ALTER TABLE public.profiles
  ADD COLUMN IF NOT EXISTS base_salary_monthly numeric;

ALTER TABLE public.company_settings
  ADD COLUMN IF NOT EXISTS default_base_salary_monthly numeric;

ALTER TABLE public.payroll_records
  ADD COLUMN IF NOT EXISTS base_salary numeric NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS net_salary_override numeric,
  ADD COLUMN IF NOT EXISTS net_salary_override_reason text;

-- 🔴 A razão é obrigatória quando há override, e proibida quando não há.
--
--    A primeira metade é óbvia. A segunda existe para que a coluna não fique
--    com a razão de um override que entretanto foi retirado — uma explicação
--    órfã a descrever um valor que já não está lá é pior do que nenhuma.
ALTER TABLE public.payroll_records
  DROP CONSTRAINT IF EXISTS payroll_net_override_needs_reason;

ALTER TABLE public.payroll_records
  ADD CONSTRAINT payroll_net_override_needs_reason CHECK (
    (net_salary_override IS NULL     AND net_salary_override_reason IS NULL)
    OR
    (net_salary_override IS NOT NULL AND length(btrim(coalesce(net_salary_override_reason, ''))) >= 3)
  );

COMMENT ON COLUMN public.payroll_records.base_salary IS
  'Vencimento base usado NESTE mês. Guardado na linha de propósito: um aumento futuro não reescreve uma folha passada.';
COMMENT ON COLUMN public.payroll_records.net_salary_override IS
  'Líquido escrito à mão. NULL = o líquido veio da conta. Não é um segundo total: net_salary continua a ser o que se paga.';

-- ─── 2. O cálculo dentro da RPC de ajuste ───────────────────────────────────

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

  -- ── O líquido escrito à mão ───────────────────────────────────────────────
  --
  -- 🔴 `p_patch ? 'net_salary_override'` distingue «não mexeu» de «apagou».
  --    Sem isto, retirar um override seria impossível: um `COALESCE` sobre
  --    NULL não sabe se o NULL é ausência ou intenção.
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
    -- Sem override, não fica razão órfã.
    v_reason := NULL;
  END IF;

  -- `net_salary` é o que se paga: ou o valor escrito à mão, ou a conta.
  v_net := COALESCE(v_override, (p_patch->>'net_salary')::numeric, v_row.net_salary);
  IF v_net IS NULL OR v_net::text IN ('NaN', 'Infinity', '-Infinity') OR abs(v_net) > 100000000 THEN
    RAISE EXCEPTION 'PAYROLL_INVALID_TOTAL' USING ERRCODE = '22023';
  END IF;

  UPDATE public.payroll_records SET
    base_salary = COALESCE((p_patch->>'base_salary')::numeric, base_salary),
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
      -- 🔴 O calculado vai para a auditoria mesmo quando não é o que se paga.
      --    Sem isto, um override apagaria da história o número que ele
      --    substituiu, e a diferença deixaria de ser auditável.
      'net_calculado', (p_patch->>'net_salary')::numeric,
      'net_override', v_after.net_salary_override,
      'override_reason', v_after.net_salary_override_reason,
      'before', to_jsonb(v_row), 'after', to_jsonb(v_after)
    )
  );
  RETURN QUERY SELECT p_record_id, v_after.net_salary;
END;
$$;

-- ─── 3. O cálculo mensal grava o base usado ─────────────────────────────────

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

    -- 🔴 Uma linha já aprovada ou paga é uma fotografia: conta-se, não se
    --    toca. A mesma regra da 096 — o recálculo não reescreve o passado.
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
        -- 🔴 Um líquido escrito à mão sobrevive ao recálculo do mês.
        --    Sem esta linha, carregar em «Recalcular» apagava em silêncio a
        --    decisão de quem escreveu o valor — e o total voltava à conta sem
        --    ninguém pedir.
        AND public.payroll_records.net_salary_override IS NULL;
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

-- ─── 4. ACL — igual à da 096, reafirmada ────────────────────────────────────

REVOKE ALL ON FUNCTION public.adjust_payroll_record_atomic(uuid, uuid, jsonb, uuid) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.upsert_payroll_records_atomic(uuid, integer, integer, jsonb, uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.adjust_payroll_record_atomic(uuid, uuid, jsonb, uuid) TO service_role;
GRANT EXECUTE ON FUNCTION public.upsert_payroll_records_atomic(uuid, integer, integer, jsonb, uuid) TO service_role;

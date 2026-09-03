-- ============================================================================
-- 096 — segurança de período da folha
-- ============================================================================
--
-- O runner é o dono da transação e do registo no `_migrations`: este ficheiro
-- não abre `BEGIN`/`COMMIT` próprios.
--
-- ---------------------------------------------------------------------------
-- 🔴 ÂMBITO: PAYROLL_PERIOD_SAFETY_ONLY
-- ---------------------------------------------------------------------------
--
-- Esta migration NÃO toca no cálculo da folha. Nada de componentes de
-- remuneração, nada de termos de compensação, nada de novas fórmulas. O
-- `gross_salary`, o `meal_allowance`, o `overtime_bonus` e o `net_salary`
-- continuam a ser calculados exactamente onde são hoje —
-- `src/app/actions/payroll.ts` e `src/lib/calculations.ts` — e chegam aqui já
-- feitos.
--
-- O que muda é uma coisa só: as escritas passam a acontecer dentro do protocolo
-- de período, e a folha e o caixa passam a ser uma transação.
--
-- Se a frente PAYROLL-SAFETY/FLEX vier a precisar destas funções como base:
-- `PAYROLL_SAFETY_REUSE_LATER = YES`. Elas recebem valores já calculados, e é
-- por isso que continuam a servir quando o cálculo mudar.
--
-- ---------------------------------------------------------------------------
-- O que falta hoje, exactamente
-- ---------------------------------------------------------------------------
--
-- Os quatro writers da folha TÊM guarda — `bloquearSePeriodoFechado` e
-- `bloquearSePeriodoFechadoPorIds` — e ela está na server action, uma viagem
-- antes da escrita. `RACY`, portanto, e não `NO_GUARD`.
--
-- Mas `markPayrollPaid` tem um segundo defeito, e o próprio ficheiro admite-o:
--
--     «⚠️ A atomicidade desta operação continua por resolver: o `update` da
--      folha e o `insert` do movimento de caixa são duas escritas separadas, e
--      uma falha entre elas deixa salário pago sem saída de caixa.»
--
-- É a P0B. Fica fechada aqui, porque é a mesma transação que o período exige.
--
-- ---------------------------------------------------------------------------
-- 🔴 Um lote de folhas é um lote de PERÍODOS
-- ---------------------------------------------------------------------------
--
-- `approvePayrollRecords` e `markPayrollPaid` recebem uma LISTA de ids. Nada
-- obriga essa lista a ser toda do mesmo mês — a guarda actual até o reconhece,
-- e verifica todos. Cada registo traz a sua competência, e o pagamento traz
-- ainda a data em que o dinheiro sai.
--
-- Conjunto de períodos = todas as competências do lote + o dia do pagamento.
-- Sem número fixo. É o protocolo de N períodos da 090.
--
-- ---------------------------------------------------------------------------
-- 🔴 Uma nota sobre `ON CONFLICT` que NÃO se corrige aqui
-- ---------------------------------------------------------------------------
--
-- `runPayrollCalculation` faz hoje
--
--     .upsert(upserts, { onConflict: "company_id,collaborator_id,period_year,period_month" })
--
-- e não existe, em nenhuma migration deste repositório, índice único sobre
-- essas quatro colunas — só o índice NÃO-único `idx_payroll_company_period`.
-- Ou a restrição foi criada fora do ledger, ou este caminho falha com 42P10.
--
-- Isto fica REGISTADO e não é resolvido por esta migration: criar a restrição
-- exigiria decidir o que fazer a duplicados que possam existir em produção, e
-- isso é uma decisão de dados, não de protocolo. `upsert_payroll_records_atomic`
-- abaixo não depende dela — faz `UPDATE` e, se não houver linha, `INSERT` — e é
-- por isso que funciona nos dois mundos.
-- ============================================================================

DO $precondicoes$
DECLARE
  v_faltam text[];
BEGIN
  SELECT array_agg(esperado.nome || '(' || esperado.assinatura || ')') INTO v_faltam
    FROM (VALUES
      ('assert_financial_periods_open_locked_many', 'p_company_id uuid, p_keys integer[]'),
      ('financial_period_lock_key',                 'p_year integer, p_month integer'),
      ('financial_period_lock_keys',                'p_dates date[]')
    ) AS esperado(nome, assinatura)
   WHERE NOT EXISTS (
     SELECT 1 FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
      WHERE n.nspname = 'public' AND p.proname = esperado.nome
        AND pg_get_function_identity_arguments(p.oid) = esperado.assinatura
   );

  IF v_faltam IS NOT NULL THEN
    RAISE EXCEPTION 'PAYROLL_PERIOD_096_PRECONDITION_FAILED: em falta %', v_faltam;
  END IF;

  IF to_regclass('public.payroll_records') IS NULL THEN
    RAISE EXCEPTION 'PAYROLL_PERIOD_096_PRECONDITION_FAILED: tabela payroll_records ausente';
  END IF;
END
$precondicoes$;

-- ─── 1. Materializar a folha calculada, sob o lock da competência ───────────
--
-- NOVA. Recebe as linhas JÁ CALCULADAS e grava-as. O cálculo não entra aqui —
-- ver o âmbito no topo.
--
-- 🔴 Preserva a regra que a action já tem: uma folha `aprovado` ou `pago` NÃO é
--    reescrita por um recálculo. Fixar o valor a pagar é o que aprovar
--    significa, e um recálculo por cima apagava-o sem deixar rasto.
CREATE OR REPLACE FUNCTION public.upsert_payroll_records_atomic(
  p_company_id   uuid,
  p_period_year  integer,
  p_period_month integer,
  p_records      jsonb,
  p_actor        uuid DEFAULT NULL
)
RETURNS TABLE (gravados int, preservados int)
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = pg_catalog, public
AS $fn$
DECLARE
  v_rec         jsonb;
  v_colaborador uuid;
  v_estado      text;
  v_gravados    int := 0;
  v_preservados int := 0;
BEGIN
  IF p_company_id IS NULL OR p_period_year IS NULL OR p_period_month IS NULL THEN
    RAISE EXCEPTION 'PAYROLL_INVALID_ARGS' USING ERRCODE = 'check_violation';
  END IF;

  IF p_records IS NULL OR jsonb_typeof(p_records) <> 'array' THEN
    RAISE EXCEPTION 'PAYROLL_RECORDS_INVALID' USING ERRCODE = 'check_violation';
  END IF;

  IF p_actor IS NOT NULL THEN
    PERFORM set_config('app.actor_id', p_actor::text, true);
  END IF;

  PERFORM public.assert_financial_periods_open_locked_many(p_company_id, ARRAY[
    public.financial_period_lock_key(p_period_year, p_period_month)
  ]);

  FOR v_rec IN SELECT * FROM jsonb_array_elements(p_records) LOOP
    v_colaborador := (v_rec->>'collaborator_id')::uuid;
    IF v_colaborador IS NULL THEN
      RAISE EXCEPTION 'PAYROLL_RECORD_WITHOUT_COLLABORATOR' USING ERRCODE = 'check_violation';
    END IF;

    -- 🔴 `FOR UPDATE` e leitura do estado antes de escrever: é o que impede um
    --    recálculo de passar por cima de uma folha já aprovada ou paga.
    SELECT status INTO v_estado
      FROM public.payroll_records
     WHERE company_id = p_company_id
       AND collaborator_id = v_colaborador
       AND period_year = p_period_year
       AND period_month = p_period_month
     FOR UPDATE;

    IF FOUND AND v_estado IN ('aprovado', 'pago') THEN
      v_preservados := v_preservados + 1;
      CONTINUE;
    END IF;

    IF FOUND THEN
      UPDATE public.payroll_records SET
        contracted_hours   = COALESCE((v_rec->>'contracted_hours')::numeric, contracted_hours),
        worked_hours       = COALESCE((v_rec->>'worked_hours')::numeric, worked_hours),
        overtime_hours     = COALESCE((v_rec->>'overtime_hours')::numeric, overtime_hours),
        absence_hours      = COALESCE((v_rec->>'absence_hours')::numeric, absence_hours),
        days_worked        = COALESCE((v_rec->>'days_worked')::integer, days_worked),
        hourly_rate        = COALESCE((v_rec->>'hourly_rate')::numeric, hourly_rate),
        gross_salary       = COALESCE((v_rec->>'gross_salary')::numeric, gross_salary),
        meal_allowance     = COALESCE((v_rec->>'meal_allowance')::numeric, meal_allowance),
        overtime_bonus     = COALESCE((v_rec->>'overtime_bonus')::numeric, overtime_bonus),
        absence_deductions = COALESCE((v_rec->>'absence_deductions')::numeric, absence_deductions),
        other_additions    = COALESCE((v_rec->>'other_additions')::numeric, other_additions),
        other_deductions   = COALESCE((v_rec->>'other_deductions')::numeric, other_deductions),
        net_salary         = COALESCE((v_rec->>'net_salary')::numeric, net_salary),
        updated_at         = now()
       WHERE company_id = p_company_id
         AND collaborator_id = v_colaborador
         AND period_year = p_period_year
         AND period_month = p_period_month;
    ELSE
      -- 🔴 `INSERT` explícito em vez de `ON CONFLICT`: não existe, neste
      --    repositório, índice único sobre
      --    (company_id, collaborator_id, period_year, period_month) — ver a
      --    nota no topo. Sem restrição não há árbitro, e um `ON CONFLICT`
      --    falharia com 42P10. Esta forma funciona com ou sem ela.
      INSERT INTO public.payroll_records (
        company_id, collaborator_id, period_year, period_month,
        contracted_hours, worked_hours, overtime_hours, absence_hours, days_worked,
        hourly_rate, gross_salary, meal_allowance, overtime_bonus,
        absence_deductions, other_additions, other_deductions, net_salary, status
      ) VALUES (
        p_company_id, v_colaborador, p_period_year, p_period_month,
        (v_rec->>'contracted_hours')::numeric, (v_rec->>'worked_hours')::numeric,
        (v_rec->>'overtime_hours')::numeric, (v_rec->>'absence_hours')::numeric,
        (v_rec->>'days_worked')::integer, (v_rec->>'hourly_rate')::numeric,
        (v_rec->>'gross_salary')::numeric, (v_rec->>'meal_allowance')::numeric,
        (v_rec->>'overtime_bonus')::numeric, (v_rec->>'absence_deductions')::numeric,
        (v_rec->>'other_additions')::numeric, (v_rec->>'other_deductions')::numeric,
        (v_rec->>'net_salary')::numeric, 'rascunho'
      );
    END IF;

    v_gravados := v_gravados + 1;
  END LOOP;

  RETURN QUERY SELECT v_gravados, v_preservados;
END;
$fn$;

-- ─── 2. Ajustar uma folha, sob o lock da sua competência ────────────────────
--
-- NOVA. Recebe os valores JÁ recalculados pela action — a soma é a mesma de
-- `calcAdjustedNetSalary` e continua lá — e grava-os.
--
-- 🔴 Preserva a guarda final da action: a escrita só acontece sobre uma folha
--    em `rascunho`. Se outra sessão aprovou entretanto, esta operação não
--    encontra linha e recusa, em vez de passar por cima da aprovação.
CREATE OR REPLACE FUNCTION public.adjust_payroll_record_atomic(
  p_company_id uuid,
  p_record_id  uuid,
  p_patch      jsonb,
  p_actor      uuid DEFAULT NULL
)
RETURNS TABLE (record_id uuid)
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = pg_catalog, public
AS $fn$
DECLARE
  v_rec       public.payroll_records%ROWTYPE;
  v_proibidas text[];
  v_alteradas int;
BEGIN
  IF p_actor IS NOT NULL THEN
    PERFORM set_config('app.actor_id', p_actor::text, true);
  END IF;

  SELECT array_agg(k) INTO v_proibidas
    FROM jsonb_object_keys(p_patch) AS k
   WHERE k NOT IN ('worked_hours', 'overtime_hours', 'absence_hours', 'days_worked',
                   'hourly_rate', 'gross_salary', 'meal_allowance', 'overtime_bonus',
                   'absence_deductions', 'other_additions', 'other_deductions',
                   'net_salary', 'notes');

  IF v_proibidas IS NOT NULL THEN
    RAISE EXCEPTION 'PAYROLL_FIELD_NOT_EDITABLE: %', array_to_string(v_proibidas, ', ')
      USING ERRCODE = 'check_violation';
  END IF;

  SELECT * INTO v_rec
    FROM public.payroll_records
   WHERE id = p_record_id AND company_id = p_company_id
   FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'PAYROLL_RECORD_NOT_FOUND' USING ERRCODE = 'no_data_found';
  END IF;

  IF v_rec.status <> 'rascunho' THEN
    RAISE EXCEPTION 'PAYROLL_RECORD_NOT_DRAFT'
      USING ERRCODE = 'object_not_in_prerequisite_state',
            HINT = 'Uma folha aprovada ou paga já não se ajusta.';
  END IF;

  PERFORM public.assert_financial_periods_open_locked_many(p_company_id, ARRAY[
    public.financial_period_lock_key(v_rec.period_year, v_rec.period_month)
  ]);

  UPDATE public.payroll_records SET
    worked_hours       = COALESCE((p_patch->>'worked_hours')::numeric, worked_hours),
    overtime_hours     = COALESCE((p_patch->>'overtime_hours')::numeric, overtime_hours),
    absence_hours      = COALESCE((p_patch->>'absence_hours')::numeric, absence_hours),
    days_worked        = COALESCE((p_patch->>'days_worked')::integer, days_worked),
    hourly_rate        = COALESCE((p_patch->>'hourly_rate')::numeric, hourly_rate),
    gross_salary       = COALESCE((p_patch->>'gross_salary')::numeric, gross_salary),
    meal_allowance     = COALESCE((p_patch->>'meal_allowance')::numeric, meal_allowance),
    overtime_bonus     = COALESCE((p_patch->>'overtime_bonus')::numeric, overtime_bonus),
    absence_deductions = COALESCE((p_patch->>'absence_deductions')::numeric, absence_deductions),
    other_additions    = COALESCE((p_patch->>'other_additions')::numeric, other_additions),
    other_deductions   = COALESCE((p_patch->>'other_deductions')::numeric, other_deductions),
    net_salary         = COALESCE((p_patch->>'net_salary')::numeric, net_salary),
    notes              = CASE WHEN p_patch ? 'notes' THEN p_patch->>'notes' ELSE notes END,
    updated_at         = now()
   WHERE id = p_record_id AND company_id = p_company_id AND status = 'rascunho';

  GET DIAGNOSTICS v_alteradas = ROW_COUNT;
  IF v_alteradas = 0 THEN
    RAISE EXCEPTION 'PAYROLL_RECORD_NOT_DRAFT'
      USING ERRCODE = 'object_not_in_prerequisite_state';
  END IF;

  RETURN QUERY SELECT p_record_id;
END;
$fn$;

-- ─── 3. Aprovar um lote, com TODAS as competências protegidas ───────────────
--
-- NOVA. Preserva a resolução fechada da action: pedimos N, resolvemos N, ou não
-- se escreve nada — um id inexistente ou de outra empresa faz a operação
-- inteira recuar, em vez de aprovar menos linhas em silêncio.
--
-- 🔴 E preserva a razão pela qual o estado é lido: uma folha **paga** não volta
--    a `aprovado`. A saída de caixa ficaria lá, e a folha passaria a dizer que
--    está por pagar com o dinheiro já registado como saído.
CREATE OR REPLACE FUNCTION public.approve_payroll_records_atomic(
  p_company_id uuid,
  p_ids        uuid[],
  p_actor      uuid
)
RETURNS TABLE (aprovados int, ja_aprovados int)
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = pg_catalog, public
AS $fn$
DECLARE
  v_ids      uuid[];
  v_chaves   integer[];
  v_pagos    int;
  v_aprov    int := 0;
  v_ja       int := 0;
BEGIN
  IF p_actor IS NOT NULL THEN
    PERFORM set_config('app.actor_id', p_actor::text, true);
  END IF;

  SELECT array_agg(DISTINCT k) INTO v_ids FROM unnest(COALESCE(p_ids, ARRAY[]::uuid[])) AS k;

  IF v_ids IS NULL OR cardinality(v_ids) = 0 THEN
    RETURN QUERY SELECT 0, 0;
    RETURN;
  END IF;

  -- As linhas primeiro, em ordem estável pelo id: um lote e outro lote com
  -- ids sobrepostos trancam-nas pela mesma ordem, e não há ciclo entre eles.
  PERFORM 1 FROM public.payroll_records
   WHERE company_id = p_company_id AND id = ANY(v_ids)
   ORDER BY id
   FOR UPDATE;

  -- Falha fechada: pedimos N, resolvemos N.
  IF (SELECT count(*) FROM public.payroll_records
       WHERE company_id = p_company_id AND id = ANY(v_ids)) <> cardinality(v_ids) THEN
    RAISE EXCEPTION 'PAYROLL_SELECTION_STALE'
      USING ERRCODE = 'no_data_found',
            HINT = 'A seleção já não corresponde aos registos existentes.';
  END IF;

  SELECT count(*) INTO v_pagos
    FROM public.payroll_records
   WHERE company_id = p_company_id AND id = ANY(v_ids) AND status = 'pago';

  IF v_pagos > 0 THEN
    RAISE EXCEPTION 'PAYROLL_ALREADY_PAID'
      USING ERRCODE = 'object_not_in_prerequisite_state',
            HINT = 'Uma folha paga não volta a aprovada.';
  END IF;

  -- Todas as competências do lote, de uma vez.
  SELECT array_agg(DISTINCT public.financial_period_lock_key(period_year, period_month))
    INTO v_chaves
    FROM public.payroll_records
   WHERE company_id = p_company_id AND id = ANY(v_ids);

  PERFORM public.assert_financial_periods_open_locked_many(p_company_id, v_chaves);

  SELECT count(*) INTO v_ja
    FROM public.payroll_records
   WHERE company_id = p_company_id AND id = ANY(v_ids) AND status = 'aprovado';

  UPDATE public.payroll_records
     SET status = 'aprovado', approved_by = p_actor, updated_at = now()
   WHERE company_id = p_company_id AND id = ANY(v_ids) AND status = 'rascunho';
  GET DIAGNOSTICS v_aprov = ROW_COUNT;

  RETURN QUERY SELECT v_aprov, v_ja;
END;
$fn$;

-- ─── 4. Pagar um lote — folha E caixa na mesma transação ────────────────────
--
-- NOVA, e é esta que fecha a P0B.
--
-- Hoje `markPayrollPaid` faz o `update` das folhas numa viagem e o `insert` dos
-- movimentos de caixa noutra. O próprio ficheiro regista o defeito: uma falha
-- entre as duas deixa salário pago sem saída de caixa. O dinheiro sai da conta
-- da empresa no mundo real e não sai em lado nenhum no sistema.
--
-- 🔴 Os períodos são todas as competências do lote MAIS o dia do pagamento. Um
--    lote pode atravessar meses, e o movimento de caixa nasce com a data de
--    hoje — que pode ser outro mês ainda.
--
-- Preserva a idempotência da action: uma folha já `pago` não é repetida, e um
-- movimento de caixa que já exista para aquela folha não é duplicado.
CREATE OR REPLACE FUNCTION public.mark_payroll_paid_atomic(
  p_company_id uuid,
  p_ids        uuid[],
  p_paid_on    date DEFAULT NULL,
  p_actor      uuid DEFAULT NULL
)
RETURNS TABLE (pagos int, movimentos int)
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = pg_catalog, public
AS $fn$
DECLARE
  v_ids      uuid[];
  v_chaves   integer[];
  v_data     date;
  v_pagos    int := 0;
  v_movs     int := 0;
BEGIN
  IF p_actor IS NOT NULL THEN
    PERFORM set_config('app.actor_id', p_actor::text, true);
  END IF;

  SELECT array_agg(DISTINCT k) INTO v_ids FROM unnest(COALESCE(p_ids, ARRAY[]::uuid[])) AS k;

  IF v_ids IS NULL OR cardinality(v_ids) = 0 THEN
    RETURN QUERY SELECT 0, 0;
    RETURN;
  END IF;

  v_data := COALESCE(p_paid_on, (now() AT TIME ZONE 'Europe/Lisbon')::date);

  PERFORM 1 FROM public.payroll_records
   WHERE company_id = p_company_id AND id = ANY(v_ids)
   ORDER BY id
   FOR UPDATE;

  IF (SELECT count(*) FROM public.payroll_records
       WHERE company_id = p_company_id AND id = ANY(v_ids)) <> cardinality(v_ids) THEN
    RAISE EXCEPTION 'PAYROLL_SELECTION_STALE'
      USING ERRCODE = 'no_data_found',
            HINT = 'A seleção já não corresponde aos registos existentes.';
  END IF;

  -- Competências do lote + o dia em que o dinheiro sai.
  SELECT array_agg(DISTINCT public.financial_period_lock_key(period_year, period_month))
    INTO v_chaves
    FROM public.payroll_records
   WHERE company_id = p_company_id AND id = ANY(v_ids);

  PERFORM public.assert_financial_periods_open_locked_many(
    p_company_id, v_chaves || public.financial_period_lock_keys(ARRAY[v_data])
  );

  -- ── Os movimentos de caixa, para as folhas que ainda não estão pagas ──────
  --
  -- 🔴 Primeiro o caixa, e só depois o estado. Não é indiferente: a condição
  --    `status <> 'pago'` é o que distingue o que falta pagar, e mudá-la antes
  --    de inserir deixaria esta consulta sem nada para encontrar.
  --
  --    O `NOT EXISTS` é a idempotência: uma folha que já tenha movimento não
  --    ganha um segundo, mesmo que o estado dela tenha ficado por escrever numa
  --    tentativa anterior.
  WITH a_pagar AS (
    SELECT r.id, r.company_id, r.net_salary, r.period_year, r.period_month,
           COALESCE(pr.full_name, 'Colaborador') AS nome
      FROM public.payroll_records r
      LEFT JOIN public.profiles pr ON pr.id = r.collaborator_id
     WHERE r.company_id = p_company_id
       AND r.id = ANY(v_ids)
       AND r.status <> 'pago'
       AND r.net_salary IS NOT NULL
       AND r.net_salary > 0
       AND NOT EXISTS (
         SELECT 1 FROM public.cash_flow_entries c
          WHERE c.company_id = p_company_id
            AND c.reference_type = 'payroll'
            AND c.reference_id = r.id
       )
  )
  INSERT INTO public.cash_flow_entries (
    company_id, type, amount, description, category, date,
    reference_id, reference_type, status
  )
  SELECT a.company_id, 'saida', a.net_salary,
         'Salario ' || a.nome || ' - ' || a.period_month || '/' || a.period_year,
         'salario', v_data,
         a.id, 'payroll', 'confirmado'
    FROM a_pagar a;
  GET DIAGNOSTICS v_movs = ROW_COUNT;

  UPDATE public.payroll_records
     SET status = 'pago', paid_at = now(), updated_at = now()
   WHERE company_id = p_company_id AND id = ANY(v_ids) AND status <> 'pago';
  GET DIAGNOSTICS v_pagos = ROW_COUNT;

  RETURN QUERY SELECT v_pagos, v_movs;
END;
$fn$;

-- ─── Superfície ─────────────────────────────────────────────────────────────
REVOKE ALL PRIVILEGES ON FUNCTION public.upsert_payroll_records_atomic(uuid, integer, integer, jsonb, uuid) FROM PUBLIC, anon, authenticated;
REVOKE ALL PRIVILEGES ON FUNCTION public.adjust_payroll_record_atomic(uuid, uuid, jsonb, uuid) FROM PUBLIC, anon, authenticated;
REVOKE ALL PRIVILEGES ON FUNCTION public.approve_payroll_records_atomic(uuid, uuid[], uuid) FROM PUBLIC, anon, authenticated;
REVOKE ALL PRIVILEGES ON FUNCTION public.mark_payroll_paid_atomic(uuid, uuid[], date, uuid) FROM PUBLIC, anon, authenticated;

GRANT EXECUTE ON FUNCTION public.upsert_payroll_records_atomic(uuid, integer, integer, jsonb, uuid) TO postgres, service_role;
GRANT EXECUTE ON FUNCTION public.adjust_payroll_record_atomic(uuid, uuid, jsonb, uuid) TO postgres, service_role;
GRANT EXECUTE ON FUNCTION public.approve_payroll_records_atomic(uuid, uuid[], uuid) TO postgres, service_role;
GRANT EXECUTE ON FUNCTION public.mark_payroll_paid_atomic(uuid, uuid[], date, uuid) TO postgres, service_role;

-- ─── Pós-estado ─────────────────────────────────────────────────────────────
DO $posestado$
DECLARE
  v_faltam text[];
BEGIN
  SELECT array_agg(esperado.nome) INTO v_faltam
    FROM (VALUES
      ('upsert_payroll_records_atomic',  'p_company_id uuid, p_period_year integer, p_period_month integer, p_records jsonb, p_actor uuid'),
      ('adjust_payroll_record_atomic',   'p_company_id uuid, p_record_id uuid, p_patch jsonb, p_actor uuid'),
      ('approve_payroll_records_atomic', 'p_company_id uuid, p_ids uuid[], p_actor uuid'),
      ('mark_payroll_paid_atomic',       'p_company_id uuid, p_ids uuid[], p_paid_on date, p_actor uuid')
    ) AS esperado(nome, assinatura)
   WHERE NOT EXISTS (
     SELECT 1 FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
      WHERE n.nspname = 'public' AND p.proname = esperado.nome
        AND pg_get_function_identity_arguments(p.oid) = esperado.assinatura
        AND NOT p.prosecdef
   );

  IF v_faltam IS NOT NULL THEN
    RAISE EXCEPTION 'PAYROLL_PERIOD_096_POSTSTATE_FAILED: em falta ou com assinatura/segurança errada %', v_faltam;
  END IF;
END
$posestado$;

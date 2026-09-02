-- ============================================================================
-- 089 — recorrência explícita dos pagamentos fixos
-- ============================================================================
--
-- Não repara legado e não infere periodicidade. Linhas recorrentes existentes
-- sem configuração passam a ser lidas como LEGACY_RECURRENCE_UNKNOWN por uma
-- coluna gerada. O único writer de preparação é uma RPC explícita e atómica.
-- O runner é dono da transação e do ledger.
-- ============================================================================

DO $pre$
DECLARE
  v_table boolean;
  v_interval boolean;
  v_anchor boolean;
  v_state boolean;
  v_index boolean;
  v_fn_count integer;
BEGIN
  SELECT to_regclass('public.fixed_variable_payments') IS NOT NULL INTO v_table;
  SELECT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema='public' AND table_name='fixed_variable_payments'
      AND column_name='recurrence_interval_months'
  ) INTO v_interval;
  SELECT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema='public' AND table_name='fixed_variable_payments'
      AND column_name='recurrence_anchor_date'
  ) INTO v_anchor;
  SELECT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema='public' AND table_name='fixed_variable_payments'
      AND column_name='recurrence_state'
  ) INTO v_state;
  SELECT to_regclass('public.fixed_variable_payments_recurrence_period_unique') IS NOT NULL INTO v_index;
  SELECT count(*) INTO v_fn_count
  FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
  WHERE n.nspname='public' AND p.proname='prepare_recurring_payments_month_atomic';

  IF NOT coalesce(v_table,false) THEN
    RAISE EXCEPTION 'PAYMENT_RECURRENCE_089_PRECONDITION_TABLE_MISSING';
  END IF;

  -- Estado normal: tudo ausente. Poststate coerente: tudo presente e uma função.
  -- Qualquer estado parcial é terceiro estado e para antes de tocar no schema.
  IF (v_interval OR v_anchor OR v_state OR v_index OR v_fn_count > 0)
     AND NOT (v_interval AND v_anchor AND v_state AND v_index AND v_fn_count = 1) THEN
    RAISE EXCEPTION 'PAYMENT_RECURRENCE_089_PRECONDITION_PARTIAL_STATE';
  END IF;
END;
$pre$;

ALTER TABLE public.fixed_variable_payments
  ADD COLUMN IF NOT EXISTS recurrence_interval_months integer,
  ADD COLUMN IF NOT EXISTS recurrence_anchor_date date;

ALTER TABLE public.fixed_variable_payments
  DROP CONSTRAINT IF EXISTS fixed_variable_payments_recurrence_interval_valid,
  ADD CONSTRAINT fixed_variable_payments_recurrence_interval_valid
    CHECK (recurrence_interval_months IS NULL OR recurrence_interval_months > 0),
  DROP CONSTRAINT IF EXISTS fixed_variable_payments_recurrence_pair,
  ADD CONSTRAINT fixed_variable_payments_recurrence_pair
    CHECK ((recurrence_interval_months IS NULL) = (recurrence_anchor_date IS NULL));

-- Estado derivado: não há UPDATE/backfill nem tentativa de adivinhar legado.
ALTER TABLE public.fixed_variable_payments
  ADD COLUMN IF NOT EXISTS recurrence_state text
  GENERATED ALWAYS AS (
    CASE
      WHEN recurring IS NOT TRUE THEN 'NOT_RECURRING'
      WHEN recurrence_interval_months IS NULL OR recurrence_anchor_date IS NULL
        THEN 'LEGACY_RECURRENCE_UNKNOWN'
      ELSE 'CONFIGURED'
    END
  ) STORED;

-- Uma série só pode materializar uma linha por competência. source_id guarda a
-- identidade da série para as linhas geradas. Produção foi verificada antes da
-- criação desta migration: zero grupos duplicados neste predicado.
CREATE UNIQUE INDEX IF NOT EXISTS fixed_variable_payments_recurrence_period_unique
  ON public.fixed_variable_payments(company_id, source_id, period_year, period_month)
  WHERE source_id IS NOT NULL;

CREATE OR REPLACE FUNCTION public.prepare_recurring_payments_month_atomic(
  p_company_id uuid,
  p_year integer,
  p_month integer,
  p_actor uuid DEFAULT NULL
)
RETURNS TABLE (
  payment_id uuid,
  recurrence_source_id uuid,
  description text,
  due_date date
)
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = pg_catalog, public
AS $fn$
DECLARE
  v_month_start date;
  v_month_end date;
BEGIN
  IF p_year < 2000 OR p_year > 2200 OR p_month < 1 OR p_month > 12 THEN
    RAISE EXCEPTION 'PAYMENT_RECURRENCE_TARGET_INVALID'
      USING ERRCODE='check_violation';
  END IF;

  -- Um lock determinístico por empresa+mês faz duplo clique e concorrência
  -- convergirem para a mesma transação, sem mês parcialmente preparado.
  PERFORM pg_advisory_xact_lock(hashtext(p_company_id::text), p_year * 100 + p_month);

  v_month_start := make_date(p_year, p_month, 1);
  v_month_end := (v_month_start + interval '1 month - 1 day')::date;

  IF p_actor IS NOT NULL THEN
    PERFORM set_config('app.actor_id', p_actor::text, true);
  END IF;

  RETURN QUERY
  WITH candidates AS (
    SELECT
      p.*,
      COALESCE(p.source_id, p.id) AS series_id,
      ((p_year * 12 + p_month) -
        (extract(year from p.recurrence_anchor_date)::int * 12
         + extract(month from p.recurrence_anchor_date)::int)) AS month_delta
    FROM public.fixed_variable_payments p
    WHERE p.company_id = p_company_id
      AND p.kind = 'fixo'
      AND p.recurring IS TRUE
      AND p.recurrence_state = 'CONFIGURED'
      AND p.source_id IS NULL
      AND p.recurrence_anchor_date <= v_month_end
  ), eligible AS (
    SELECT c.*,
      make_date(
        p_year,
        p_month,
        LEAST(
          extract(day from c.recurrence_anchor_date)::int,
          extract(day from v_month_end)::int
        )
      ) AS target_due_date
    FROM candidates c
    WHERE c.month_delta >= 0
      AND mod(c.month_delta, c.recurrence_interval_months) = 0
      AND NOT EXISTS (
        SELECT 1
        FROM public.fixed_variable_payments existing
        WHERE existing.company_id = p_company_id
          AND existing.period_year = p_year
          AND existing.period_month = p_month
          AND (existing.id = c.series_id OR existing.source_id = c.series_id)
      )
  ), inserted AS (
    INSERT INTO public.fixed_variable_payments (
      company_id, kind, description, amount, due_date, direct_debit, status,
      recurring, period_year, period_month, notes, sort_order, source_id,
      created_by, expense_category_id, recurrence_interval_months,
      recurrence_anchor_date
    )
    SELECT
      p_company_id, 'fixo', e.description, e.amount, e.target_due_date,
      e.direct_debit, 'pendente', true, p_year, p_month, e.notes, e.sort_order,
      e.series_id, p_actor, e.expense_category_id,
      e.recurrence_interval_months, e.recurrence_anchor_date
    FROM eligible e
    -- Só a linha-raiz (`source_id IS NULL`) é candidata. As linhas já
    -- materializadas guardam a mesma identidade de série, mas não podem voltar
    -- a gerar descendentes quando se atravessa um novo ano.
    RETURNING id, source_id, fixed_variable_payments.description,
              fixed_variable_payments.due_date
  )
  SELECT i.id, i.source_id, i.description, i.due_date FROM inserted i;
END;
$fn$;

REVOKE ALL PRIVILEGES ON FUNCTION public.prepare_recurring_payments_month_atomic(uuid, integer, integer, uuid)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.prepare_recurring_payments_month_atomic(uuid, integer, integer, uuid)
  TO service_role;

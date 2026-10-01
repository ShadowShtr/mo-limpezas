-- ============================================================================
-- 107 — recorrência dos pagamentos fixos
-- ============================================================================
--
-- Os fixos deixaram de se repetir a 2026-08-11, quando a materialização
-- implícita foi posta em quarentena. Desde então cada mês é lançado à mão.
-- Esta migration devolve a repetição, cumprindo as condições que o incidente
-- deixou escritas (`docs/incidents/2026-08-11-pagamentos-materializacao-implicita.md` §6):
--
--   · a periodicidade passa a existir no modelo — mensal, bimestral,
--     trimestral, semestral, anual — e a data é aritmética sobre ela, não
--     uma deslocação cega do mês;
--   · ler não gera nada: a geração é uma RPC chamada por um cron e pelas
--     acções explícitas de quem cria um fixo;
--   · os fixos antigos NÃO ganham periodicidade por inferência — a semente
--     inicial é um ficheiro à parte, revisto linha a linha pelo dono.
--
-- ---------------------------------------------------------------------------
-- O modelo
-- ---------------------------------------------------------------------------
--
-- Uma recorrência é o MOLDE de um fixo: descrição, valor, categoria, dia de
-- vencimento, periodicidade. Cada mês gerado é uma linha normal de
-- `fixed_variable_payments`, com `recurrence_id` a apontar para o molde.
--
-- 🔴 O molde não é «a linha do mês anterior». Copiar a última linha foi o que a
--    versão em quarentena fazia, e tinha dois defeitos que aqui se evitam:
--    um trimestral não tem linha no mês anterior, e uma conta de valor variável
--    (luz) arrastaria para o mês seguinte um valor que só vale para um mês.
--    Com o molde, `amount` NULL quer dizer «aparece como lembrete, sem valor».
--
-- `generated_through` (chave AAAAMM, a mesma da 090) é até onde a recorrência
-- já foi gerada. A geração só avança, nunca recua: apagar uma linha gerada não
-- a faz reaparecer no dia seguinte.
--
-- ---------------------------------------------------------------------------
-- O que esta migration NÃO toca
-- ---------------------------------------------------------------------------
--
-- Nenhuma linha existente de `fixed_variable_payments` é alterada aqui, nem
-- nenhum anexo — nem as colunas `attachment_*` da 052, nem a tabela
-- `attachments` da 074, nem o storage. As linhas geradas nascem SEM anexo: o
-- comprovativo é de um mês, não do molde.
--
-- ---------------------------------------------------------------------------
-- 🔴 Sem `SELECT ... INTO` em lado nenhum
-- ---------------------------------------------------------------------------
--
-- O SQL Editor do Supabase lê `SELECT ... INTO x` como «criar a tabela x» e
-- injecta `ALTER TABLE x ENABLE ROW LEVEL SECURITY` a seguir — a meio do corpo
-- da função, que deixa de compilar (visto a 2026-10-01 ao aplicar esta
-- migration). Por isso as atribuições são todas `x := (SELECT ...)`.
-- ============================================================================

-- ─── 0. Precondições ────────────────────────────────────────────────────────
DO $precondicoes$
DECLARE
  v_faltam text;
BEGIN
  v_faltam := (SELECT string_agg(f, ', ')
    FROM unnest(ARRAY[
      'public.lock_financial_periods_many(uuid,integer[])',
      'public.is_financial_period_open(uuid,integer,integer)',
      'public.financial_period_lock_key(integer,integer)',
      'public.create_payment_atomic(uuid,text,text,numeric,date,integer,integer,uuid,boolean,text,uuid)'
    ]) AS f
   WHERE to_regprocedure(f) IS NULL);

  IF v_faltam IS NOT NULL THEN
    RAISE EXCEPTION 'PAYMENT_RECURRENCES_107_PRECONDITION_FAILED: em falta %', v_faltam;
  END IF;
END
$precondicoes$;

-- ─── 1. O molde ─────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS public.payment_recurrences (
  id                  uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id          uuid        NOT NULL REFERENCES public.companies(id) ON DELETE CASCADE,
  description         text        NOT NULL CHECK (btrim(description) <> ''),
  -- NULL = repete como lembrete, sem valor (contas de luz, por exemplo).
  amount              numeric(10,2) CHECK (amount IS NULL OR amount >= 0),
  expense_category_id uuid,
  direct_debit        boolean     NOT NULL DEFAULT false,
  notes               text,
  sort_order          integer     NOT NULL DEFAULT 0,
  interval_months     smallint    NOT NULL CHECK (interval_months IN (1, 2, 3, 6, 12)),
  -- Dia do vencimento. Num mês mais curto, cai no último dia (31 → 30/28).
  -- NULL = as linhas geradas nascem sem vencimento.
  due_day             smallint    CHECK (due_day IS NULL OR due_day BETWEEN 1 AND 31),
  -- Chave AAAAMM do último mês já gerado (ou do mês da linha de origem).
  generated_through   integer     NOT NULL
                        CHECK (generated_through % 100 BETWEEN 1 AND 12 AND generated_through > 200000),
  active              boolean     NOT NULL DEFAULT true,
  ended_at            timestamptz,
  -- Proveniência: a linha a partir da qual o molde foi feito. Sem FK de
  -- propósito — apagar essa linha não pode apagar nem bloquear a recorrência.
  source_payment_id   uuid,
  created_by          uuid        REFERENCES public.profiles(id) ON DELETE SET NULL,
  created_at          timestamptz NOT NULL DEFAULT now(),
  updated_at          timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_payment_recurrences_company_active
  ON public.payment_recurrences (company_id) WHERE active;

ALTER TABLE public.fixed_variable_payments
  ADD COLUMN IF NOT EXISTS recurrence_id uuid
    REFERENCES public.payment_recurrences(id) ON DELETE SET NULL;

-- 🔴 A garantia de que um mês nunca recebe o mesmo fixo duas vezes vive aqui,
--    e não no código: duas gerações simultâneas, ou um cron repetido, batem
--    neste índice e a segunda inserção não acontece.
CREATE UNIQUE INDEX IF NOT EXISTS uq_fvp_recurrence_period
  ON public.fixed_variable_payments (recurrence_id, period_year, period_month)
  WHERE recurrence_id IS NOT NULL;

-- ─── 2. ACL — fechado por conjunto, como a 084 ──────────────────────────────
--
-- Uma tabela nova em Supabase nasce com os default privileges do schema, que
-- dão ALL a anon e authenticated. Revoga-se tudo e concede-se só o que o
-- caminho canónico (service_role, via RPC) precisa.
ALTER TABLE public.payment_recurrences ENABLE ROW LEVEL SECURITY;

REVOKE ALL PRIVILEGES ON TABLE public.payment_recurrences FROM PUBLIC;
DO $acl$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'anon') THEN
    EXECUTE 'REVOKE ALL PRIVILEGES ON TABLE public.payment_recurrences FROM anon';
  END IF;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'authenticated') THEN
    EXECUTE 'REVOKE ALL PRIVILEGES ON TABLE public.payment_recurrences FROM authenticated';
  END IF;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'service_role') THEN
    EXECUTE 'REVOKE ALL PRIVILEGES ON TABLE public.payment_recurrences FROM service_role';
    -- Sem DELETE: parar uma recorrência é `active = false`, para o histórico
    -- de onde vieram as linhas geradas não desaparecer.
    EXECUTE 'GRANT SELECT, INSERT, UPDATE ON TABLE public.payment_recurrences TO service_role';
  END IF;
END
$acl$;

-- ─── 3. Utilitários de mês ──────────────────────────────────────────────────

-- AAAAMM + n meses → AAAAMM.
CREATE OR REPLACE FUNCTION public.payment_period_key_add(p_key integer, p_months integer)
RETURNS integer
LANGUAGE sql
IMMUTABLE
AS $fn$
  SELECT ((((p_key / 100) * 12 + (p_key % 100) - 1) + p_months) / 12) * 100
       + ((((p_key / 100) * 12 + (p_key % 100) - 1) + p_months) % 12) + 1;
$fn$;

-- O vencimento de uma recorrência num mês: o dia do molde, ou o último dia do
-- mês quando este é mais curto.
CREATE OR REPLACE FUNCTION public.payment_recurrence_due_date(p_key integer, p_due_day smallint)
RETURNS date
LANGUAGE sql
IMMUTABLE
AS $fn$
  SELECT CASE WHEN p_due_day IS NULL THEN NULL ELSE
    make_date(p_key / 100, p_key % 100, LEAST(
      p_due_day::integer,
      extract(day FROM (make_date(p_key / 100, p_key % 100, 1) + interval '1 month - 1 day'))::integer
    ))
  END;
$fn$;

-- ─── 4. Gerar ───────────────────────────────────────────────────────────────
--
-- Gera, para cada recorrência activa, as ocorrências cuja chave cai em
-- [p_from_key, p_through_key]. Idempotente: correr duas vezes seguidas cria
-- zero linhas na segunda.
--
-- 🔴 `GENERATION_FLOOR = 202611`. Nada é gerado antes de Novembro de 2026,
--    seja qual for o argumento. Outubro de 2026 está a ser lançado à mão
--    enquanto esta migration é escrita, e é decisão do dono que fique como
--    está. O piso vive na base para não depender de o chamador se lembrar.
--
-- Ocorrências abaixo de `p_from_key` (o mês corrente, ou meses que passaram
-- sem o cron correr) são SALTADAS, não recuperadas: o mês corrente é sempre
-- de quem o está a preencher. `generated_through` avança por cima delas.
--
-- Ordem dos locks, a da 090: LINHAS primeiro (as recorrências, FOR UPDATE),
-- PERÍODOS depois (todos de uma vez, ordenados), e só então as perguntas.
-- Um mês fechado no futuro — não devia existir — é saltado, não aborta os
-- outros.
CREATE OR REPLACE FUNCTION public.generate_recurring_payments_atomic(
  p_company_id    uuid,
  p_from_key      integer,
  p_through_key   integer,
  p_recurrence_id uuid DEFAULT NULL
)
RETURNS TABLE (criados integer, saltados_fechados integer)
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = pg_catalog, public
AS $fn$
DECLARE
  c_floor    CONSTANT integer := 202611;
  v_from     integer;
  v_rec      public.payment_recurrences%ROWTYPE;
  v_recs     public.payment_recurrences[] := ARRAY[]::public.payment_recurrences[];
  v_alvos    integer[] := ARRAY[]::integer[];
  v_k        integer;
  v_fechados integer[] := ARRAY[]::integer[];
  v_criados  integer := 0;
  v_saltados integer := 0;
  v_n        integer;
BEGIN
  IF p_company_id IS NULL OR p_from_key IS NULL OR p_through_key IS NULL THEN
    RAISE EXCEPTION 'PAYMENT_RECURRENCE_INVALID_ARGS' USING ERRCODE = 'check_violation';
  END IF;

  v_from := GREATEST(p_from_key, c_floor);
  IF v_from > p_through_key THEN
    RETURN QUERY SELECT 0, 0;
    RETURN;
  END IF;

  -- 1) Linhas.
  FOR v_rec IN
    SELECT * FROM public.payment_recurrences
     WHERE company_id = p_company_id
       AND active
       AND (p_recurrence_id IS NULL OR id = p_recurrence_id)
       AND public.payment_period_key_add(generated_through, interval_months) <= p_through_key
     ORDER BY id
     FOR UPDATE
  LOOP
    v_recs := v_recs || v_rec;
    v_k := public.payment_period_key_add(v_rec.generated_through, v_rec.interval_months);
    WHILE v_k <= p_through_key LOOP
      IF v_k >= v_from THEN v_alvos := v_alvos || v_k; END IF;
      v_k := public.payment_period_key_add(v_k, v_rec.interval_months);
    END LOOP;
  END LOOP;

  IF cardinality(v_recs) = 0 THEN
    RETURN QUERY SELECT 0, 0;
    RETURN;
  END IF;

  -- 2) Períodos, todos de uma vez; 3) só depois as perguntas.
  IF cardinality(v_alvos) > 0 THEN
    PERFORM public.lock_financial_periods_many(p_company_id, v_alvos);
    v_fechados := ARRAY(
      SELECT k FROM (SELECT DISTINCT unnest(v_alvos) AS k) s
       WHERE NOT public.is_financial_period_open(p_company_id, k / 100, k % 100)
    );
  END IF;

  -- 4) Escrita.
  FOREACH v_rec IN ARRAY v_recs LOOP
    v_k := public.payment_period_key_add(v_rec.generated_through, v_rec.interval_months);
    WHILE v_k <= p_through_key LOOP
      IF v_k >= v_from THEN
        IF v_k = ANY (v_fechados) THEN
          v_saltados := v_saltados + 1;
        ELSE
          INSERT INTO public.fixed_variable_payments (
            company_id, kind, description, amount, due_date, expense_category_id,
            direct_debit, status, recurring, period_year, period_month, notes,
            sort_order, recurrence_id, created_by
          ) VALUES (
            p_company_id, 'fixo', v_rec.description, v_rec.amount,
            public.payment_recurrence_due_date(v_k, v_rec.due_day),
            v_rec.expense_category_id, v_rec.direct_debit, 'pendente', true,
            v_k / 100, v_k % 100, v_rec.notes, v_rec.sort_order, v_rec.id, NULL
          )
          ON CONFLICT (recurrence_id, period_year, period_month)
            WHERE recurrence_id IS NOT NULL
          DO NOTHING;
          GET DIAGNOSTICS v_n = ROW_COUNT;
          v_criados := v_criados + v_n;
        END IF;
      END IF;
      UPDATE public.payment_recurrences
         SET generated_through = v_k, updated_at = now()
       WHERE id = v_rec.id;
      v_k := public.payment_period_key_add(v_k, v_rec.interval_months);
    END LOOP;
  END LOOP;

  RETURN QUERY SELECT v_criados, v_saltados;
END;
$fn$;

-- ─── 5. Tornar recorrente um fixo que já existe ─────────────────────────────
--
-- «Repetir…» no menu de um fixo. O molde é tirado da própria linha, e a linha
-- passa a pertencer à recorrência — é ela a primeira ocorrência.
--
-- 🔴 Só se escreve `recurrence_id` e `recurring` na linha. Nem valor, nem
--    vencimento, nem anexos: o conteúdo económico do mês não muda, e por isso
--    o lock do período da linha não é pedido — tornar recorrente o fixo de um
--    mês já fechado tem de continuar a ser possível.
CREATE OR REPLACE FUNCTION public.make_payment_recurring_atomic(
  p_company_id      uuid,
  p_payment_id      uuid,
  p_interval_months smallint,
  p_actor           uuid DEFAULT NULL
)
RETURNS TABLE (recurrence_id uuid)
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = pg_catalog, public
AS $fn$
DECLARE
  v_pag public.fixed_variable_payments%ROWTYPE;
  v_id  uuid;
BEGIN
  IF p_company_id IS NULL OR p_payment_id IS NULL OR p_interval_months IS NULL THEN
    RAISE EXCEPTION 'PAYMENT_RECURRENCE_INVALID_ARGS' USING ERRCODE = 'check_violation';
  END IF;

  v_pag := (
    SELECT p FROM public.fixed_variable_payments p
     WHERE p.id = p_payment_id AND p.company_id = p_company_id
     FOR UPDATE
  );

  IF v_pag.id IS NULL THEN
    RAISE EXCEPTION 'PAYMENT_NOT_FOUND' USING ERRCODE = 'no_data_found';
  END IF;
  IF v_pag.kind <> 'fixo' THEN
    RAISE EXCEPTION 'PAYMENT_RECURRENCE_ONLY_FIXED' USING ERRCODE = 'check_violation';
  END IF;
  IF v_pag.recurrence_id IS NOT NULL THEN
    RAISE EXCEPTION 'PAYMENT_ALREADY_RECURRING' USING ERRCODE = 'unique_violation';
  END IF;

  IF p_actor IS NOT NULL THEN
    PERFORM set_config('app.actor_id', p_actor::text, true);
  END IF;

  INSERT INTO public.payment_recurrences (
    company_id, description, amount, expense_category_id, direct_debit, notes,
    sort_order, interval_months, due_day, generated_through, source_payment_id,
    created_by
  ) VALUES (
    p_company_id, v_pag.description, v_pag.amount, v_pag.expense_category_id,
    COALESCE(v_pag.direct_debit, false), v_pag.notes, COALESCE(v_pag.sort_order, 0),
    p_interval_months, extract(day FROM v_pag.due_date)::smallint,
    public.financial_period_lock_key(v_pag.period_year, v_pag.period_month),
    v_pag.id, p_actor
  )
  RETURNING id INTO v_id;

  UPDATE public.fixed_variable_payments
     SET recurrence_id = v_id, recurring = true
   WHERE id = v_pag.id;

  RETURN QUERY SELECT v_id;
END;
$fn$;

-- ─── 6. Criar um fixo já recorrente — uma transacção ────────────────────────
--
-- «Novo fixo» com periodicidade. Criar a linha e o molde em dois pedidos
-- deixava, na falha do segundo, um fixo que não se repete sem ninguém saber.
CREATE OR REPLACE FUNCTION public.create_recurring_payment_atomic(
  p_company_id          uuid,
  p_description         text,
  p_amount              numeric,
  p_due_date            date,
  p_period_year         integer,
  p_period_month        integer,
  p_interval_months     smallint,
  p_expense_category_id uuid DEFAULT NULL,
  p_direct_debit        boolean DEFAULT false,
  p_notes               text DEFAULT NULL,
  p_actor               uuid DEFAULT NULL
)
RETURNS TABLE (payment_id uuid, recurrence_id uuid)
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = pg_catalog, public
AS $fn$
DECLARE
  v_pag uuid;
  v_rec uuid;
BEGIN
  v_pag := (
    SELECT c.payment_id FROM public.create_payment_atomic(
      p_company_id, 'fixo', p_description, p_amount, p_due_date,
      p_period_year, p_period_month, p_expense_category_id, p_direct_debit,
      p_notes, p_actor
    ) AS c
  );

  v_rec := (
    SELECT m.recurrence_id
      FROM public.make_payment_recurring_atomic(p_company_id, v_pag, p_interval_months, p_actor) AS m
  );

  RETURN QUERY SELECT v_pag, v_rec;
END;
$fn$;

-- ─── 7. Parar de repetir ────────────────────────────────────────────────────
--
-- Desliga a recorrência e apaga as ocorrências FUTURAS (chave > p_after_key)
-- que ainda não têm nada de ninguém. Uma ocorrência gerada é mantida — e
-- contada em `mantidos` — se tiver QUALQUER uma destas coisas:
--
--   · estado diferente de `pendente`;
--   · movimento de caixa ligado, ou proveniência registada;
--   · anexo, seja na coluna `attachment_url` (052) seja na tabela
--     `attachments` (074).
--
-- 🔴 Os anexos não têm FK para o pagamento (a 074 é polimórfica), por isso
--    apagar a linha deixaria o anexo órfão sem erro nenhum. É por isso que a
--    regra é «não se apaga», e não «apaga-se e o anexo fica».
CREATE OR REPLACE FUNCTION public.stop_payment_recurrence_atomic(
  p_company_id    uuid,
  p_recurrence_id uuid,
  p_after_key     integer,
  p_actor         uuid DEFAULT NULL
)
RETURNS TABLE (apagados integer, mantidos integer)
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = pg_catalog, public
AS $fn$
DECLARE
  v_ids      uuid[];
  v_chaves   integer[];
  v_apagados integer := 0;
  v_futuros  integer := 0;
BEGIN
  IF p_company_id IS NULL OR p_recurrence_id IS NULL OR p_after_key IS NULL THEN
    RAISE EXCEPTION 'PAYMENT_RECURRENCE_INVALID_ARGS' USING ERRCODE = 'check_violation';
  END IF;

  IF p_actor IS NOT NULL THEN
    PERFORM set_config('app.actor_id', p_actor::text, true);
  END IF;

  -- Linhas primeiro: a recorrência, depois as ocorrências futuras.
  PERFORM 1 FROM public.payment_recurrences
    WHERE id = p_recurrence_id AND company_id = p_company_id
    FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'PAYMENT_RECURRENCE_NOT_FOUND' USING ERRCODE = 'no_data_found';
  END IF;

  UPDATE public.payment_recurrences
     SET active = false, ended_at = COALESCE(ended_at, now()), updated_at = now()
   WHERE id = p_recurrence_id;

  v_futuros := (
    SELECT count(*) FROM public.fixed_variable_payments p
     WHERE p.company_id = p_company_id
       AND p.recurrence_id = p_recurrence_id
       AND public.financial_period_lock_key(p.period_year, p.period_month) > p_after_key
  );

  v_ids := ARRAY(
      SELECT p.id FROM public.fixed_variable_payments p
       WHERE p.company_id = p_company_id
         AND p.recurrence_id = p_recurrence_id
         AND public.financial_period_lock_key(p.period_year, p.period_month) > p_after_key
         AND p.status = 'pendente'
         AND p.attachment_url IS NULL
         AND NOT EXISTS (SELECT 1 FROM public.attachments a
                          WHERE a.company_id = p.company_id
                            AND a.parent_type = 'fixed_variable_payment'
                            AND a.parent_id = p.id)
         AND NOT EXISTS (SELECT 1 FROM public.cash_flow_entries c
                          WHERE c.company_id = p.company_id
                            AND c.reference_type = 'fixed_variable_payment'
                            AND c.reference_id = p.id)
         AND NOT EXISTS (SELECT 1 FROM public.payment_cashflow_provenance v
                          WHERE v.payment_id = p.id)
       ORDER BY p.id
       FOR UPDATE
  );
  v_chaves := ARRAY(
    SELECT DISTINCT public.financial_period_lock_key(p.period_year, p.period_month)
      FROM public.fixed_variable_payments p
     WHERE p.id = ANY (v_ids)
  );

  IF cardinality(v_ids) > 0 THEN
    -- Períodos depois, e todos abertos — ou nada é apagado.
    PERFORM public.assert_financial_periods_open_locked_many(p_company_id, v_chaves);
    DELETE FROM public.fixed_variable_payments WHERE id = ANY (v_ids);
    GET DIAGNOSTICS v_apagados = ROW_COUNT;
  END IF;

  RETURN QUERY SELECT v_apagados, v_futuros - v_apagados;
END;
$fn$;

-- ─── 8. Execução — só o service_role ────────────────────────────────────────
DO $exec$
DECLARE
  f text;
BEGIN
  FOREACH f IN ARRAY ARRAY[
    'public.generate_recurring_payments_atomic(uuid,integer,integer,uuid)',
    'public.make_payment_recurring_atomic(uuid,uuid,smallint,uuid)',
    'public.create_recurring_payment_atomic(uuid,text,numeric,date,integer,integer,smallint,uuid,boolean,text,uuid)',
    'public.stop_payment_recurrence_atomic(uuid,uuid,integer,uuid)'
  ] LOOP
    EXECUTE format('REVOKE ALL ON FUNCTION %s FROM PUBLIC', f);
    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'anon') THEN
      EXECUTE format('REVOKE ALL ON FUNCTION %s FROM anon', f);
    END IF;
    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'authenticated') THEN
      EXECUTE format('REVOKE ALL ON FUNCTION %s FROM authenticated', f);
    END IF;
    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'service_role') THEN
      EXECUTE format('GRANT EXECUTE ON FUNCTION %s TO service_role', f);
    END IF;
  END LOOP;
END
$exec$;

COMMENT ON TABLE public.payment_recurrences IS
  'Molde de um pagamento fixo recorrente (107). Cada mês gerado é uma linha de '
  'fixed_variable_payments com recurrence_id. Gerado por generate_recurring_payments_atomic '
  '(cron diário, 4 meses à frente, nunca o mês corrente, nunca antes de 2026-11). '
  'ACL: só service_role, SELECT/INSERT/UPDATE.';

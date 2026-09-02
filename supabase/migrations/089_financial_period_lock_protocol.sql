-- ============================================================================
-- 089 — protocolo único de serialização do período financeiro
-- ============================================================================
--
-- O runner é o dono da transação e do registo no `_migrations`: este ficheiro
-- não abre `BEGIN`/`COMMIT` próprios.
--
-- ---------------------------------------------------------------------------
-- O defeito que isto fecha
-- ---------------------------------------------------------------------------
--
-- Hoje um writer financeiro faz, em pedidos separados:
--
--     CHECK_OPEN  →  (outra sessão fecha o mês)  →  WRITE
--
-- e `closeFinancialPeriod` faz, também em pedidos separados:
--
--     lê estado  →  calcula o checklist  →  upsert 'closed'
--
-- Entre qualquer par de passos cabe a transação do outro. O resultado não é
-- teórico: uma escrita entra num mês que acabou de fechar, ou um mês fecha com
-- um checklist calculado antes de alguém lhe acrescentar um pendente. Nenhum
-- dos dois lados vê o outro, e nenhum dos dois está errado sozinho.
--
-- Acrescentar mais um `SELECT` dentro da RPC não resolve. Ler outra vez é ler
-- outra vez; continua a não impedir que o outro lado se meta pelo meio.
--
-- ---------------------------------------------------------------------------
-- O protocolo
-- ---------------------------------------------------------------------------
--
-- Um recurso determinístico por `(company_id, year, month)`, que os DOIS lados
-- adquirem dentro da transação que vai escrever:
--
--     pg_advisory_xact_lock(hashtext(company_id::text), year * 100 + month)
--
-- A chave é a que a preparação de recorrência já usava — passa a ser canónica,
-- num sítio só, para não haver duas convenções a proteger o mesmo mês sem se
-- verem uma à outra.
--
-- Consequência, e é a que interessa:
--
--   * writer primeiro  → o writer termina inteiro; o close espera, revalida
--                        o checklist DEPOIS, e decide com o mês como ficou;
--   * close primeiro   → o mês fecha; o writer acorda, encontra-o fechado e
--                        recusa. Zero escritas parciais.
--
-- `pg_advisory_xact_lock` liberta no fim da transação, sempre — commit ou
-- rollback. Não há caminho em que fique um lock pendurado.
--
-- ---------------------------------------------------------------------------
-- Ausência de linha significa aberto
-- ---------------------------------------------------------------------------
--
-- `financial_periods` está vazia em produção, e a semântica instalada pela 071
-- é `NOT EXISTS(... status='closed')`. Um lock de linha não serve: não há linha
-- para bloquear, e duas sessões inseririam a primeira em paralelo. O advisory
-- lock não depende de a linha existir — é essa a razão de ser ele.
-- ============================================================================

DO $precondicoes$
DECLARE
  v_tabela boolean;
  v_fn boolean;
BEGIN
  SELECT to_regclass('public.financial_periods') IS NOT NULL INTO v_tabela;
  SELECT EXISTS (
    SELECT 1 FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
     WHERE n.nspname = 'public' AND p.proname = 'is_financial_period_open'
  ) INTO v_fn;

  IF NOT (coalesce(v_tabela, false) AND coalesce(v_fn, false)) THEN
    RAISE EXCEPTION 'FINANCIAL_PERIOD_LOCK_089_PRECONDITION_FAILED: financial_periods=% is_financial_period_open=%',
      v_tabela, v_fn;
  END IF;
END
$precondicoes$;

-- ─── A chave canónica ───────────────────────────────────────────────────────
--
-- Existe como função para que ninguém a volte a escrever à mão. Duas versões
-- da mesma chave seriam dois recursos diferentes, e o protocolo deixaria de
-- proteger o que diz proteger.
CREATE OR REPLACE FUNCTION public.financial_period_lock_key(
  p_year integer,
  p_month integer
)
RETURNS integer
LANGUAGE sql
IMMUTABLE
AS $fn$
  SELECT p_year * 100 + p_month;
$fn$;

COMMENT ON FUNCTION public.financial_period_lock_key(integer, integer) IS
  'Segunda metade da chave canónica do lock de período. A primeira é hashtext(company_id::text).';

-- ─── Adquirir o lock de um mês ──────────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.lock_financial_period(
  p_company_id uuid,
  p_year integer,
  p_month integer
)
RETURNS void
LANGUAGE plpgsql
AS $fn$
BEGIN
  IF p_company_id IS NULL OR p_year IS NULL OR p_month IS NULL THEN
    RAISE EXCEPTION 'FINANCIAL_PERIOD_LOCK_INVALID_ARGS';
  END IF;
  IF p_month < 1 OR p_month > 12 THEN
    RAISE EXCEPTION 'FINANCIAL_PERIOD_LOCK_INVALID_MONTH: %', p_month;
  END IF;

  PERFORM pg_advisory_xact_lock(
    hashtext(p_company_id::text),
    public.financial_period_lock_key(p_year, p_month)
  );
END;
$fn$;

-- ─── Dois meses, em ordem canónica ──────────────────────────────────────────
--
-- Mover um lançamento de Julho para Agosto toca em dois períodos. Duas sessões
-- a fazer o movimento inverso, cada uma a bloquear pela sua ordem, dão deadlock.
-- Ordenar sempre pelo mesmo critério — o ano-mês crescente — elimina-o por
-- construção, e não por sorte de temporização.
CREATE OR REPLACE FUNCTION public.lock_financial_periods_pair(
  p_company_id uuid,
  p_year_a integer,
  p_month_a integer,
  p_year_b integer,
  p_month_b integer
)
RETURNS void
LANGUAGE plpgsql
AS $fn$
DECLARE
  v_a integer := public.financial_period_lock_key(p_year_a, p_month_a);
  v_b integer := public.financial_period_lock_key(p_year_b, p_month_b);
BEGIN
  IF v_a = v_b THEN
    PERFORM public.lock_financial_period(p_company_id, p_year_a, p_month_a);
    RETURN;
  END IF;

  IF v_a < v_b THEN
    PERFORM public.lock_financial_period(p_company_id, p_year_a, p_month_a);
    PERFORM public.lock_financial_period(p_company_id, p_year_b, p_month_b);
  ELSE
    PERFORM public.lock_financial_period(p_company_id, p_year_b, p_month_b);
    PERFORM public.lock_financial_period(p_company_id, p_year_a, p_month_a);
  END IF;
END;
$fn$;

-- ─── Bloquear e exigir aberto, na mesma transação ───────────────────────────
--
-- É esta a função que os writers passam a chamar. Depois de voltar sem erro, o
-- mês não pode fechar até a transação terminar — porque quem o fechar tem de
-- adquirir o mesmo lock.
CREATE OR REPLACE FUNCTION public.assert_financial_period_open_locked(
  p_company_id uuid,
  p_year integer,
  p_month integer
)
RETURNS void
LANGUAGE plpgsql
AS $fn$
BEGIN
  PERFORM public.lock_financial_period(p_company_id, p_year, p_month);

  IF NOT public.is_financial_period_open(
       p_company_id,
       make_date(p_year, p_month, 1)
     ) THEN
    RAISE EXCEPTION 'FINANCIAL_PERIOD_CLOSED: %-%', p_year, lpad(p_month::text, 2, '0')
      USING ERRCODE = 'P0001';
  END IF;
END;
$fn$;

-- ─── Os bloqueadores do fecho, contados sob o lock ──────────────────────────
--
-- O checklist do ecrã não é prova: é calculado antes, noutra viagem, e pode
-- estar desactualizado no instante em que o fecho grava. Estes são os mesmos
-- quatro bloqueadores que `getFinancialCloseChecklist` mostra, recontados aqui
-- dentro — a diferença é que aqui já ninguém pode acrescentar mais um.
CREATE OR REPLACE FUNCTION public.financial_period_blockers(
  p_company_id uuid,
  p_year integer,
  p_month integer
)
RETURNS TABLE (chave text, total bigint)
LANGUAGE sql
STABLE
AS $fn$
  WITH limites AS (
    SELECT make_date(p_year, p_month, 1) AS inicio,
           (make_date(p_year, p_month, 1) + interval '1 month - 1 day')::date AS fim
  )
  SELECT 'faturas_rascunho', count(*)
    FROM public.invoices i, limites l
   WHERE i.company_id = p_company_id AND i.status = 'rascunho'
     AND i.period_start >= l.inicio AND i.period_start <= l.fim
  UNION ALL
  SELECT 'saidas_sem_categoria', count(*)
    FROM public.cash_flow_entries e, limites l
   WHERE e.company_id = p_company_id AND e.type = 'saida'
     AND e.expense_category_id IS NULL
     AND e.date >= l.inicio AND e.date <= l.fim
  UNION ALL
  SELECT 'movimentos_bancarios_pendentes', count(*)
    FROM public.bank_transactions b, limites l
   WHERE b.company_id = p_company_id AND b.status = 'pending'
     AND b.transaction_date >= l.inicio AND b.transaction_date <= l.fim
  UNION ALL
  SELECT 'pagamentos_pendentes', count(*)
    FROM public.fixed_variable_payments p
   WHERE p.company_id = p_company_id AND p.status = 'pendente'
     AND p.period_year = p_year AND p.period_month = p_month;
$fn$;

-- ─── Fechar o período, sob o mesmo lock ─────────────────────────────────────
CREATE OR REPLACE FUNCTION public.close_financial_period_atomic(
  p_company_id uuid,
  p_year integer,
  p_month integer,
  p_actor uuid
)
RETURNS TABLE (fechado boolean, bloqueadores jsonb)
LANGUAGE plpgsql
AS $fn$
DECLARE
  v_bloqueadores jsonb;
  v_total bigint;
BEGIN
  -- Primeiro o lock. Só depois se olha para o mês: um checklist lido antes do
  -- lock descreve um passado, não o estado que vai ser gravado.
  PERFORM public.lock_financial_period(p_company_id, p_year, p_month);

  IF NOT public.is_financial_period_open(p_company_id, make_date(p_year, p_month, 1)) THEN
    RETURN QUERY SELECT false, jsonb_build_object('ja_fechado', true);
    RETURN;
  END IF;

  SELECT jsonb_object_agg(chave, total), coalesce(sum(total), 0)
    INTO v_bloqueadores, v_total
    FROM public.financial_period_blockers(p_company_id, p_year, p_month);

  IF v_total > 0 THEN
    RETURN QUERY SELECT false, v_bloqueadores;
    RETURN;
  END IF;

  INSERT INTO public.financial_periods (company_id, year, month, status, closed_at, closed_by)
  VALUES (p_company_id, p_year, p_month, 'closed', now(), p_actor)
  ON CONFLICT (company_id, year, month) DO UPDATE
    SET status = 'closed', closed_at = now(), closed_by = p_actor,
        reopened_at = NULL, reopened_by = NULL, reopen_reason = NULL,
        updated_at = now();

  RETURN QUERY SELECT true, '{}'::jsonb;
END;
$fn$;

-- ─── Reabrir, sob o mesmo lock ──────────────────────────────────────────────
--
-- Reabrir participa do mesmo protocolo. Sem isso, um writer podia ver o mês
-- fechado, recusar, e a reabertura entrar logo a seguir — dando uma recusa que
-- já não correspondia a nada.
CREATE OR REPLACE FUNCTION public.reopen_financial_period_atomic(
  p_company_id uuid,
  p_year integer,
  p_month integer,
  p_actor uuid,
  p_reason text
)
RETURNS boolean
LANGUAGE plpgsql
AS $fn$
BEGIN
  IF p_reason IS NULL OR btrim(p_reason) = '' THEN
    RAISE EXCEPTION 'FINANCIAL_PERIOD_REOPEN_REQUIRES_REASON';
  END IF;

  PERFORM public.lock_financial_period(p_company_id, p_year, p_month);

  IF public.is_financial_period_open(p_company_id, make_date(p_year, p_month, 1)) THEN
    RETURN false;
  END IF;

  UPDATE public.financial_periods
     SET status = 'open', reopened_at = now(), reopened_by = p_actor,
         reopen_reason = btrim(p_reason), updated_at = now()
   WHERE company_id = p_company_id AND year = p_year AND month = p_month;

  RETURN true;
END;
$fn$;

-- ─── Superfície ─────────────────────────────────────────────────────────────
--
-- Nada disto é chamável pelo browser. As primitivas de lock são internas, e as
-- de fecho/reabertura passam pelas server actions, que fazem a autorização.
REVOKE ALL PRIVILEGES ON FUNCTION public.financial_period_lock_key(integer, integer) FROM PUBLIC, anon, authenticated;
REVOKE ALL PRIVILEGES ON FUNCTION public.lock_financial_period(uuid, integer, integer) FROM PUBLIC, anon, authenticated;
REVOKE ALL PRIVILEGES ON FUNCTION public.lock_financial_periods_pair(uuid, integer, integer, integer, integer) FROM PUBLIC, anon, authenticated;
REVOKE ALL PRIVILEGES ON FUNCTION public.assert_financial_period_open_locked(uuid, integer, integer) FROM PUBLIC, anon, authenticated;
REVOKE ALL PRIVILEGES ON FUNCTION public.financial_period_blockers(uuid, integer, integer) FROM PUBLIC, anon, authenticated;
REVOKE ALL PRIVILEGES ON FUNCTION public.close_financial_period_atomic(uuid, integer, integer, uuid) FROM PUBLIC, anon, authenticated;
REVOKE ALL PRIVILEGES ON FUNCTION public.reopen_financial_period_atomic(uuid, integer, integer, uuid, text) FROM PUBLIC, anon, authenticated;

GRANT EXECUTE ON FUNCTION public.financial_period_lock_key(integer, integer) TO service_role;
GRANT EXECUTE ON FUNCTION public.lock_financial_period(uuid, integer, integer) TO service_role;
GRANT EXECUTE ON FUNCTION public.lock_financial_periods_pair(uuid, integer, integer, integer, integer) TO service_role;
GRANT EXECUTE ON FUNCTION public.assert_financial_period_open_locked(uuid, integer, integer) TO service_role;
GRANT EXECUTE ON FUNCTION public.financial_period_blockers(uuid, integer, integer) TO service_role;
GRANT EXECUTE ON FUNCTION public.close_financial_period_atomic(uuid, integer, integer, uuid) TO service_role;
GRANT EXECUTE ON FUNCTION public.reopen_financial_period_atomic(uuid, integer, integer, uuid, text) TO service_role;

-- ─── Pós-estado ─────────────────────────────────────────────────────────────
DO $posestado$
DECLARE
  v_faltam text[];
BEGIN
  SELECT array_agg(nome) INTO v_faltam
    FROM unnest(ARRAY[
      'financial_period_lock_key', 'lock_financial_period', 'lock_financial_periods_pair',
      'assert_financial_period_open_locked', 'financial_period_blockers',
      'close_financial_period_atomic', 'reopen_financial_period_atomic'
    ]) AS nome
   WHERE NOT EXISTS (
     SELECT 1 FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
      WHERE n.nspname = 'public' AND p.proname = nome
   );

  IF v_faltam IS NOT NULL THEN
    RAISE EXCEPTION 'FINANCIAL_PERIOD_LOCK_089_POSTSTATE_FAILED: em falta %', v_faltam;
  END IF;
END
$posestado$;

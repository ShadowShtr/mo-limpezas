-- ============================================================================
-- 090 — protocolo único de serialização do período financeiro
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
-- 🔴 Colisão de hash: o que pode e o que NÃO pode acontecer
-- ---------------------------------------------------------------------------
--
-- `hashtext` devolve `integer`. Duas empresas diferentes podem, em princípio,
-- ter o mesmo `hashtext(company_id::text)` — e nesse caso partilham o mesmo
-- recurso de lock para o mesmo ano-mês.
--
-- O que isso causa:  CONTENÇÃO. Uma escrita da empresa A espera pela transação
--                    da empresa B. Mais lento, nada mais.
--
-- O que isso NÃO causa, e não pode causar:
--
--   * NÃO permite que A escreva em dados de B. O lock não autoriza nada — só
--     serializa. Toda a autorização e todo o `company_id` continuam a ser
--     validados pelas funções de negócio e pelo RLS, que não olham para o lock.
--   * NÃO quebra isolamento. Duas empresas com o mesmo hash ficam MAIS
--     serializadas, nunca menos. O erro perigoso seria o inverso — duas
--     sessões da MESMA empresa e do MESMO mês a não se verem — e esse não
--     depende de colisão nenhuma: `hashtext` é determinística, logo a mesma
--     empresa dá sempre a mesma chave.
--
-- É por isso que a colisão é aceitável aqui e não seria noutro sítio: o custo
-- de uma colisão é desempenho, e o benefício é uma chave que não precisa de
-- tabela, de linha, nem de existir previamente.
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
  v_audit boolean;
BEGIN
  SELECT to_regclass('public.financial_periods') IS NOT NULL INTO v_tabela;

  -- 🔴 A assinatura EXACTA, e não só o nome. Existiu uma versão
  --    `(uuid, date)` desta função; aceitar «existe alguma coisa com este
  --    nome» deixaria a fundação assente numa função que recebe outra coisa,
  --    e o erro só apareceria em produção na primeira escrita.
  SELECT EXISTS (
    SELECT 1 FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
     WHERE n.nspname = 'public' AND p.proname = 'is_financial_period_open'
       AND pg_get_function_identity_arguments(p.oid) = 'p_company_id uuid, p_year integer, p_month integer'
  ) INTO v_fn;

  SELECT to_regclass('public.audit_logs') IS NOT NULL INTO v_audit;

  IF NOT (coalesce(v_tabela, false) AND coalesce(v_fn, false) AND coalesce(v_audit, false)) THEN
    RAISE EXCEPTION 'FINANCIAL_PERIOD_LOCK_090_PRECONDITION_FAILED: financial_periods=% is_financial_period_open(uuid,integer,integer)=% audit_logs=%',
      v_tabela, v_fn, v_audit;
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
SECURITY INVOKER
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
SECURITY INVOKER
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

-- ─── N meses, em ordem canónica ─────────────────────────────────────────────
--
-- ---------------------------------------------------------------------------
-- 🔴 Porque é que o par não chega
-- ---------------------------------------------------------------------------
--
-- Uma operação económica pode tocar em MAIS do que dois meses. Retirar o
-- recebimento de uma cobrança avulsa é o caso que obrigou a escrever isto:
--
--   · o mês da `charge_date` — o facto;
--   · o mês de HOJE — a data com que o caixa teria sido escrito;
--   · o mês do movimento de caixa que já lá está e vai ser apagado, que foi
--     criado noutro dia e pode ser um TERCEIRO mês.
--
-- Bloquear os dois primeiros e só depois descobrir o terceiro devolve o
-- deadlock por outra porta:
--
--     T1 adquire Julho, Agosto  →  descobre Setembro  →  pede Setembro
--     T2 adquire Agosto, Julho  →  descobre Setembro  →  pede Setembro
--
-- Cada transação adquiriu um SUBCONJUNTO antes de conhecer o conjunto todo. A
-- ordem canónica dentro de cada chamada não salva nada: o que tem de estar
-- ordenado é a sequência global de aquisições da transação, e isso só é
-- possível se o conjunto inteiro for conhecido ANTES da primeira aquisição.
--
-- Daí a regra, e é uma regra, não uma preferência:
--
--     descobrir TODOS os períodos  →  ordenar  →  adquirir TODOS
--     →  validar TODOS  →  só então escrever.
--
-- Nunca «adquirir alguns, descobrir mais um, adquirir fora de ordem».
--
-- ---------------------------------------------------------------------------
-- A convenção, num sítio só
-- ---------------------------------------------------------------------------
--
-- `lock_financial_periods_many` é a primitiva canónica. O lock de um mês e o
-- lock do par passam a ser invocações dela — não implementações paralelas —
-- para que não existam duas ordens de aquisição no mesmo sistema.

-- ---------------------------------------------------------------------------
-- 🔴 A ordem entre locks de LINHA e locks de PERÍODO — e porque é sempre esta
-- ---------------------------------------------------------------------------
--
-- Quase todos os writers precisam das duas coisas: trancar as linhas em que
-- vão mexer (`SELECT ... FOR UPDATE`) e trancar os meses que vão tocar. A
-- ordem entre as duas famílias tem de ser a MESMA em todo o sistema, senão
-- volta a haver ciclo — desta vez entre um lock de linha e um advisory:
--
--     T1 tem a linha, espera pelo mês  ·  T2 tem o mês, espera pela linha
--
-- A convenção é:
--
--     1. LINHAS primeiro (`FOR UPDATE`), pela ordem que a operação exigir;
--     2. PERÍODOS depois, todos de uma vez, em ordem canónica;
--     3. só então escrever.
--
-- E é esta e não a inversa por uma razão concreta: as datas que determinam os
-- períodos estão NAS LINHAS. Só depois de as ter trancadas é que o conjunto de
-- períodos é conhecido e estável — se fosse lido antes, podia mudar debaixo dos
-- pés entre a leitura e a aquisição.
--
-- O outro lado do ciclo não existe por construção: o fecho
-- (`close_financial_period_atomic`) adquire o advisory lock e depois só LÊ, com
-- `SELECT` simples e sem `FOR UPDATE` nenhum. Nunca espera por um lock de
-- linha, portanto nunca fecha o ciclo. Quem acrescentar `FOR UPDATE` ao
-- caminho do fecho parte esta garantia, e é por isso que fica escrito aqui.

-- ─── Datas → conjunto canónico de chaves ────────────────────────────────────
--
-- A maior parte dos writers tem datas, não pares ano/mês. Esta função é a
-- ponte, e é onde a normalização acontece uma vez só.
--
-- 🔴 Datas NULL são DESCARTADAS, de propósito. Metade dos writers financeiros
--    tem datas opcionais — um pagamento por liquidar não tem data de
--    liquidação — e uma data que não existe não nomeia período nenhum. O que
--    NÃO é aceitável é o conjunto ficar vazio: isso significaria escrever sem
--    período nenhum protegido, e quem recusa esse caso é
--    `lock_financial_periods_many`, abaixo.
CREATE OR REPLACE FUNCTION public.financial_period_lock_keys(
  p_dates date[]
)
RETURNS integer[]
LANGUAGE sql
IMMUTABLE
SECURITY INVOKER
AS $fn$
  SELECT COALESCE(
    array_agg(DISTINCT public.financial_period_lock_key(
      EXTRACT(YEAR FROM d)::integer, EXTRACT(MONTH FROM d)::integer
    )),
    ARRAY[]::integer[]
  )
  FROM unnest(COALESCE(p_dates, ARRAY[]::date[])) AS d
  WHERE d IS NOT NULL;
$fn$;

COMMENT ON FUNCTION public.financial_period_lock_keys(date[]) IS
  'Datas → conjunto único de chaves de período. Datas NULL são descartadas; o conjunto vazio é recusado por quem bloqueia.';

-- ─── Adquirir N meses, em ordem canónica ────────────────────────────────────
--
-- Devolve o conjunto que efectivamente bloqueou, por ordem de aquisição. Não é
-- decoração: é a única forma de um teste provar que a ordem foi a canónica e
-- que os duplicados deram um lock lógico só.
CREATE OR REPLACE FUNCTION public.lock_financial_periods_many(
  p_company_id uuid,
  p_keys integer[]
)
RETURNS integer[]
LANGUAGE plpgsql
SECURITY INVOKER
AS $fn$
DECLARE
  v_chave  integer;
  v_chaves integer[];
BEGIN
  IF p_company_id IS NULL THEN
    RAISE EXCEPTION 'FINANCIAL_PERIOD_LOCK_INVALID_ARGS';
  END IF;

  -- Validar ANTES de adquirir o primeiro lock. Uma chave inválida descoberta a
  -- meio deixaria a transação com locks adquiridos e um erro por cima — o
  -- rollback devolve-os, mas o diagnóstico fica pior e a regra «todos ou
  -- nenhum» deixaria de ser verdade à letra.
  IF p_keys IS NULL OR array_position(p_keys, NULL) IS NOT NULL THEN
    RAISE EXCEPTION 'FINANCIAL_PERIOD_LOCK_INVALID_ARGS';
  END IF;

  -- 🔴 Conjunto vazio é recusa, não no-op. Um writer que chegue aqui sem
  --    período nenhum está prestes a escrever sem protecção: falhar fechado é
  --    a única resposta que não inventa uma garantia que não existe.
  IF cardinality(p_keys) = 0 THEN
    RAISE EXCEPTION 'FINANCIAL_PERIOD_LOCK_EMPTY_SET';
  END IF;

  FOREACH v_chave IN ARRAY p_keys LOOP
    IF v_chave < 100 OR (v_chave % 100) < 1 OR (v_chave % 100) > 12 THEN
      RAISE EXCEPTION 'FINANCIAL_PERIOD_LOCK_INVALID_MONTH: %', v_chave % 100;
    END IF;
  END LOOP;

  -- Único e ordenado. A entrada pode vir por qualquer ordem e com repetições:
  -- é precisamente isso que os call sites produzem quando juntam datas de
  -- origens diferentes, e é aqui que deixa de importar.
  SELECT array_agg(k ORDER BY k) INTO v_chaves
    FROM (SELECT DISTINCT unnest(p_keys) AS k) AS s;

  FOREACH v_chave IN ARRAY v_chaves LOOP
    PERFORM public.lock_financial_period(
      p_company_id, v_chave / 100, v_chave % 100
    );
  END LOOP;

  RETURN v_chaves;
END;
$fn$;

-- ─── Bloquear e exigir aberto, na mesma transação ───────────────────────────
--
-- É esta a função que os writers passam a chamar. Depois de voltar sem erro,
-- nenhum dos meses pode fechar até a transação terminar — porque quem os
-- fechar tem de adquirir os mesmos locks.
--
-- 🔴 TODOS os locks primeiro, e só depois TODAS as perguntas. Validar à medida
--    que se bloqueia deixaria uma janela em que o primeiro mês está validado e
--    o último ainda livre para fechar.
CREATE OR REPLACE FUNCTION public.assert_financial_periods_open_locked_many(
  p_company_id uuid,
  p_keys integer[]
)
RETURNS void
LANGUAGE plpgsql
SECURITY INVOKER
AS $fn$
DECLARE
  v_chaves integer[];
  v_chave  integer;
BEGIN
  v_chaves := public.lock_financial_periods_many(p_company_id, p_keys);

  FOREACH v_chave IN ARRAY v_chaves LOOP
    IF NOT public.is_financial_period_open(p_company_id, v_chave / 100, v_chave % 100) THEN
      RAISE EXCEPTION 'FINANCIAL_PERIOD_CLOSED: %-%',
        v_chave / 100, lpad((v_chave % 100)::text, 2, '0')
        USING ERRCODE = 'P0001';
    END IF;
  END LOOP;
END;
$fn$;

-- ─── As mesmas garantias, a partir de datas ─────────────────────────────────
--
-- O atalho que a maioria dos writers usa: entrega-se a lista de datas
-- economicamente relevantes da operação inteira — origem, destino, caixa novo,
-- caixa antigo — e o protocolo trata do resto.
CREATE OR REPLACE FUNCTION public.assert_financial_period_dates_open_locked(
  p_company_id uuid,
  p_dates date[]
)
RETURNS void
LANGUAGE plpgsql
SECURITY INVOKER
AS $fn$
BEGIN
  PERFORM public.assert_financial_periods_open_locked_many(
    p_company_id, public.financial_period_lock_keys(p_dates)
  );
END;
$fn$;

-- ─── Um mês e dois meses: invocações da primitiva, não cópias dela ──────────
--
-- Ficam porque são legíveis no call site e porque as suites existentes falam
-- esta linguagem. O que não fica é uma segunda implementação da ordem de
-- aquisição: por baixo é sempre `lock_financial_periods_many`.
CREATE OR REPLACE FUNCTION public.lock_financial_periods_pair(
  p_company_id uuid,
  p_year_a integer,
  p_month_a integer,
  p_year_b integer,
  p_month_b integer
)
RETURNS void
LANGUAGE plpgsql
SECURITY INVOKER
AS $fn$
BEGIN
  PERFORM public.lock_financial_periods_many(p_company_id, ARRAY[
    public.financial_period_lock_key(p_year_a, p_month_a),
    public.financial_period_lock_key(p_year_b, p_month_b)
  ]);
END;
$fn$;

CREATE OR REPLACE FUNCTION public.assert_financial_period_open_locked(
  p_company_id uuid,
  p_year integer,
  p_month integer
)
RETURNS void
LANGUAGE plpgsql
SECURITY INVOKER
AS $fn$
BEGIN
  PERFORM public.assert_financial_periods_open_locked_many(p_company_id, ARRAY[
    public.financial_period_lock_key(p_year, p_month)
  ]);
END;
$fn$;

CREATE OR REPLACE FUNCTION public.assert_financial_periods_open_locked_pair(
  p_company_id uuid,
  p_year_a integer,
  p_month_a integer,
  p_year_b integer,
  p_month_b integer
)
RETURNS void
LANGUAGE plpgsql
SECURITY INVOKER
AS $fn$
BEGIN
  PERFORM public.assert_financial_periods_open_locked_many(p_company_id, ARRAY[
    public.financial_period_lock_key(p_year_a, p_month_a),
    public.financial_period_lock_key(p_year_b, p_month_b)
  ]);
END;
$fn$;

-- ─── Os bloqueadores do fecho, contados sob o lock ──────────────────────────
--
-- O checklist do ecrã não é prova: é calculado antes, noutra viagem, e pode
-- estar desactualizado no instante em que o fecho grava. Estes são os mesmos
-- quatro bloqueadores que `getFinancialCloseChecklist` mostra, recontados aqui
-- dentro — a diferença é que aqui já ninguém pode acrescentar mais um.
--
-- 🔴 As chaves e as condições têm de acompanhar `getFinancialCloseChecklist`.
--    Implementações diferentes são aceitáveis; regras diferentes não são — o
--    ecrã diria «pode fechar» e o fecho recusaria, ou pior, o contrário.
CREATE OR REPLACE FUNCTION public.financial_period_blockers(
  p_company_id uuid,
  p_year integer,
  p_month integer
)
RETURNS TABLE (chave text, total bigint)
LANGUAGE sql
STABLE
SECURITY INVOKER
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
--
-- ---------------------------------------------------------------------------
-- 🔴 Porque é que a auditoria está DENTRO desta função
-- ---------------------------------------------------------------------------
--
-- O runtime actual faz `upsert` e só depois `auditLog(...)`, em duas viagens.
-- Se a segunda falhar — rede, timeout, processo morto — o mês fica fechado sem
-- registo de quem o fechou. Para um fecho contabilístico isso não é um log
-- perdido: é a perda da única prova de autoria de um acto que congela um mês.
--
-- Aqui a linha de auditoria entra na MESMA transação que a mudança de estado.
-- Ou existem as duas, ou não existe nenhuma. `actor`, `company`, `year`,
-- `month` e os timestamps ficam preservados, e o `reason` no caso da
-- reabertura.
--
-- Isto NÃO substitui `auditLog` para o resto do sistema — substitui-o apenas
-- para este acto, onde o requisito é atomicidade e não conveniência.
CREATE OR REPLACE FUNCTION public.close_financial_period_atomic(
  p_company_id uuid,
  p_year integer,
  p_month integer,
  p_actor uuid
)
RETURNS TABLE (fechado boolean, bloqueadores jsonb)
LANGUAGE plpgsql
SECURITY INVOKER
AS $fn$
DECLARE
  v_bloqueadores jsonb;
  v_total bigint;
BEGIN
  -- Primeiro o lock. Só depois se olha para o mês: um checklist lido antes do
  -- lock descreve um passado, não o estado que vai ser gravado.
  PERFORM public.lock_financial_period(p_company_id, p_year, p_month);

  IF NOT public.is_financial_period_open(p_company_id, p_year, p_month) THEN
    -- Já fechado é no-op, não erro: um duplo-clique não pode reescrever o
    -- `closed_at` original nem gerar uma segunda linha de auditoria.
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

  INSERT INTO public.audit_logs (company_id, actor_id, action, entity_type, entity_id, meta)
  VALUES (
    p_company_id,
    p_actor,
    'financial_period_closed',
    'financial_period',
    p_year::text || '-' || lpad(p_month::text, 2, '0'),
    jsonb_build_object('year', p_year, 'month', p_month, 'source', 'rpc')
  );

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
SECURITY INVOKER
AS $fn$
BEGIN
  -- O motivo é o ponto da auditoria da reabertura: seis meses depois é o que
  -- explica porque é que os números daquele mês mudaram. Validado antes de
  -- adquirir o lock — não vale a pena serializar para depois recusar.
  IF p_reason IS NULL OR btrim(p_reason) = '' THEN
    RAISE EXCEPTION 'FINANCIAL_PERIOD_REOPEN_REQUIRES_REASON';
  END IF;

  PERFORM public.lock_financial_period(p_company_id, p_year, p_month);

  IF public.is_financial_period_open(p_company_id, p_year, p_month) THEN
    RETURN false;
  END IF;

  UPDATE public.financial_periods
     SET status = 'open', reopened_at = now(), reopened_by = p_actor,
         reopen_reason = btrim(p_reason), updated_at = now()
   WHERE company_id = p_company_id AND year = p_year AND month = p_month;

  INSERT INTO public.audit_logs (company_id, actor_id, action, entity_type, entity_id, meta)
  VALUES (
    p_company_id,
    p_actor,
    'financial_period_reopened',
    'financial_period',
    p_year::text || '-' || lpad(p_month::text, 2, '0'),
    jsonb_build_object('year', p_year, 'month', p_month, 'reason', btrim(p_reason), 'source', 'rpc')
  );

  RETURN true;
END;
$fn$;

-- ─── Superfície ─────────────────────────────────────────────────────────────
--
-- Nada disto é chamável pelo browser. As primitivas de lock são internas, e as
-- de fecho/reabertura passam pelas server actions, que fazem a autorização.
--
-- `postgres` entra porque é o papel que corre as migrations e as suites de
-- PostgreSQL; `service_role` porque é o papel do `createAdminClient()`. Mais
-- nenhum.
REVOKE ALL PRIVILEGES ON FUNCTION public.financial_period_lock_key(integer, integer) FROM PUBLIC, anon, authenticated;
REVOKE ALL PRIVILEGES ON FUNCTION public.lock_financial_period(uuid, integer, integer) FROM PUBLIC, anon, authenticated;
REVOKE ALL PRIVILEGES ON FUNCTION public.lock_financial_periods_pair(uuid, integer, integer, integer, integer) FROM PUBLIC, anon, authenticated;
REVOKE ALL PRIVILEGES ON FUNCTION public.financial_period_lock_keys(date[]) FROM PUBLIC, anon, authenticated;
REVOKE ALL PRIVILEGES ON FUNCTION public.lock_financial_periods_many(uuid, integer[]) FROM PUBLIC, anon, authenticated;
REVOKE ALL PRIVILEGES ON FUNCTION public.assert_financial_periods_open_locked_many(uuid, integer[]) FROM PUBLIC, anon, authenticated;
REVOKE ALL PRIVILEGES ON FUNCTION public.assert_financial_period_dates_open_locked(uuid, date[]) FROM PUBLIC, anon, authenticated;
REVOKE ALL PRIVILEGES ON FUNCTION public.assert_financial_period_open_locked(uuid, integer, integer) FROM PUBLIC, anon, authenticated;
REVOKE ALL PRIVILEGES ON FUNCTION public.assert_financial_periods_open_locked_pair(uuid, integer, integer, integer, integer) FROM PUBLIC, anon, authenticated;
REVOKE ALL PRIVILEGES ON FUNCTION public.financial_period_blockers(uuid, integer, integer) FROM PUBLIC, anon, authenticated;
REVOKE ALL PRIVILEGES ON FUNCTION public.close_financial_period_atomic(uuid, integer, integer, uuid) FROM PUBLIC, anon, authenticated;
REVOKE ALL PRIVILEGES ON FUNCTION public.reopen_financial_period_atomic(uuid, integer, integer, uuid, text) FROM PUBLIC, anon, authenticated;

GRANT EXECUTE ON FUNCTION public.financial_period_lock_key(integer, integer) TO postgres, service_role;
GRANT EXECUTE ON FUNCTION public.lock_financial_period(uuid, integer, integer) TO postgres, service_role;
GRANT EXECUTE ON FUNCTION public.lock_financial_periods_pair(uuid, integer, integer, integer, integer) TO postgres, service_role;
GRANT EXECUTE ON FUNCTION public.financial_period_lock_keys(date[]) TO postgres, service_role;
GRANT EXECUTE ON FUNCTION public.lock_financial_periods_many(uuid, integer[]) TO postgres, service_role;
GRANT EXECUTE ON FUNCTION public.assert_financial_periods_open_locked_many(uuid, integer[]) TO postgres, service_role;
GRANT EXECUTE ON FUNCTION public.assert_financial_period_dates_open_locked(uuid, date[]) TO postgres, service_role;
GRANT EXECUTE ON FUNCTION public.assert_financial_period_open_locked(uuid, integer, integer) TO postgres, service_role;
GRANT EXECUTE ON FUNCTION public.assert_financial_periods_open_locked_pair(uuid, integer, integer, integer, integer) TO postgres, service_role;
GRANT EXECUTE ON FUNCTION public.financial_period_blockers(uuid, integer, integer) TO postgres, service_role;
GRANT EXECUTE ON FUNCTION public.close_financial_period_atomic(uuid, integer, integer, uuid) TO postgres, service_role;
GRANT EXECUTE ON FUNCTION public.reopen_financial_period_atomic(uuid, integer, integer, uuid, text) TO postgres, service_role;

-- ─── Pós-estado ─────────────────────────────────────────────────────────────
--
-- Verifica a assinatura, e não só o nome: uma função certa com argumentos
-- errados passaria uma verificação por nome e falharia na primeira chamada.
DO $posestado$
DECLARE
  v_faltam text[];
BEGIN
  SELECT array_agg(esperado.assinatura) INTO v_faltam
    FROM (VALUES
      ('financial_period_lock_key',                 'p_year integer, p_month integer'),
      ('lock_financial_period',                     'p_company_id uuid, p_year integer, p_month integer'),
      ('lock_financial_periods_pair',               'p_company_id uuid, p_year_a integer, p_month_a integer, p_year_b integer, p_month_b integer'),
      ('financial_period_lock_keys',                 'p_dates date[]'),
      ('lock_financial_periods_many',                'p_company_id uuid, p_keys integer[]'),
      ('assert_financial_periods_open_locked_many',  'p_company_id uuid, p_keys integer[]'),
      ('assert_financial_period_dates_open_locked',  'p_company_id uuid, p_dates date[]'),
      ('assert_financial_period_open_locked',       'p_company_id uuid, p_year integer, p_month integer'),
      ('assert_financial_periods_open_locked_pair', 'p_company_id uuid, p_year_a integer, p_month_a integer, p_year_b integer, p_month_b integer'),
      ('financial_period_blockers',                 'p_company_id uuid, p_year integer, p_month integer'),
      ('close_financial_period_atomic',             'p_company_id uuid, p_year integer, p_month integer, p_actor uuid'),
      ('reopen_financial_period_atomic',            'p_company_id uuid, p_year integer, p_month integer, p_actor uuid, p_reason text')
    ) AS esperado(nome, assinatura)
   WHERE NOT EXISTS (
     SELECT 1 FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
      WHERE n.nspname = 'public' AND p.proname = esperado.nome
        AND pg_get_function_identity_arguments(p.oid) = esperado.assinatura
   );

  IF v_faltam IS NOT NULL THEN
    RAISE EXCEPTION 'FINANCIAL_PERIOD_LOCK_090_POSTSTATE_FAILED: em falta %', v_faltam;
  END IF;
END
$posestado$;

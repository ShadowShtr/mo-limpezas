-- ============================================================================
-- 095 — conciliação bancária dentro do protocolo de período
-- ============================================================================
--
-- O runner é o dono da transação e do registo no `_migrations`: este ficheiro
-- não abre `BEGIN`/`COMMIT` próprios.
--
-- ---------------------------------------------------------------------------
-- 🔴 O critério que estava a faltar, e que muda a resposta
-- ---------------------------------------------------------------------------
--
-- `src/app/actions/bank-reconciliation.ts` diz hoje, em comentário e a sério:
--
--     «`confirmMatch`, `rejectMatch`, `manualMatch` e `ignoreTransaction`
--      **não** têm guarda, deliberadamente: escrevem metadados de
--      correspondência e não criam nem alteram nenhum movimento de caixa.
--      Bloqueá-las seria travar operação por a action viver na pasta do
--      Financeiro — o critério é o efeito económico, não a localização.»
--
-- O critério está certo. A aplicação dele é que estava incompleta, e faltava-lhe
-- uma coisa concreta:
--
--     `bank_transactions.status = 'pending'` é UM DOS QUATRO BLOQUEADORES DO
--     FECHO. É a chave `movimentos_por_conciliar`, contada por
--     `transaction_date`.
--
-- Ou seja: mudar o estado de uma transacção bancária de `pending` para
-- `reconciled`, `matched` ou `ignored` REMOVE um bloqueador de um mês. E
-- rejeitar a última sugestão devolve-o a `pending`, ACRESCENTANDO um.
--
-- Isso é efeito económico sobre o período — pelo mesmo critério que o
-- comentário enuncia. Não move dinheiro, mas move a resposta à pergunta «este
-- mês pode fechar?». Feito em corrida com o fecho:
--
--     checklist lê 3 pendentes  →  alguém ignora os 3  →  o mês fecha
--     …e o fecho terá visto zero, ou três, conforme a temporização.
--
-- Ou o inverso, que é pior: o mês fecha porque nesse instante não havia
-- pendentes, e a rejeição que devolve um a `pending` entra logo a seguir — o
-- mês fica fechado com um bloqueador lá dentro que ninguém chegou a ver.
--
-- Por isso as quatro entram no protocolo. Não por viverem na pasta do
-- Financeiro; por escreverem numa coluna que o fecho lê.
--
-- ---------------------------------------------------------------------------
-- 🔴 `deleteImport` — o writer de N períodos
-- ---------------------------------------------------------------------------
--
-- Apagar uma importação apaga em cascata TODAS as suas transacções bancárias e
-- as respectivas correspondências. Um extracto atravessa meses com facilidade —
-- um trimestre, um ano — e cada mês tocado perde bloqueadores de uma vez.
--
-- Não há número fixo de períodos. É este writer que obriga a primitiva canónica
-- da 090 a receber uma LISTA e não um par, e é aqui que ela se paga.
--
-- ---------------------------------------------------------------------------
-- O que estas funções também corrigem, além do período
-- ---------------------------------------------------------------------------
--
-- `manualMatch`, `createEntryFromTransaction`, `rejectMatch` e `deleteImport`
-- são hoje TRÊS a QUATRO viagens cada, sem transação comum. Uma falha a meio
-- deixa, por exemplo, um movimento de caixa criado sem correspondência, ou uma
-- correspondência confirmada com a transacção ainda por reconciliar. Passam a
-- ser uma escrita só.
--
-- ---------------------------------------------------------------------------
-- Compatibilidade — EXPAND FIRST
-- ---------------------------------------------------------------------------
--
-- `confirm_bank_match_atomic` mantém a assinatura EXACTA e toda a lógica da
-- 082: a transacção bancária trancada PRIMEIRO como ponto de contenção comum, a
-- releitura da correspondência depois do lock, a recusa sobre transacção já
-- conciliada por outra correspondência, a recusa sobre correspondência
-- rejeitada, e a rejeição das sugestões restantes dentro da mesma transação.
--
-- As outras cinco são NOVAS: hoje esses caminhos vivem na server action.
-- ============================================================================

DO $precondicoes$
DECLARE
  v_faltam text[];
BEGIN
  SELECT array_agg(esperado.nome || '(' || esperado.assinatura || ')') INTO v_faltam
    FROM (VALUES
      ('assert_financial_period_dates_open_locked', 'p_company_id uuid, p_dates date[]'),
      ('confirm_bank_match_atomic',                 'p_company_id uuid, p_match_id uuid, p_actor_id uuid')
    ) AS esperado(nome, assinatura)
   WHERE NOT EXISTS (
     SELECT 1 FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
      WHERE n.nspname = 'public' AND p.proname = esperado.nome
        AND pg_get_function_identity_arguments(p.oid) = esperado.assinatura
   );

  IF v_faltam IS NOT NULL THEN
    RAISE EXCEPTION 'BANK_PERIOD_095_PRECONDITION_FAILED: em falta %', v_faltam;
  END IF;

  IF to_regclass('public.bank_statement_imports') IS NULL
     OR to_regclass('public.bank_transactions') IS NULL
     OR to_regclass('public.bank_reconciliation_matches') IS NULL THEN
    RAISE EXCEPTION 'BANK_PERIOD_095_PRECONDITION_FAILED: tabelas da conciliação ausentes';
  END IF;
END
$precondicoes$;

-- ─── 1. Confirmar uma correspondência ───────────────────────────────────────
--
-- `CREATE OR REPLACE` da função da 082, com tudo preservado e o período por
-- cima.
--
-- 🔴 Dois períodos: o da transacção bancária (que muda de `pending` e deixa de
--    contar como bloqueador) e o do movimento de caixa emparelhado — porque a
--    partir daqui esse movimento fica conciliado, e a 081 recusa desmarcá-lo.
--    Conciliar um movimento de um mês fechado é congelá-lo por uma via lateral.
CREATE OR REPLACE FUNCTION public.confirm_bank_match_atomic(
  p_company_id uuid,
  p_match_id   uuid,
  p_actor_id   uuid
)
-- 🔴 Os nomes de saída não podem repetir nomes de coluna: dentro do corpo,
--    `bank_transaction_id` referia-se ao parâmetro E à coluna, e o PostgreSQL
--    recusava com «column reference is ambiguous». Daí `transacao_id` e
--    `movimento_id`.
RETURNS TABLE (match_id uuid, transacao_id uuid, movimento_id uuid, rejeitadas int)
LANGUAGE plpgsql
SECURITY INVOKER
AS $fn$
DECLARE
  v_match  public.bank_reconciliation_matches%ROWTYPE;
  v_mov    public.cash_flow_entries%ROWTYPE;
  v_tem_mov boolean := false;
  v_tx     uuid;
  v_data_tx date;
  v_rejeit int;
BEGIN
  -- 🔴 Primeiro a transacção bancária, e só depois tudo o resto.
  --
  --    Duas pessoas podem confirmar sugestões **diferentes** da mesma
  --    transacção bancária. Trancar a correspondência escolhida não as faz
  --    encontrar-se: são linhas distintas, e cada uma tranca a sua. As duas
  --    passariam, e a transacção ficava com duas correspondências confirmadas
  --    — duas verdades incompatíveis sobre o mesmo movimento do banco.
  --
  --    A transacção bancária é o ponto de contenção comum: é a única linha que
  --    ambas têm de tocar. Quem chega primeiro tranca-a; a segunda espera e
  --    depois vê o estado já escrito.
  SELECT bank_transaction_id INTO v_tx
    FROM public.bank_reconciliation_matches
   WHERE id = p_match_id AND company_id = p_company_id;

  IF v_tx IS NULL THEN
    RAISE EXCEPTION 'BANK_MATCH_NOT_FOUND' USING ERRCODE = 'no_data_found';
  END IF;

  SELECT transaction_date INTO v_data_tx
    FROM public.bank_transactions
   WHERE id = v_tx AND company_id = p_company_id
   FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'BANK_TRANSACTION_NOT_FOUND' USING ERRCODE = 'no_data_found';
  END IF;

  -- Relê a correspondência **depois** do lock: o que se leu antes de esperar
  -- pode já não ser verdade.
  SELECT * INTO v_match
    FROM public.bank_reconciliation_matches
   WHERE id = p_match_id AND company_id = p_company_id
   FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'BANK_MATCH_NOT_FOUND' USING ERRCODE = 'no_data_found';
  END IF;

  -- Já houve uma confirmação para esta transacção bancária? Então esta perdeu.
  -- Não se sobrepõe em silêncio: recusa-se, e quem chamou vê o estado final.
  IF EXISTS (
    SELECT 1 FROM public.bank_reconciliation_matches
     WHERE bank_transaction_id = v_tx AND company_id = p_company_id
       AND status = 'confirmed' AND id <> p_match_id
  ) THEN
    RAISE EXCEPTION 'BANK_TRANSACTION_ALREADY_RECONCILED'
      USING ERRCODE = 'object_not_in_prerequisite_state';
  END IF;

  IF v_match.status = 'rejected' THEN
    RAISE EXCEPTION 'BANK_MATCH_REJECTED'
      USING ERRCODE = 'object_not_in_prerequisite_state';
  END IF;

  IF v_match.cash_flow_entry_id IS NOT NULL THEN
    -- O mesmo lock que as mutações manuais tomam. É aqui que a conciliação e
    -- a edição de um movimento se encontram.
    SELECT * INTO v_mov
      FROM public.cash_flow_entries
     WHERE id = v_match.cash_flow_entry_id AND company_id = p_company_id
     FOR UPDATE;

    IF NOT FOUND THEN
      RAISE EXCEPTION 'CASHFLOW_VANISHED_BEFORE_RECONCILE'
        USING ERRCODE = 'object_not_in_prerequisite_state';
    END IF;
    v_tem_mov := true;
  END IF;

  -- 🔴 Os períodos, depois de todas as linhas trancadas e antes de qualquer
  --    escrita. A ordem é a da 090.
  PERFORM public.assert_financial_period_dates_open_locked(
    p_company_id,
    ARRAY[v_data_tx, CASE WHEN v_tem_mov THEN v_mov.date ELSE NULL END]
  );

  UPDATE public.bank_reconciliation_matches
     SET status = 'confirmed', confirmed_by = p_actor_id, confirmed_at = now()
   WHERE id = p_match_id;

  -- 🔴 As sugestões restantes e o estado da transacção pertencem a esta
  --    transacção, não a chamadas seguintes da aplicação. Feitas de fora,
  --    ficavam sujeitas a falhar depois da confirmação já ter sido gravada —
  --    e sobrava uma transacção bancária confirmada com sugestões abertas, ou
  --    por reconciliar.
  UPDATE public.bank_reconciliation_matches
     SET status = 'rejected'
   WHERE bank_transaction_id = v_tx AND company_id = p_company_id
     AND id <> p_match_id AND status = 'suggested';
  GET DIAGNOSTICS v_rejeit = ROW_COUNT;

  UPDATE public.bank_transactions
     SET status = 'reconciled', updated_at = now()
   WHERE id = v_tx AND company_id = p_company_id;

  RETURN QUERY SELECT p_match_id, v_tx, v_match.cash_flow_entry_id, v_rejeit;
END;
$fn$;

-- ─── 2. Rejeitar uma sugestão ───────────────────────────────────────────────
--
-- NOVA. Preserva exactamente o que a action faz: rejeita a sugestão e, se a
-- transacção ficar sem sugestões activas nem confirmação, devolve-a a
-- `pending` — mas só se estava em `matched`.
--
-- 🔴 É a operação que ACRESCENTA um bloqueador. Uma transacção que volta a
--    `pending` volta a contar em `movimentos_por_conciliar`, e fazê-lo num mês
--    fechado põe lá dentro um pendente que o fecho nunca viu.
CREATE OR REPLACE FUNCTION public.reject_bank_match_atomic(
  p_company_id uuid,
  p_match_id   uuid,
  p_actor_id   uuid DEFAULT NULL
)
RETURNS TABLE (match_id uuid, transacao_id uuid, voltou_a_pendente boolean)
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = pg_catalog, public
AS $fn$
DECLARE
  v_tx      uuid;
  v_data_tx date;
  v_estado  text;
  v_activas int;
  v_voltou  boolean := false;
BEGIN
  IF p_actor_id IS NOT NULL THEN
    PERFORM set_config('app.actor_id', p_actor_id::text, true);
  END IF;

  SELECT bank_transaction_id INTO v_tx
    FROM public.bank_reconciliation_matches
   WHERE id = p_match_id AND company_id = p_company_id;

  IF v_tx IS NULL THEN
    RAISE EXCEPTION 'BANK_MATCH_NOT_FOUND' USING ERRCODE = 'no_data_found';
  END IF;

  -- A transacção bancária primeiro, como em `confirm`: é o ponto de contenção
  -- comum, e é a mesma ordem, que é o que impede um ciclo entre as duas.
  SELECT transaction_date, status INTO v_data_tx, v_estado
    FROM public.bank_transactions
   WHERE id = v_tx AND company_id = p_company_id
   FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'BANK_TRANSACTION_NOT_FOUND' USING ERRCODE = 'no_data_found';
  END IF;

  PERFORM public.assert_financial_period_dates_open_locked(p_company_id, ARRAY[v_data_tx]);

  UPDATE public.bank_reconciliation_matches
     SET status = 'rejected'
   WHERE id = p_match_id AND company_id = p_company_id;

  SELECT count(*) INTO v_activas
    FROM public.bank_reconciliation_matches
   WHERE bank_transaction_id = v_tx AND company_id = p_company_id
     AND status IN ('suggested', 'confirmed');

  IF v_activas = 0 AND v_estado = 'matched' THEN
    UPDATE public.bank_transactions
       SET status = 'pending', updated_at = now()
     WHERE id = v_tx AND company_id = p_company_id;
    v_voltou := true;
  END IF;

  RETURN QUERY SELECT p_match_id, v_tx, v_voltou;
END;
$fn$;

-- ─── 3. Associação manual ───────────────────────────────────────────────────
--
-- NOVA. Hoje são três viagens: o upsert da correspondência, a rejeição das
-- outras sugestões e o estado da transacção. Uma falha entre elas deixa uma
-- correspondência confirmada com a transacção ainda por reconciliar.
--
-- 🔴 Dois períodos: o da transacção e o do movimento de caixa que passa a ficar
--    conciliado — e portanto congelado para o `unmark` da 081.
CREATE OR REPLACE FUNCTION public.manual_bank_match_atomic(
  p_company_id  uuid,
  p_bank_tx_id  uuid,
  p_entry_id    uuid,
  p_actor_id    uuid
)
RETURNS TABLE (match_id uuid, rejeitadas int)
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = pg_catalog, public
AS $fn$
DECLARE
  v_data_tx  date;
  v_data_mov date;
  v_match    uuid;
  v_rejeit   int;
BEGIN
  IF p_actor_id IS NOT NULL THEN
    PERFORM set_config('app.actor_id', p_actor_id::text, true);
  END IF;

  SELECT transaction_date INTO v_data_tx
    FROM public.bank_transactions
   WHERE id = p_bank_tx_id AND company_id = p_company_id
   FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'BANK_TRANSACTION_NOT_FOUND' USING ERRCODE = 'no_data_found';
  END IF;

  -- 🔴 A validação de empresa vive aqui, e não só na action. Estas RPCs correm
  --    pelo `service_role`, que passa por cima do RLS: emparelhar uma
  --    transacção de uma empresa com o movimento de outra seria escrever
  --    dinheiro alheio no extracto errado.
  SELECT date INTO v_data_mov
    FROM public.cash_flow_entries
   WHERE id = p_entry_id AND company_id = p_company_id
   FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'CASHFLOW_NOT_FOUND' USING ERRCODE = 'no_data_found';
  END IF;

  PERFORM public.assert_financial_period_dates_open_locked(
    p_company_id, ARRAY[v_data_tx, v_data_mov]
  );

  INSERT INTO public.bank_reconciliation_matches (
    company_id, bank_transaction_id, cash_flow_entry_id,
    match_score, match_reason, status, confirmed_by, confirmed_at
  ) VALUES (
    p_company_id, p_bank_tx_id, p_entry_id,
    100, 'associação manual', 'confirmed', p_actor_id, now()
  )
  ON CONFLICT (bank_transaction_id, cash_flow_entry_id) DO UPDATE
    SET status = 'confirmed', match_score = 100, match_reason = 'associação manual',
        confirmed_by = p_actor_id, confirmed_at = now()
  RETURNING id INTO v_match;

  UPDATE public.bank_reconciliation_matches
     SET status = 'rejected'
   WHERE bank_transaction_id = p_bank_tx_id AND company_id = p_company_id
     AND cash_flow_entry_id IS DISTINCT FROM p_entry_id
     AND status = 'suggested';
  GET DIAGNOSTICS v_rejeit = ROW_COUNT;

  UPDATE public.bank_transactions
     SET status = 'reconciled', updated_at = now()
   WHERE id = p_bank_tx_id AND company_id = p_company_id;

  RETURN QUERY SELECT v_match, v_rejeit;
END;
$fn$;

-- ─── 4. Ignorar / voltar a considerar uma transacção ────────────────────────
--
-- NOVA. Preserva a recusa da action sobre transacção já conciliada.
--
-- 🔴 Nos dois sentidos mexe no bloqueador: ignorar tira-o, voltar atrás
--    devolve-o.
CREATE OR REPLACE FUNCTION public.set_bank_transaction_ignored_atomic(
  p_company_id uuid,
  p_bank_tx_id uuid,
  p_ignorar    boolean,
  p_actor_id   uuid DEFAULT NULL
)
RETURNS TABLE (transacao_id uuid, estado text)
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = pg_catalog, public
AS $fn$
DECLARE
  v_data_tx date;
  v_estado  text;
  v_novo    text;
BEGIN
  IF p_actor_id IS NOT NULL THEN
    PERFORM set_config('app.actor_id', p_actor_id::text, true);
  END IF;

  SELECT transaction_date, status INTO v_data_tx, v_estado
    FROM public.bank_transactions
   WHERE id = p_bank_tx_id AND company_id = p_company_id
   FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'BANK_TRANSACTION_NOT_FOUND' USING ERRCODE = 'no_data_found';
  END IF;

  IF v_estado = 'reconciled' THEN
    RAISE EXCEPTION 'BANK_TRANSACTION_ALREADY_RECONCILED'
      USING ERRCODE = 'object_not_in_prerequisite_state';
  END IF;

  PERFORM public.assert_financial_period_dates_open_locked(p_company_id, ARRAY[v_data_tx]);

  v_novo := CASE WHEN p_ignorar THEN 'ignored' ELSE 'pending' END;

  UPDATE public.bank_transactions
     SET status = v_novo, updated_at = now()
   WHERE id = p_bank_tx_id AND company_id = p_company_id;

  RETURN QUERY SELECT p_bank_tx_id, v_novo;
END;
$fn$;

-- ─── 5. Criar um lançamento a partir de uma transacção ──────────────────────
--
-- NOVA. Hoje são três viagens — o movimento de caixa, a correspondência, o
-- estado da transacção — e uma falha a meio deixa um movimento de caixa criado
-- sem correspondência nenhuma, invisível no ecrã da conciliação e a somar no
-- mês na mesma.
--
-- Preserva a lógica da action: a categoria por omissão segue a direcção do
-- movimento bancário, o tipo também, e a data do movimento de caixa é a
-- `transaction_date` — que é a data autoritativa e a única em jogo aqui.
CREATE OR REPLACE FUNCTION public.create_cashflow_from_bank_transaction_atomic(
  p_company_id uuid,
  p_bank_tx_id uuid,
  p_category   text DEFAULT NULL,
  p_actor_id   uuid DEFAULT NULL
)
RETURNS TABLE (entry_id uuid, match_id uuid)
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = pg_catalog, public
AS $fn$
DECLARE
  v_tx       public.bank_transactions%ROWTYPE;
  v_categoria text;
  v_entrada  uuid;
  v_match    uuid;
BEGIN
  IF p_actor_id IS NOT NULL THEN
    PERFORM set_config('app.actor_id', p_actor_id::text, true);
  END IF;

  SELECT * INTO v_tx
    FROM public.bank_transactions
   WHERE id = p_bank_tx_id AND company_id = p_company_id
   FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'BANK_TRANSACTION_NOT_FOUND' USING ERRCODE = 'no_data_found';
  END IF;

  IF v_tx.status = 'reconciled' THEN
    RAISE EXCEPTION 'BANK_TRANSACTION_ALREADY_RECONCILED'
      USING ERRCODE = 'object_not_in_prerequisite_state';
  END IF;

  IF v_tx.amount IS NULL OR v_tx.amount <= 0 THEN
    RAISE EXCEPTION 'CASHFLOW_AMOUNT_INVALID' USING ERRCODE = 'check_violation';
  END IF;

  PERFORM public.assert_financial_period_dates_open_locked(p_company_id, ARRAY[v_tx.transaction_date]);

  v_categoria := COALESCE(
    p_category,
    CASE WHEN v_tx.direction = 'credit' THEN 'faturacao' ELSE 'despesa' END
  );

  INSERT INTO public.cash_flow_entries (
    company_id, type, amount, description, category, date, status, notes, created_by
  ) VALUES (
    p_company_id,
    CASE WHEN v_tx.direction = 'credit' THEN 'entrada' ELSE 'saida' END,
    v_tx.amount,
    -- A action punha «Movimento bancário» quando a descrição vinha vazia; a
    -- coluna é NOT NULL, e uma descrição em branco num movimento de caixa é
    -- uma linha que ninguém consegue identificar no extracto.
    COALESCE(NULLIF(btrim(v_tx.description), ''), 'Movimento bancário'),
    v_categoria,
    v_tx.transaction_date,
    'confirmado',
    'Criado a partir de conciliação bancária',
    p_actor_id
  )
  RETURNING id INTO v_entrada;

  INSERT INTO public.bank_reconciliation_matches (
    company_id, bank_transaction_id, cash_flow_entry_id,
    match_score, match_reason, status, confirmed_by, confirmed_at
  ) VALUES (
    p_company_id, p_bank_tx_id, v_entrada,
    100, 'lançamento criado a partir do movimento', 'confirmed', p_actor_id, now()
  )
  RETURNING id INTO v_match;

  UPDATE public.bank_transactions
     SET status = 'reconciled', updated_at = now()
   WHERE id = p_bank_tx_id AND company_id = p_company_id;

  RETURN QUERY SELECT v_entrada, v_match;
END;
$fn$;

-- ─── 6. Apagar uma importação — N períodos de uma vez ───────────────────────
--
-- NOVA. Preserva o que a action faz e o que ela NÃO faz: apaga a importação e,
-- em cascata, as suas transacções e correspondências; não toca nos movimentos
-- de caixa criados a partir dela — a chave estrangeira da correspondência é
-- `ON DELETE CASCADE` sobre `cash_flow_entry_id`, mas apagar a correspondência
-- não apaga o movimento, e é isso que se quer.
--
-- 🔴 Este é o writer sem número fixo de períodos. Um extracto atravessa meses,
--    e cada mês tocado perde os seus pendentes de uma vez. O conjunto é
--    descoberto por leitura das transacções — sob o lock da própria importação,
--    que é a linha por onde todos os writers desta cascata passam — e entregue
--    inteiro ao protocolo antes da primeira escrita.
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

-- ─── Superfície ─────────────────────────────────────────────────────────────
REVOKE ALL PRIVILEGES ON FUNCTION public.confirm_bank_match_atomic(uuid, uuid, uuid) FROM PUBLIC, anon, authenticated;
REVOKE ALL PRIVILEGES ON FUNCTION public.reject_bank_match_atomic(uuid, uuid, uuid) FROM PUBLIC, anon, authenticated;
REVOKE ALL PRIVILEGES ON FUNCTION public.manual_bank_match_atomic(uuid, uuid, uuid, uuid) FROM PUBLIC, anon, authenticated;
REVOKE ALL PRIVILEGES ON FUNCTION public.set_bank_transaction_ignored_atomic(uuid, uuid, boolean, uuid) FROM PUBLIC, anon, authenticated;
REVOKE ALL PRIVILEGES ON FUNCTION public.create_cashflow_from_bank_transaction_atomic(uuid, uuid, text, uuid) FROM PUBLIC, anon, authenticated;
REVOKE ALL PRIVILEGES ON FUNCTION public.delete_bank_import_atomic(uuid, uuid, uuid) FROM PUBLIC, anon, authenticated;

GRANT EXECUTE ON FUNCTION public.confirm_bank_match_atomic(uuid, uuid, uuid) TO postgres, service_role;
GRANT EXECUTE ON FUNCTION public.reject_bank_match_atomic(uuid, uuid, uuid) TO postgres, service_role;
GRANT EXECUTE ON FUNCTION public.manual_bank_match_atomic(uuid, uuid, uuid, uuid) TO postgres, service_role;
GRANT EXECUTE ON FUNCTION public.set_bank_transaction_ignored_atomic(uuid, uuid, boolean, uuid) TO postgres, service_role;
GRANT EXECUTE ON FUNCTION public.create_cashflow_from_bank_transaction_atomic(uuid, uuid, text, uuid) TO postgres, service_role;
GRANT EXECUTE ON FUNCTION public.delete_bank_import_atomic(uuid, uuid, uuid) TO postgres, service_role;

-- ─── Pós-estado ─────────────────────────────────────────────────────────────
DO $posestado$
DECLARE
  v_faltam text[];
BEGIN
  SELECT array_agg(esperado.nome) INTO v_faltam
    FROM (VALUES
      ('confirm_bank_match_atomic',                     'p_company_id uuid, p_match_id uuid, p_actor_id uuid'),
      ('reject_bank_match_atomic',                      'p_company_id uuid, p_match_id uuid, p_actor_id uuid'),
      ('manual_bank_match_atomic',                      'p_company_id uuid, p_bank_tx_id uuid, p_entry_id uuid, p_actor_id uuid'),
      ('set_bank_transaction_ignored_atomic',           'p_company_id uuid, p_bank_tx_id uuid, p_ignorar boolean, p_actor_id uuid'),
      ('create_cashflow_from_bank_transaction_atomic',  'p_company_id uuid, p_bank_tx_id uuid, p_category text, p_actor_id uuid'),
      ('delete_bank_import_atomic',                     'p_company_id uuid, p_import_id uuid, p_actor_id uuid')
    ) AS esperado(nome, assinatura)
   WHERE NOT EXISTS (
     SELECT 1 FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
      WHERE n.nspname = 'public' AND p.proname = esperado.nome
        AND pg_get_function_identity_arguments(p.oid) = esperado.assinatura
        AND NOT p.prosecdef
   );

  IF v_faltam IS NOT NULL THEN
    RAISE EXCEPTION 'BANK_PERIOD_095_POSTSTATE_FAILED: em falta ou com assinatura/segurança errada %', v_faltam;
  END IF;
END
$posestado$;

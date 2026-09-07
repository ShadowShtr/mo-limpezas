-- ============================================================================
-- 093 — fluxo de caixa manual dentro do protocolo de período
-- ============================================================================
--
-- O runner é o dono da transação e do registo no `_migrations`: este ficheiro
-- não abre `BEGIN`/`COMMIT` próprios.
--
-- ---------------------------------------------------------------------------
-- O que falta hoje, exactamente
-- ---------------------------------------------------------------------------
--
-- Os três writers manuais do caixa — criar, editar, apagar — têm guarda, e a
-- guarda está no sítio errado: em `src/app/actions/cash-flow.ts`, ANTES da
-- chamada à base.
--
--     action: assertFinancialPeriodOpen()  →  (outra sessão fecha o mês)
--     →  RPC: WRITE
--
-- Duas viagens, duas transações. A pergunta é respondida sobre um estado que
-- pode deixar de ser verdade antes da escrita — e é precisamente esse o defeito
-- que a 090 existe para fechar. A guarda da action não desaparece nem passa a
-- estar errada: continua a dar a mensagem com o nome do mês em vez de a deduzir
-- de um erro de plpgsql. Deixa é de ser a garantia.
--
-- ---------------------------------------------------------------------------
-- 🔴 Editar um movimento toca em DOIS meses
-- ---------------------------------------------------------------------------
--
-- `update_cashflow_entry_atomic` aceita `date` no patch. Mudar a data de um
-- movimento de Julho para Agosto tira dinheiro de Julho e põe-no em Agosto: os
-- dois meses mudam de conteúdo, e os dois têm de estar abertos.
--
-- A guarda da action olha para UM dos dois — e, pior, olha para o que vier no
-- patch, que é o destino. A origem ficava por proteger, e esvaziar um mês
-- fechado por arrastamento passava sem nada a assinalar.
--
-- E não é só a data: `status` também. Um movimento `pendente` que passa a
-- `confirmado` muda o que o mês vale, e `saidas_sem_categoria` — um dos quatro
-- bloqueadores do fecho — conta por `date`, não por estado. Tudo isto é o mesmo
-- mês, e o lock cobre-o na mesma.
--
-- ---------------------------------------------------------------------------
-- Compatibilidade — EXPAND FIRST
-- ---------------------------------------------------------------------------
--
-- `update_cashflow_entry_atomic` e `delete_cashflow_entry_atomic` mantêm a
-- assinatura EXACTA e toda a lógica da 082: a lista branca de campos editáveis,
-- a recusa sobre movimento com origem (`CASHFLOW_MANAGED_BY_ORIGIN`) e sobre
-- movimento conciliado (`CASHFLOW_RECONCILED`), ambas via
-- `lock_cashflow_for_manual_mutation`, que não muda.
--
-- `create_cashflow_entry_atomic` é NOVA: hoje a criação é um INSERT directo da
-- server action e não passa pela base.
-- ============================================================================

DO $precondicoes$
DECLARE
  v_faltam text[];
BEGIN
  SELECT array_agg(esperado.nome || '(' || esperado.assinatura || ')') INTO v_faltam
    FROM (VALUES
      ('assert_financial_periods_open_locked_many', 'p_company_id uuid, p_keys integer[]'),
      ('financial_period_lock_keys',                'p_dates date[]'),
      ('assert_financial_period_dates_open_locked', 'p_company_id uuid, p_dates date[]'),
      ('lock_cashflow_for_manual_mutation',         'p_company_id uuid, p_entry_id uuid'),
      ('update_cashflow_entry_atomic',              'p_company_id uuid, p_entry_id uuid, p_patch jsonb'),
      ('delete_cashflow_entry_atomic',              'p_company_id uuid, p_entry_id uuid')
    ) AS esperado(nome, assinatura)
   WHERE NOT EXISTS (
     SELECT 1 FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
      WHERE n.nspname = 'public' AND p.proname = esperado.nome
        AND pg_get_function_identity_arguments(p.oid) = esperado.assinatura
   );

  IF v_faltam IS NOT NULL THEN
    RAISE EXCEPTION 'CASHFLOW_PERIOD_093_PRECONDITION_FAILED: em falta %', v_faltam;
  END IF;
END
$precondicoes$;

-- ─── 1. Criar um movimento manual, sob o lock da sua data ───────────────────
--
-- NOVA. Preserva o que a action faz hoje, incluindo a razão de `expense_
-- category_id` ser opcional: o histórico não tem categoria estruturada, e
-- exigi-la aqui impediria de registar uma despesa numa base onde a 071 ainda
-- não foi aplicada.
--
-- 🔴 Movimentos MANUAIS apenas. `reference_type` e `reference_id` não são
--    parâmetros de propósito: um movimento com origem pertence a essa origem —
--    pagamento, fatura, cobrança avulsa — e é ela que o cria, dentro do seu
--    próprio protocolo. Dar aqui uma porta para os fabricar à mão criaria
--    movimentos ligados que nenhuma das RPCs de origem sabe que existem, e que
--    `lock_cashflow_for_manual_mutation` depois recusa editar para sempre.
--
-- 🔴 A data autoritativa é a DO MOVIMENTO, não hoje. Um movimento lançado hoje
--    com data de Julho pertence a Julho, e é Julho que tem de estar aberto.
CREATE OR REPLACE FUNCTION public.create_cashflow_entry_atomic(
  p_company_id          uuid,
  p_type                text,
  p_amount              numeric,
  p_description         text,
  p_category            text,
  p_date                date,
  p_status              text DEFAULT 'confirmado',
  p_notes               text DEFAULT NULL,
  p_expense_category_id uuid DEFAULT NULL,
  p_actor               uuid DEFAULT NULL
)
RETURNS TABLE (entry_id uuid)
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = pg_catalog, public
AS $fn$
DECLARE
  v_id uuid;
BEGIN
  IF p_company_id IS NULL OR p_date IS NULL THEN
    RAISE EXCEPTION 'CASHFLOW_INVALID_ARGS' USING ERRCODE = 'check_violation';
  END IF;

  IF p_type IS NULL OR p_type NOT IN ('entrada', 'saida') THEN
    RAISE EXCEPTION 'CASHFLOW_TYPE_INVALID: %', p_type USING ERRCODE = 'check_violation';
  END IF;

  IF p_status IS NULL OR p_status NOT IN ('pendente', 'confirmado') THEN
    RAISE EXCEPTION 'CASHFLOW_STATUS_INVALID: %', p_status USING ERRCODE = 'check_violation';
  END IF;

  IF p_description IS NULL OR btrim(p_description) = '' THEN
    RAISE EXCEPTION 'CASHFLOW_DESCRIPTION_REQUIRED' USING ERRCODE = 'check_violation';
  END IF;

  -- O `CHECK` da tabela aceita qualquer numérico; a regra de negócio não. Um
  -- movimento de zero não é dinheiro nenhum a mexer, e um negativo inverteria o
  -- sinal de uma entrada ou de uma saída sem mudar o `type` — duas formas de
  -- pôr o mês a somar o contrário do que aconteceu.
  IF p_amount IS NULL OR p_amount <= 0 THEN
    RAISE EXCEPTION 'CASHFLOW_AMOUNT_INVALID' USING ERRCODE = 'check_violation';
  END IF;

  IF p_actor IS NOT NULL THEN
    PERFORM set_config('app.actor_id', p_actor::text, true);
  END IF;

  PERFORM public.assert_financial_period_dates_open_locked(p_company_id, ARRAY[p_date]);

  INSERT INTO public.cash_flow_entries (
    company_id, type, amount, description, category, date, status, notes,
    expense_category_id, created_by
  ) VALUES (
    p_company_id, p_type, p_amount, btrim(p_description), p_category, p_date,
    p_status, p_notes, p_expense_category_id, p_actor
  )
  RETURNING id INTO v_id;

  RETURN QUERY SELECT v_id;
END;
$fn$;

-- ─── 2. Alterar um movimento manual, com origem E destino protegidos ────────
--
-- `CREATE OR REPLACE` da função da 082. Preserva tudo:
-- `lock_cashflow_for_manual_mutation` continua a ser a primeira coisa que
-- acontece — tranca a linha, recusa movimentos com origem e movimentos
-- conciliados — e a lista branca de campos continua a mesma. Um passthrough do
-- `jsonb` deixaria alterar `company_id`, `reference_type` ou `id`, e a guarda
-- acabada de correr passaria a descrever outra linha.
--
-- 🔴 A ordem é a da 090: a LINHA primeiro (é dela que sai a data actual), os
--    PERÍODOS depois, a escrita no fim.
CREATE OR REPLACE FUNCTION public.update_cashflow_entry_atomic(
  p_company_id uuid,
  p_entry_id   uuid,
  p_patch      jsonb
)
RETURNS TABLE (entry_id uuid)
LANGUAGE plpgsql
SECURITY INVOKER
AS $fn$
DECLARE
  v_mov       public.cash_flow_entries%ROWTYPE;
  v_proibidas text[];
  v_data_nova date;
BEGIN
  v_mov := public.lock_cashflow_for_manual_mutation(p_company_id, p_entry_id);

  SELECT array_agg(k) INTO v_proibidas
    FROM jsonb_object_keys(p_patch) AS k
   WHERE k NOT IN ('type', 'amount', 'description', 'category', 'date',
                   'status', 'expense_category_id', 'notes');

  IF v_proibidas IS NOT NULL THEN
    RAISE EXCEPTION 'CASHFLOW_FIELD_NOT_EDITABLE: %', array_to_string(v_proibidas, ', ')
      USING ERRCODE = 'check_violation';
  END IF;

  -- 🔴 Os dois meses. A data nova só se conhece com a linha na mão: um patch
  --    sem `date` mantém a que lá está, e nesse caso os dois são o mesmo — o
  --    protocolo da 090 deduplica e faz um lock só.
  v_data_nova := COALESCE((p_patch->>'date')::date, v_mov.date);

  PERFORM public.assert_financial_period_dates_open_locked(
    p_company_id, ARRAY[v_mov.date, v_data_nova]
  );

  UPDATE public.cash_flow_entries c
     SET type        = COALESCE(p_patch->>'type', c.type),
         amount      = COALESCE((p_patch->>'amount')::numeric, c.amount),
         description = COALESCE(p_patch->>'description', c.description),
         category    = CASE WHEN p_patch ? 'category'
                            THEN p_patch->>'category' ELSE c.category END,
         date        = COALESCE((p_patch->>'date')::date, c.date),
         status      = COALESCE(p_patch->>'status', c.status),
         expense_category_id = CASE WHEN p_patch ? 'expense_category_id'
                                   THEN (p_patch->>'expense_category_id')::uuid
                                   ELSE c.expense_category_id END,
         notes       = CASE WHEN p_patch ? 'notes'
                            THEN p_patch->>'notes' ELSE c.notes END
   WHERE c.id = p_entry_id;

  RETURN QUERY SELECT p_entry_id;
END;
$fn$;

-- ─── 3. Apagar um movimento manual, sob o lock da sua data ──────────────────
--
-- `CREATE OR REPLACE` da função da 082, com a mesma guarda de linha e as mesmas
-- recusas. Apagar toca num mês só — o do movimento.
CREATE OR REPLACE FUNCTION public.delete_cashflow_entry_atomic(
  p_company_id uuid,
  p_entry_id   uuid
)
RETURNS TABLE (entry_id uuid, apagados int)
LANGUAGE plpgsql
SECURITY INVOKER
AS $fn$
DECLARE
  v_mov      public.cash_flow_entries%ROWTYPE;
  v_apagados int;
BEGIN
  v_mov := public.lock_cashflow_for_manual_mutation(p_company_id, p_entry_id);

  PERFORM public.assert_financial_period_dates_open_locked(p_company_id, ARRAY[v_mov.date]);

  DELETE FROM public.cash_flow_entries WHERE id = p_entry_id;
  GET DIAGNOSTICS v_apagados = ROW_COUNT;

  RETURN QUERY SELECT p_entry_id, v_apagados;
END;
$fn$;

-- ─── Superfície ─────────────────────────────────────────────────────────────
REVOKE ALL PRIVILEGES ON FUNCTION public.create_cashflow_entry_atomic(uuid, text, numeric, text, text, date, text, text, uuid, uuid) FROM PUBLIC, anon, authenticated;
REVOKE ALL PRIVILEGES ON FUNCTION public.update_cashflow_entry_atomic(uuid, uuid, jsonb) FROM PUBLIC, anon, authenticated;
REVOKE ALL PRIVILEGES ON FUNCTION public.delete_cashflow_entry_atomic(uuid, uuid) FROM PUBLIC, anon, authenticated;

GRANT EXECUTE ON FUNCTION public.create_cashflow_entry_atomic(uuid, text, numeric, text, text, date, text, text, uuid, uuid) TO postgres, service_role;
GRANT EXECUTE ON FUNCTION public.update_cashflow_entry_atomic(uuid, uuid, jsonb) TO postgres, service_role;
GRANT EXECUTE ON FUNCTION public.delete_cashflow_entry_atomic(uuid, uuid) TO postgres, service_role;

-- ─── Pós-estado ─────────────────────────────────────────────────────────────
DO $posestado$
DECLARE
  v_faltam text[];
BEGIN
  SELECT array_agg(esperado.nome) INTO v_faltam
    FROM (VALUES
      ('create_cashflow_entry_atomic', 'p_company_id uuid, p_type text, p_amount numeric, p_description text, p_category text, p_date date, p_status text, p_notes text, p_expense_category_id uuid, p_actor uuid'),
      ('update_cashflow_entry_atomic', 'p_company_id uuid, p_entry_id uuid, p_patch jsonb'),
      ('delete_cashflow_entry_atomic', 'p_company_id uuid, p_entry_id uuid')
    ) AS esperado(nome, assinatura)
   WHERE NOT EXISTS (
     SELECT 1 FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
      WHERE n.nspname = 'public' AND p.proname = esperado.nome
        AND pg_get_function_identity_arguments(p.oid) = esperado.assinatura
        AND NOT p.prosecdef
   );

  IF v_faltam IS NOT NULL THEN
    RAISE EXCEPTION 'CASHFLOW_PERIOD_093_POSTSTATE_FAILED: em falta ou com assinatura/segurança errada %', v_faltam;
  END IF;
END
$posestado$;

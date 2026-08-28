-- ============================================================================
-- 082 — guarda e escrita na MESMA transacção (TOCTOU financeiro)
-- ============================================================================
--
-- As acções financeiras liam o estado por PostgREST, decidiam, e escreviam num
-- segundo pedido. Entre a leitura e a escrita não há transacção, não há lock e
-- não há predicado: qualquer coisa pode acontecer no meio.
--
--   updatePayment        lê "sem movimento de caixa" → B corre
--                        `mark_payment_paid` e liga um movimento → A grava o
--                        novo valor. Fica `payment.amount` ≠
--                        `cash_flow_entries.amount`, e a marcação seguinte
--                        rebenta com `CASHFLOW_LINK_AMOUNT_MISMATCH` sobre
--                        dados que já divergiram.
--   deletePayment        lê "sem movimento" → B liga um → A apaga o pagamento
--                        e deixa o movimento a apontar para o vazio.
--   updateCashFlowEntry  lê "sem conciliação confirmada" → B confirma → A
--                        altera um movimento já conciliado.
--   deleteCashFlowEntry  o mesmo, a apagar.
--
-- Nenhum destes é um erro de validação: é uma corrida. Validar melhor não
-- resolve, porque o problema é o intervalo, não o critério.
--
-- ---------------------------------------------------------------------------
-- O protocolo de lock já existia — isto passa a usá-lo
-- ---------------------------------------------------------------------------
--
-- Não se inventa aqui uma segunda arquitectura financeira. A 073/079 já fixou
-- a disciplina: `mark_payment_paid` tranca a linha do pagamento com
-- `FOR UPDATE` antes de tocar no caixa, e tranca também a linha do movimento.
-- Basta que quem muta tome o MESMO lock, e as duas operações deixam de se
-- cruzar — serializam na linha, que é onde a verdade vive.
--
--   pagamentos  →  FOR UPDATE em `fixed_variable_payments`  (o mesmo do mark)
--   movimentos  →  FOR UPDATE em `cash_flow_entries`        (o mesmo do mark)
--
-- É por isso que a confirmação de conciliação também passa por aqui: era um
-- `UPDATE` directo que não trancava nada. Sem ela no protocolo, trancar do lado
-- do movimento não provaria coisa nenhuma — um lock só serializa contra quem o
-- pede. Essa é a metade da correcção que é fácil esquecer.
--
--     TOCTOU_FIX_STRATEGY = SHARED_ROW_LOCK_PROTOCOL
--     SECOND_FINANCE_ARCHITECTURE = NO
--     MIGRATION_DATA_WRITES = 0
--
-- ---------------------------------------------------------------------------
-- De onde vem o isolamento — e de onde NÃO vem
-- ---------------------------------------------------------------------------
--
-- 🔴 Não é do RLS. Dizê-lo seria descrever uma garantia que não existe neste
--    caminho, e é assim que uma verificação em falta passa despercebida.
--
--    As funções são `SECURITY INVOKER` e não elevam privilégio nenhum — isso
--    está certo e mantém-se. Mas o chamador normal da aplicação é
--    `service_role`, porque o caminho canónico é
--
--        Server Action → requireProfile(admin/gestor) → service_role → RPC
--
--    e `service_role` tem `BYPASSRLS`. As políticas não se aplicam. Se um
--    predicado de empresa cair, não há segunda linha de defesa a apanhá-lo.
--
--    O isolamento da aplicação é, e só é:
--
--        requireProfile          quem pode pedir
--      + profile.company_id      resolvido no servidor, nunca vindo do cliente
--      + predicados explícitos   cada função confronta `p_company_id` com a linha
--      + EXECUTE restrito        secção 7: só `service_role`
--
--    O `p_company_id` é sempre confrontado com a linha, nunca aceite por si só.
--
-- ---------------------------------------------------------------------------
-- A transacção é do runner, não desta migração
-- ---------------------------------------------------------------------------
--
-- 🔴 Este ficheiro não abre nem fecha transacção. É deliberado, e foi medido:
--    o runner faz `BEGIN → SQL → INSERT public._migrations → COMMIT`, e um
--    `COMMIT` interno fecharia a transacção dele mais cedo. A partir daí a
--    escrita no ledger corre fora dela — e se falhar, o efeito de schema fica
--    aplicado sem registo. É o `SCHEMA_EFFECT != MIGRATION_PROVENANCE` que
--    esta frente inteira existe para eliminar, e foi o que aconteceu às
--    079/080/081 até serem corrigidas pelo mesmo motivo.
--
--        MIGRATION_SCHEMA_EFFECT + LEDGER_INSERT = UMA transacção, a do runner
--
--    Se o registo no ledger falhar, as seis funções e as suas ACL revertem
--    com ele.
-- ============================================================================

-- ─── 1. Alterar o valor de um pagamento ─────────────────────────────────────
CREATE OR REPLACE FUNCTION public.update_payment_amount_atomic(
  p_company_id uuid,
  p_payment_id uuid,
  p_amount     numeric
)
RETURNS TABLE (payment_id uuid, amount numeric, alterou boolean)
LANGUAGE plpgsql
SECURITY INVOKER
AS $fn$
DECLARE
  v_pag public.fixed_variable_payments%ROWTYPE;
  v_mov uuid;
BEGIN
  -- 🔴 `NULL` é um valor legítimo, não um erro.
  --
  --    Um pagamento pendente pode existir sem valor — a fatura ainda não
  --    chegou. Recusar `NULL` aqui tornaria impossível criar ou repor esse
  --    estado pela aplicação, e seria a função a inventar uma regra de negócio
  --    que o domínio não tem. Só um valor **negativo** é inválido.
  IF p_amount IS NOT NULL AND p_amount < 0 THEN
    RAISE EXCEPTION 'PAYMENT_AMOUNT_INVALID' USING ERRCODE = 'check_violation';
  END IF;

  -- 🔴 O lock primeiro, a decisão depois. É o mesmo lock que
  --    `mark_payment_paid` toma: a partir daqui, ou esta função corre inteira
  --    antes da marcação, ou depois dela — nunca no meio.
  SELECT * INTO v_pag
    FROM public.fixed_variable_payments
   WHERE id = p_payment_id AND company_id = p_company_id
   FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'PAYMENT_NOT_FOUND' USING ERRCODE = 'no_data_found';
  END IF;

  -- 🔴 Valor inalterado não é uma escrita.
  --
  --    O formulário reenvia todos os campos, inclusive o valor que não mudou.
  --    Recusar isso impediria alguém de corrigir a descrição ou as notas de um
  --    pagamento já pago — uma operação legítima que nada tem que ver com
  --    dinheiro. `IS NOT DISTINCT FROM` compara com `NULL` de ambos os lados,
  --    que `=` não faz.
  IF p_amount IS NOT DISTINCT FROM v_pag.amount THEN
    RETURN QUERY SELECT p_payment_id, v_pag.amount, false;
    RETURN;
  END IF;

  -- Daqui para baixo o valor muda mesmo, e aí sim as guardas valem.
  IF v_pag.status = 'pago' THEN
    RAISE EXCEPTION 'PAYMENT_ALREADY_PAID'
      USING ERRCODE = 'object_not_in_prerequisite_state';
  END IF;

  SELECT c.id INTO v_mov
    FROM public.cash_flow_entries c
   WHERE c.company_id = p_company_id
     AND c.reference_type = 'fixed_variable_payment'
     AND c.reference_id = p_payment_id
   LIMIT 1;

  IF v_mov IS NOT NULL THEN
    RAISE EXCEPTION 'PAYMENT_LINKED_TO_CASHFLOW'
      USING ERRCODE = 'object_not_in_prerequisite_state';
  END IF;

  UPDATE public.fixed_variable_payments
     SET amount = p_amount
   WHERE id = p_payment_id;

  RETURN QUERY SELECT p_payment_id, p_amount, true;
END;
$fn$;

-- ─── 2. Apagar um pagamento ─────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.delete_payment_atomic(
  p_company_id uuid,
  p_payment_id uuid
)
RETURNS TABLE (payment_id uuid, apagados int)
LANGUAGE plpgsql
SECURITY INVOKER
AS $fn$
DECLARE
  v_pag      public.fixed_variable_payments%ROWTYPE;
  v_mov      uuid;
  v_apagados int;
BEGIN
  SELECT * INTO v_pag
    FROM public.fixed_variable_payments
   WHERE id = p_payment_id AND company_id = p_company_id
   FOR UPDATE;

  IF NOT FOUND THEN
    -- Já não existe. Apagar o que não existe é sucesso, não erro.
    RETURN QUERY SELECT p_payment_id, 0;
    RETURN;
  END IF;

  IF v_pag.status = 'pago' THEN
    RAISE EXCEPTION 'PAYMENT_ALREADY_PAID'
      USING ERRCODE = 'object_not_in_prerequisite_state';
  END IF;

  SELECT c.id INTO v_mov
    FROM public.cash_flow_entries c
   WHERE c.company_id = p_company_id
     AND c.reference_type = 'fixed_variable_payment'
     AND c.reference_id = p_payment_id
   LIMIT 1;

  IF v_mov IS NOT NULL THEN
    RAISE EXCEPTION 'PAYMENT_LINKED_TO_CASHFLOW'
      USING ERRCODE = 'object_not_in_prerequisite_state';
  END IF;

  DELETE FROM public.fixed_variable_payments WHERE id = p_payment_id;
  GET DIAGNOSTICS v_apagados = ROW_COUNT;

  RETURN QUERY SELECT p_payment_id, v_apagados;
END;
$fn$;

-- ─── 3. Guarda partilhada do movimento ──────────────────────────────────────
--
-- Tranca a linha e recusa se ela não for editável. Existe como função própria
-- para os dois caminhos — alterar e apagar — usarem exactamente o mesmo
-- critério. Foi um critério duplicado e divergente que criou o F14-A; não se
-- repete o padrão aqui.
CREATE OR REPLACE FUNCTION public.lock_cashflow_for_manual_mutation(
  p_company_id uuid,
  p_entry_id   uuid
)
RETURNS public.cash_flow_entries
LANGUAGE plpgsql
SECURITY INVOKER
AS $fn$
DECLARE
  v_mov  public.cash_flow_entries%ROWTYPE;
  v_conc int;
BEGIN
  SELECT * INTO v_mov
    FROM public.cash_flow_entries
   WHERE id = p_entry_id AND company_id = p_company_id
   FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'CASHFLOW_NOT_FOUND' USING ERRCODE = 'no_data_found';
  END IF;

  -- Um movimento com origem é gerido por essa origem, não à mão.
  IF v_mov.reference_type IS NOT NULL THEN
    RAISE EXCEPTION 'CASHFLOW_MANAGED_BY_ORIGIN'
      USING ERRCODE = 'object_not_in_prerequisite_state';
  END IF;

  SELECT count(*) INTO v_conc
    FROM public.bank_reconciliation_matches m
   WHERE m.cash_flow_entry_id = p_entry_id
     AND m.status = 'confirmed';

  IF v_conc > 0 THEN
    RAISE EXCEPTION 'CASHFLOW_RECONCILED'
      USING ERRCODE = 'object_not_in_prerequisite_state';
  END IF;

  RETURN v_mov;
END;
$fn$;

-- ─── 4. Alterar um movimento manual ─────────────────────────────────────────
--
-- O patch chega em `jsonb`, mas só as chaves da lista branca são aplicadas. Um
-- passthrough deixaria alterar `company_id`, `reference_type` ou `id`, e a
-- guarda acabada de correr passaria a descrever outra linha.
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

-- ─── 5. Apagar um movimento manual ──────────────────────────────────────────
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

  DELETE FROM public.cash_flow_entries WHERE id = p_entry_id;
  GET DIAGNOSTICS v_apagados = ROW_COUNT;

  RETURN QUERY SELECT p_entry_id, v_apagados;
END;
$fn$;

-- ─── 6. Confirmar uma correspondência bancária ──────────────────────────────
--
-- 🔴 Sem isto, o resto não prova nada. Um lock só serializa contra quem o pede:
--    trancar a linha do movimento antes de a alterar não impede uma confirmação
--    concorrente que nunca tranca nada. A conciliação entra no mesmo protocolo,
--    e passa a ser a segunda metade da prova.
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
  v_tx     uuid;
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

  PERFORM 1 FROM public.bank_transactions
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
  END IF;

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

-- ─── 7. Quem pode executar isto ─────────────────────────────────────────────
--
-- 🔴 Sem este bloco, as seis funções acima nasciam com `EXECUTE` para
--    `PUBLIC` — o comportamento por omissão do PostgreSQL. Seriam seis RPC de
--    mutação financeira abertas a `anon` e a `authenticated`.
--
--    E a 083 **não as fecharia**. Ela revoga por lista explícita de
--    assinaturas — `mark_payment_paid`, `unmark_payment_paid`,
--    `assert_payment_cashflow_link`, `is_financial_period_open` — e não
--    conhece nomes que ainda não existiam quando foi escrita. Como a ordem é
--    081 → 082 → 083, seria fácil supor que a 083 «limpa a seguir». Não
--    limpa: reabria-se por uma porta nova exactamente o que ela fecha pela
--    porta da frente.
--
--    Por isso a 082 fecha as suas próprias funções. Não depende de nenhuma
--    migração posterior para ser segura, e a ordem entre as duas deixa de
--    importar para este efeito.
--
--     PAYMENT_MUTATION_CANONICAL_PATH_ONLY = mantido
--     NEW_AUTHENTICATED_MUTATION_RPC = 0
--
-- O caminho canónico da aplicação é Server Action → `requireProfile` →
-- `service_role` → RPC. `service_role` é o único executor legítimo destas
-- funções hoje. Se algum dia aparecer um caller autenticado com motivo
-- concreto, a resposta é um `GRANT` nomeado e justificado — não deixar a
-- porta aberta à espera dele.
--
-- `lock_cashflow_for_manual_mutation` entra na lista pelo mesmo critério de
-- mapa de callers que a 083 usou: só é invocada pelas duas funções acima, e
-- expô-la daria a qualquer um a capacidade de trancar linhas de caixa.

REVOKE EXECUTE ON FUNCTION public.update_payment_amount_atomic(uuid, uuid, numeric) FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION public.update_payment_amount_atomic(uuid, uuid, numeric) FROM anon;
REVOKE EXECUTE ON FUNCTION public.update_payment_amount_atomic(uuid, uuid, numeric) FROM authenticated;
GRANT  EXECUTE ON FUNCTION public.update_payment_amount_atomic(uuid, uuid, numeric) TO service_role;

REVOKE EXECUTE ON FUNCTION public.delete_payment_atomic(uuid, uuid) FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION public.delete_payment_atomic(uuid, uuid) FROM anon;
REVOKE EXECUTE ON FUNCTION public.delete_payment_atomic(uuid, uuid) FROM authenticated;
GRANT  EXECUTE ON FUNCTION public.delete_payment_atomic(uuid, uuid) TO service_role;

REVOKE EXECUTE ON FUNCTION public.lock_cashflow_for_manual_mutation(uuid, uuid) FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION public.lock_cashflow_for_manual_mutation(uuid, uuid) FROM anon;
REVOKE EXECUTE ON FUNCTION public.lock_cashflow_for_manual_mutation(uuid, uuid) FROM authenticated;
GRANT  EXECUTE ON FUNCTION public.lock_cashflow_for_manual_mutation(uuid, uuid) TO service_role;

REVOKE EXECUTE ON FUNCTION public.update_cashflow_entry_atomic(uuid, uuid, jsonb) FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION public.update_cashflow_entry_atomic(uuid, uuid, jsonb) FROM anon;
REVOKE EXECUTE ON FUNCTION public.update_cashflow_entry_atomic(uuid, uuid, jsonb) FROM authenticated;
GRANT  EXECUTE ON FUNCTION public.update_cashflow_entry_atomic(uuid, uuid, jsonb) TO service_role;

REVOKE EXECUTE ON FUNCTION public.delete_cashflow_entry_atomic(uuid, uuid) FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION public.delete_cashflow_entry_atomic(uuid, uuid) FROM anon;
REVOKE EXECUTE ON FUNCTION public.delete_cashflow_entry_atomic(uuid, uuid) FROM authenticated;
GRANT  EXECUTE ON FUNCTION public.delete_cashflow_entry_atomic(uuid, uuid) TO service_role;

REVOKE EXECUTE ON FUNCTION public.confirm_bank_match_atomic(uuid, uuid, uuid) FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION public.confirm_bank_match_atomic(uuid, uuid, uuid) FROM anon;
REVOKE EXECUTE ON FUNCTION public.confirm_bank_match_atomic(uuid, uuid, uuid) FROM authenticated;
GRANT  EXECUTE ON FUNCTION public.confirm_bank_match_atomic(uuid, uuid, uuid) TO service_role;

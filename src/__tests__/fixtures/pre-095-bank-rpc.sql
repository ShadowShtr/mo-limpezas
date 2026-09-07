-- GERADO de supabase/migrations/082_atomic_finance_mutations.sql por scripts/gen-095-fixture.mjs. Nao editar a mao.
-- A RPC de conciliacao COMO ESTA EM PRODUCAO (sem guarda de periodo).

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

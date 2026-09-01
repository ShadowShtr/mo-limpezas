-- ROLLBACK 088 — restaura a definição canónica da 082.
-- Ensaio/revisão apenas; nunca executar em produção sem autorização.
DO $precondicoes_rollback$
DECLARE
  v_hash text;
  v_count integer;
BEGIN
  SELECT count(*), max(md5(regexp_replace(regexp_replace(pg_get_functiondef(p.oid), E'--[^\r\n]*', '', 'g'), '[[:space:]]+', '', 'g'))) INTO v_count, v_hash
    FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
   WHERE n.nspname = 'public' AND p.proname = 'update_payment_atomic';
  IF v_count <> 1 OR v_hash <> 'a227a222d9a94852c5b3e086a6a31c78' THEN
    RAISE EXCEPTION 'PAYMENT_COMPETENCE_088_ROLLBACK_UNKNOWN_POSTSTATE';
  END IF;
END;
$precondicoes_rollback$;

CREATE OR REPLACE FUNCTION public.update_payment_atomic(
  p_company_id uuid,
  p_payment_id uuid,
  p_patch      jsonb
)
RETURNS TABLE (payment_id uuid, valor_alterou boolean)
LANGUAGE plpgsql
SECURITY INVOKER
AS $fn$
DECLARE
  v_pag        public.fixed_variable_payments%ROWTYPE;
  v_mov        uuid;
  v_proibidas  text[];
  v_novo_valor numeric;
  v_muda_valor boolean := false;
  v_venc       date;
  v_ano        integer;
  v_mes        integer;
BEGIN
  -- 🔴 UMA edição, UMA escrita.
  --
  --    A primeira versão desta migração tinha uma RPC só para o valor, e a
  --    Server Action escrevia os restantes campos num segundo pedido. Uma
  --    edição composta podia então gravar metade: o valor passava, a descrição
  --    falhava, a acção devolvia erro — e o valor ficava alterado à mesma.
  --    Para quem editou, a operação «falhou» e o dinheiro mudou.
  --
  --    Não há compensação do lado da aplicação que resolva isto de forma
  --    fiável. A resposta é não haver duas escritas: tudo o que uma edição
  --    muda decide-se e grava-se aqui dentro, numa transacção.
  --
  --        RELATED_WRITES = ATOMIC
  --        PARTIAL_USER_EDIT = FORBIDDEN

  -- ── 1. Só os campos que uma edição pode mexer ────────────────────────────
  --
  -- Lista branca, não passthrough. Sem isto, um `p_patch` com `status`,
  -- `paid_at` ou `company_id` contornava as RPC que existem precisamente para
  -- governar esses campos — a 083 fecha a porta da frente, e isto seria uma
  -- porta lateral com a chave por dentro.
  SELECT array_agg(k) INTO v_proibidas
    FROM jsonb_object_keys(p_patch) AS k
   WHERE k NOT IN ('description', 'amount', 'due_date',
                   'expense_category_id', 'direct_debit', 'notes');
  IF v_proibidas IS NOT NULL THEN
    RAISE EXCEPTION 'PAYMENT_FIELD_NOT_EDITABLE: %', array_to_string(v_proibidas, ', ')
      USING ERRCODE = 'check_violation';
  END IF;

  -- ── 2. O lock primeiro, a decisão depois ─────────────────────────────────
  --
  -- É o mesmo lock que `mark_payment_paid` toma: a partir daqui, ou esta
  -- função corre inteira antes da marcação, ou depois dela — nunca no meio.
  SELECT * INTO v_pag
    FROM public.fixed_variable_payments
   WHERE id = p_payment_id AND company_id = p_company_id
   FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'PAYMENT_NOT_FOUND' USING ERRCODE = 'no_data_found';
  END IF;

  -- ── 3. O valor, quando vem ───────────────────────────────────────────────
  -- ── 3. O valor, quando vem ───────────────────────────────────────────────
  IF p_patch ? 'amount' THEN
    v_novo_valor := (p_patch->>'amount')::numeric;
    IF v_novo_valor IS NOT NULL AND v_novo_valor < 0 THEN
      RAISE EXCEPTION 'PAYMENT_AMOUNT_INVALID' USING ERRCODE = 'check_violation';
    END IF;
    -- 🔴 `IS NOT DISTINCT FROM` compara com `NULL` dos dois lados; `=` não.
    --    O formulário reenvia o valor que não mudou, e recusá-lo impediria
    --    corrigir a descrição de um pagamento já pago — operação legítima que
    --    nada tem que ver com dinheiro.
    v_muda_valor := v_novo_valor IS DISTINCT FROM v_pag.amount;
  END IF;

  -- As guardas só valem quando o valor muda mesmo.
  IF v_muda_valor THEN
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
  END IF;

  -- ── 4. Competência: move-se com o vencimento ─────────────────────────────
  --
  -- Um pagamento editado de 15/07 para 15/08 tem de mudar de mês. Sem isto
  -- ficava com data de Agosto e competência de Julho: aparecia no ecrã errado.
  --
  -- 🔴 `due_date` a `NULL` **não** mexe na competência: não há de onde a
  -- derivar, e apagá-la deixaria a linha sem pertencer a mês nenhum. É o
  -- comportamento que a aplicação já tinha, e mantém-se.
  v_ano := v_pag.period_year;
  v_mes := v_pag.period_month;
  IF (p_patch ? 'due_date') AND (p_patch->>'due_date') IS NOT NULL THEN
    v_venc := (p_patch->>'due_date')::date;
    v_ano  := EXTRACT(YEAR  FROM v_venc)::integer;
    v_mes  := EXTRACT(MONTH FROM v_venc)::integer;
  END IF;

  -- ── 5. Uma só escrita ────────────────────────────────────────────────────
  -- ── 5. Uma só escrita ────────────────────────────────────────────────────
  UPDATE public.fixed_variable_payments SET
    description = CASE WHEN p_patch ? 'description'
                       THEN p_patch->>'description' ELSE description END,
    amount      = CASE WHEN p_patch ? 'amount'
                       THEN (p_patch->>'amount')::numeric ELSE amount END,
    due_date    = CASE WHEN p_patch ? 'due_date'
                       THEN (p_patch->>'due_date')::date ELSE due_date END,
    expense_category_id = CASE WHEN p_patch ? 'expense_category_id'
                               THEN (p_patch->>'expense_category_id')::uuid
                               ELSE expense_category_id END,
    direct_debit = CASE WHEN p_patch ? 'direct_debit'
                        THEN (p_patch->>'direct_debit')::boolean ELSE direct_debit END,
    notes       = CASE WHEN p_patch ? 'notes'
                       THEN p_patch->>'notes' ELSE notes END,
    period_year  = v_ano,
    period_month = v_mes,
    updated_at   = now()
  WHERE id = p_payment_id;

  RETURN QUERY SELECT p_payment_id, v_muda_valor;
END;
$fn$;

REVOKE EXECUTE ON FUNCTION public.update_payment_atomic(uuid, uuid, jsonb) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.update_payment_atomic(uuid, uuid, jsonb) TO service_role;

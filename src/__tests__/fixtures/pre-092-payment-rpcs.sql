-- GERADO por scripts/gen-092-fixture.mjs. Nao editar a mao.
-- As RPCs de pagamentos COMO ESTAO EM PRODUCAO, cada uma extraida da
-- migration que a define POR ULTIMO. E sobre estas que a 092 actua.

-- assert_payment_cashflow_link — de supabase/migrations/079_reuse_pending_cashflow_on_payment.sql
CREATE OR REPLACE FUNCTION public.assert_payment_cashflow_link(
  p_mov        public.cash_flow_entries,
  p_pag        public.fixed_variable_payments,
  p_company_id uuid,
  p_payment_id uuid
)
RETURNS void
LANGUAGE plpgsql
IMMUTABLE
SECURITY INVOKER
AS $guard$
BEGIN
  -- Identidade: empresa e vínculo. Uma linha de outra empresa, ou ligada a
  -- outro pagamento, nunca é reutilizada.
  IF p_mov.company_id IS DISTINCT FROM p_company_id
     OR p_mov.reference_type IS DISTINCT FROM 'fixed_variable_payment'
     OR p_mov.reference_id IS DISTINCT FROM p_payment_id THEN
    RAISE EXCEPTION 'CASHFLOW_LINK_MISMATCH'
      USING ERRCODE = 'data_exception';
  END IF;

  -- Sentido económico: pagar é sempre uma saída. Uma entrada com esta origem
  -- inverteria o sinal do dinheiro.
  IF p_mov.type IS DISTINCT FROM 'saida' THEN
    RAISE EXCEPTION 'CASHFLOW_LINK_TYPE_MISMATCH'
      USING ERRCODE = 'data_exception';
  END IF;

  -- Um valor diferente não se ajusta em silêncio. Ou alguém editou o movimento
  -- à mão, ou o pagamento mudou de valor depois de ligado — nos dois casos,
  -- confirmar a saída pelo valor errado é pior do que parar.
  IF p_mov.amount IS DISTINCT FROM p_pag.amount THEN
    RAISE EXCEPTION 'CASHFLOW_LINK_AMOUNT_MISMATCH'
      USING ERRCODE = 'data_exception';
  END IF;

  -- O CHECK da tabela só permite `pendente`/`confirmado`. Outra coisa quer
  -- dizer que o modelo mudou e esta função não sabe o que fazer.
  IF p_mov.status IS NULL OR p_mov.status NOT IN ('pendente', 'confirmado') THEN
    RAISE EXCEPTION 'CASHFLOW_LINK_STATUS_UNEXPECTED'
      USING ERRCODE = 'data_exception';
  END IF;
END;
$guard$;

-- mark_payment_paid — de supabase/migrations/081_safe_unmark_payment_paid.sql
CREATE OR REPLACE FUNCTION public.mark_payment_paid(
  p_company_id uuid,
  p_payment_id uuid,
  p_paid_on    date
)
RETURNS TABLE (payment_id uuid, cash_entry_id uuid, ja_estava_pago boolean)
LANGUAGE plpgsql
SECURITY INVOKER
AS $fn$
DECLARE
  v_pag        public.fixed_variable_payments%ROWTYPE;
  v_mov        public.cash_flow_entries%ROWTYPE;
  v_entrada    uuid;
  v_sem_efeito boolean := false;
BEGIN
  SELECT * INTO v_pag
    FROM public.fixed_variable_payments
   WHERE id = p_payment_id
     AND company_id = p_company_id
   FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Pagamento inexistente ou de outra empresa.'
      USING ERRCODE = 'no_data_found';
  END IF;

  IF v_pag.amount IS NULL OR v_pag.amount <= 0 THEN
    RAISE EXCEPTION 'Um pagamento sem valor não pode gerar um movimento de caixa.'
      USING ERRCODE = 'check_violation';
  END IF;

  IF NOT public.is_financial_period_open(p_company_id, v_pag.period_year, v_pag.period_month) THEN
    RAISE EXCEPTION 'FINANCIAL_PERIOD_CLOSED'
      USING ERRCODE = 'object_not_in_prerequisite_state';
  END IF;

  UPDATE public.fixed_variable_payments
     SET status  = 'pago',
         paid_at = COALESCE(paid_at, p_paid_on::timestamptz)
   WHERE id = p_payment_id;

  SELECT * INTO v_mov
    FROM public.cash_flow_entries
   WHERE company_id = p_company_id
     AND reference_type = 'fixed_variable_payment'
     AND reference_id = p_payment_id
   FOR UPDATE;

  IF FOUND THEN
    PERFORM public.assert_payment_cashflow_link(v_mov, v_pag, p_company_id, p_payment_id);

    IF v_mov.status = 'pendente' THEN
      -- 🔴 A proveniência escreve-se **antes** do UPDATE, enquanto o prestate
      --    ainda está na linha. Depois do UPDATE a data antiga já não existe
      --    em lado nenhum, e não há como a recuperar.
      --
      --    `ON CONFLICT DO NOTHING`: se já houver registo, é de um ciclo
      --    anterior (mark → unmark → mark). O primeiro prestate é o que vale —
      --    é o estado legado verdadeiro. Sobrescrevê-lo com o que o `unmark`
      --    acabou de restaurar seria guardar uma cópia da cópia.
      INSERT INTO public.payment_cashflow_provenance (
        cash_flow_entry_id, company_id, payment_id, origin,
        prestate_date, prestate_expense_category_id
      ) VALUES (
        v_mov.id, p_company_id, p_payment_id, 'adopted_existing',
        v_mov.date, v_mov.expense_category_id
      )
      ON CONFLICT (cash_flow_entry_id) DO NOTHING;

      UPDATE public.cash_flow_entries
         SET status = 'confirmado',
             date   = p_paid_on,
             expense_category_id = COALESCE(v_pag.expense_category_id, expense_category_id)
       WHERE id = v_mov.id;

    ELSIF v_mov.status = 'confirmado' THEN
      -- 🔴 Idempotência, e **nenhuma** proveniência escrita aqui.
      --
      --    Um movimento já confirmado e sem registo pode ter sido criado pelo
      --    `mark` ou adoptado e já confirmado — daqui não se distingue.
      --    Inventar um dos dois seria fabricar uma prova. Fica desconhecido, e
      --    o `unmark` recusa-o mais tarde por isso mesmo.
      v_sem_efeito := true;

    ELSE
      RAISE EXCEPTION 'CASHFLOW_LINK_STATUS_UNEXPECTED'
        USING ERRCODE = 'data_exception';
    END IF;

    v_entrada := v_mov.id;

  ELSE
    INSERT INTO public.cash_flow_entries (
      company_id, type, amount, description, category, date,
      reference_type, reference_id, status, expense_category_id
    ) VALUES (
      p_company_id, 'saida', v_pag.amount,
      v_pag.description, 'despesa', p_paid_on,
      'fixed_variable_payment', p_payment_id, 'confirmado', v_pag.expense_category_id
    )
    ON CONFLICT (company_id, reference_type, reference_id)
      WHERE reference_type IS NOT NULL AND reference_id IS NOT NULL
      DO NOTHING
    RETURNING id INTO v_entrada;

    IF v_entrada IS NOT NULL THEN
      -- Criado por esta chamada. Não há prestate: antes disto não existia.
      INSERT INTO public.payment_cashflow_provenance (
        cash_flow_entry_id, company_id, payment_id, origin
      ) VALUES (
        v_entrada, p_company_id, p_payment_id, 'created_by_mark'
      )
      ON CONFLICT (cash_flow_entry_id) DO NOTHING;

    ELSE
      -- F14-A: conflito. Relê-se a linha completa e valida-se pelos mesmos
      -- invariantes — ver `assert_payment_cashflow_link`.
      SELECT * INTO v_mov
        FROM public.cash_flow_entries c
       WHERE c.company_id = p_company_id
         AND c.reference_type = 'fixed_variable_payment'
         AND c.reference_id = p_payment_id
       FOR UPDATE;

      IF NOT FOUND THEN
        RAISE EXCEPTION 'CASHFLOW_LINK_VANISHED'
          USING ERRCODE = 'data_exception';
      END IF;

      PERFORM public.assert_payment_cashflow_link(v_mov, v_pag, p_company_id, p_payment_id);

      IF v_mov.status = 'pendente' THEN
        -- 🔴 A linha veio de outra ligação: esta transacção não a criou. É
        --    adopção, e o prestate é o que ela traz.
        INSERT INTO public.payment_cashflow_provenance (
          cash_flow_entry_id, company_id, payment_id, origin,
          prestate_date, prestate_expense_category_id
        ) VALUES (
          v_mov.id, p_company_id, p_payment_id, 'adopted_existing',
          v_mov.date, v_mov.expense_category_id
        )
        ON CONFLICT (cash_flow_entry_id) DO NOTHING;

        UPDATE public.cash_flow_entries
           SET status = 'confirmado',
               date   = p_paid_on,
               expense_category_id = COALESCE(v_pag.expense_category_id, expense_category_id)
         WHERE id = v_mov.id;
      ELSIF v_mov.status = 'confirmado' THEN
        v_sem_efeito := true;
      ELSE
        RAISE EXCEPTION 'CASHFLOW_LINK_STATUS_UNEXPECTED'
          USING ERRCODE = 'data_exception';
      END IF;

      v_entrada := v_mov.id;
    END IF;
  END IF;

  RETURN QUERY SELECT p_payment_id, v_entrada, v_sem_efeito;
END;
$fn$;

-- unmark_payment_paid — de supabase/migrations/081_safe_unmark_payment_paid.sql
CREATE OR REPLACE FUNCTION public.unmark_payment_paid(
  p_company_id uuid,
  p_payment_id uuid
)
RETURNS TABLE (payment_id uuid, movimentos_removidos int)
LANGUAGE plpgsql
SECURITY INVOKER
AS $fn$
DECLARE
  v_pag        public.fixed_variable_payments%ROWTYPE;
  v_mov        public.cash_flow_entries%ROWTYPE;
  v_prov       public.payment_cashflow_provenance%ROWTYPE;
  v_removidos  int := 0;
  v_conciliado int;
BEGIN
  SELECT * INTO v_pag
    FROM public.fixed_variable_payments
   WHERE id = p_payment_id
     AND company_id = p_company_id
   FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Pagamento inexistente ou de outra empresa.'
      USING ERRCODE = 'no_data_found';
  END IF;

  IF NOT public.is_financial_period_open(p_company_id, v_pag.period_year, v_pag.period_month) THEN
    RAISE EXCEPTION 'FINANCIAL_PERIOD_CLOSED'
      USING ERRCODE = 'object_not_in_prerequisite_state';
  END IF;

  -- 🔴 `FOR UPDATE` no movimento: sem isto, um `unmark` concorrente e uma
  --    conciliação a acontecer ao mesmo tempo podiam cruzar-se entre a leitura
  --    e a escrita. Duas chamadas simultâneas serializam-se aqui.
  SELECT * INTO v_mov
    FROM public.cash_flow_entries
   WHERE company_id = p_company_id
     AND reference_type = 'fixed_variable_payment'
     AND reference_id = p_payment_id
   FOR UPDATE;

  IF FOUND THEN
    -- ── Conciliação: falha fechado, antes de tocar em nada ─────────────────
    --
    -- `bank_reconciliation_matches.cash_flow_entry_id` é `ON DELETE CASCADE`.
    -- Apagar o movimento levaria a correspondência à frente e deixaria a
    -- transacção bancária marcada como reconciliada contra uma linha que já
    -- não existe: apagava a prova e mentia sobre o resultado.
    --
    -- Reverter uma conciliação é uma operação com significado próprio e não
    -- existe mecanismo canónico para isso neste repositório. Inventar um aqui
    -- seria trocar um risco por outro. Quem quiser desmarcar desfaz primeiro a
    -- conciliação, conscientemente.
    SELECT count(*) INTO v_conciliado
      FROM public.bank_reconciliation_matches m
     WHERE m.cash_flow_entry_id = v_mov.id
       AND m.status <> 'rejected';

    IF v_conciliado > 0 THEN
      RAISE EXCEPTION 'UNMARK_BLOCKED_RECONCILED_CASHFLOW'
        USING ERRCODE = 'object_not_in_prerequisite_state';
    END IF;

    SELECT * INTO v_prov
      FROM public.payment_cashflow_provenance
     WHERE cash_flow_entry_id = v_mov.id
     FOR UPDATE;

    IF NOT FOUND THEN
      -- 🔴 Proveniência desconhecida. **Falha fechado.**
      --
      --    A ausência de registo não prova que o movimento foi criado pelo
      --    `mark`: prova apenas que ninguém sabe. Para as linhas anteriores a
      --    esta infraestrutura as duas hipóteses continuam abertas, e uma
      --    delas é «já cá estava». Apagar sobre essa dúvida é exactamente o
      --    risco que esta migration existe para fechar — a versão anterior
      --    deste ficheiro apagava, e estava errada.
      --
      --    Quem tiver de desmarcar um movimento destes classifica-o primeiro,
      --    com a auditoria da task PAYMENT_CASHFLOW_PROVENANCE_BACKFILL. Não
      --    se adivinha a origem a partir de `created_at`, `description`,
      --    `notes` ou proximidade temporal: são sinais insuficientes.
      RAISE EXCEPTION 'UNMARK_BLOCKED_UNKNOWN_CASHFLOW_PROVENANCE'
        USING ERRCODE = 'object_not_in_prerequisite_state';
    END IF;

    IF v_prov.origin = 'adopted_existing' THEN
      -- 🔴 O movimento já cá estava. Desmarcar devolve-o ao que era —
      --    mesma linha, mesmo `id`, mesmo histórico. Nunca `DELETE`.
      --
      --    `status` não é lido de uma cópia: é `pendente` por invariante
      --    estrutural. `adopted_existing` só pode nascer de uma linha
      --    `pendente` — o `CHECK` da tabela de proveniência não chega para o
      --    garantir, portanto é a própria RPC que só o escreve nesse ramo, e
      --    há testes que o provam. Derivação, não adivinhação.
      --
      --    A proveniência **fica**: se o pagamento voltar a ser marcado, o
      --    movimento é adoptado outra vez, e o prestate original continua a
      --    ser o estado legado verdadeiro.
      UPDATE public.cash_flow_entries
         SET status = 'pendente',
             date   = v_prov.prestate_date,
             expense_category_id = v_prov.prestate_expense_category_id
       WHERE id = v_mov.id;

      v_removidos := 0;

    ELSIF v_prov.origin = 'created_by_mark' THEN
      -- Foi o `mark` que o criou; desfazer é fazê-lo desaparecer. Não havia
      -- nada antes, portanto não há nada para restaurar.
      --
      -- 🔴 A proveniência sai primeiro. A chave estrangeira é `RESTRICT`, de
      --    propósito: ninguém apaga um movimento com origem registada sem
      --    passar por aqui. Este é o único sítio que tem o direito de o fazer,
      --    e fá-lo na mesma transacção — se o `DELETE` do movimento falhar, o
      --    registo volta com ele.
      DELETE FROM public.payment_cashflow_provenance
       WHERE cash_flow_entry_id = v_mov.id;

      DELETE FROM public.cash_flow_entries
       WHERE id = v_mov.id;
      GET DIAGNOSTICS v_removidos = ROW_COUNT;

    ELSE
      -- O CHECK da tabela só permite os dois valores acima. Outra coisa quer
      -- dizer que o modelo mudou e esta função não sabe o que fazer.
      RAISE EXCEPTION 'UNMARK_BLOCKED_UNKNOWN_CASHFLOW_PROVENANCE'
        USING ERRCODE = 'object_not_in_prerequisite_state';
    END IF;
  END IF;

  UPDATE public.fixed_variable_payments
     SET status = 'pendente', paid_at = NULL
   WHERE id = p_payment_id;

  RETURN QUERY SELECT p_payment_id, v_removidos;
END;
$fn$;

-- update_payment_atomic — de supabase/migrations/088_payment_competence_idempotent_edit.sql
CREATE OR REPLACE FUNCTION public.update_payment_atomic(
  p_company_id uuid,
  p_payment_id uuid,
  p_patch jsonb
)
RETURNS TABLE (payment_id uuid, valor_alterou boolean)
LANGUAGE plpgsql
SECURITY INVOKER
AS $fn$
DECLARE
  v_pag public.fixed_variable_payments%ROWTYPE;
  v_mov uuid;
  v_proibidas text[];
  v_novo_valor numeric;
  v_muda_valor boolean := false;
  v_venc date;
  v_ano integer;
  v_mes integer;
BEGIN
  SELECT array_agg(k) INTO v_proibidas
    FROM jsonb_object_keys(p_patch) AS k
   WHERE k NOT IN ('description', 'amount', 'due_date', 'expense_category_id', 'direct_debit', 'notes');
  IF v_proibidas IS NOT NULL THEN
    RAISE EXCEPTION 'PAYMENT_FIELD_NOT_EDITABLE: %', array_to_string(v_proibidas, ', ')
      USING ERRCODE = 'check_violation';
  END IF;

  SELECT * INTO v_pag FROM public.fixed_variable_payments
   WHERE id = p_payment_id AND company_id = p_company_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'PAYMENT_NOT_FOUND' USING ERRCODE = 'no_data_found'; END IF;

  IF p_patch ? 'amount' THEN
    v_novo_valor := (p_patch->>'amount')::numeric;
    IF v_novo_valor IS NOT NULL AND v_novo_valor < 0 THEN
      RAISE EXCEPTION 'PAYMENT_AMOUNT_INVALID' USING ERRCODE = 'check_violation';
    END IF;
    v_muda_valor := v_novo_valor IS DISTINCT FROM v_pag.amount;
  END IF;

  IF v_muda_valor THEN
    IF v_pag.status = 'pago' THEN
      RAISE EXCEPTION 'PAYMENT_ALREADY_PAID' USING ERRCODE = 'object_not_in_prerequisite_state';
    END IF;
    SELECT c.id INTO v_mov FROM public.cash_flow_entries c
     WHERE c.company_id = p_company_id AND c.reference_type = 'fixed_variable_payment'
       AND c.reference_id = p_payment_id LIMIT 1;
    IF v_mov IS NOT NULL THEN
      RAISE EXCEPTION 'PAYMENT_LINKED_TO_CASHFLOW' USING ERRCODE = 'object_not_in_prerequisite_state';
    END IF;
  END IF;

  v_ano := v_pag.period_year;
  v_mes := v_pag.period_month;
  IF (p_patch ? 'due_date')
     AND (p_patch->>'due_date') IS NOT NULL
     AND (p_patch->>'due_date')::date IS DISTINCT FROM v_pag.due_date THEN
    v_venc := (p_patch->>'due_date')::date;
    v_ano := EXTRACT(YEAR FROM v_venc)::integer;
    v_mes := EXTRACT(MONTH FROM v_venc)::integer;
  END IF;

  UPDATE public.fixed_variable_payments SET
    description = CASE WHEN p_patch ? 'description' THEN p_patch->>'description' ELSE description END,
    amount = CASE WHEN p_patch ? 'amount' THEN (p_patch->>'amount')::numeric ELSE amount END,
    due_date = CASE WHEN p_patch ? 'due_date' THEN (p_patch->>'due_date')::date ELSE due_date END,
    expense_category_id = CASE WHEN p_patch ? 'expense_category_id' THEN (p_patch->>'expense_category_id')::uuid ELSE expense_category_id END,
    direct_debit = CASE WHEN p_patch ? 'direct_debit' THEN (p_patch->>'direct_debit')::boolean ELSE direct_debit END,
    notes = CASE WHEN p_patch ? 'notes' THEN p_patch->>'notes' ELSE notes END,
    period_year = v_ano, period_month = v_mes, updated_at = now()
   WHERE id = p_payment_id AND company_id = p_company_id;
  RETURN QUERY SELECT p_payment_id, v_muda_valor;
END;
$fn$;

-- delete_payment_atomic — de supabase/migrations/082_atomic_finance_mutations.sql
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

-- ============================================================================
-- PROVISIONAL — desmarcar um pagamento deixa de apagar histórico (F14-B)
-- ============================================================================
--
-- 🔴 NÃO APLICADA. MIGRATION_NUMBER_FINAL = UNASSIGNED. Depende de
--    `PROVISIONAL_payment_cashflow_provenance.sql`, que tem de correr primeiro.
--
-- Aplica-se a seguir à 079 corrigida (F14-A) e substitui duas funções:
--
--   `mark_payment_paid`   — passa a registar de onde veio o movimento e, se o
--                           adoptou, o estado a que ele tem de poder voltar;
--   `unmark_payment_paid` — deixa de apagar cegamente. Apaga o que o `mark`
--                           criou, restaura o que o `mark` adoptou, e recusa
--                           quando há conciliação pelo meio.
--
-- ---------------------------------------------------------------------------
-- As três respostas do unmark
-- ---------------------------------------------------------------------------
--
--   proveniência diz `created_by_mark`   → apaga. Foi o `mark` que o criou;
--                                          desfazer é fazê-lo desaparecer.
--   proveniência diz `adopted_existing`  → **restaura**. Mesmo `id`, volta a
--                                          `pendente`, com a data e a categoria
--                                          que tinha antes. Nunca `DELETE`.
--   não há proveniência nenhuma          → apaga. É o comportamento da 073, e
--                                          é o que era verdade para todos os
--                                          movimentos criados antes desta
--                                          migration existir. Não se adivinha.
--
-- E, antes de qualquer um dos três: se o movimento estiver conciliado, não se
-- faz nada. `UNMARK_RECONCILED_CASHFLOW = BLOCKED`.
-- ============================================================================

BEGIN;

-- ─── 1. mark_payment_paid — regista de onde veio o movimento ────────────────
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

-- ─── 2. unmark_payment_paid — restaura em vez de apagar ─────────────────────
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

    IF FOUND AND v_prov.origin = 'adopted_existing' THEN
      -- 🔴 O movimento já cá estava. Desmarcar devolve-o ao que era —
      --    mesma linha, mesmo `id`, mesmo histórico. Nunca `DELETE`.
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

    ELSE
      -- Criado pelo `mark`, ou sem proveniência (movimento anterior a esta
      -- migration). Nos dois casos o comportamento da 073 é o correcto.
      DELETE FROM public.cash_flow_entries
       WHERE id = v_mov.id;
      GET DIAGNOSTICS v_removidos = ROW_COUNT;
    END IF;
  END IF;

  UPDATE public.fixed_variable_payments
     SET status = 'pendente', paid_at = NULL
   WHERE id = p_payment_id;

  RETURN QUERY SELECT p_payment_id, v_removidos;
END;
$fn$;

COMMENT ON FUNCTION public.unmark_payment_paid IS
  'Desmarca o pagamento. Apaga o movimento de caixa se foi mark_payment_paid '
  'que o criou; restaura-o ao estado anterior, com o mesmo id, se já existia e '
  'foi adoptado; recusa se o movimento estiver conciliado.';

COMMIT;

-- ============================================================================
-- O que esta migration NÃO faz
-- ============================================================================
--
--  · não escreve uma linha de dados: `MIGRATION_DATA_WRITES = 0`;
--  · não inventa proveniência para movimentos que já existem. Sem registo, o
--    comportamento é o da 073 — que é o que era verdade quando foram criados;
--  · não reverte conciliações: bloqueia e devolve a decisão a quem a tomou;
--  · não toca no índice da 024, no CHECK da 075 nem na 070.
-- ============================================================================

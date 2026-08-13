-- ============================================================================
-- 073 — Pagamento → caixa, numa só operação
-- ============================================================================
--
-- 🔴 NÃO APLICADA. Preparada para revisão, e ensaiada em base descartável
--    (`npm run rehearse:071`, que cobre as três).
--
-- Posterior à 071 (precisa de `financial_periods` e `expense_category_id`) e
-- à 072 (mesmo padrão, mesma disciplina).
--
-- ---------------------------------------------------------------------------
-- O que está errado hoje
-- ---------------------------------------------------------------------------
-- `setPaymentStatus` marca o pagamento como pago em `fixed_variable_payments`
-- e **mais nada**. O dinheiro sai da conta da empresa e o Fluxo de Caixa não
-- sabe: os Custos do mês ficam por baixo do real, e a Margem por cima.
--
-- Fazê-lo em dois pedidos a partir da aplicação não resolve — resolve metade.
-- A primeira escrita pode passar e a segunda falhar, e fica um pagamento pago
-- sem movimento nenhum, que é exactamente a divergência que se queria evitar.
--
-- ---------------------------------------------------------------------------
-- Uma ocorrência económica, um movimento
-- ---------------------------------------------------------------------------
-- A identidade é `(company_id, reference_type='fixed_variable_payment',
-- reference_id=payment.id)`, e o índice único da **024** garante-a na base.
--
-- Estas funções não lutam contra esse índice: usam-no. `ON CONFLICT DO
-- NOTHING` seguido de leitura torna a operação **idempotente** em vez de
-- explosiva — clicar duas vezes, um retry de rede ou dois separadores abertos
-- devolvem o mesmo movimento, e não um erro que o utilizador não sabe
-- interpretar.
-- ============================================================================

BEGIN;

-- ─── 1. O período está aberto? ──────────────────────────────────────────────
--
-- Um período sem linha em `financial_periods` está **aberto**. É a ausência
-- que significa aberto, e não um registo a dizê-lo: obrigar a criar uma linha
-- por mês só para poder trabalhar seria uma cerimónia que alguém acabaria por
-- automatizar, e o fecho deixaria de querer dizer alguma coisa.

CREATE OR REPLACE FUNCTION public.is_financial_period_open(
  p_company_id uuid,
  p_year       int,
  p_month      int
) RETURNS boolean
LANGUAGE sql
STABLE
AS $$
  SELECT NOT EXISTS (
    SELECT 1 FROM public.financial_periods fp
     WHERE fp.company_id = p_company_id
       AND fp.year = p_year
       AND fp.month = p_month
       AND fp.status = 'closed'
  );
$$;

-- ─── 2. Marcar como pago ────────────────────────────────────────────────────

CREATE OR REPLACE FUNCTION public.mark_payment_paid(
  p_company_id uuid,
  p_payment_id uuid,
  p_paid_on    date
)
RETURNS TABLE (payment_id uuid, cash_entry_id uuid, ja_estava_pago boolean)
LANGUAGE plpgsql
SECURITY INVOKER
AS $$
DECLARE
  v_pag     public.fixed_variable_payments%ROWTYPE;
  v_entrada uuid;
  v_novo    boolean := false;
BEGIN
  -- 🔴 `FOR UPDATE`: tranca a linha do pagamento até ao fim da transacção.
  --    Dois pedidos simultâneos para o mesmo pagamento serializam-se aqui, e
  --    o segundo vê o estado que o primeiro deixou.
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

  -- Idempotente pela identidade de origem. O índice da 024 é quem decide.
  INSERT INTO public.cash_flow_entries (
    company_id, type, amount, description, category, date,
    reference_type, reference_id, status, expense_category_id
  ) VALUES (
    p_company_id, 'saida', v_pag.amount,
    v_pag.description, 'despesa', p_paid_on,
    'fixed_variable_payment', p_payment_id, 'confirmado', v_pag.expense_category_id
  )
  -- 🔴 O predicado tem de vir. O índice da 024 é **parcial**
  --    (`WHERE reference_type IS NOT NULL AND reference_id IS NOT NULL`), e o
  --    Postgres só o infere se o `ON CONFLICT` repetir a mesma condição. Sem
  --    ela: «there is no unique or exclusion constraint matching the ON
  --    CONFLICT specification» — apanhado pelo ensaio.
  ON CONFLICT (company_id, reference_type, reference_id)
    WHERE reference_type IS NOT NULL AND reference_id IS NOT NULL
    DO NOTHING
  RETURNING id INTO v_entrada;

  IF v_entrada IS NULL THEN
    -- Já existia: devolve-se o movimento que lá está, em vez de um erro.
    SELECT c.id INTO v_entrada
      FROM public.cash_flow_entries c
     WHERE c.company_id = p_company_id
       AND c.reference_type = 'fixed_variable_payment'
       AND c.reference_id = p_payment_id;
  ELSE
    v_novo := true;
  END IF;

  RETURN QUERY SELECT p_payment_id, v_entrada, (NOT v_novo);
END;
$$;

-- ─── 3. Desmarcar ───────────────────────────────────────────────────────────
--
-- 🔴 Apaga **apenas** o movimento cuja origem é este pagamento.
--
-- Uma reversão que apagasse por valor e data levaria à frente a despesa
-- manual que alguém lançou no mesmo dia pelo mesmo montante — e essa não
-- volta, porque ninguém saberia que tinha desaparecido.

CREATE OR REPLACE FUNCTION public.unmark_payment_paid(
  p_company_id uuid,
  p_payment_id uuid
)
RETURNS TABLE (payment_id uuid, movimentos_removidos int)
LANGUAGE plpgsql
SECURITY INVOKER
AS $$
DECLARE
  v_pag       public.fixed_variable_payments%ROWTYPE;
  v_removidos int;
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

  DELETE FROM public.cash_flow_entries
   WHERE company_id = p_company_id
     AND reference_type = 'fixed_variable_payment'
     AND reference_id = p_payment_id;
  GET DIAGNOSTICS v_removidos = ROW_COUNT;

  UPDATE public.fixed_variable_payments
     SET status = 'pendente', paid_at = NULL
   WHERE id = p_payment_id;

  RETURN QUERY SELECT p_payment_id, v_removidos;
END;
$$;

COMMENT ON FUNCTION public.mark_payment_paid IS
  'Marca o pagamento como pago e cria a saída de caixa correspondente, numa '
  'só transacção. Idempotente pela identidade (company, reference_type, '
  'reference_id) — repetir devolve o mesmo movimento.';

COMMIT;

-- ============================================================================
-- O que esta migration NÃO faz
-- ============================================================================
--
--  · não cria movimentos para pagamentos que já estão marcados como pagos —
--    seria um backfill, e um backfill de dinheiro inventa histórico;
--  · não toca em nenhum movimento manual;
--  · não fecha nem reabre períodos: só respeita o que lá estiver;
--  · não altera `due_date` nem `source_id`.
--
-- ⚠️ Os pagamentos hoje marcados como `pago` **não têm** movimento de caixa
--    associado, e vão continuar sem. Reconciliá-los é uma decisão de negócio
--    com dados reais, não um efeito colateral de uma migration.
-- ============================================================================

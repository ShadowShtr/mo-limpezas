-- ============================================================================
-- ROLLBACK da 079 — repõe a `mark_payment_paid` tal como a 073 a deixou
-- ============================================================================
--
-- 🔴 ESTA PASTA NÃO É APLICADA PELO RUNNER. `scripts/lib/migration-runner-core.mjs`
--    lê `supabase/migrations/` com `readdirSync` **não recursivo** e fica só
--    com os nomes terminados em `.sql` — o nome desta pasta não termina em
--    `.sql`, portanto nunca entra na lista. Há um teste que fixa isso
--    (`reuse-pending-cashflow-rpc.test.ts`), para o dia em que alguém trocar o
--    `readdirSync` por uma versão recursiva e este ficheiro passar a ser
--    aplicado como se fosse uma migration para a frente.
--
-- ⚠️ Reverter é uma operação de esquema, não uma operação de negócio.
--
--    Depois de a 079 estar aplicada e de as 6 obrigações estarem ligadas aos
--    seus movimentos, voltar atrás **reabre o buraco**: marcar um desses
--    pagamentos como pago volta a deixar o movimento preso em `pendente`.
--    Nenhum dado é perdido pelo rollback em si — os movimentos que já foram
--    convertidos ficam convertidos — mas o comportamento futuro regride.
--
--    Por isso este ficheiro existe para o caso de a 079 ter de sair **antes**
--    de a reparação das 6 ser executada, não para desfazer a reparação. Desfazer
--    a reparação é o rollback do repair, e é outro ficheiro.
--
-- O corpo abaixo é uma cópia literal da definição da 073. Se a 073 mudar, este
-- ficheiro deixa de ser o rollback correcto — e o ensaio detecta-o, porque
-- compara a definição reposta com a que a 073 instala.
-- ============================================================================

BEGIN;

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

COMMENT ON FUNCTION public.mark_payment_paid IS
  'Marca o pagamento como pago e cria a saída de caixa correspondente, numa '
  'só transacção. Idempotente pela identidade (company, reference_type, '
  'reference_id) — repetir devolve o mesmo movimento.';

-- 🔴 F14-A. A 079 criou `assert_payment_cashflow_link` e é a única coisa que a
--    usa. Reposta a definição da 073, a função fica sem chamador nenhum:
--    deixá-la de pé seria devolver a base a um estado que a 073 nunca produziu.
--    O `DROP` vem depois do `CREATE OR REPLACE` acima — enquanto
--    `mark_payment_paid` ainda dependia dela, largá-la primeiro falharia.
DROP FUNCTION IF EXISTS public.assert_payment_cashflow_link(
  public.cash_flow_entries,
  public.fixed_variable_payments,
  uuid,
  uuid
);

COMMIT;

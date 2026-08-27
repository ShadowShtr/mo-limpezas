-- ============================================================================
-- ROLLBACK da 081 — repor o mark/unmark anteriores à proveniência
-- ============================================================================
--
-- Repõe as definições que a 079 (`mark_payment_paid`) e a 073
-- (`unmark_payment_paid`) deixaram, ou seja, o comportamento anterior a esta
-- frente. **Não larga a tabela `payment_cashflow_provenance` e não apaga uma
-- única linha**: a estrutura é da 080 e reverte-se lá, depois desta.
--
--     ROLLBACK_ORDER = 081 antes de 080
--     ROLLBACK_DATA_DESTRUCTION = 0
--
-- ---------------------------------------------------------------------------
-- Porque é que isto exige a tabela vazia
-- ---------------------------------------------------------------------------
--
-- Não é zelo: sem a exigência, reverter deixava o sistema sem saída.
--
-- O `unmark` antigo apaga o movimento directamente, sem passar pela
-- proveniência — foi escrito num mundo em que ela não existia. A chave
-- estrangeira da 080 é `ON DELETE RESTRICT` de propósito. Com linhas na tabela
-- e o `unmark` antigo reposto:
--
--   · desmarcar um pagamento com registo `created_by_mark` passa a rebentar
--     com violação de chave estrangeira — a operação fica partida;
--   · e a 080 também já não pode ser revertida para desfazer o nó, porque o
--     seu rollback exige, com razão, que a tabela esteja vazia.
--
-- Pior ainda com `adopted_existing`: o `unmark` antigo faria `DELETE` a um
-- movimento **preexistente**, que é precisamente o histórico que esta frente
-- inteira existe para não apagar. E, se esse movimento estiver conciliado, o
-- `ON DELETE CASCADE` de `bank_reconciliation_matches` levava a correspondência
-- à frente.
--
-- 🔴 A saída não é este ficheiro apagar linhas. É esvaziar a tabela pelo
--    caminho normal, com as funções da 081 ainda instaladas — que sabem apagar
--    o que criaram e restaurar o que adoptaram — ou por uma decisão explícita
--    de classificação. Um rollback que apaga proveniência para se conseguir
--    executar destrói exactamente aquilo que devia proteger.
-- ============================================================================

BEGIN;

DO $guarda$
DECLARE
  v_total     bigint;
  v_adoptados bigint;
BEGIN
  IF to_regclass('public.payment_cashflow_provenance') IS NULL THEN
    -- A 080 já foi revertida (ou nunca correu). Nada a proteger: repõe-se o
    -- comportamento antigo e pronto.
    RETURN;
  END IF;

  SELECT count(*), count(*) FILTER (WHERE origin = 'adopted_existing')
    INTO v_total, v_adoptados
    FROM public.payment_cashflow_provenance;

  IF v_adoptados > 0 THEN
    RAISE EXCEPTION
      'ROLLBACK_BLOCKED_ADOPTED_PROVENANCE: % movimento(s) adoptado(s) de % registo(s). '
      'Repor o unmark antigo devolveria um DELETE a linhas preexistentes e '
      'apagaria historico financeiro, com o prestate a perder-se junto.',
      v_adoptados, v_total
      USING ERRCODE = 'object_not_in_prerequisite_state';
  END IF;

  IF v_total > 0 THEN
    RAISE EXCEPTION
      'ROLLBACK_BLOCKED_PROVENANCE_ROWS_EXIST: % registo(s) de proveniencia. '
      'O unmark antigo apaga o movimento sem limpar o registo e a chave '
      'estrangeira e RESTRICT: a operacao passaria a falhar, e a 080 deixaria '
      'de poder ser revertida. Esvaziar primeiro pelo caminho normal.', v_total
      USING ERRCODE = 'object_not_in_prerequisite_state';
  END IF;
END
$guarda$;

-- --- 1. mark_payment_paid — a definição da 079 (F14-A), sem proveniência ----
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
  -- 🔴 `FOR UPDATE`: tranca a linha do pagamento até ao fim da transacção.
  --    Dois pedidos simultâneos para o mesmo pagamento serializam-se aqui, e
  --    o segundo vê o estado que o primeiro deixou. É esta tranca — e não o
  --    índice único — que faz duas chamadas concorrentes darem um só
  --    movimento; o índice é a rede por baixo.
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

  -- ─── Já existe movimento ligado a este pagamento? ────────────────────────
  --
  -- 🔴 O `company_id` está na condição, não num `IF` a seguir. Uma linha de
  --    outra empresa nunca chega a ser vista aqui — não há ramo nenhum onde
  --    ela pudesse ser reutilizada por engano.
  SELECT * INTO v_mov
    FROM public.cash_flow_entries
   WHERE company_id = p_company_id
     AND reference_type = 'fixed_variable_payment'
     AND reference_id = p_payment_id
   FOR UPDATE;

  IF FOUND THEN
    -- ── Guardas. Nenhuma linha é reutilizada sem provar que é a linha certa.
    --    A regra vive em `assert_payment_cashflow_link` e é a mesma que o
    --    caminho do conflito aplica — ver F14-A mais abaixo.
    PERFORM public.assert_payment_cashflow_link(v_mov, v_pag, p_company_id, p_payment_id);

    IF v_mov.status = 'pendente' THEN
      -- 🔴 A mesma linha. O `id` não muda, e é isso que preserva o histórico
      --    do movimento legado: `created_at`, `notes`, quem o criou.
      --
      --    `date` passa a ser a data efectiva do pagamento. A data antiga era
      --    a do registo da factura; deixá-la aqui diria que o dinheiro saiu
      --    num dia em que não saiu, e o mês fecharia com o valor no sítio
      --    errado.
      --
      --    `expense_category_id` só é actualizado quando o pagamento **tem**
      --    categoria. Apagar a que lá está por o pagamento não ter nenhuma
      --    seria destruir informação sem ganhar nada: para um movimento
      --    ligado, quem manda na leitura é sempre o pagamento
      --    (`src/domain/finance-v2/effective-expense-category.ts`), portanto o
      --    snapshot nunca contradiz o ecrã.
      UPDATE public.cash_flow_entries
         SET status = 'confirmado',
             date   = p_paid_on,
             expense_category_id = COALESCE(v_pag.expense_category_id, expense_category_id)
       WHERE id = v_mov.id;

    ELSIF v_mov.status = 'confirmado' THEN
      -- Idempotência: repetir a operação não mexe em nada.
      v_sem_efeito := true;

    ELSE
      -- O CHECK da tabela só permite `pendente`/`confirmado`. Se aparecer
      -- outra coisa, o modelo mudou e esta função não sabe o que fazer.
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
    -- 🔴 O predicado tem de vir. O índice da 024 é **parcial** e o Postgres só
    --    o infere se o `ON CONFLICT` repetir a mesma condição.
    ON CONFLICT (company_id, reference_type, reference_id)
      WHERE reference_type IS NOT NULL AND reference_id IS NOT NULL
      DO NOTHING
    RETURNING id INTO v_entrada;

    IF v_entrada IS NULL THEN
      -- 🔴 F14-A. O `DO NOTHING` disparou: outra ligação inseriu a linha entre
      --    o `SELECT ... FOR UPDATE` e este `INSERT`.
      --
      --    A versão anterior desta função relia aqui **apenas o `id`** e
      --    devolvia-o, com o comentário de que isto «não pode acontecer para o
      --    mesmo pagamento porque a tranca acima impede-o». O comentário estava
      --    errado, e a PR #85 provou-o em PostgreSQL real: a tranca serializa
      --    duas chamadas **à RPC**, mas não impede um `INSERT` directo de
      --    outra ligação sobre a mesma identidade única. Era possível terminar
      --    com `type = entrada` numa saída, com um valor que não é o do
      --    pagamento, e com o movimento em `pendente` enquanto o pagamento
      --    ficava `pago`.
      --
      --    A linha que vem de fora não merece mais confiança do que a que já cá
      --    estava. Relê-se **completa**, com `FOR UPDATE` — quem a inseriu
      --    pode ainda não ter feito COMMIT — e passa exactamente pelos mesmos
      --    invariantes do caminho de reutilização, pela mesma função.
      SELECT * INTO v_mov
        FROM public.cash_flow_entries c
       WHERE c.company_id = p_company_id
         AND c.reference_type = 'fixed_variable_payment'
         AND c.reference_id = p_payment_id
       FOR UPDATE;

      IF NOT FOUND THEN
        -- O `DO NOTHING` disparou mas não há linha nenhuma: quem a inseriu
        -- reverteu. Não há nada para adoptar, e não se inventa um movimento.
        RAISE EXCEPTION 'CASHFLOW_LINK_VANISHED'
          USING ERRCODE = 'data_exception';
      END IF;

      PERFORM public.assert_payment_cashflow_link(v_mov, v_pag, p_company_id, p_payment_id);

      -- Sobreviveu aos guardas: é economicamente a mesma ocorrência. Segue a
      -- mesma regra do caminho de reutilização.
      IF v_mov.status = 'pendente' THEN
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

COMMENT ON FUNCTION public.mark_payment_paid IS
  'Marca o pagamento como pago e garante um único movimento de caixa com a '
  'origem (company, fixed_variable_payment, payment_id): cria-o se não '
  'existir, converte-o de pendente para confirmado se já existir, e não faz '
  'nada se já estiver confirmado. Recusa reutilizar um movimento cujo tipo ou '
  'valor não corresponda ao pagamento.';

-- --- 2. unmark_payment_paid — a definição anterior à proveniência -----------
--
-- 🔴 Esta versão apaga o movimento sem olhar à origem. É o defeito que a 081
--    corrige, e está aqui só porque um rollback tem de devolver o que lá
--    estava — não porque este comportamento seja aceitável. As guardas acima
--    são o que impede que ele encontre alguma coisa para destruir.
CREATE OR REPLACE FUNCTION public.unmark_payment_paid(
  p_company_id uuid,
  p_payment_id uuid
)
RETURNS TABLE (payment_id uuid, movimentos_removidos int)
LANGUAGE plpgsql
SECURITY INVOKER
AS $fn$
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
$fn$;

COMMENT ON FUNCTION public.unmark_payment_paid IS NULL;

COMMIT;

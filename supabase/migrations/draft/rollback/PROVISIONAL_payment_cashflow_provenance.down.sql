-- ============================================================================
-- ROLLBACK PROVISIONAL — proveniência do movimento de caixa (F14-B)
-- ============================================================================
--
-- 🔴 NÃO APLICADO. Repõe o estado anterior às duas migrations `draft/`:
--    `unmark_payment_paid` e `mark_payment_paid` voltam à definição que a 079
--    corrigida deixou, e a tabela de proveniência desaparece.
--
-- ---------------------------------------------------------------------------
-- A guarda vem antes de tudo
-- ---------------------------------------------------------------------------
--
-- Se já existir uma única linha de proveniência, este rollback **recusa-se a
-- correr**. Não é excesso de zelo: largar a tabela apagaria o prestate dos
-- movimentos adoptados — a data e a categoria originais que já não existem em
-- mais lado nenhum — e devolveria ao sistema um `unmark_payment_paid` que
-- apaga histórico. Seria desfazer a correcção e destruir a prova de que ela
-- era precisa, na mesma transacção.
--
--     ROLLBACK_WITH_PROVENANCE_ROWS = BLOCKED
--
-- 🔴 A verificação acontece **antes** de qualquer DDL destrutivo. Um rollback
--    que largasse metade dos objectos e só depois descobrisse que não podia
--    continuar deixaria a base num estado que nem é o novo nem o antigo. O
--    `BEGIN`/`COMMIT` já garantiria a atomicidade, mas a ordem torna a
--    intenção legível: primeiro pergunta-se, depois mexe-se.
--
-- Para largar mesmo a tabela é preciso decidir, conscientemente, o que fazer a
-- cada linha — e essa é a task `PAYMENT_CASHFLOW_PROVENANCE_BACKFILL`, não um
-- efeito colateral de um rollback.
-- ============================================================================

BEGIN;

-- ─── 1. A guarda ────────────────────────────────────────────────────────────
DO $guard$
DECLARE
  v_linhas bigint;
BEGIN
  IF to_regclass('public.payment_cashflow_provenance') IS NULL THEN
    -- A tabela não existe: não há nada a proteger nem a largar.
    RETURN;
  END IF;

  SELECT count(*) INTO v_linhas FROM public.payment_cashflow_provenance;

  IF v_linhas > 0 THEN
    RAISE EXCEPTION
      'ROLLBACK_BLOCKED_PROVENANCE_ROWS_EXIST: % linha(s) de proveniência. '
      'Largar a tabela apagaria o prestate dos movimentos adoptados e '
      'devolveria um unmark que apaga histórico. Classificar primeiro '
      '(PAYMENT_CASHFLOW_PROVENANCE_BACKFILL).', v_linhas
      USING ERRCODE = 'object_not_in_prerequisite_state';
  END IF;
END
$guard$;

-- ─── 2. unmark_payment_paid volta à definição da 073 ────────────────────────
--
-- Palavra por palavra o que a 073 instalou. A 079 nunca lhe tocou.
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

-- ─── 3. mark_payment_paid: reaplicar a 079 corrigida ───────────────────────
--
-- 🔴 Este ficheiro **não** traz uma cópia da definição da 079. Uma segunda
--    cópia mantida à mão diverge da primeira ao primeiro comentário que
--    alguém corrigir — e foi exactamente isso que aconteceu na primeira
--    tentativa: o rollback repunha uma versão sem os comentários da 079, e a
--    definição instalada ficava diferente da esperada. O teste apanhou-o.
--
--    Quem executa o rollback reaplica a 079 a seguir a este ficheiro:
--
--        psql < supabase/migrations/draft/rollback/PROVISIONAL_...down.sql
--        psql < supabase/migrations/079_reuse_pending_cashflow_on_payment.sql
--
--    A 079 é `CREATE OR REPLACE` e não escreve dados: reaplicá-la é seguro e
--    devolve `mark_payment_paid` byte a byte ao que era. É a única fonte da
--    sua própria definição, e assim continua.
--
--    `unmark_payment_paid` é o caso oposto e por isso está aqui em cima: a
--    079 nunca lhe tocou, portanto não há ficheiro nenhum para reaplicar — a
--    definição da 073 tem de ser reposta por este rollback.

-- ─── 4. Só agora a tabela ───────────────────────────────────────────────────
--
-- Chegar aqui significa que a guarda passou: zero linhas. O índice e as
-- políticas vão com ela.
DROP TABLE IF EXISTS public.payment_cashflow_provenance;

COMMIT;

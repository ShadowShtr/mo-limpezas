-- ============================================================================
-- ROLLBACK da 080 — largar a tabela de proveniência
-- ============================================================================
--
-- 🔴 Este rollback **destrói dados**. É o único desta frente que o faz, e é por
--    isso que existe separado do da 081: reverter o comportamento das funções é
--    reversível, largar a tabela não é. Fundidos num só ficheiro, desfazer uma
--    mudança de comportamento obrigaria a apagar o prestate dos movimentos
--    adoptados — que é o oposto do que esta frente serve.
--
--     ROLLBACK_ORDER = 081 antes de 080
--     ROLLBACK_DATA_DESTRUCTION = YES (a tabela inteira)
--
-- Duas condições, ambas obrigatórias:
--
--   1. a 081 tem de estar revertida. As funções que ela instala lêem e escrevem
--      nesta tabela; largá-la debaixo delas deixava `mark_payment_paid` a
--      inserir numa relação inexistente e o `unmark` a falhar em cada chamada;
--   2. a tabela tem de estar vazia. Cada linha é o estado a que um movimento
--      preexistente tem de poder voltar, e não existe em mais lado nenhum: a
--      data e a categoria legadas foram sobrescritas no momento da adopção.
--
-- Nenhuma das duas se contorna aqui. Quem precisar de reverter esvazia a tabela
-- pelo caminho normal — com as funções da 081 ainda instaladas, que sabem o que
-- fazer a cada origem — ou classifica o que falta pela auditoria
-- `PAYMENT_CASHFLOW_PROVENANCE_BACKFILL`, e só depois reverte as duas peças por
-- esta ordem.
-- ============================================================================

BEGIN;

DO $guarda$
DECLARE
  v_linhas bigint;
  v_def    text;
BEGIN
  IF to_regclass('public.payment_cashflow_provenance') IS NULL THEN
    -- A tabela não existe: não há nada a proteger nem a largar.
    RETURN;
  END IF;

  -- ── 1. A 081 ainda está instalada? ───────────────────────────────────────
  --
  -- Mede-se pela definição instalada, não pelo ledger. O ledger diz o que
  -- correu; a definição diz o que está lá agora — e é a definição que vai
  -- partir. Se alguém repôs as funções à mão, o que interessa é o que a base
  -- tem.
  SELECT pg_get_functiondef(p.oid) INTO v_def
    FROM pg_proc p
    JOIN pg_namespace n ON n.oid = p.pronamespace
   WHERE n.nspname = 'public' AND p.proname = 'unmark_payment_paid'
   LIMIT 1;

  IF v_def IS NOT NULL AND v_def LIKE '%payment_cashflow_provenance%' THEN
    RAISE EXCEPTION
      'ROLLBACK_BLOCKED_081_STILL_INSTALLED: unmark_payment_paid ainda consome a '
      'tabela de proveniencia. Reverter a 081 primeiro '
      '(rollback/081_safe_unmark_payment_paid.down.sql).'
      USING ERRCODE = 'object_not_in_prerequisite_state';
  END IF;

  SELECT pg_get_functiondef(p.oid) INTO v_def
    FROM pg_proc p
    JOIN pg_namespace n ON n.oid = p.pronamespace
   WHERE n.nspname = 'public' AND p.proname = 'mark_payment_paid'
   LIMIT 1;

  IF v_def IS NOT NULL AND v_def LIKE '%payment_cashflow_provenance%' THEN
    RAISE EXCEPTION
      'ROLLBACK_BLOCKED_081_STILL_INSTALLED: mark_payment_paid ainda escreve na '
      'tabela de proveniencia. Reverter a 081 primeiro '
      '(rollback/081_safe_unmark_payment_paid.down.sql).'
      USING ERRCODE = 'object_not_in_prerequisite_state';
  END IF;

  -- ── 2. Há proveniência registada? ────────────────────────────────────────
  SELECT count(*) INTO v_linhas FROM public.payment_cashflow_provenance;

  IF v_linhas > 0 THEN
    RAISE EXCEPTION
      'ROLLBACK_BLOCKED_PROVENANCE_ROWS_EXIST: % linha(s) de proveniencia. '
      'Largar a tabela apagaria o prestate dos movimentos adoptados e '
      'devolveria um unmark que apaga historico. Classificar primeiro '
      '(PAYMENT_CASHFLOW_PROVENANCE_BACKFILL).', v_linhas
      USING ERRCODE = 'object_not_in_prerequisite_state';
  END IF;
END
$guarda$;

DROP TABLE IF EXISTS public.payment_cashflow_provenance;

COMMIT;

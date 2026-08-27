-- ============================================================================
-- ROLLBACK da 082 — largar as RPC atómicas
-- ============================================================================
--
-- Não destrói dados: a 082 só cria funções e não escreve uma linha. Largá-las
-- devolve o sistema ao estado anterior — que é o estado com a corrida aberta.
--
--     ROLLBACK_DATA_DESTRUCTION = 0
--
-- 🔴 Reverter isto **reabre** o TOCTOU. As acções que passarem a chamar estas
--    RPC deixam de encontrar a função e falham em vez de escrever, o que é o
--    modo de falha certo: recusam alto em vez de gravarem por um caminho sem
--    guarda. Não repor os caminhos antigos por PostgREST ao mesmo tempo — seria
--    trocar uma falha visível por uma corrida silenciosa.
--
-- A ordem em relação à 080/081 é indiferente: nada aqui depende da tabela de
-- proveniência, e nada lá depende destas funções.
-- ============================================================================

BEGIN;

DROP FUNCTION IF EXISTS public.confirm_bank_match_atomic(uuid, uuid, uuid);
DROP FUNCTION IF EXISTS public.delete_cashflow_entry_atomic(uuid, uuid);
DROP FUNCTION IF EXISTS public.update_cashflow_entry_atomic(uuid, uuid, jsonb);
DROP FUNCTION IF EXISTS public.lock_cashflow_for_manual_mutation(uuid, uuid);
DROP FUNCTION IF EXISTS public.delete_payment_atomic(uuid, uuid);
DROP FUNCTION IF EXISTS public.update_payment_amount_atomic(uuid, uuid, numeric);

COMMIT;

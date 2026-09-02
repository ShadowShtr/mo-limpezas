-- Rollback da 089 — protocolo de serialização do período financeiro.
--
-- Só remove funções. Não toca em `financial_periods` nem em linha de negócio
-- nenhuma: o protocolo não cria dados, serializa acesso a eles.
--
-- 🔴 Depois disto, os writers que passaram a chamar
--    `assert_financial_period_open_locked` deixam de encontrar a função. O
--    rollback do schema tem de andar com o rollback do código que a chama —
--    largar uma sem a outra deixa a aplicação a falhar em cada escrita
--    financeira.

DROP FUNCTION IF EXISTS public.reopen_financial_period_atomic(uuid, integer, integer, uuid, text);
DROP FUNCTION IF EXISTS public.close_financial_period_atomic(uuid, integer, integer, uuid);
DROP FUNCTION IF EXISTS public.financial_period_blockers(uuid, integer, integer);
DROP FUNCTION IF EXISTS public.assert_financial_period_open_locked(uuid, integer, integer);
DROP FUNCTION IF EXISTS public.lock_financial_periods_pair(uuid, integer, integer, integer, integer);
DROP FUNCTION IF EXISTS public.lock_financial_period(uuid, integer, integer);
DROP FUNCTION IF EXISTS public.financial_period_lock_key(integer, integer);

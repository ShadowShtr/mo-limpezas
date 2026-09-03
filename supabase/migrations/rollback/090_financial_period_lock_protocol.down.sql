-- Rollback da 090 — protocolo de serialização do período financeiro.
--
-- Só remove funções. Não toca em `financial_periods`, em `audit_logs` nem em
-- linha de negócio nenhuma: o protocolo não cria dados, serializa acesso a eles.
--
-- 🔴 ROLLBACK_REQUIRES_CODE_ROLLBACK = YES
--
--    Depois disto, os writers que passaram a chamar
--    `assert_financial_period_open_locked` (ou o par) deixam de encontrar a
--    função, e as actions que chamam `close_financial_period_atomic` /
--    `reopen_financial_period_atomic` falham em cada invocação. O rollback do
--    schema tem de andar com o rollback do código que as chama — largar uma
--    sem a outra deixa a aplicação a falhar em cada escrita financeira.
--
--    Enquanto existir runtime publicado que dependa destas funções, o caminho
--    correcto é FORWARD FIX, não este ficheiro.
--
-- 🔴 Perde a auditoria transacional do fecho/reabertura. Voltar atrás repõe o
--    comportamento antigo — `upsert` e depois `auditLog` em viagens separadas —
--    em que uma falha entre as duas deixa o mês fechado sem registo de autoria.
--    As linhas de auditoria já gravadas NÃO são apagadas por este rollback.

DROP FUNCTION IF EXISTS public.reopen_financial_period_atomic(uuid, integer, integer, uuid, text);
DROP FUNCTION IF EXISTS public.close_financial_period_atomic(uuid, integer, integer, uuid);
DROP FUNCTION IF EXISTS public.financial_period_blockers(uuid, integer, integer);
DROP FUNCTION IF EXISTS public.assert_financial_periods_open_locked_pair(uuid, integer, integer, integer, integer);
DROP FUNCTION IF EXISTS public.assert_financial_period_open_locked(uuid, integer, integer);
DROP FUNCTION IF EXISTS public.lock_financial_periods_pair(uuid, integer, integer, integer, integer);
DROP FUNCTION IF EXISTS public.lock_financial_period(uuid, integer, integer);
DROP FUNCTION IF EXISTS public.financial_period_lock_key(integer, integer);

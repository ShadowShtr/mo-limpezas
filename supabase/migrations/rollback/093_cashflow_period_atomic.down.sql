-- Rollback da 093 — fluxo de caixa manual dentro do protocolo de período.
--
-- 🔴 ROLLBACK_DATA_DESTRUCTIVE = NO. Nenhuma linha de `cash_flow_entries` é
--    tocada.
--
-- 🔴 ROLLBACK_REQUIRES_CODE_ROLLBACK = PARCIAL.
--
--    `create_cashflow_entry_atomic` é NOVA na 093 e é aqui removida. Hoje
--    `createCashFlowEntry` ainda faz um INSERT directo e não a chama; se a PR de
--    runtime do caixa já estiver em produção, este ficheiro NÃO pode correr
--    sozinho.
--
--    `update_cashflow_entry_atomic` e `delete_cashflow_entry_atomic` NÃO são
--    removidas: o runtime usa-as desde a 082. Para as repor na versão anterior
--    reaplica-se a 082, que é toda em `CREATE OR REPLACE`.
--
-- 🔴 O QUE SE PERDE: a edição de um movimento volta a proteger, quando muito, o
--    mês de DESTINO — pela guarda da action, noutra transação — e deixa o mês de
--    ORIGEM sem protecção nenhuma. Mudar a data de um movimento para fora de um
--    mês fechado volta a passar em silêncio.
--
-- 🔴 FORWARD_FIX_PREFERRED = YES.

DROP FUNCTION IF EXISTS public.create_cashflow_entry_atomic(uuid, text, numeric, text, text, date, text, text, uuid, uuid);

-- As duas substituídas NÃO são removidas aqui. Reponha-as reaplicando a 082.

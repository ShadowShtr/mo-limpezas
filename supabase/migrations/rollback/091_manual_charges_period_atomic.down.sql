-- Rollback da 091 — cobranças avulsas dentro do protocolo de período.
--
-- 🔴 ROLLBACK_DATA_DESTRUCTIVE = NO. Nenhuma linha de `manual_charges` ou de
--    `cash_flow_entries` é tocada: a 091 só acrescentou guardas de período a
--    funções que já existiam.
--
-- 🔴 ROLLBACK_REQUIRES_CODE_ROLLBACK = PARCIAL, e é preciso ler com atenção.
--
--    `create_manual_charge_atomic` é NOVA na 091 e é aqui removida. Qualquer
--    runtime publicado que a chame passa a falhar — se a PR de runtime das
--    cobranças já estiver em produção, este ficheiro NÃO pode correr sozinho.
--
--    As outras três voltam à versão da 086: mesma assinatura, mesmo
--    comportamento de negócio, SEM guarda de período. O código que as chama
--    continua a funcionar — e é precisamente esse o perigo: volta a ser
--    possível criar, editar, receber e anular cobranças num mês FECHADO, sem
--    nada a assinalar que a protecção desapareceu.
--
-- 🔴 FORWARD_FIX_PREFERRED = YES. Reverter guardas de período em silêncio é
--    pior do que corrigir para a frente: o sistema fica a aceitar escritas que
--    a contabilidade já dá por encerradas, e não deixa rasto.
--
-- Para repor as versões da 086 basta reaplicá-la — é toda em
-- `CREATE OR REPLACE` e não recria a tabela (`CREATE TABLE IF NOT EXISTS`).
-- Este ficheiro remove apenas a função nova, que a 086 não conhece.

DROP FUNCTION IF EXISTS public.create_manual_charge_atomic(uuid, uuid, date, text, numeric, boolean, text, uuid);

-- As três substituídas NÃO são removidas aqui: deixá-las cair partiria o
-- runtime que as usa desde a 086. Reponha-as reaplicando a 086.

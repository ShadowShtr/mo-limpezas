-- Rollback da 095 — conciliação bancária dentro do protocolo de período.
--
-- 🔴 ROLLBACK_DATA_DESTRUCTIVE = NO. Nenhuma linha de `bank_transactions`,
--    `bank_reconciliation_matches`, `bank_statement_imports` ou
--    `cash_flow_entries` é tocada.
--
-- 🔴 ROLLBACK_REQUIRES_CODE_ROLLBACK = PARCIAL.
--
--    Cinco das seis funções são NOVAS na 095 e são aqui removidas. Hoje
--    `rejectMatch`, `manualMatch`, `ignoreTransaction`,
--    `createEntryFromTransaction` e `deleteImport` ainda escrevem directamente
--    da server action e não as chamam; se a PR de runtime da conciliação já
--    estiver em produção, este ficheiro NÃO pode correr sozinho.
--
--    `confirm_bank_match_atomic` NÃO é removida: `confirmMatch` usa-a desde a
--    082. Para a repor na versão anterior reaplica-se a 082.
--
-- 🔴 O QUE SE PERDE, e é mais do que a guarda de período:
--
--    · voltam a ser TRÊS a QUATRO viagens sem transação comum — um movimento de
--      caixa criado sem correspondência, ou uma correspondência confirmada com
--      a transacção por reconciliar, voltam a ser desfechos possíveis;
--    · `bank_transactions.status` volta a poder mudar num mês fechado. Como
--      `status = 'pending'` é um dos quatro bloqueadores do fecho, isso
--      significa acrescentar ou remover bloqueadores de meses encerrados sem
--      nada a assinalar;
--    · apagar uma importação volta a arrasar meses inteiros de pendentes sem
--      olhar a nenhum deles.
--
-- 🔴 FORWARD_FIX_PREFERRED = YES.

DROP FUNCTION IF EXISTS public.delete_bank_import_atomic(uuid, uuid, uuid);
DROP FUNCTION IF EXISTS public.create_cashflow_from_bank_transaction_atomic(uuid, uuid, text, uuid);
DROP FUNCTION IF EXISTS public.set_bank_transaction_ignored_atomic(uuid, uuid, boolean, uuid);
DROP FUNCTION IF EXISTS public.manual_bank_match_atomic(uuid, uuid, uuid, uuid);
DROP FUNCTION IF EXISTS public.reject_bank_match_atomic(uuid, uuid, uuid);

-- `confirm_bank_match_atomic` NÃO é removida aqui. Reponha-a reaplicando a 082.

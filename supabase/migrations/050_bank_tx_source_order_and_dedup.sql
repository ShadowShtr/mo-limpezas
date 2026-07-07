-- 050 — Conciliação Bancária: ordem original do CSV + brecha de deduplicação
--
-- Dois bugs encontrados em auditoria (2026-07-07):
--
-- 1) A ordem do extrato só existia na pré-visualização (ParsedTransaction.index),
--    nunca era gravada em bank_transactions. A listagem ordenava só por
--    transaction_date desc, sem desempate — movimentos do mesmo dia saíam
--    numa ordem diferente da do ficheiro importado.
--
-- 2) uq_bank_tx_fingerprint era (company_id, bank_account_id, fingerprint).
--    Em Postgres, NULL nunca é igual a outro NULL num unique index — importar
--    sem conta bancária selecionada (bank_account_id NULL) não bloqueava
--    duplicados como deveria.

ALTER TABLE bank_transactions
  ADD COLUMN IF NOT EXISTS source_row_index integer;

CREATE INDEX IF NOT EXISTS idx_bank_tx_import_order
  ON bank_transactions(company_id, statement_import_id, source_row_index);

-- Coluna gerada: trata "sem conta bancária" como um valor concreto em vez de
-- NULL, para que o unique index consiga mesmo bloquear duplicados nesse caso.
-- PostgREST onConflict precisa de nomes de coluna reais (não aceita expressões
-- COALESCE inline), por isso a coluna gerada em vez de um índice de expressão.
ALTER TABLE bank_transactions
  ADD COLUMN IF NOT EXISTS bank_account_key uuid
  GENERATED ALWAYS AS (COALESCE(bank_account_id, '00000000-0000-0000-0000-000000000000'::uuid)) STORED;

DROP INDEX IF EXISTS uq_bank_tx_fingerprint;
CREATE UNIQUE INDEX IF NOT EXISTS uq_bank_tx_fingerprint_safe
  ON bank_transactions(company_id, bank_account_key, fingerprint);

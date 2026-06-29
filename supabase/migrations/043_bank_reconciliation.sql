-- 043 — Conciliação Bancária
-- Importação de extratos bancários (CSV/XLSX/XLS/PDF texto) e sugestão de
-- conciliação com lançamentos financeiros existentes (cash_flow_entries).
--
-- Regras de segurança:
--  * Só admin/gestor da própria company_id acede a dados bancários.
--  * Colaborador NÃO tem qualquer política → sem acesso.
--  * Isolamento multi-tenant garantido por company_id em todas as tabelas.
--  * O processamento de importações é feito via service-role (bypass RLS).
--  * NÃO apaga lançamentos financeiros existentes.
--  * Conciliações NÃO são confirmadas automaticamente (MVP só sugere).
--
-- get_my_company_id() já existe desde a migration 014.

-- ─── 1. bank_accounts ────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS bank_accounts (
  id           uuid DEFAULT gen_random_uuid() PRIMARY KEY,
  company_id   uuid NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  bank_name    text NOT NULL,
  account_name text NOT NULL,
  iban_last4   text,                          -- só os últimos 4 dígitos (nunca IBAN completo)
  currency     text NOT NULL DEFAULT 'EUR',
  is_active     boolean NOT NULL DEFAULT true,
  created_at   timestamptz NOT NULL DEFAULT now(),
  updated_at   timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT bank_accounts_iban_last4_chk CHECK (iban_last4 IS NULL OR iban_last4 ~ '^[0-9]{4}$')
);

CREATE INDEX IF NOT EXISTS idx_bank_accounts_company
  ON bank_accounts(company_id, is_active);

-- ─── 2. bank_statement_imports ───────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS bank_statement_imports (
  id              uuid DEFAULT gen_random_uuid() PRIMARY KEY,
  company_id      uuid NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  bank_account_id uuid REFERENCES bank_accounts(id) ON DELETE SET NULL,
  file_name       text NOT NULL,
  file_type       text NOT NULL CHECK (file_type IN ('csv', 'xlsx', 'xls', 'pdf')),
  file_hash       text NOT NULL,                 -- SHA-256 do ficheiro (anti-duplicado)
  status          text NOT NULL DEFAULT 'pending'
                    CHECK (status IN ('pending', 'processing', 'completed', 'failed')),
  total_rows      integer NOT NULL DEFAULT 0,
  imported_rows   integer NOT NULL DEFAULT 0,
  duplicate_rows  integer NOT NULL DEFAULT 0,
  error_message   text,
  uploaded_by     uuid REFERENCES profiles(id),
  created_at      timestamptz NOT NULL DEFAULT now(),
  completed_at    timestamptz
);

-- Impede reimportar exatamente o mesmo ficheiro na mesma empresa.
CREATE UNIQUE INDEX IF NOT EXISTS uq_bank_imports_company_hash
  ON bank_statement_imports(company_id, file_hash);
CREATE INDEX IF NOT EXISTS idx_bank_imports_company_created
  ON bank_statement_imports(company_id, created_at DESC);

-- ─── 3. bank_transactions ────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS bank_transactions (
  id                  uuid DEFAULT gen_random_uuid() PRIMARY KEY,
  company_id          uuid NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  bank_account_id     uuid REFERENCES bank_accounts(id) ON DELETE SET NULL,
  statement_import_id uuid REFERENCES bank_statement_imports(id) ON DELETE CASCADE,
  transaction_date    date NOT NULL,
  value_date          date,
  description         text NOT NULL DEFAULT '',
  counterparty_name   text,
  reference           text,
  amount              numeric(12,2) NOT NULL,     -- valor absoluto (sinal em direction)
  direction           text NOT NULL CHECK (direction IN ('credit', 'debit')),  -- entrada/saída
  currency            text NOT NULL DEFAULT 'EUR',
  raw_data            jsonb,                       -- linha original normalizada
  fingerprint         text NOT NULL,               -- hash p/ deteção de duplicados de movimento
  status              text NOT NULL DEFAULT 'pending'
                        CHECK (status IN ('pending', 'matched', 'reconciled', 'ignored', 'duplicate')),
  created_at          timestamptz NOT NULL DEFAULT now(),
  updated_at          timestamptz NOT NULL DEFAULT now()
);

-- Um movimento idêntico (mesma empresa+conta+fingerprint) não deve repetir-se.
CREATE UNIQUE INDEX IF NOT EXISTS uq_bank_tx_fingerprint
  ON bank_transactions(company_id, bank_account_id, fingerprint);
CREATE INDEX IF NOT EXISTS idx_bank_tx_company_status
  ON bank_transactions(company_id, status, transaction_date DESC);
CREATE INDEX IF NOT EXISTS idx_bank_tx_import
  ON bank_transactions(statement_import_id);
-- Acelera o matching por valor/data.
CREATE INDEX IF NOT EXISTS idx_bank_tx_match
  ON bank_transactions(company_id, transaction_date, amount);

-- ─── 4. bank_reconciliation_matches ──────────────────────────────────────────
CREATE TABLE IF NOT EXISTS bank_reconciliation_matches (
  id                  uuid DEFAULT gen_random_uuid() PRIMARY KEY,
  company_id          uuid NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  bank_transaction_id uuid NOT NULL REFERENCES bank_transactions(id) ON DELETE CASCADE,
  cash_flow_entry_id  uuid REFERENCES cash_flow_entries(id) ON DELETE CASCADE,
  match_score         integer NOT NULL DEFAULT 0 CHECK (match_score BETWEEN 0 AND 100),
  match_reason        text,
  status              text NOT NULL DEFAULT 'suggested'
                        CHECK (status IN ('suggested', 'confirmed', 'rejected')),
  confirmed_by        uuid REFERENCES profiles(id),
  confirmed_at        timestamptz,
  created_at          timestamptz NOT NULL DEFAULT now()
);

-- Evita sugestões duplicadas do mesmo par (transação, lançamento).
CREATE UNIQUE INDEX IF NOT EXISTS uq_bank_match_pair
  ON bank_reconciliation_matches(bank_transaction_id, cash_flow_entry_id);
CREATE INDEX IF NOT EXISTS idx_bank_match_company_status
  ON bank_reconciliation_matches(company_id, status);
CREATE INDEX IF NOT EXISTS idx_bank_match_tx
  ON bank_reconciliation_matches(bank_transaction_id);

-- ─── RLS ─────────────────────────────────────────────────────────────────────
-- Só admin/gestor da própria empresa. Colaborador: sem política = sem acesso.
-- Service-role (importações/processamento) faz bypass de RLS por design.

ALTER TABLE bank_accounts                ENABLE ROW LEVEL SECURITY;
ALTER TABLE bank_statement_imports       ENABLE ROW LEVEL SECURITY;
ALTER TABLE bank_transactions            ENABLE ROW LEVEL SECURITY;
ALTER TABLE bank_reconciliation_matches  ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "bank_accounts_admin" ON bank_accounts;
CREATE POLICY "bank_accounts_admin" ON bank_accounts
  FOR ALL
  USING (
    company_id = get_my_company_id()
    AND (SELECT role FROM profiles WHERE id = auth.uid()) IN ('admin', 'gestor')
  )
  WITH CHECK (
    company_id = get_my_company_id()
    AND (SELECT role FROM profiles WHERE id = auth.uid()) IN ('admin', 'gestor')
  );

DROP POLICY IF EXISTS "bank_statement_imports_admin" ON bank_statement_imports;
CREATE POLICY "bank_statement_imports_admin" ON bank_statement_imports
  FOR ALL
  USING (
    company_id = get_my_company_id()
    AND (SELECT role FROM profiles WHERE id = auth.uid()) IN ('admin', 'gestor')
  )
  WITH CHECK (
    company_id = get_my_company_id()
    AND (SELECT role FROM profiles WHERE id = auth.uid()) IN ('admin', 'gestor')
  );

DROP POLICY IF EXISTS "bank_transactions_admin" ON bank_transactions;
CREATE POLICY "bank_transactions_admin" ON bank_transactions
  FOR ALL
  USING (
    company_id = get_my_company_id()
    AND (SELECT role FROM profiles WHERE id = auth.uid()) IN ('admin', 'gestor')
  )
  WITH CHECK (
    company_id = get_my_company_id()
    AND (SELECT role FROM profiles WHERE id = auth.uid()) IN ('admin', 'gestor')
  );

DROP POLICY IF EXISTS "bank_reconciliation_matches_admin" ON bank_reconciliation_matches;
CREATE POLICY "bank_reconciliation_matches_admin" ON bank_reconciliation_matches
  FOR ALL
  USING (
    company_id = get_my_company_id()
    AND (SELECT role FROM profiles WHERE id = auth.uid()) IN ('admin', 'gestor')
  )
  WITH CHECK (
    company_id = get_my_company_id()
    AND (SELECT role FROM profiles WHERE id = auth.uid()) IN ('admin', 'gestor')
  );

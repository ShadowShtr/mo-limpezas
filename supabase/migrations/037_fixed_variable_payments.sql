-- 037 — Pagamentos Fixos e Variáveis (com lembrete recorrente)
-- Lista de pagamentos a controlar. Os FIXOS (recurring = true) repetem todos os
-- meses automaticamente: ao abrir um mês novo, são clonados como 'pendente' a
-- partir do mês anterior. Os VARIÁVEIS são pontuais (não se repetem).
-- Serve de lembrete: ver o que falta pagar e o estado de cada um.

CREATE TABLE IF NOT EXISTS fixed_variable_payments (
  id            uuid DEFAULT gen_random_uuid() PRIMARY KEY,
  company_id    uuid NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  kind          text NOT NULL CHECK (kind IN ('fixo', 'variavel')),
  description   text NOT NULL,
  amount        numeric(10,2),                 -- pode ficar por preencher
  due_date      date,                          -- data prevista (pode faltar)
  direct_debit  boolean,                       -- SIM = true, NAO = false, em branco = null
  status        text NOT NULL DEFAULT 'pendente'
                  CHECK (status IN ('pago', 'pendente')),
  recurring     boolean NOT NULL DEFAULT false,  -- fixos = true (repetem todo o mês)
  period_year   integer NOT NULL,
  period_month  integer NOT NULL CHECK (period_month BETWEEN 1 AND 12),
  paid_at       timestamptz,
  notes         text,
  sort_order    integer DEFAULT 0,
  source_id     uuid,                          -- linha de origem (clone do mês anterior)
  created_by    uuid REFERENCES profiles(id),
  created_at    timestamptz DEFAULT now(),
  updated_at    timestamptz DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_fvp_company_period
  ON fixed_variable_payments(company_id, period_year, period_month, kind, sort_order);

ALTER TABLE fixed_variable_payments ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "company members manage fixed variable payments" ON fixed_variable_payments;
CREATE POLICY "company members manage fixed variable payments"
  ON fixed_variable_payments
  USING (company_id IN (SELECT company_id FROM profiles WHERE id = auth.uid()));

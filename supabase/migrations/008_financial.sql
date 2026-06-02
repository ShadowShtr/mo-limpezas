-- ============================================================
-- MIGRATION 008: invoices + invoice_items + payroll_records
-- ============================================================

-- Documentos de cobrança a clientes
CREATE TABLE invoices (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id      UUID NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  client_id       UUID NOT NULL REFERENCES clients(id) ON DELETE RESTRICT,

  invoice_number  TEXT NOT NULL,        -- gerado: "F2025/001"
  invoice_date    DATE NOT NULL DEFAULT CURRENT_DATE,
  due_date        DATE,

  period_start    DATE,
  period_end      DATE,

  subtotal        NUMERIC(10,2) NOT NULL DEFAULT 0,
  vat_rate        NUMERIC(5,2) DEFAULT 23,
  vat_amount      NUMERIC(10,2) DEFAULT 0,
  total           NUMERIC(10,2) NOT NULL DEFAULT 0,

  status          TEXT DEFAULT 'rascunho'
                  CHECK (status IN ('rascunho', 'pendente', 'pago', 'vencido', 'cancelado')),

  paid_at         TIMESTAMPTZ,
  notes           TEXT,

  created_by      UUID REFERENCES profiles(id),
  created_at      TIMESTAMPTZ DEFAULT NOW(),
  updated_at      TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX idx_invoices_company ON invoices(company_id);
CREATE INDEX idx_invoices_client ON invoices(client_id);
CREATE INDEX idx_invoices_status ON invoices(company_id, status);

CREATE TRIGGER invoices_updated_at
  BEFORE UPDATE ON invoices
  FOR EACH ROW EXECUTE FUNCTION update_updated_at();

-- --------------------------------------------------------

CREATE TABLE invoice_items (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  invoice_id    UUID NOT NULL REFERENCES invoices(id) ON DELETE CASCADE,
  service_id    UUID REFERENCES services(id) ON DELETE SET NULL,

  description   TEXT NOT NULL,
  quantity      NUMERIC(8,2) NOT NULL DEFAULT 1,
  unit_price    NUMERIC(8,2) NOT NULL DEFAULT 0,
  total         NUMERIC(10,2) NOT NULL DEFAULT 0,
  sort_order    INTEGER DEFAULT 0
);

CREATE INDEX idx_invoice_items_invoice ON invoice_items(invoice_id);

-- --------------------------------------------------------
-- Folha de pagamento mensal por colaborador
-- --------------------------------------------------------
CREATE TABLE payroll_records (
  id                    UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id            UUID NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  collaborator_id       UUID NOT NULL REFERENCES profiles(id) ON DELETE CASCADE,

  period_year           INTEGER NOT NULL,
  period_month          INTEGER NOT NULL CHECK (period_month BETWEEN 1 AND 12),

  -- Horas
  contracted_hours      NUMERIC(6,2),
  worked_hours          NUMERIC(6,2) DEFAULT 0,
  overtime_hours        NUMERIC(6,2) DEFAULT 0,
  absence_hours         NUMERIC(6,2) DEFAULT 0,
  days_worked           INTEGER DEFAULT 0,

  -- Valores
  hourly_rate           NUMERIC(8,2),
  gross_salary          NUMERIC(10,2) DEFAULT 0,
  meal_allowance        NUMERIC(10,2) DEFAULT 0,
  overtime_bonus        NUMERIC(10,2) DEFAULT 0,
  absence_deductions    NUMERIC(10,2) DEFAULT 0,
  other_deductions      NUMERIC(10,2) DEFAULT 0,
  other_additions       NUMERIC(10,2) DEFAULT 0,
  net_salary            NUMERIC(10,2) DEFAULT 0,

  status                TEXT DEFAULT 'rascunho'
                        CHECK (status IN ('rascunho', 'aprovado', 'pago')),

  notes                 TEXT,
  approved_by           UUID REFERENCES profiles(id),
  paid_at               TIMESTAMPTZ,

  created_at            TIMESTAMPTZ DEFAULT NOW(),
  updated_at            TIMESTAMPTZ DEFAULT NOW(),

  UNIQUE(company_id, collaborator_id, period_year, period_month)
);

CREATE INDEX idx_payroll_company_period ON payroll_records(company_id, period_year, period_month);

CREATE TRIGGER payroll_updated_at
  BEFORE UPDATE ON payroll_records
  FOR EACH ROW EXECUTE FUNCTION update_updated_at();

-- RLS
ALTER TABLE invoices ENABLE ROW LEVEL SECURITY;
ALTER TABLE invoice_items ENABLE ROW LEVEL SECURITY;
ALTER TABLE payroll_records ENABLE ROW LEVEL SECURITY;

CREATE POLICY "managers manage invoices" ON invoices
  FOR ALL USING (
    company_id = (SELECT company_id FROM profiles WHERE id = auth.uid())
    AND (SELECT role FROM profiles WHERE id = auth.uid()) IN ('admin', 'gestor')
  );

CREATE POLICY "managers manage invoice items" ON invoice_items
  FOR ALL USING (
    (SELECT company_id FROM invoices WHERE id = invoice_id)
    = (SELECT company_id FROM profiles WHERE id = auth.uid())
    AND (SELECT role FROM profiles WHERE id = auth.uid()) IN ('admin', 'gestor')
  );

CREATE POLICY "managers manage payroll" ON payroll_records
  FOR ALL USING (
    company_id = (SELECT company_id FROM profiles WHERE id = auth.uid())
    AND (SELECT role FROM profiles WHERE id = auth.uid()) IN ('admin', 'gestor')
  );

CREATE POLICY "collaborators see own payroll" ON payroll_records
  FOR SELECT USING (collaborator_id = auth.uid());

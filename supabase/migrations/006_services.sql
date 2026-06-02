-- ============================================================
-- MIGRATION 006: services + service_reinforcements + service_price_audit
-- Cada serviço é uma ocorrência agendada (gerada por contrato ou pontual)
-- ============================================================

-- Sequence para reference_number por empresa
CREATE SEQUENCE IF NOT EXISTS service_reference_seq START 1;

CREATE TABLE services (
  id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id          UUID NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  location_id         UUID NOT NULL REFERENCES locations(id) ON DELETE RESTRICT,
  team_id             UUID REFERENCES teams(id) ON DELETE SET NULL,
  contract_id         UUID REFERENCES contracts(id) ON DELETE SET NULL,  -- null = pontual

  -- Referência legível (ex: #0042)
  reference_number    TEXT NOT NULL,

  -- Quando
  scheduled_start     TIMESTAMPTZ NOT NULL,
  scheduled_end       TIMESTAMPTZ NOT NULL,

  -- Preço
  hourly_rate         NUMERIC(8,2),         -- copiado do local, editável
  calculated_value    NUMERIC(10,2),        -- duração × rate × (equipa + reforços)
  manual_value        NUMERIC(10,2),        -- override manual (ignora cálculo)
  discount_pct        NUMERIC(5,2) DEFAULT 0,

  -- Estado
  status              TEXT DEFAULT 'agendado'
                      CHECK (status IN (
                        'agendado', 'em_curso', 'concluido',
                        'cancelado', 'falta', 'sem_cobertura'
                      )),

  -- Timestamps reais (preenchidos pelo clock-in/out)
  actual_start        TIMESTAMPTZ,
  actual_end          TIMESTAMPTZ,

  -- Ocorrência de contrato recorrente — foi editada individualmente?
  is_exception        BOOLEAN DEFAULT FALSE,
  original_date       DATE,

  notes               TEXT,

  created_by          UUID REFERENCES profiles(id),
  created_at          TIMESTAMPTZ DEFAULT NOW(),
  updated_at          TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX idx_services_company_date ON services(company_id, scheduled_start);
CREATE INDEX idx_services_team ON services(team_id);
CREATE INDEX idx_services_location ON services(location_id);
CREATE INDEX idx_services_status ON services(company_id, status);
CREATE INDEX idx_services_contract ON services(contract_id);

CREATE TRIGGER services_updated_at
  BEFORE UPDATE ON services
  FOR EACH ROW EXECUTE FUNCTION update_updated_at();

-- Gerar reference_number automático por empresa
CREATE OR REPLACE FUNCTION generate_reference_number(p_company_id UUID)
RETURNS TEXT AS $$
DECLARE
  v_count INTEGER;
BEGIN
  SELECT COUNT(*) + 1 INTO v_count
  FROM services WHERE company_id = p_company_id;
  RETURN '#' || LPAD(v_count::TEXT, 4, '0');
END;
$$ LANGUAGE plpgsql;

-- --------------------------------------------------------
-- Reforços avulso por serviço (colaboradores além da equipa)
-- --------------------------------------------------------
CREATE TABLE service_reinforcements (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  service_id      UUID NOT NULL REFERENCES services(id) ON DELETE CASCADE,
  collaborator_id UUID NOT NULL REFERENCES profiles(id) ON DELETE CASCADE,
  UNIQUE(service_id, collaborator_id)
);

-- --------------------------------------------------------
-- Auditoria de preço
-- --------------------------------------------------------
CREATE TABLE service_price_audit (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  service_id      UUID NOT NULL REFERENCES services(id) ON DELETE CASCADE,
  old_value       NUMERIC(10,2),
  new_value       NUMERIC(10,2),
  changed_by      UUID REFERENCES profiles(id),
  reason          TEXT,
  created_at      TIMESTAMPTZ DEFAULT NOW()
);

-- RLS
ALTER TABLE services ENABLE ROW LEVEL SECURITY;
ALTER TABLE service_reinforcements ENABLE ROW LEVEL SECURITY;
ALTER TABLE service_price_audit ENABLE ROW LEVEL SECURITY;

-- Gestores/admins veem tudo da empresa
CREATE POLICY "managers see company services" ON services
  FOR ALL USING (
    company_id = (SELECT company_id FROM profiles WHERE id = auth.uid())
    AND (SELECT role FROM profiles WHERE id = auth.uid()) IN ('admin', 'gestor')
  );

-- Colaboradores veem apenas os seus serviços (equipa ou reforço)
CREATE POLICY "collaborators see own services" ON services
  FOR SELECT USING (
    company_id = (SELECT company_id FROM profiles WHERE id = auth.uid())
    AND (
      team_id IN (
        SELECT team_id FROM team_members
        WHERE collaborator_id = auth.uid() AND left_at IS NULL
      )
      OR id IN (
        SELECT service_id FROM service_reinforcements
        WHERE collaborator_id = auth.uid()
      )
    )
  );

CREATE POLICY "company reinforcements" ON service_reinforcements
  FOR ALL USING (
    (SELECT company_id FROM services WHERE id = service_id)
    = (SELECT company_id FROM profiles WHERE id = auth.uid())
  );

CREATE POLICY "managers see price audit" ON service_price_audit
  FOR ALL USING (
    (SELECT company_id FROM services WHERE id = service_id)
    = (SELECT company_id FROM profiles WHERE id = auth.uid())
    AND (SELECT role FROM profiles WHERE id = auth.uid()) IN ('admin', 'gestor')
  );

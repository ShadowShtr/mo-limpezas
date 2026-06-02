-- ============================================================
-- MIGRATION 005: contracts (Contratos Fixos recorrentes)
-- Cada contrato define um padrão de serviço recorrente.
-- O campo schedule_days é um array JSONB com a config por dia:
-- [{"day": "mon", "start_time": "09:00", "duration_min": 120, "team_id": "uuid"}]
-- ============================================================

CREATE TABLE contracts (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id      UUID NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  location_id     UUID NOT NULL REFERENCES locations(id) ON DELETE RESTRICT,

  name            TEXT,                 -- nome descritivo opcional

  -- Padrão de recorrência
  frequency       TEXT NOT NULL
                  CHECK (frequency IN ('daily', 'weekly', 'biweekly', 'monthly', 'custom')),
  interval_days   INTEGER DEFAULT 1,    -- para custom: a cada N dias
  weekdays        INTEGER[],            -- para weekly: [1,3,5] = seg,qua,sex

  -- Para monthly
  month_day       INTEGER,              -- ex: 15 = dia 15 do mês
  month_week      INTEGER,              -- ex: 1 = 1ª semana
  month_weekday   INTEGER,              -- ex: 1 = segunda-feira

  -- Config por dia da semana (equipa pode variar por dia)
  -- [{"day": "mon", "start_time": "09:00", "duration_min": 120, "team_id": "uuid"}]
  schedule_days   JSONB NOT NULL DEFAULT '[]',

  -- Período de validade
  starts_on       DATE NOT NULL,
  ends_on         DATE,                 -- null = sem fim

  status          TEXT DEFAULT 'ativo'
                  CHECK (status IN ('ativo', 'pausado', 'cancelado')),

  notes           TEXT,

  created_by      UUID REFERENCES profiles(id),
  created_at      TIMESTAMPTZ DEFAULT NOW(),
  updated_at      TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX idx_contracts_company ON contracts(company_id);
CREATE INDEX idx_contracts_location ON contracts(location_id);
CREATE INDEX idx_contracts_status ON contracts(company_id, status);

CREATE TRIGGER contracts_updated_at
  BEFORE UPDATE ON contracts
  FOR EACH ROW EXECUTE FUNCTION update_updated_at();

-- RLS
ALTER TABLE contracts ENABLE ROW LEVEL SECURITY;

CREATE POLICY "company contracts" ON contracts
  FOR ALL USING (
    company_id = (SELECT company_id FROM profiles WHERE id = auth.uid())
  );

CREATE POLICY "colaboradores see own contracts" ON contracts
  FOR SELECT USING (
    company_id = (SELECT company_id FROM profiles WHERE id = auth.uid())
    AND (SELECT role FROM profiles WHERE id = auth.uid()) != 'colaborador'
  );

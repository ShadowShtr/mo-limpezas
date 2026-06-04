-- ============================================================
-- MIGRATION 016: Gestão de viaturas
-- Tabelas: vehicles, vehicle_allocations
-- ============================================================

-- ── vehicles ──────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS vehicles (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id  UUID NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  model       VARCHAR(100) NOT NULL,
  plate       VARCHAR(20)  NOT NULL,
  status      VARCHAR(20)  NOT NULL DEFAULT 'ativo'
                CHECK (status IN ('ativo', 'manutencao', 'inativo')),
  notes       TEXT,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS vehicles_company_plate_idx ON vehicles (company_id, plate);

-- ── vehicle_allocations ───────────────────────────────────────────────────────
-- Registo diário: qual viatura vai com qual equipa e quem conduz
CREATE TABLE IF NOT EXISTS vehicle_allocations (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id  UUID NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  vehicle_id  UUID NOT NULL REFERENCES vehicles(id) ON DELETE CASCADE,
  team_id     UUID NOT NULL REFERENCES teams(id)    ON DELETE CASCADE,
  driver_id   UUID          REFERENCES profiles(id) ON DELETE SET NULL,
  date        DATE NOT NULL,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT now(),

  -- Uma viatura só pode estar numa equipa por dia
  CONSTRAINT vehicle_allocations_vehicle_date_unique UNIQUE (vehicle_id, date)
);

CREATE INDEX IF NOT EXISTS vehicle_allocations_team_date_idx
  ON vehicle_allocations (team_id, date);

-- ── updated_at trigger ────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION update_updated_at_column()
RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN
  NEW.updated_at = now();
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS vehicles_updated_at ON vehicles;
CREATE TRIGGER vehicles_updated_at
  BEFORE UPDATE ON vehicles
  FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

DROP TRIGGER IF EXISTS vehicle_allocations_updated_at ON vehicle_allocations;
CREATE TRIGGER vehicle_allocations_updated_at
  BEFORE UPDATE ON vehicle_allocations
  FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

-- ── RLS ───────────────────────────────────────────────────────────────────────
ALTER TABLE vehicles           ENABLE ROW LEVEL SECURITY;
ALTER TABLE vehicle_allocations ENABLE ROW LEVEL SECURITY;

-- Vehicles: gestores e admins da mesma empresa
CREATE POLICY vehicles_company_isolation ON vehicles
  USING (company_id IN (
    SELECT company_id FROM profiles WHERE id = auth.uid()
  ));

CREATE POLICY vehicles_insert ON vehicles FOR INSERT
  WITH CHECK (company_id IN (
    SELECT company_id FROM profiles
    WHERE id = auth.uid() AND role IN ('admin', 'gestor')
  ));

CREATE POLICY vehicles_update ON vehicles FOR UPDATE
  USING (company_id IN (
    SELECT company_id FROM profiles
    WHERE id = auth.uid() AND role IN ('admin', 'gestor')
  ));

CREATE POLICY vehicles_delete ON vehicles FOR DELETE
  USING (company_id IN (
    SELECT company_id FROM profiles
    WHERE id = auth.uid() AND role IN ('admin', 'gestor')
  ));

-- Vehicle allocations
CREATE POLICY vehicle_allocations_company_isolation ON vehicle_allocations
  USING (company_id IN (
    SELECT company_id FROM profiles WHERE id = auth.uid()
  ));

CREATE POLICY vehicle_allocations_insert ON vehicle_allocations FOR INSERT
  WITH CHECK (company_id IN (
    SELECT company_id FROM profiles
    WHERE id = auth.uid() AND role IN ('admin', 'gestor')
  ));

CREATE POLICY vehicle_allocations_update ON vehicle_allocations FOR UPDATE
  USING (company_id IN (
    SELECT company_id FROM profiles
    WHERE id = auth.uid() AND role IN ('admin', 'gestor')
  ));

CREATE POLICY vehicle_allocations_delete ON vehicle_allocations FOR DELETE
  USING (company_id IN (
    SELECT company_id FROM profiles
    WHERE id = auth.uid() AND role IN ('admin', 'gestor')
  ));

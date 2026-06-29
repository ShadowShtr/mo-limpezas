-- ============================================================
-- MIGRATION 040: Trocar colaboradoras de equipa por dia
-- Tabela: collaborator_ride_assignments
--
-- Por defeito uma colaboradora trabalha com a SUA equipa.
-- Esta tabela regista reatribuições do dia: a colaboradora X
-- trabalha hoje com a equipa Y (a viatura segue a equipa Y).
-- ============================================================

CREATE TABLE IF NOT EXISTS collaborator_ride_assignments (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id      UUID NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  collaborator_id UUID NOT NULL REFERENCES profiles(id)  ON DELETE CASCADE,
  team_id         UUID NOT NULL REFERENCES teams(id)     ON DELETE CASCADE,
  date            DATE NOT NULL,
  assigned_by     UUID          REFERENCES profiles(id)  ON DELETE SET NULL,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT now(),

  -- Uma colaboradora só pode estar numa equipa por dia
  CONSTRAINT collaborator_ride_collaborator_date_unique UNIQUE (collaborator_id, date)
);

CREATE INDEX IF NOT EXISTS collaborator_ride_company_date_idx
  ON collaborator_ride_assignments (company_id, date);

CREATE INDEX IF NOT EXISTS collaborator_ride_team_date_idx
  ON collaborator_ride_assignments (team_id, date);

-- ── updated_at trigger (função criada na migration 016) ─────────────────────────
DROP TRIGGER IF EXISTS collaborator_ride_assignments_updated_at ON collaborator_ride_assignments;
CREATE TRIGGER collaborator_ride_assignments_updated_at
  BEFORE UPDATE ON collaborator_ride_assignments
  FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

-- ── RLS ─────────────────────────────────────────────────────────────────────────
ALTER TABLE collaborator_ride_assignments ENABLE ROW LEVEL SECURITY;

-- Leitura: qualquer membro da empresa (a colaboradora vê a sua própria atribuição)
DROP POLICY IF EXISTS collaborator_ride_company_isolation ON collaborator_ride_assignments;
CREATE POLICY collaborator_ride_company_isolation ON collaborator_ride_assignments
  USING (company_id IN (
    SELECT company_id FROM profiles WHERE id = auth.uid()
  ));

-- Escrita: apenas admin/gestor da empresa
DROP POLICY IF EXISTS collaborator_ride_insert ON collaborator_ride_assignments;
CREATE POLICY collaborator_ride_insert ON collaborator_ride_assignments FOR INSERT
  WITH CHECK (company_id IN (
    SELECT company_id FROM profiles
    WHERE id = auth.uid() AND role IN ('admin', 'gestor')
  ));

DROP POLICY IF EXISTS collaborator_ride_update ON collaborator_ride_assignments;
CREATE POLICY collaborator_ride_update ON collaborator_ride_assignments FOR UPDATE
  USING (company_id IN (
    SELECT company_id FROM profiles
    WHERE id = auth.uid() AND role IN ('admin', 'gestor')
  ));

DROP POLICY IF EXISTS collaborator_ride_delete ON collaborator_ride_assignments;
CREATE POLICY collaborator_ride_delete ON collaborator_ride_assignments FOR DELETE
  USING (company_id IN (
    SELECT company_id FROM profiles
    WHERE id = auth.uid() AND role IN ('admin', 'gestor')
  ));

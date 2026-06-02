-- ============================================================
-- MIGRATION 004: teams + team_members
-- ============================================================

CREATE TABLE teams (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id  UUID NOT NULL REFERENCES companies(id) ON DELETE CASCADE,

  name        TEXT NOT NULL,
  color       TEXT DEFAULT '#16A34A',   -- hex para o calendário
  leader_id   UUID REFERENCES profiles(id) ON DELETE SET NULL,
  active      BOOLEAN DEFAULT TRUE,

  created_at  TIMESTAMPTZ DEFAULT NOW(),
  updated_at  TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX idx_teams_company ON teams(company_id);

CREATE TRIGGER teams_updated_at
  BEFORE UPDATE ON teams
  FOR EACH ROW EXECUTE FUNCTION update_updated_at();

-- --------------------------------------------------------

CREATE TABLE team_members (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  team_id         UUID NOT NULL REFERENCES teams(id) ON DELETE CASCADE,
  collaborator_id UUID NOT NULL REFERENCES profiles(id) ON DELETE CASCADE,
  joined_at       DATE DEFAULT CURRENT_DATE,
  left_at         DATE,                 -- null = ainda na equipa

  UNIQUE(team_id, collaborator_id)
);

CREATE INDEX idx_team_members_team ON team_members(team_id);
CREATE INDEX idx_team_members_collaborator ON team_members(collaborator_id);

-- RLS
ALTER TABLE teams ENABLE ROW LEVEL SECURITY;
ALTER TABLE team_members ENABLE ROW LEVEL SECURITY;

CREATE POLICY "company teams" ON teams
  FOR ALL USING (
    company_id = (SELECT company_id FROM profiles WHERE id = auth.uid())
  );

CREATE POLICY "company team members" ON team_members
  FOR ALL USING (
    (SELECT company_id FROM teams WHERE id = team_id)
    = (SELECT company_id FROM profiles WHERE id = auth.uid())
  );

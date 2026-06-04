-- ============================================================
-- MIGRATION 014: Fix RLS infinite recursion em profiles
-- O problema: policies que fazem SELECT em profiles dentro
-- de policies de profiles = loop infinito.
-- Solução: função SECURITY DEFINER que bypassa RLS.
-- ============================================================

-- Função que retorna o company_id do utilizador atual
-- SECURITY DEFINER = corre com privilégios do owner (postgres),
-- bypassa RLS e evita recursão.
CREATE OR REPLACE FUNCTION get_my_company_id()
RETURNS UUID
LANGUAGE SQL
SECURITY DEFINER
STABLE
SET search_path = public
AS $$
  SELECT company_id FROM profiles WHERE id = auth.uid() LIMIT 1;
$$;

-- Função que retorna o role do utilizador atual
CREATE OR REPLACE FUNCTION get_my_role()
RETURNS TEXT
LANGUAGE SQL
SECURITY DEFINER
STABLE
SET search_path = public
AS $$
  SELECT role FROM profiles WHERE id = auth.uid() LIMIT 1;
$$;

-- ── Recriar policies de profiles sem recursão ─────────────────────────────────

DROP POLICY IF EXISTS "users see own company profiles"       ON profiles;
DROP POLICY IF EXISTS "users update own profile"             ON profiles;
DROP POLICY IF EXISTS "admins gestores manage profiles"      ON profiles;

CREATE POLICY "profiles_select" ON profiles
  FOR SELECT USING (
    id = auth.uid()                          -- o próprio utilizador
    OR company_id = get_my_company_id()      -- colegas da mesma empresa
  );

CREATE POLICY "profiles_update_own" ON profiles
  FOR UPDATE USING (id = auth.uid());

CREATE POLICY "profiles_manage_company" ON profiles
  FOR ALL USING (
    company_id = get_my_company_id()
    AND get_my_role() IN ('admin', 'gestor')
  );

-- ── Recriar policies de outras tabelas que tinham o mesmo padrão ─────────────

-- company_settings
DROP POLICY IF EXISTS "users see own company settings"  ON company_settings;
DROP POLICY IF EXISTS "admins manage company settings"  ON company_settings;

CREATE POLICY "company_settings_select" ON company_settings
  FOR SELECT USING (company_id = get_my_company_id());

CREATE POLICY "company_settings_manage" ON company_settings
  FOR ALL USING (
    company_id = get_my_company_id()
    AND get_my_role() = 'admin'
  );

-- teams
DROP POLICY IF EXISTS "users see own company teams"    ON teams;
DROP POLICY IF EXISTS "admins gestores manage teams"   ON teams;

ALTER TABLE teams ENABLE ROW LEVEL SECURITY;

CREATE POLICY "teams_select" ON teams
  FOR SELECT USING (company_id = get_my_company_id());

CREATE POLICY "teams_manage" ON teams
  FOR ALL USING (
    company_id = get_my_company_id()
    AND get_my_role() IN ('admin', 'gestor')
  );

-- team_members (sem company_id próprio — herda via team)
DROP POLICY IF EXISTS "users see own company team_members" ON team_members;
DROP POLICY IF EXISTS "admins gestores manage team_members" ON team_members;

ALTER TABLE team_members ENABLE ROW LEVEL SECURITY;

CREATE POLICY "team_members_select" ON team_members
  FOR SELECT USING (
    team_id IN (SELECT id FROM teams WHERE company_id = get_my_company_id())
  );

CREATE POLICY "team_members_manage" ON team_members
  FOR ALL USING (
    team_id IN (SELECT id FROM teams WHERE company_id = get_my_company_id())
    AND get_my_role() IN ('admin', 'gestor')
  );

-- services
DROP POLICY IF EXISTS "users see own company services"  ON services;
DROP POLICY IF EXISTS "admins gestores manage services" ON services;

ALTER TABLE services ENABLE ROW LEVEL SECURITY;

CREATE POLICY "services_select" ON services
  FOR SELECT USING (company_id = get_my_company_id());

CREATE POLICY "services_manage" ON services
  FOR ALL USING (
    company_id = get_my_company_id()
    AND get_my_role() IN ('admin', 'gestor')
  );

CREATE POLICY "services_collaborator_view" ON services
  FOR SELECT USING (
    team_id IN (
      SELECT t.id FROM teams t
      JOIN team_members tm ON tm.team_id = t.id
      WHERE tm.collaborator_id = auth.uid()
    )
  );

-- timesheets
DROP POLICY IF EXISTS "users see own timesheets"           ON timesheets;
DROP POLICY IF EXISTS "admins gestores manage timesheets"  ON timesheets;

ALTER TABLE timesheets ENABLE ROW LEVEL SECURITY;

CREATE POLICY "timesheets_select" ON timesheets
  FOR SELECT USING (
    company_id = get_my_company_id()
    OR collaborator_id = auth.uid()
  );

CREATE POLICY "timesheets_collaborator_insert" ON timesheets
  FOR INSERT WITH CHECK (collaborator_id = auth.uid());

CREATE POLICY "timesheets_collaborator_update" ON timesheets
  FOR UPDATE USING (collaborator_id = auth.uid());

CREATE POLICY "timesheets_manager_manage" ON timesheets
  FOR ALL USING (
    company_id = get_my_company_id()
    AND get_my_role() IN ('admin', 'gestor')
  );

-- absences
DROP POLICY IF EXISTS "users see own company absences"  ON absences;
DROP POLICY IF EXISTS "admins gestores manage absences" ON absences;

ALTER TABLE absences ENABLE ROW LEVEL SECURITY;

CREATE POLICY "absences_select" ON absences
  FOR SELECT USING (
    company_id = get_my_company_id()
    OR collaborator_id = auth.uid()
  );

CREATE POLICY "absences_manage" ON absences
  FOR ALL USING (
    company_id = get_my_company_id()
    AND get_my_role() IN ('admin', 'gestor')
  );

-- clients
DROP POLICY IF EXISTS "users see own company clients"  ON clients;
DROP POLICY IF EXISTS "admins gestores manage clients" ON clients;

ALTER TABLE clients ENABLE ROW LEVEL SECURITY;

CREATE POLICY "clients_select" ON clients
  FOR SELECT USING (company_id = get_my_company_id());

CREATE POLICY "clients_manage" ON clients
  FOR ALL USING (
    company_id = get_my_company_id()
    AND get_my_role() IN ('admin', 'gestor')
  );

-- locations
DROP POLICY IF EXISTS "users see own company locations"  ON locations;
DROP POLICY IF EXISTS "admins gestores manage locations" ON locations;

ALTER TABLE locations ENABLE ROW LEVEL SECURITY;

CREATE POLICY "locations_select" ON locations
  FOR SELECT USING (company_id = get_my_company_id());

CREATE POLICY "locations_manage" ON locations
  FOR ALL USING (
    company_id = get_my_company_id()
    AND get_my_role() IN ('admin', 'gestor')
  );

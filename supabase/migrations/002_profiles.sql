-- ============================================================
-- MIGRATION 002: profiles + auth trigger
-- Extensão da tabela auth.users do Supabase
-- ============================================================

CREATE TABLE profiles (
  id          UUID PRIMARY KEY REFERENCES auth.users(id) ON DELETE CASCADE,
  company_id  UUID NOT NULL REFERENCES companies(id) ON DELETE CASCADE,

  -- Dados pessoais
  full_name   TEXT NOT NULL,
  phone       TEXT,
  email       TEXT,
  nif         TEXT,
  iban        TEXT,
  avatar_url  TEXT,

  -- Role
  role        TEXT NOT NULL DEFAULT 'colaborador'
              CHECK (role IN ('admin', 'gestor', 'colaborador')),

  -- Contrato
  contracted_hours_month  NUMERIC(6,2) DEFAULT 168,
  contract_start          DATE,
  contract_end            DATE,           -- null = sem prazo
  vacation_balance        NUMERIC(6,2) DEFAULT 22,  -- saldo inicial editável

  -- Skills/competências (ex: ["vidros", "industrial"])
  skills      TEXT[] DEFAULT '{}',

  -- Disponibilidade semanal
  availability JSONB DEFAULT '{
    "mon": true, "tue": true, "wed": true,
    "thu": true, "fri": true, "sat": false, "sun": false
  }',

  -- Estado
  status      TEXT DEFAULT 'ativo'
              CHECK (status IN ('ativo', 'inativo', 'suspenso')),

  -- Convite
  invited_at  TIMESTAMPTZ,
  invite_accepted_at TIMESTAMPTZ,

  created_at  TIMESTAMPTZ DEFAULT NOW(),
  updated_at  TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX idx_profiles_company ON profiles(company_id);
CREATE INDEX idx_profiles_role ON profiles(company_id, role);

CREATE TRIGGER profiles_updated_at
  BEFORE UPDATE ON profiles
  FOR EACH ROW EXECUTE FUNCTION update_updated_at();

-- --------------------------------------------------------
-- Trigger: criar profile automaticamente quando user regista
-- --------------------------------------------------------
CREATE OR REPLACE FUNCTION handle_new_user()
RETURNS TRIGGER AS $$
DECLARE
  v_company_id UUID;
  v_role TEXT;
  v_full_name TEXT;
BEGIN
  -- Extrair dados do metadata do convite
  v_company_id := (NEW.raw_user_meta_data->>'company_id')::UUID;
  v_role       := COALESCE(NEW.raw_user_meta_data->>'role', 'colaborador');
  v_full_name  := COALESCE(NEW.raw_user_meta_data->>'full_name', NEW.email);

  IF v_company_id IS NOT NULL THEN
    INSERT INTO profiles (id, company_id, full_name, email, role)
    VALUES (NEW.id, v_company_id, v_full_name, NEW.email, v_role)
    ON CONFLICT (id) DO NOTHING;
  END IF;

  RETURN NEW;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

CREATE TRIGGER on_auth_user_created
  AFTER INSERT ON auth.users
  FOR EACH ROW EXECUTE FUNCTION handle_new_user();

-- RLS
ALTER TABLE profiles ENABLE ROW LEVEL SECURITY;

CREATE POLICY "users see own company profiles" ON profiles
  FOR SELECT USING (
    company_id = (SELECT company_id FROM profiles WHERE id = auth.uid())
  );

CREATE POLICY "users update own profile" ON profiles
  FOR UPDATE USING (id = auth.uid());

CREATE POLICY "admins gestores manage profiles" ON profiles
  FOR ALL USING (
    company_id = (SELECT company_id FROM profiles WHERE id = auth.uid())
    AND (SELECT role FROM profiles WHERE id = auth.uid()) IN ('admin', 'gestor')
  );

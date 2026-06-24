-- ============================================================
-- ESCALA — APPLY ALL MIGRATIONS + SEED (versão corrigida)
-- ============================================================

-- Limpar tudo antes de começar (seguro reexecutar)
DROP VIEW IF EXISTS teams_with_members CASCADE;
DROP VIEW IF EXISTS monthly_hours_summary CASCADE;
DROP VIEW IF EXISTS services_full CASCADE;
DROP TABLE IF EXISTS push_subscriptions CASCADE;
DROP TABLE IF EXISTS notifications CASCADE;
DROP TABLE IF EXISTS payroll_records CASCADE;
DROP TABLE IF EXISTS invoice_items CASCADE;
DROP TABLE IF EXISTS invoices CASCADE;
DROP TABLE IF EXISTS vacation_requests CASCADE;
DROP TABLE IF EXISTS absences CASCADE;
DROP TABLE IF EXISTS timesheets CASCADE;
DROP TABLE IF EXISTS service_price_audit CASCADE;
DROP TABLE IF EXISTS service_reinforcements CASCADE;
DROP TABLE IF EXISTS services CASCADE;
DROP TABLE IF EXISTS contracts CASCADE;
DROP TABLE IF EXISTS team_members CASCADE;
DROP TABLE IF EXISTS teams CASCADE;
DROP TABLE IF EXISTS locations CASCADE;
DROP TABLE IF EXISTS clients CASCADE;
DROP TABLE IF EXISTS profiles CASCADE;
DROP TABLE IF EXISTS company_settings CASCADE;
DROP TABLE IF EXISTS companies CASCADE;
DROP FUNCTION IF EXISTS update_updated_at CASCADE;
DROP FUNCTION IF EXISTS handle_new_user CASCADE;
DROP FUNCTION IF EXISTS generate_reference_number CASCADE;
DROP SEQUENCE IF EXISTS service_reference_seq CASCADE;


-- ============================================================
-- 001_companies.sql
-- ============================================================
-- ============================================================
-- MIGRATION 001: companies + company_settings
-- Base do multi-tenancy — company_id em todas as tabelas
-- ============================================================

CREATE EXTENSION IF NOT EXISTS "uuid-ossp";

-- Empresas (multi-tenancy)
CREATE TABLE companies (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name        TEXT NOT NULL,
  slug        TEXT UNIQUE NOT NULL,       -- ex: "mo-limpezas"
  logo_url    TEXT,
  active      BOOLEAN DEFAULT TRUE,
  created_at  TIMESTAMPTZ DEFAULT NOW(),
  updated_at  TIMESTAMPTZ DEFAULT NOW()
);

-- Configurações globais da empresa
CREATE TABLE company_settings (
  id                      UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id              UUID NOT NULL REFERENCES companies(id) ON DELETE CASCADE,

  -- Salários
  hourly_rate             NUMERIC(8,2) DEFAULT 8.00,       -- €/hora para todos
  meal_allowance_day      NUMERIC(6,2) DEFAULT 9.60,       -- subsídio alimentação €/dia
  overtime_rate_pct       NUMERIC(5,2) DEFAULT 25.00,      -- % acréscimo hora extra
  vacation_days_year      INTEGER DEFAULT 22,               -- dias férias/ano

  -- Faturação
  vat_rate                NUMERIC(5,2) DEFAULT 23.00,       -- IVA %
  invoice_prefix          TEXT DEFAULT 'F',                 -- prefixo das faturas

  -- Operacional
  gps_radius_meters       INTEGER DEFAULT 200,              -- raio validação ponto
  timezone                TEXT DEFAULT 'Europe/Lisbon',

  -- Identidade
  primary_color           TEXT DEFAULT '#16A34A',
  currency                TEXT DEFAULT 'EUR',

  UNIQUE(company_id),
  created_at              TIMESTAMPTZ DEFAULT NOW(),
  updated_at              TIMESTAMPTZ DEFAULT NOW()
);

-- Trigger: updated_at automático
CREATE OR REPLACE FUNCTION update_updated_at()
RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at = NOW();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER companies_updated_at
  BEFORE UPDATE ON companies
  FOR EACH ROW EXECUTE FUNCTION update_updated_at();

CREATE TRIGGER company_settings_updated_at
  BEFORE UPDATE ON company_settings
  FOR EACH ROW EXECUTE FUNCTION update_updated_at();

-- RLS
ALTER TABLE companies ENABLE ROW LEVEL SECURITY;
ALTER TABLE company_settings ENABLE ROW LEVEL SECURITY;

-- Policies (baseadas no company_id do profile do utilizador)
-- [policy movida para depois de 002]

-- [policy movida para depois de 002]

-- [policy movida para depois de 002]


-- ============================================================
-- 002_profiles.sql
-- ============================================================
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



-- ============================================================
-- POLICIES companies/company_settings (diferidas — dependem de profiles)
-- ============================================================
CREATE POLICY "users see own company" ON companies
  FOR SELECT USING (
    id = (SELECT company_id FROM profiles WHERE id = auth.uid())
  );

CREATE POLICY "users see own company settings" ON company_settings
  FOR SELECT USING (
    company_id = (SELECT company_id FROM profiles WHERE id = auth.uid())
  );

CREATE POLICY "admins manage company settings" ON company_settings
  FOR ALL USING (
    company_id = (SELECT company_id FROM profiles WHERE id = auth.uid())
    AND (SELECT role FROM profiles WHERE id = auth.uid()) = 'admin'
  );


-- ============================================================
-- 003_clients_locations.sql
-- ============================================================
-- ============================================================
-- MIGRATION 003: clients + locations
-- ============================================================

CREATE TABLE clients (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id  UUID NOT NULL REFERENCES companies(id) ON DELETE CASCADE,

  name        TEXT NOT NULL,
  nif         TEXT,
  email       TEXT,
  phone       TEXT,
  address     TEXT,
  type        TEXT DEFAULT 'empresa' CHECK (type IN ('individual', 'empresa')),
  notes       TEXT,
  status      TEXT DEFAULT 'ativo' CHECK (status IN ('ativo', 'inativo')),

  created_at  TIMESTAMPTZ DEFAULT NOW(),
  updated_at  TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX idx_clients_company ON clients(company_id);

CREATE TRIGGER clients_updated_at
  BEFORE UPDATE ON clients
  FOR EACH ROW EXECUTE FUNCTION update_updated_at();

-- --------------------------------------------------------

CREATE TABLE locations (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id      UUID NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  client_id       UUID NOT NULL REFERENCES clients(id) ON DELETE CASCADE,

  name            TEXT NOT NULL,
  address         TEXT NOT NULL,
  lat             NUMERIC(10,7),
  lng             NUMERIC(10,7),
  access_code     TEXT,
  instructions    TEXT,

  service_type    TEXT DEFAULT 'limpeza_regular'
                  CHECK (service_type IN (
                    'limpeza_regular', 'manutencao', 'pos_obra',
                    'vidros', 'carpetes', 'industrial', 'outro'
                  )),

  area_sqm        NUMERIC(8,2),
  hourly_rate     NUMERIC(8,2),       -- preço/hora cobrado AO CLIENTE neste local
  gps_radius_m    INTEGER DEFAULT 200, -- override do raio global

  active          BOOLEAN DEFAULT TRUE,

  created_at      TIMESTAMPTZ DEFAULT NOW(),
  updated_at      TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX idx_locations_company ON locations(company_id);
CREATE INDEX idx_locations_client ON locations(client_id);

CREATE TRIGGER locations_updated_at
  BEFORE UPDATE ON locations
  FOR EACH ROW EXECUTE FUNCTION update_updated_at();

-- RLS
ALTER TABLE clients ENABLE ROW LEVEL SECURITY;
ALTER TABLE locations ENABLE ROW LEVEL SECURITY;

CREATE POLICY "company clients" ON clients
  FOR ALL USING (
    company_id = (SELECT company_id FROM profiles WHERE id = auth.uid())
  );

CREATE POLICY "company locations" ON locations
  FOR ALL USING (
    company_id = (SELECT company_id FROM profiles WHERE id = auth.uid())
  );


-- ============================================================
-- 004_teams.sql
-- ============================================================
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


-- ============================================================
-- 005_contracts.sql
-- ============================================================
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


-- ============================================================
-- 006_services.sql
-- ============================================================
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


-- ============================================================
-- 007_timesheets_absences.sql
-- ============================================================
-- ============================================================
-- MIGRATION 007: timesheets + absences + vacation_requests
-- ============================================================

-- Registo de ponto (clock-in / clock-out)
CREATE TABLE timesheets (
  id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  service_id          UUID NOT NULL REFERENCES services(id) ON DELETE CASCADE,
  collaborator_id     UUID NOT NULL REFERENCES profiles(id) ON DELETE CASCADE,
  company_id          UUID NOT NULL REFERENCES companies(id) ON DELETE CASCADE,

  clock_in_at         TIMESTAMPTZ,
  clock_in_lat        NUMERIC(10,7),
  clock_in_lng        NUMERIC(10,7),
  clock_in_distance_m INTEGER,          -- distância ao local no check-in

  clock_out_at        TIMESTAMPTZ,
  clock_out_lat       NUMERIC(10,7),
  clock_out_lng       NUMERIC(10,7),

  duration_minutes    INTEGER,          -- calculado: clock_out - clock_in
  location_warning    BOOLEAN DEFAULT FALSE, -- estava longe do local?

  closed_by_manager   BOOLEAN DEFAULT FALSE, -- gestor fechou manualmente?
  manager_note        TEXT,

  created_at          TIMESTAMPTZ DEFAULT NOW(),
  updated_at          TIMESTAMPTZ DEFAULT NOW(),

  UNIQUE(service_id, collaborator_id)
);

CREATE INDEX idx_timesheets_company ON timesheets(company_id);
CREATE INDEX idx_timesheets_collaborator ON timesheets(collaborator_id, clock_in_at);
CREATE INDEX idx_timesheets_service ON timesheets(service_id);

CREATE TRIGGER timesheets_updated_at
  BEFORE UPDATE ON timesheets
  FOR EACH ROW EXECUTE FUNCTION update_updated_at();

-- --------------------------------------------------------
-- Ausências / Faltas
-- --------------------------------------------------------
CREATE TABLE absences (
  id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id          UUID NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  collaborator_id     UUID NOT NULL REFERENCES profiles(id) ON DELETE CASCADE,

  absence_type        TEXT NOT NULL
                      CHECK (absence_type IN (
                        'doenca_com_baixa', 'doenca_sem_baixa',
                        'pessoal_justificado', 'pessoal_injustificado',
                        'ferias', 'feriado', 'formacao', 'outro'
                      )),

  starts_on           DATE NOT NULL,
  ends_on             DATE NOT NULL,

  notes               TEXT,
  document_url        TEXT,             -- upload de documento (baixa médica, etc.)

  -- Substituição
  replaced_by         UUID REFERENCES profiles(id),

  approved_by         UUID REFERENCES profiles(id),
  created_by          UUID REFERENCES profiles(id),
  created_at          TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX idx_absences_company ON absences(company_id);
CREATE INDEX idx_absences_collaborator ON absences(collaborator_id, starts_on);

-- --------------------------------------------------------
-- Pedidos de Férias
-- --------------------------------------------------------
CREATE TABLE vacation_requests (
  id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id        UUID NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  collaborator_id   UUID NOT NULL REFERENCES profiles(id) ON DELETE CASCADE,

  starts_on         DATE NOT NULL,
  ends_on           DATE NOT NULL,
  days_count        INTEGER,           -- calculado (exclui fins de semana e feriados)

  status            TEXT DEFAULT 'pendente'
                    CHECK (status IN ('pendente', 'aprovado', 'rejeitado')),

  notes             TEXT,
  rejection_reason  TEXT,
  reviewed_by       UUID REFERENCES profiles(id),
  reviewed_at       TIMESTAMPTZ,

  created_at        TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX idx_vacation_requests_company ON vacation_requests(company_id);
CREATE INDEX idx_vacation_requests_collaborator ON vacation_requests(collaborator_id);

-- RLS
ALTER TABLE timesheets ENABLE ROW LEVEL SECURITY;
ALTER TABLE absences ENABLE ROW LEVEL SECURITY;
ALTER TABLE vacation_requests ENABLE ROW LEVEL SECURITY;

CREATE POLICY "collaborators see own timesheets" ON timesheets
  FOR SELECT USING (collaborator_id = auth.uid());

CREATE POLICY "managers see company timesheets" ON timesheets
  FOR ALL USING (
    company_id = (SELECT company_id FROM profiles WHERE id = auth.uid())
    AND (SELECT role FROM profiles WHERE id = auth.uid()) IN ('admin', 'gestor')
  );

CREATE POLICY "collaborators create own timesheets" ON timesheets
  FOR INSERT WITH CHECK (collaborator_id = auth.uid());

CREATE POLICY "company absences" ON absences
  FOR ALL USING (
    company_id = (SELECT company_id FROM profiles WHERE id = auth.uid())
  );

CREATE POLICY "company vacation requests" ON vacation_requests
  FOR ALL USING (
    company_id = (SELECT company_id FROM profiles WHERE id = auth.uid())
  );


-- ============================================================
-- 008_financial.sql
-- ============================================================
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


-- ============================================================
-- 009_notifications.sql
-- ============================================================
-- ============================================================
-- MIGRATION 009: notifications + push_subscriptions
-- ============================================================

CREATE TABLE notifications (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id  UUID NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  user_id     UUID NOT NULL REFERENCES profiles(id) ON DELETE CASCADE,

  type        TEXT NOT NULL,
                -- 'new_service' | 'service_changed' | 'service_cancelled'
                -- | 'substitute_needed' | 'clock_out_missing'
                -- | 'vacation_approved' | 'vacation_rejected'
                -- | 'generation_conflict'

  title       TEXT NOT NULL,
  body        TEXT,
  data        JSONB,                    -- ex: {"service_id": "uuid"}
  read_at     TIMESTAMPTZ,

  created_at  TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX idx_notifications_user ON notifications(user_id, created_at DESC);
CREATE INDEX idx_notifications_unread ON notifications(user_id) WHERE read_at IS NULL;

-- --------------------------------------------------------
-- Push subscriptions (Web Push VAPID)
-- --------------------------------------------------------
CREATE TABLE push_subscriptions (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id     UUID NOT NULL REFERENCES profiles(id) ON DELETE CASCADE,
  company_id  UUID NOT NULL REFERENCES companies(id) ON DELETE CASCADE,

  endpoint    TEXT NOT NULL,
  p256dh      TEXT NOT NULL,
  auth_key    TEXT NOT NULL,
  user_agent  TEXT,

  created_at  TIMESTAMPTZ DEFAULT NOW(),

  UNIQUE(user_id, endpoint)
);

CREATE INDEX idx_push_subs_user ON push_subscriptions(user_id);

-- RLS
ALTER TABLE notifications ENABLE ROW LEVEL SECURITY;
ALTER TABLE push_subscriptions ENABLE ROW LEVEL SECURITY;

CREATE POLICY "users see own notifications" ON notifications
  FOR ALL USING (user_id = auth.uid());

CREATE POLICY "managers create notifications" ON notifications
  FOR INSERT WITH CHECK (
    company_id = (SELECT company_id FROM profiles WHERE id = auth.uid())
  );

CREATE POLICY "users manage own push subs" ON push_subscriptions
  FOR ALL USING (user_id = auth.uid());


-- ============================================================
-- 010_views.sql
-- ============================================================
-- ============================================================
-- MIGRATION 010: views úteis para queries frequentes
-- ============================================================

-- Vista de serviços com toda a informação para o calendário
CREATE OR REPLACE VIEW services_full AS
SELECT
  s.id,
  s.company_id,
  s.reference_number,
  s.scheduled_start,
  s.scheduled_end,
  s.actual_start,
  s.actual_end,
  s.status,
  s.notes,
  s.calculated_value,
  s.manual_value,
  s.contract_id,
  s.is_exception,

  -- Location
  l.id          AS location_id,
  l.name        AS location_name,
  l.address     AS location_address,
  l.lat         AS location_lat,
  l.lng         AS location_lng,
  l.access_code AS location_access_code,
  l.instructions AS location_instructions,

  -- Client
  c.id          AS client_id,
  c.name        AS client_name,

  -- Team
  t.id          AS team_id,
  t.name        AS team_name,
  t.color       AS team_color

FROM services s
JOIN locations l ON s.location_id = l.id
JOIN clients c ON l.client_id = c.id
LEFT JOIN teams t ON s.team_id = t.id;

-- Vista de resumo mensal de horas por colaborador
CREATE OR REPLACE VIEW monthly_hours_summary AS
SELECT
  p.id                    AS collaborator_id,
  p.company_id,
  p.full_name,
  p.contracted_hours_month,
  DATE_TRUNC('month', ts.clock_in_at)  AS month,
  COUNT(ts.id)                          AS services_count,
  SUM(ts.duration_minutes) / 60.0       AS worked_hours,
  SUM(CASE WHEN ts.location_warning THEN 1 ELSE 0 END) AS location_warnings
FROM profiles p
LEFT JOIN timesheets ts ON ts.collaborator_id = p.id
  AND ts.clock_in_at IS NOT NULL
  AND ts.clock_out_at IS NOT NULL
WHERE p.role = 'colaborador'
GROUP BY p.id, p.company_id, p.full_name, p.contracted_hours_month,
         DATE_TRUNC('month', ts.clock_in_at);

-- Vista de equipa com membros activos
CREATE OR REPLACE VIEW teams_with_members AS
SELECT
  t.id,
  t.company_id,
  t.name,
  t.color,
  t.active,
  t.leader_id,
  COALESCE(
    json_agg(
      json_build_object(
        'id', p.id,
        'full_name', p.full_name,
        'avatar_url', p.avatar_url,
        'phone', p.phone
      )
    ) FILTER (WHERE p.id IS NOT NULL),
    '[]'
  ) AS members
FROM teams t
LEFT JOIN team_members tm ON tm.team_id = t.id AND tm.left_at IS NULL
LEFT JOIN profiles p ON p.id = tm.collaborator_id
GROUP BY t.id;


-- ============================================================
-- SEED
-- ============================================================
-- ============================================================
-- SEED: dados fictícios para desenvolvimento
-- NÃO executar em produção
-- ============================================================

-- Empresa
INSERT INTO companies (id, name, slug) VALUES
  ('00000000-0000-0000-0000-000000000001', 'Mó Limpezas', 'mo-limpezas');

INSERT INTO company_settings (company_id, hourly_rate, meal_allowance_day, vat_rate) VALUES
  ('00000000-0000-0000-0000-000000000001', 9.50, 9.60, 23.00);

-- NOTA: Profiles são criados via auth.users (trigger automático).
-- Para seed, usar o dashboard do Supabase para criar utilizadores
-- ou a API de admin. Os UUIDs abaixo são placeholders.

-- Clientes
INSERT INTO clients (id, company_id, name, nif, email, phone, type) VALUES
  ('10000000-0000-0000-0000-000000000001', '00000000-0000-0000-0000-000000000001',
   'Escritórios Central Lda', '501234567', 'central@exemplo.pt', '210000001', 'empresa'),
  ('10000000-0000-0000-0000-000000000002', '00000000-0000-0000-0000-000000000001',
   'Clínica Saúde Plus', '502345678', 'clinica@exemplo.pt', '210000002', 'empresa'),
  ('10000000-0000-0000-0000-000000000003', '00000000-0000-0000-0000-000000000001',
   'Escola Primária do Porto', '503456789', 'escola@exemplo.pt', '210000003', 'empresa'),
  ('10000000-0000-0000-0000-000000000004', '00000000-0000-0000-0000-000000000001',
   'Hotel Mar e Sol', '504567890', 'hotel@exemplo.pt', '210000004', 'empresa'),
  ('10000000-0000-0000-0000-000000000005', '00000000-0000-0000-0000-000000000001',
   'Supermercado Bom Preço', '505678901', 'super@exemplo.pt', '210000005', 'empresa');

-- Locais
INSERT INTO locations (id, company_id, client_id, name, address, lat, lng, hourly_rate, service_type) VALUES
  ('20000000-0000-0000-0000-000000000001', '00000000-0000-0000-0000-000000000001',
   '10000000-0000-0000-0000-000000000001',
   'Escritório Central — Piso 1', 'Rua do Comércio, 10, Porto', 41.1496, -8.6110, 15.00, 'limpeza_regular'),
  ('20000000-0000-0000-0000-000000000002', '00000000-0000-0000-0000-000000000001',
   '10000000-0000-0000-0000-000000000001',
   'Escritório Central — Piso 2', 'Rua do Comércio, 10, Porto', 41.1496, -8.6110, 15.00, 'limpeza_regular'),
  ('20000000-0000-0000-0000-000000000003', '00000000-0000-0000-0000-000000000001',
   '10000000-0000-0000-0000-000000000002',
   'Clínica Saúde Plus — Recepção', 'Avenida da Boavista, 500, Porto', 41.1600, -8.6400, 18.00, 'limpeza_regular'),
  ('20000000-0000-0000-0000-000000000004', '00000000-0000-0000-0000-000000000001',
   '10000000-0000-0000-0000-000000000003',
   'Escola — Bloco A', 'Rua das Flores, 50, Matosinhos', 41.1800, -8.6900, 12.00, 'limpeza_regular'),
  ('20000000-0000-0000-0000-000000000005', '00000000-0000-0000-0000-000000000001',
   '10000000-0000-0000-0000-000000000004',
   'Hotel — Quartos andares 1-3', 'Avenida do Mar, 200, Leça', 41.2000, -8.7100, 20.00, 'limpeza_regular'),
  ('20000000-0000-0000-0000-000000000006', '00000000-0000-0000-0000-000000000001',
   '10000000-0000-0000-0000-000000000005',
   'Supermercado — Área de venda', 'Rua Nova, 80, Gaia', 41.1300, -8.6200, 14.00, 'limpeza_regular');

-- Teams (serão ligadas a profiles reais quando criares os utilizadores)
INSERT INTO teams (id, company_id, name, color) VALUES
  ('30000000-0000-0000-0000-000000000001', '00000000-0000-0000-0000-000000000001', 'Equipa 01', '#16A34A'),
  ('30000000-0000-0000-0000-000000000002', '00000000-0000-0000-0000-000000000001', 'Equipa 02', '#3B82F6'),
  ('30000000-0000-0000-0000-000000000003', '00000000-0000-0000-0000-000000000001', 'Equipa 03', '#F59E0B');


-- ============================================================
-- 038_service_contract_fields.sql + 039_upholstery_units.sql
-- ============================================================
-- Tipo de limpeza, estado de pagamento e detalhes de estofos (contratos e serviços).
-- Todos NULLABLE — compatíveis com registos antigos.

ALTER TABLE contracts ADD COLUMN IF NOT EXISTS cleaning_type         TEXT;
ALTER TABLE contracts ADD COLUMN IF NOT EXISTS payment_status        TEXT;
ALTER TABLE contracts ADD COLUMN IF NOT EXISTS upholstery_type       TEXT;
ALTER TABLE contracts ADD COLUMN IF NOT EXISTS upholstery_notes      TEXT;
ALTER TABLE contracts ADD COLUMN IF NOT EXISTS upholstery_units      INTEGER;
ALTER TABLE contracts ADD COLUMN IF NOT EXISTS upholstery_unit_price NUMERIC(10,2);

ALTER TABLE services  ADD COLUMN IF NOT EXISTS cleaning_type         TEXT;
ALTER TABLE services  ADD COLUMN IF NOT EXISTS payment_status        TEXT;
ALTER TABLE services  ADD COLUMN IF NOT EXISTS upholstery_type       TEXT;
ALTER TABLE services  ADD COLUMN IF NOT EXISTS upholstery_notes      TEXT;
ALTER TABLE services  ADD COLUMN IF NOT EXISTS upholstery_units      INTEGER;
ALTER TABLE services  ADD COLUMN IF NOT EXISTS upholstery_unit_price NUMERIC(10,2);

DO $$ BEGIN
  ALTER TABLE contracts ADD CONSTRAINT contracts_cleaning_type_chk
    CHECK (cleaning_type IS NULL OR cleaning_type IN (
      'manutencao','manutencao_lisboa','pos_obra','pos_obra_lisboa','geral','geral_lisboa','estofos'));
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN
  ALTER TABLE contracts ADD CONSTRAINT contracts_payment_status_chk
    CHECK (payment_status IS NULL OR payment_status IN ('nao_informado','sinal_50','pago_total'));
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN
  ALTER TABLE contracts ADD CONSTRAINT contracts_upholstery_type_chk
    CHECK (upholstery_type IS NULL OR upholstery_type IN ('sofa','poltrona','cadeira','tapete','colchao','unidade','outro'));
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN
  ALTER TABLE services ADD CONSTRAINT services_cleaning_type_chk
    CHECK (cleaning_type IS NULL OR cleaning_type IN (
      'manutencao','manutencao_lisboa','pos_obra','pos_obra_lisboa','geral','geral_lisboa','estofos'));
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN
  ALTER TABLE services ADD CONSTRAINT services_payment_status_chk
    CHECK (payment_status IS NULL OR payment_status IN ('nao_informado','sinal_50','pago_total'));
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN
  ALTER TABLE services ADD CONSTRAINT services_upholstery_type_chk
    CHECK (upholstery_type IS NULL OR upholstery_type IN ('sofa','poltrona','cadeira','tapete','colchao','unidade','outro'));
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

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

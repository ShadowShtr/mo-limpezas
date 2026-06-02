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

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

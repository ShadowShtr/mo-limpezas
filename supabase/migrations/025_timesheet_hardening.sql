-- 025_timesheet_hardening.sql
-- Correcoes operacionais: idempotencia, indices de performance e audit_logs

-- ── 1. Idempotencia nos pontos ────────────────────────────────────────────────

ALTER TABLE timesheets
  ADD COLUMN IF NOT EXISTS client_event_id UUID UNIQUE,
  ADD COLUMN IF NOT EXISTS manual_checkin   BOOLEAN NOT NULL DEFAULT FALSE,
  ADD COLUMN IF NOT EXISTS gps_accuracy_m   INTEGER;

-- ── 2. Indice unico parcial: max 1 ponto aberto por colaboradora ──────────────
-- Remove conflictos em corrida paralela (double clock-in) a nivel de BD.
-- Remover registos duplicados antes de criar o indice (safety net).
DELETE FROM timesheets t1
USING timesheets t2
WHERE t1.collaborator_id = t2.collaborator_id
  AND t1.clock_out_at IS NULL
  AND t2.clock_out_at IS NULL
  AND t1.id > t2.id; -- manter o mais antigo (menor UUID)

CREATE UNIQUE INDEX IF NOT EXISTS timesheets_one_open_per_collab
  ON timesheets (collaborator_id)
  WHERE clock_out_at IS NULL;

-- ── 3. Indices de performance no calendario ───────────────────────────────────

CREATE INDEX IF NOT EXISTS idx_services_company_scheduled
  ON services (company_id, scheduled_start)
  WHERE status NOT IN ('cancelado', 'concluido');

CREATE INDEX IF NOT EXISTS idx_timesheets_company_collab_clock_in
  ON timesheets (company_id, collaborator_id, clock_in_at DESC);

CREATE INDEX IF NOT EXISTS idx_timesheets_open_collab
  ON timesheets (collaborator_id, service_id)
  WHERE clock_out_at IS NULL;

CREATE INDEX IF NOT EXISTS idx_timesheets_service_open
  ON timesheets (service_id)
  WHERE clock_out_at IS NULL;

-- ── 4. Tabela de logs de auditoria ────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS audit_logs (
  id          UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id  UUID        NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  actor_id    UUID        NOT NULL REFERENCES profiles(id)  ON DELETE SET NULL,
  action      TEXT        NOT NULL,
  entity_type TEXT        NOT NULL DEFAULT 'timesheet',
  entity_id   TEXT,
  meta        JSONB       NOT NULL DEFAULT '{}',
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_audit_logs_company_time
  ON audit_logs (company_id, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_audit_logs_actor
  ON audit_logs (actor_id, created_at DESC);

ALTER TABLE audit_logs ENABLE ROW LEVEL SECURITY;

-- Admin/gestor podem ler os logs da sua empresa
CREATE POLICY "audit_logs_admin_read"
  ON audit_logs FOR SELECT
  USING (
    company_id = (SELECT company_id FROM profiles WHERE id = auth.uid())
    AND (SELECT role FROM profiles WHERE id = auth.uid()) IN ('admin', 'gestor')
  );

-- Service role insere (via createAdminClient no servidor)
CREATE POLICY "audit_logs_service_insert"
  ON audit_logs FOR INSERT
  WITH CHECK (true);

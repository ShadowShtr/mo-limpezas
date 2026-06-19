-- 029_background_jobs.sql
-- TASK 14 — Crons pesados em lotes. Tabela de controlo para tarefas longas
-- (geração mensal, arquivo, importações) com cursor, progresso e reentrada segura.

CREATE TABLE IF NOT EXISTS background_jobs (
  id           UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  type         TEXT        NOT NULL,                 -- ex: 'generate_services'
  status       TEXT        NOT NULL DEFAULT 'running'
               CHECK (status IN ('running', 'completed', 'failed')),
  company_id   UUID        REFERENCES companies(id) ON DELETE CASCADE, -- null = multi-empresa
  cursor       INTEGER     NOT NULL DEFAULT 0,        -- posição retomável (índice/offset)
  total        INTEGER     NOT NULL DEFAULT 0,
  processed    INTEGER     NOT NULL DEFAULT 0,
  failed       INTEGER     NOT NULL DEFAULT 0,
  last_error   TEXT,
  meta         JSONB       NOT NULL DEFAULT '{}',     -- ex: { month: '2026-07' }
  started_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  finished_at  TIMESTAMPTZ,
  updated_at   TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Consultar o último job de um tipo (retoma) e listar progresso recente.
CREATE INDEX IF NOT EXISTS idx_background_jobs_type_started
  ON background_jobs (type, started_at DESC);

CREATE INDEX IF NOT EXISTS idx_background_jobs_status
  ON background_jobs (status, started_at DESC);

ALTER TABLE background_jobs ENABLE ROW LEVEL SECURITY;

-- Admin/gestor podem ver o progresso dos jobs da sua empresa (ou globais).
DROP POLICY IF EXISTS "background_jobs_admin_read" ON background_jobs;
CREATE POLICY "background_jobs_admin_read"
  ON background_jobs FOR SELECT
  USING (
    (SELECT role FROM profiles WHERE id = auth.uid()) IN ('admin', 'gestor')
    AND (company_id IS NULL
         OR company_id = (SELECT company_id FROM profiles WHERE id = auth.uid()))
  );

-- Escrita feita via service-role (crons no servidor).
DROP POLICY IF EXISTS "background_jobs_service_write" ON background_jobs;
CREATE POLICY "background_jobs_service_write"
  ON background_jobs FOR ALL
  USING (true) WITH CHECK (true);

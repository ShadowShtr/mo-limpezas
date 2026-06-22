-- 036_background_jobs_lock.sql
-- Adiciona job_key e índice único para evitar execuções paralelas do mesmo cron.
-- Um cron que tente criar um job com job_key já em execução recebe erro 23505
-- e pode sair de imediato — prevenindo duplicação de serviços gerados.

ALTER TABLE background_jobs
  ADD COLUMN IF NOT EXISTS job_key text;

-- Índice único: só pode existir um job "running" por (type, job_key)
CREATE UNIQUE INDEX IF NOT EXISTS idx_background_jobs_running_key
  ON background_jobs(type, job_key)
  WHERE status = 'running';

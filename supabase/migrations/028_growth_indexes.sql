-- 028_growth_indexes.sql
-- TASK 15 — Índices para crescimento. Só os que FALTAM e têm query real a
-- justificá-los (não indexar às cegas — índice acelera leitura mas pesa escrita).
--
-- Já existentes (NÃO recriar):
--   services(company_id, scheduled_start)            → idx_services_company_date
--   services(company_id, scheduled_start) parcial    → idx_services_company_scheduled (025)
--   timesheets(company_id, collaborator_id, clock_in)→ idx_timesheets_company_collab_clock_in (025)
--   timesheets aberto parcial                        → timesheets_one_open_per_collab, *_open (025)
--   service_photos(company_id, service_id, created_at)→ idx_service_photos_service (027)
--   service_photos(company_id, status, created_at)   → idx_service_photos_status (027)
--   audit_logs(company_id, created_at)               → idx_audit_logs_company_time (025)

-- services(company_id, status, scheduled_start)
-- Query: faturação (status='concluido') e dashboard/pendências filtrados por
-- status e ordenados por data. O parcial de 025 só cobre serviços ativos.
CREATE INDEX IF NOT EXISTS idx_services_company_status_scheduled
  ON services (company_id, status, scheduled_start);

-- services(company_id, team_id, scheduled_start)
-- Query: app da colaboradora (serviços da equipa de hoje) e "próximo serviço".
CREATE INDEX IF NOT EXISTS idx_services_company_team_scheduled
  ON services (company_id, team_id, scheduled_start);

-- timesheets(company_id, service_id)
-- Query: gestor a ver os pontos de um serviço; cruzamentos por serviço na empresa.
CREATE INDEX IF NOT EXISTS idx_timesheets_company_service
  ON timesheets (company_id, service_id);

-- clients(company_id, status)
-- Query: lista de clientes filtrada por estado (ativo/inativo).
CREATE INDEX IF NOT EXISTS idx_clients_company_status
  ON clients (company_id, status);

-- locations(company_id, client_id)
-- Query: locais de um cliente dentro da empresa (ficha do cliente, criação de serviço).
CREATE INDEX IF NOT EXISTS idx_locations_company_client
  ON locations (company_id, client_id);

-- NOTA (decisão deliberada): NÃO criamos timesheets(company_id, clock_out_at).
-- As consultas de "ponto aberto" já são servidas por índices parciais
-- (timesheets_one_open_per_collab, idx_timesheets_open_collab, idx_timesheets_service_open)
-- e um índice cheio sobre clock_out_at sofreria muita reescrita a cada checkout
-- para benefício marginal.

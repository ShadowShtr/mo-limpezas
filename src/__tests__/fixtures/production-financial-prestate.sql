-- Overlay read-only do prestate financeiro observado em produção.
-- Não contém dados e só é aplicado em containers de teste.
--
-- A constraint já existe na base real; a origem/migration que a criou continua
-- UNKNOWN. O overlay torna essa evidência explícita sem alterar o dump gerado
-- da forma do schema.
ALTER TABLE public.payroll_records
  ADD CONSTRAINT payroll_records_company_id_collaborator_id_period_year_period_month_key
  UNIQUE (company_id, collaborator_id, period_year, period_month);

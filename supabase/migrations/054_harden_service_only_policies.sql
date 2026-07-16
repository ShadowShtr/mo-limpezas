-- Fecha 2 policies RLS demasiado abertas (achado da auditoria de seguranca 2026-07-16):
-- "USING(true)/WITH CHECK(true)" sem restricao de role permitia a qualquer
-- utilizador autenticado escrever nestas tabelas via API REST do Supabase
-- diretamente, contornando a app. As escritas reais sao sempre feitas por
-- createAdminClient() (service role), que ja ignora RLS por completo — logo
-- restringir estas policies a "TO service_role" nao muda nenhum comportamento
-- da aplicacao, so fecha o acesso direto de utilizadores comuns.

DROP POLICY IF EXISTS "audit_logs_service_insert" ON audit_logs;
CREATE POLICY "audit_logs_service_insert"
  ON audit_logs FOR INSERT
  TO service_role
  WITH CHECK (true);

DROP POLICY IF EXISTS "background_jobs_service_write" ON background_jobs;
CREATE POLICY "background_jobs_service_write"
  ON background_jobs FOR ALL
  TO service_role
  USING (true) WITH CHECK (true);

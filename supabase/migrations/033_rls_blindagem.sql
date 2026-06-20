-- 033_rls_blindagem.sql
-- Restringe políticas RLS permissivas que permitiam a qualquer colaboradora
-- aceder a dados financeiros, GPS de colegas, chaves de acesso e tarefas internas.

-- ─── Auxiliar: role do utilizador atual ──────────────────────────────────────
-- (get_my_company_id() já existe desde migration 014)

-- ─── 1. cash_flow_entries ────────────────────────────────────────────────────
-- Antes: "company members can manage cash flow" (FOR ALL, só company_id) →
-- qualquer colaboradora via browser client podia ler/escrever entradas financeiras.
DROP POLICY IF EXISTS "company members can manage cash flow" ON cash_flow_entries;
CREATE POLICY "cash_flow_admin" ON cash_flow_entries
  FOR ALL
  USING (
    company_id = get_my_company_id()
    AND (SELECT role FROM profiles WHERE id = auth.uid()) IN ('admin', 'gestor')
  )
  WITH CHECK (
    company_id = get_my_company_id()
    AND (SELECT role FROM profiles WHERE id = auth.uid()) IN ('admin', 'gestor')
  );

-- ─── 2. management_tasks ─────────────────────────────────────────────────────
-- Antes: "company members can manage tasks" (FOR ALL, só company_id) →
-- qualquer colaboradora via browser client via ler/escrever tarefas internas.
DROP POLICY IF EXISTS "company members can manage tasks" ON management_tasks;
CREATE POLICY "management_tasks_admin" ON management_tasks
  FOR ALL
  USING (
    company_id = get_my_company_id()
    AND (SELECT role FROM profiles WHERE id = auth.uid()) IN ('admin', 'gestor')
  )
  WITH CHECK (
    company_id = get_my_company_id()
    AND (SELECT role FROM profiles WHERE id = auth.uid()) IN ('admin', 'gestor')
  );

-- ─── 3. timesheets SELECT ────────────────────────────────────────────────────
-- Antes: "timesheets_select" permitia SELECT de TODOS os timesheets da empresa →
-- colaboradora conseguia obter coordenadas GPS de todas as colegas.
DROP POLICY IF EXISTS "timesheets_select" ON timesheets;
-- Gestoras: veem todos da empresa
CREATE POLICY "timesheets_manager_select" ON timesheets
  FOR SELECT
  USING (
    company_id = get_my_company_id()
    AND (SELECT role FROM profiles WHERE id = auth.uid()) IN ('admin', 'gestor')
  );
-- Colaboradoras: só os próprios
CREATE POLICY "timesheets_own_select" ON timesheets
  FOR SELECT
  USING (collaborator_id = auth.uid());

-- ─── 4. absences SELECT ──────────────────────────────────────────────────────
-- Antes: "absences_select" permitia SELECT de todas as faltas da empresa →
-- colaboradora via ler notes/document_url de colegas (dados médicos).
DROP POLICY IF EXISTS "absences_select" ON absences;
-- Gestoras: veem todas da empresa
CREATE POLICY "absences_manager_select" ON absences
  FOR SELECT
  USING (
    company_id = get_my_company_id()
    AND (SELECT role FROM profiles WHERE id = auth.uid()) IN ('admin', 'gestor')
  );
-- Colaboradoras: só as próprias
CREATE POLICY "absences_own_select" ON absences
  FOR SELECT
  USING (collaborator_id = auth.uid());

-- ─── 5. contracts SELECT ─────────────────────────────────────────────────────
-- Antes: "contracts_select" (só company_id) → colaboradora via ler todos os
-- contratos (equipas, horários, preços, observações de acesso).
-- A app mobile nunca consulta contratos diretamente (usa services/instâncias).
DROP POLICY IF EXISTS "contracts_select" ON contracts;
CREATE POLICY "contracts_manager_select" ON contracts
  FOR SELECT
  USING (
    company_id = get_my_company_id()
    AND (SELECT role FROM profiles WHERE id = auth.uid()) IN ('admin', 'gestor')
  );

-- ─── 6. service_photos write ─────────────────────────────────────────────────
-- Antes: "service_photos_service_write" era FOR ALL com USING (true) →
-- qualquer utilizador autenticado podia SELECT/UPDATE/DELETE qualquer foto,
-- incluindo sobrepor a de outra colaboradora.
-- Todas as escritas são feitas via admin client (route handlers): não é necessária
-- uma política de escrita com user client.
DROP POLICY IF EXISTS "service_photos_service_write" ON service_photos;

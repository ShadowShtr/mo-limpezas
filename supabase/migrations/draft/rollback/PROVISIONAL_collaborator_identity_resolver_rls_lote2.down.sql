-- ============================================================================
-- ROLLBACK do LOTE 2 — repõe a identidade legada nas 67 políticas
-- ============================================================================
--
-- 🔴 Reverter reabre o defeito. Depois de reposto, um colaborador com conta
--    criada pelo fluxo novo volta a não conseguir picar o ponto, e um gestor
--    novo volta a perder o acesso de gestão. Existe para o caso de o lote ter
--    de sair **antes** de alguém criar acesso a alguém — não para desfazer
--    depois de estar em uso.
--
-- As definições abaixo são as que a base tinha antes, palavra por palavra.
-- ============================================================================

BEGIN;

DROP POLICY IF EXISTS "absences_manager_select" ON public.absences;
CREATE POLICY "absences_manager_select" ON public.absences AS PERMISSIVE FOR SELECT TO public
  USING (((company_id = get_my_company_id()) AND (( SELECT profiles.role
   FROM profiles
  WHERE (profiles.id = auth.uid())) = ANY (ARRAY['admin'::text, 'gestor'::text]))));
DROP POLICY IF EXISTS "absences_own_select" ON public.absences;
CREATE POLICY "absences_own_select" ON public.absences AS PERMISSIVE FOR SELECT TO public
  USING ((collaborator_id = auth.uid()));
DROP POLICY IF EXISTS "read own reads" ON public.app_notice_reads;
CREATE POLICY "read own reads" ON public.app_notice_reads AS PERMISSIVE FOR SELECT TO public
  USING ((profile_id = auth.uid()));
DROP POLICY IF EXISTS "company members delete attachments" ON public.attachments;
CREATE POLICY "company members delete attachments" ON public.attachments AS PERMISSIVE FOR DELETE TO public
  USING ((company_id IN ( SELECT profiles.company_id
   FROM profiles
  WHERE (profiles.id = auth.uid()))));
DROP POLICY IF EXISTS "company members insert attachments" ON public.attachments;
CREATE POLICY "company members insert attachments" ON public.attachments AS PERMISSIVE FOR INSERT TO public
  WITH CHECK ((company_id IN ( SELECT profiles.company_id
   FROM profiles
  WHERE (profiles.id = auth.uid()))));
DROP POLICY IF EXISTS "company members read attachments" ON public.attachments;
CREATE POLICY "company members read attachments" ON public.attachments AS PERMISSIVE FOR SELECT TO public
  USING ((company_id IN ( SELECT profiles.company_id
   FROM profiles
  WHERE (profiles.id = auth.uid()))));
DROP POLICY IF EXISTS "audit_logs_admin_read" ON public.audit_logs;
CREATE POLICY "audit_logs_admin_read" ON public.audit_logs AS PERMISSIVE FOR SELECT TO public
  USING (((company_id = ( SELECT profiles.company_id
   FROM profiles
  WHERE (profiles.id = auth.uid()))) AND (( SELECT profiles.role
   FROM profiles
  WHERE (profiles.id = auth.uid())) = ANY (ARRAY['admin'::text, 'gestor'::text]))));
DROP POLICY IF EXISTS "background_jobs_admin_read" ON public.background_jobs;
CREATE POLICY "background_jobs_admin_read" ON public.background_jobs AS PERMISSIVE FOR SELECT TO public
  USING (((( SELECT profiles.role
   FROM profiles
  WHERE (profiles.id = auth.uid())) = ANY (ARRAY['admin'::text, 'gestor'::text])) AND ((company_id IS NULL) OR (company_id = ( SELECT profiles.company_id
   FROM profiles
  WHERE (profiles.id = auth.uid()))))));
DROP POLICY IF EXISTS "bank_accounts_admin" ON public.bank_accounts;
CREATE POLICY "bank_accounts_admin" ON public.bank_accounts AS PERMISSIVE FOR ALL TO public
  USING (((company_id = get_my_company_id()) AND (( SELECT profiles.role
   FROM profiles
  WHERE (profiles.id = auth.uid())) = ANY (ARRAY['admin'::text, 'gestor'::text]))))
  WITH CHECK (((company_id = get_my_company_id()) AND (( SELECT profiles.role
   FROM profiles
  WHERE (profiles.id = auth.uid())) = ANY (ARRAY['admin'::text, 'gestor'::text]))));
DROP POLICY IF EXISTS "bank_reconciliation_matches_admin" ON public.bank_reconciliation_matches;
CREATE POLICY "bank_reconciliation_matches_admin" ON public.bank_reconciliation_matches AS PERMISSIVE FOR ALL TO public
  USING (((company_id = get_my_company_id()) AND (( SELECT profiles.role
   FROM profiles
  WHERE (profiles.id = auth.uid())) = ANY (ARRAY['admin'::text, 'gestor'::text]))))
  WITH CHECK (((company_id = get_my_company_id()) AND (( SELECT profiles.role
   FROM profiles
  WHERE (profiles.id = auth.uid())) = ANY (ARRAY['admin'::text, 'gestor'::text]))));
DROP POLICY IF EXISTS "bank_statement_imports_admin" ON public.bank_statement_imports;
CREATE POLICY "bank_statement_imports_admin" ON public.bank_statement_imports AS PERMISSIVE FOR ALL TO public
  USING (((company_id = get_my_company_id()) AND (( SELECT profiles.role
   FROM profiles
  WHERE (profiles.id = auth.uid())) = ANY (ARRAY['admin'::text, 'gestor'::text]))))
  WITH CHECK (((company_id = get_my_company_id()) AND (( SELECT profiles.role
   FROM profiles
  WHERE (profiles.id = auth.uid())) = ANY (ARRAY['admin'::text, 'gestor'::text]))));
DROP POLICY IF EXISTS "bank_transactions_admin" ON public.bank_transactions;
CREATE POLICY "bank_transactions_admin" ON public.bank_transactions AS PERMISSIVE FOR ALL TO public
  USING (((company_id = get_my_company_id()) AND (( SELECT profiles.role
   FROM profiles
  WHERE (profiles.id = auth.uid())) = ANY (ARRAY['admin'::text, 'gestor'::text]))))
  WITH CHECK (((company_id = get_my_company_id()) AND (( SELECT profiles.role
   FROM profiles
  WHERE (profiles.id = auth.uid())) = ANY (ARRAY['admin'::text, 'gestor'::text]))));
DROP POLICY IF EXISTS "building_cards_company_isolation" ON public.building_cards;
CREATE POLICY "building_cards_company_isolation" ON public.building_cards AS PERMISSIVE FOR ALL TO public
  USING ((company_id IN ( SELECT profiles.company_id
   FROM profiles
  WHERE (profiles.id = auth.uid()))));
DROP POLICY IF EXISTS "building_cards_delete" ON public.building_cards;
CREATE POLICY "building_cards_delete" ON public.building_cards AS PERMISSIVE FOR DELETE TO public
  USING ((company_id IN ( SELECT profiles.company_id
   FROM profiles
  WHERE ((profiles.id = auth.uid()) AND (profiles.role = ANY (ARRAY['admin'::text, 'gestor'::text]))))));
DROP POLICY IF EXISTS "building_cards_insert" ON public.building_cards;
CREATE POLICY "building_cards_insert" ON public.building_cards AS PERMISSIVE FOR INSERT TO public
  WITH CHECK ((company_id IN ( SELECT profiles.company_id
   FROM profiles
  WHERE ((profiles.id = auth.uid()) AND (profiles.role = ANY (ARRAY['admin'::text, 'gestor'::text]))))));
DROP POLICY IF EXISTS "building_cards_update" ON public.building_cards;
CREATE POLICY "building_cards_update" ON public.building_cards AS PERMISSIVE FOR UPDATE TO public
  USING ((company_id IN ( SELECT profiles.company_id
   FROM profiles
  WHERE ((profiles.id = auth.uid()) AND (profiles.role = ANY (ARRAY['admin'::text, 'gestor'::text]))))));
DROP POLICY IF EXISTS "cash_flow_admin" ON public.cash_flow_entries;
CREATE POLICY "cash_flow_admin" ON public.cash_flow_entries AS PERMISSIVE FOR ALL TO public
  USING (((company_id = get_my_company_id()) AND (( SELECT profiles.role
   FROM profiles
  WHERE (profiles.id = auth.uid())) = ANY (ARRAY['admin'::text, 'gestor'::text]))))
  WITH CHECK (((company_id = get_my_company_id()) AND (( SELECT profiles.role
   FROM profiles
  WHERE (profiles.id = auth.uid())) = ANY (ARRAY['admin'::text, 'gestor'::text]))));
DROP POLICY IF EXISTS "managers manage client notifications" ON public.client_notifications;
CREATE POLICY "managers manage client notifications" ON public.client_notifications AS PERMISSIVE FOR ALL TO public
  USING (((company_id = ( SELECT profiles.company_id
   FROM profiles
  WHERE (profiles.id = auth.uid()))) AND (( SELECT profiles.role
   FROM profiles
  WHERE (profiles.id = auth.uid())) = ANY (ARRAY['admin'::text, 'gestor'::text]))));
DROP POLICY IF EXISTS "clients_collaborator_select" ON public.clients;
CREATE POLICY "clients_collaborator_select" ON public.clients AS PERMISSIVE FOR SELECT TO public
  USING (((company_id = get_my_company_id()) AND (( SELECT profiles.role
   FROM profiles
  WHERE (profiles.id = auth.uid())) <> ALL (ARRAY['admin'::text, 'gestor'::text])) AND (EXISTS ( SELECT 1
   FROM (locations l
     JOIN services s ON ((s.location_id = l.id)))
  WHERE ((l.client_id = clients.id) AND can_access_service(s.id))))));
DROP POLICY IF EXISTS "colaboradoras submetem relatórios de avaria" ON public.collaborator_documents;
CREATE POLICY "colaboradoras submetem relatórios de avaria" ON public.collaborator_documents AS PERMISSIVE FOR INSERT TO public
  WITH CHECK (((collaborator_id = auth.uid()) AND (category = 'avaria'::text) AND (visible_to_collaborator = true) AND (uploaded_by_role = 'colaboradora'::text)));
DROP POLICY IF EXISTS "colaboradoras veem os seus docs visíveis" ON public.collaborator_documents;
CREATE POLICY "colaboradoras veem os seus docs visíveis" ON public.collaborator_documents AS PERMISSIVE FOR SELECT TO public
  USING (((collaborator_id = auth.uid()) AND (visible_to_collaborator = true)));
DROP POLICY IF EXISTS "gestores gerem documentos da empresa" ON public.collaborator_documents;
CREATE POLICY "gestores gerem documentos da empresa" ON public.collaborator_documents AS PERMISSIVE FOR ALL TO public
  USING ((company_id IN ( SELECT profiles.company_id
   FROM profiles
  WHERE ((profiles.id = auth.uid()) AND (profiles.role = ANY (ARRAY['gestor'::text, 'admin'::text]))))))
  WITH CHECK ((company_id IN ( SELECT profiles.company_id
   FROM profiles
  WHERE ((profiles.id = auth.uid()) AND (profiles.role = ANY (ARRAY['gestor'::text, 'admin'::text]))))));
DROP POLICY IF EXISTS "collaborator_ride_company_isolation" ON public.collaborator_ride_assignments;
CREATE POLICY "collaborator_ride_company_isolation" ON public.collaborator_ride_assignments AS PERMISSIVE FOR ALL TO public
  USING ((company_id IN ( SELECT profiles.company_id
   FROM profiles
  WHERE (profiles.id = auth.uid()))));
DROP POLICY IF EXISTS "collaborator_ride_delete" ON public.collaborator_ride_assignments;
CREATE POLICY "collaborator_ride_delete" ON public.collaborator_ride_assignments AS PERMISSIVE FOR DELETE TO public
  USING ((company_id IN ( SELECT profiles.company_id
   FROM profiles
  WHERE ((profiles.id = auth.uid()) AND (profiles.role = ANY (ARRAY['admin'::text, 'gestor'::text]))))));
DROP POLICY IF EXISTS "collaborator_ride_insert" ON public.collaborator_ride_assignments;
CREATE POLICY "collaborator_ride_insert" ON public.collaborator_ride_assignments AS PERMISSIVE FOR INSERT TO public
  WITH CHECK ((company_id IN ( SELECT profiles.company_id
   FROM profiles
  WHERE ((profiles.id = auth.uid()) AND (profiles.role = ANY (ARRAY['admin'::text, 'gestor'::text]))))));
DROP POLICY IF EXISTS "collaborator_ride_update" ON public.collaborator_ride_assignments;
CREATE POLICY "collaborator_ride_update" ON public.collaborator_ride_assignments AS PERMISSIVE FOR UPDATE TO public
  USING ((company_id IN ( SELECT profiles.company_id
   FROM profiles
  WHERE ((profiles.id = auth.uid()) AND (profiles.role = ANY (ARRAY['admin'::text, 'gestor'::text]))))));
DROP POLICY IF EXISTS "users see own company" ON public.companies;
CREATE POLICY "users see own company" ON public.companies AS PERMISSIVE FOR SELECT TO public
  USING ((id = ( SELECT profiles.company_id
   FROM profiles
  WHERE (profiles.id = auth.uid()))));
DROP POLICY IF EXISTS "managers see company change events" ON public.company_change_events;
CREATE POLICY "managers see company change events" ON public.company_change_events AS PERMISSIVE FOR SELECT TO public
  USING (((company_id = ( SELECT profiles.company_id
   FROM profiles
  WHERE (profiles.id = auth.uid()))) AND (( SELECT profiles.role
   FROM profiles
  WHERE (profiles.id = auth.uid())) = ANY (ARRAY['admin'::text, 'gestor'::text]))));
DROP POLICY IF EXISTS "contracts_manager_select" ON public.contracts;
CREATE POLICY "contracts_manager_select" ON public.contracts AS PERMISSIVE FOR SELECT TO public
  USING (((company_id = get_my_company_id()) AND (( SELECT profiles.role
   FROM profiles
  WHERE (profiles.id = auth.uid())) = ANY (ARRAY['admin'::text, 'gestor'::text]))));
DROP POLICY IF EXISTS "daily_clocks_own" ON public.daily_clocks;
CREATE POLICY "daily_clocks_own" ON public.daily_clocks AS PERMISSIVE FOR ALL TO public
  USING ((collaborator_id = auth.uid()))
  WITH CHECK ((collaborator_id = auth.uid()));
DROP POLICY IF EXISTS "expense_categories_read" ON public.expense_categories;
CREATE POLICY "expense_categories_read" ON public.expense_categories AS PERMISSIVE FOR SELECT TO public
  USING ((company_id IN ( SELECT profiles.company_id
   FROM profiles
  WHERE (profiles.id = auth.uid()))));
DROP POLICY IF EXISTS "expense_categories_write" ON public.expense_categories;
CREATE POLICY "expense_categories_write" ON public.expense_categories AS PERMISSIVE FOR ALL TO public
  USING ((company_id IN ( SELECT profiles.company_id
   FROM profiles
  WHERE ((profiles.id = auth.uid()) AND (profiles.role = ANY (ARRAY['admin'::text, 'gestor'::text]))))));
DROP POLICY IF EXISTS "financial_periods_read" ON public.financial_periods;
CREATE POLICY "financial_periods_read" ON public.financial_periods AS PERMISSIVE FOR SELECT TO public
  USING ((company_id IN ( SELECT profiles.company_id
   FROM profiles
  WHERE (profiles.id = auth.uid()))));
DROP POLICY IF EXISTS "financial_periods_write" ON public.financial_periods;
CREATE POLICY "financial_periods_write" ON public.financial_periods AS PERMISSIVE FOR ALL TO public
  USING ((company_id IN ( SELECT profiles.company_id
   FROM profiles
  WHERE ((profiles.id = auth.uid()) AND (profiles.role = ANY (ARRAY['admin'::text, 'gestor'::text]))))));
DROP POLICY IF EXISTS "company members manage fixed variable payments" ON public.fixed_variable_payments;
CREATE POLICY "company members manage fixed variable payments" ON public.fixed_variable_payments AS PERMISSIVE FOR ALL TO public
  USING ((company_id IN ( SELECT profiles.company_id
   FROM profiles
  WHERE (profiles.id = auth.uid()))));
DROP POLICY IF EXISTS "managers manage invoice items" ON public.invoice_items;
CREATE POLICY "managers manage invoice items" ON public.invoice_items AS PERMISSIVE FOR ALL TO public
  USING (((( SELECT invoices.company_id
   FROM invoices
  WHERE (invoices.id = invoice_items.invoice_id)) = ( SELECT profiles.company_id
   FROM profiles
  WHERE (profiles.id = auth.uid()))) AND (( SELECT profiles.role
   FROM profiles
  WHERE (profiles.id = auth.uid())) = ANY (ARRAY['admin'::text, 'gestor'::text]))));
DROP POLICY IF EXISTS "managers manage invoices" ON public.invoices;
CREATE POLICY "managers manage invoices" ON public.invoices AS PERMISSIVE FOR ALL TO public
  USING (((company_id = ( SELECT profiles.company_id
   FROM profiles
  WHERE (profiles.id = auth.uid()))) AND (( SELECT profiles.role
   FROM profiles
  WHERE (profiles.id = auth.uid())) = ANY (ARRAY['admin'::text, 'gestor'::text]))));
DROP POLICY IF EXISTS "locations_collaborator_select" ON public.locations;
CREATE POLICY "locations_collaborator_select" ON public.locations AS PERMISSIVE FOR SELECT TO public
  USING (((company_id = get_my_company_id()) AND (( SELECT profiles.role
   FROM profiles
  WHERE (profiles.id = auth.uid())) <> ALL (ARRAY['admin'::text, 'gestor'::text])) AND (EXISTS ( SELECT 1
   FROM services s
  WHERE ((s.location_id = locations.id) AND can_access_service(s.id))))));
DROP POLICY IF EXISTS "management_tasks_admin" ON public.management_tasks;
CREATE POLICY "management_tasks_admin" ON public.management_tasks AS PERMISSIVE FOR ALL TO public
  USING (((company_id = get_my_company_id()) AND (( SELECT profiles.role
   FROM profiles
  WHERE (profiles.id = auth.uid())) = ANY (ARRAY['admin'::text, 'gestor'::text]))))
  WITH CHECK (((company_id = get_my_company_id()) AND (( SELECT profiles.role
   FROM profiles
  WHERE (profiles.id = auth.uid())) = ANY (ARRAY['admin'::text, 'gestor'::text]))));
DROP POLICY IF EXISTS "managers create notifications" ON public.notifications;
CREATE POLICY "managers create notifications" ON public.notifications AS PERMISSIVE FOR INSERT TO public
  WITH CHECK ((company_id = ( SELECT profiles.company_id
   FROM profiles
  WHERE (profiles.id = auth.uid()))));
DROP POLICY IF EXISTS "users see own notifications" ON public.notifications;
CREATE POLICY "users see own notifications" ON public.notifications AS PERMISSIVE FOR ALL TO public
  USING ((user_id = auth.uid()));
DROP POLICY IF EXISTS "collaborators see own payroll" ON public.payroll_records;
CREATE POLICY "collaborators see own payroll" ON public.payroll_records AS PERMISSIVE FOR SELECT TO public
  USING ((collaborator_id = auth.uid()));
DROP POLICY IF EXISTS "managers manage payroll" ON public.payroll_records;
CREATE POLICY "managers manage payroll" ON public.payroll_records AS PERMISSIVE FOR ALL TO public
  USING (((company_id = ( SELECT profiles.company_id
   FROM profiles
  WHERE (profiles.id = auth.uid()))) AND (( SELECT profiles.role
   FROM profiles
  WHERE (profiles.id = auth.uid())) = ANY (ARRAY['admin'::text, 'gestor'::text]))));
DROP POLICY IF EXISTS "read own platform admin row" ON public.platform_admins;
CREATE POLICY "read own platform admin row" ON public.platform_admins AS PERMISSIVE FOR SELECT TO public
  USING ((profile_id = auth.uid()));
DROP POLICY IF EXISTS "users manage own push subs" ON public.push_subscriptions;
CREATE POLICY "users manage own push subs" ON public.push_subscriptions AS PERMISSIVE FOR ALL TO public
  USING ((user_id = auth.uid()));
DROP POLICY IF EXISTS "service_photos_manager_read" ON public.service_photos;
CREATE POLICY "service_photos_manager_read" ON public.service_photos AS PERMISSIVE FOR SELECT TO public
  USING (((company_id = ( SELECT profiles.company_id
   FROM profiles
  WHERE (profiles.id = auth.uid()))) AND (( SELECT profiles.role
   FROM profiles
  WHERE (profiles.id = auth.uid())) = ANY (ARRAY['admin'::text, 'gestor'::text]))));
DROP POLICY IF EXISTS "service_photos_own_read" ON public.service_photos;
CREATE POLICY "service_photos_own_read" ON public.service_photos AS PERMISSIVE FOR SELECT TO public
  USING ((collaborator_id = auth.uid()));
DROP POLICY IF EXISTS "reinforcements_select" ON public.service_reinforcements;
CREATE POLICY "reinforcements_select" ON public.service_reinforcements AS PERMISSIVE FOR SELECT TO public
  USING (((collaborator_id = auth.uid()) OR (get_service_company_id(service_id) = get_my_company_id())));
DROP POLICY IF EXISTS "company team members" ON public.team_members;
CREATE POLICY "company team members" ON public.team_members AS PERMISSIVE FOR ALL TO public
  USING ((( SELECT teams.company_id
   FROM teams
  WHERE (teams.id = team_members.team_id)) = ( SELECT profiles.company_id
   FROM profiles
  WHERE (profiles.id = auth.uid()))));
DROP POLICY IF EXISTS "company teams" ON public.teams;
CREATE POLICY "company teams" ON public.teams AS PERMISSIVE FOR ALL TO public
  USING ((company_id = ( SELECT profiles.company_id
   FROM profiles
  WHERE (profiles.id = auth.uid()))));
DROP POLICY IF EXISTS "collaborators create own timesheets" ON public.timesheets;
CREATE POLICY "collaborators create own timesheets" ON public.timesheets AS PERMISSIVE FOR INSERT TO public
  WITH CHECK ((collaborator_id = auth.uid()));
DROP POLICY IF EXISTS "collaborators see own timesheets" ON public.timesheets;
CREATE POLICY "collaborators see own timesheets" ON public.timesheets AS PERMISSIVE FOR SELECT TO public
  USING ((collaborator_id = auth.uid()));
DROP POLICY IF EXISTS "managers see company timesheets" ON public.timesheets;
CREATE POLICY "managers see company timesheets" ON public.timesheets AS PERMISSIVE FOR ALL TO public
  USING (((company_id = ( SELECT profiles.company_id
   FROM profiles
  WHERE (profiles.id = auth.uid()))) AND (( SELECT profiles.role
   FROM profiles
  WHERE (profiles.id = auth.uid())) = ANY (ARRAY['admin'::text, 'gestor'::text]))));
DROP POLICY IF EXISTS "timesheets_collaborator_insert" ON public.timesheets;
CREATE POLICY "timesheets_collaborator_insert" ON public.timesheets AS PERMISSIVE FOR INSERT TO public
  WITH CHECK ((collaborator_id = auth.uid()));
DROP POLICY IF EXISTS "timesheets_collaborator_update" ON public.timesheets;
CREATE POLICY "timesheets_collaborator_update" ON public.timesheets AS PERMISSIVE FOR UPDATE TO public
  USING ((collaborator_id = auth.uid()));
DROP POLICY IF EXISTS "timesheets_manager_select" ON public.timesheets;
CREATE POLICY "timesheets_manager_select" ON public.timesheets AS PERMISSIVE FOR SELECT TO public
  USING (((company_id = get_my_company_id()) AND (( SELECT profiles.role
   FROM profiles
  WHERE (profiles.id = auth.uid())) = ANY (ARRAY['admin'::text, 'gestor'::text]))));
DROP POLICY IF EXISTS "timesheets_own_select" ON public.timesheets;
CREATE POLICY "timesheets_own_select" ON public.timesheets AS PERMISSIVE FOR SELECT TO public
  USING ((collaborator_id = auth.uid()));
DROP POLICY IF EXISTS "vacation_requests_insert" ON public.vacation_requests;
CREATE POLICY "vacation_requests_insert" ON public.vacation_requests AS PERMISSIVE FOR INSERT TO public
  WITH CHECK (((collaborator_id = auth.uid()) AND (company_id = get_my_company_id())));
DROP POLICY IF EXISTS "vacation_requests_select" ON public.vacation_requests;
CREATE POLICY "vacation_requests_select" ON public.vacation_requests AS PERMISSIVE FOR SELECT TO public
  USING (((collaborator_id = auth.uid()) OR ((company_id = get_my_company_id()) AND (get_my_role() = ANY (ARRAY['admin'::text, 'gestor'::text])))));
DROP POLICY IF EXISTS "vehicle_allocations_company_isolation" ON public.vehicle_allocations;
CREATE POLICY "vehicle_allocations_company_isolation" ON public.vehicle_allocations AS PERMISSIVE FOR ALL TO public
  USING ((company_id IN ( SELECT profiles.company_id
   FROM profiles
  WHERE (profiles.id = auth.uid()))));
DROP POLICY IF EXISTS "vehicle_allocations_delete" ON public.vehicle_allocations;
CREATE POLICY "vehicle_allocations_delete" ON public.vehicle_allocations AS PERMISSIVE FOR DELETE TO public
  USING ((company_id IN ( SELECT profiles.company_id
   FROM profiles
  WHERE ((profiles.id = auth.uid()) AND (profiles.role = ANY (ARRAY['admin'::text, 'gestor'::text]))))));
DROP POLICY IF EXISTS "vehicle_allocations_insert" ON public.vehicle_allocations;
CREATE POLICY "vehicle_allocations_insert" ON public.vehicle_allocations AS PERMISSIVE FOR INSERT TO public
  WITH CHECK ((company_id IN ( SELECT profiles.company_id
   FROM profiles
  WHERE ((profiles.id = auth.uid()) AND (profiles.role = ANY (ARRAY['admin'::text, 'gestor'::text]))))));
DROP POLICY IF EXISTS "vehicle_allocations_update" ON public.vehicle_allocations;
CREATE POLICY "vehicle_allocations_update" ON public.vehicle_allocations AS PERMISSIVE FOR UPDATE TO public
  USING ((company_id IN ( SELECT profiles.company_id
   FROM profiles
  WHERE ((profiles.id = auth.uid()) AND (profiles.role = ANY (ARRAY['admin'::text, 'gestor'::text]))))));
DROP POLICY IF EXISTS "vehicles_company_isolation" ON public.vehicles;
CREATE POLICY "vehicles_company_isolation" ON public.vehicles AS PERMISSIVE FOR ALL TO public
  USING ((company_id IN ( SELECT profiles.company_id
   FROM profiles
  WHERE (profiles.id = auth.uid()))));
DROP POLICY IF EXISTS "vehicles_delete" ON public.vehicles;
CREATE POLICY "vehicles_delete" ON public.vehicles AS PERMISSIVE FOR DELETE TO public
  USING ((company_id IN ( SELECT profiles.company_id
   FROM profiles
  WHERE ((profiles.id = auth.uid()) AND (profiles.role = ANY (ARRAY['admin'::text, 'gestor'::text]))))));
DROP POLICY IF EXISTS "vehicles_insert" ON public.vehicles;
CREATE POLICY "vehicles_insert" ON public.vehicles AS PERMISSIVE FOR INSERT TO public
  WITH CHECK ((company_id IN ( SELECT profiles.company_id
   FROM profiles
  WHERE ((profiles.id = auth.uid()) AND (profiles.role = ANY (ARRAY['admin'::text, 'gestor'::text]))))));
DROP POLICY IF EXISTS "vehicles_update" ON public.vehicles;
CREATE POLICY "vehicles_update" ON public.vehicles AS PERMISSIVE FOR UPDATE TO public
  USING ((company_id IN ( SELECT profiles.company_id
   FROM profiles
  WHERE ((profiles.id = auth.uid()) AND (profiles.role = ANY (ARRAY['admin'::text, 'gestor'::text]))))));

COMMIT;

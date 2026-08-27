-- ============================================================================
-- PROVISIONAL — identidade de colaborador: RESOLVER NAS POLÍTICAS (LOTE 2)
-- ============================================================================
--
-- 🔴 NÃO APLICADA PELO RUNNER. Vive em `supabase/migrations/draft/`.
--    MIGRATION_NUMBER_FINAL = UNASSIGNED
--
-- ---------------------------------------------------------------------------
-- Porque é que este ficheiro cresceu de 8 políticas para 67
-- ---------------------------------------------------------------------------
--
-- A versão anterior migrava oito políticas. Um preflight read-only contra a
-- base real mostrou que isso era 12% do problema: **71 das 93 políticas do
-- schema `public` resolvem a identidade por `auth.uid()`**, em 39 tabelas.
--
-- Nenhuma delas usa `auth.uid()` com outro significado. Foi verificado uma a
-- uma: todas as 71 comparam `auth.uid()` com um id de perfil, seja
-- directamente (`collaborator_id = auth.uid()`) seja por subconsulta
-- (`SELECT role FROM profiles WHERE id = auth.uid()`). A transformação é, por
-- isso, uniforme e mecânica: `auth.uid()` → `public.get_my_profile_id()`.
--
-- ---------------------------------------------------------------------------
-- Porque é que isto não parte ninguém que hoje funciona
-- ---------------------------------------------------------------------------
--
-- O EXPAND preenche `auth_user_id = id` em todas as pessoas que já têm conta.
-- Para essas — as 30 que existem hoje — `get_my_profile_id()` devolve
-- **exactamente** `auth.uid()`, e cada política reescrita avalia igual à
-- anterior, expressão por expressão. A diferença só aparece para quem tiver
-- uma conta criada pelo fluxo novo, onde `auth.users.id` é gerado pelo GoTrue
-- e não coincide com o id da pessoa. Para esses, a versão antiga destas
-- políticas devolvia falso — o colaborador não conseguia picar o ponto, e um
-- gestor novo perdia o acesso de gestão.
--
-- ---------------------------------------------------------------------------
-- Duas políticas órfãs, e porque são apagadas no LOTE 1
-- ---------------------------------------------------------------------------
--
-- `users see own profile` e `users see company profiles` existem na base e
-- **não existem em nenhuma migration versionada**: são restos da 002 que uma
-- substituição posterior não apagou por usar nomes diferentes — o mesmo
-- padrão que causou a recursão de RLS corrigida pela 018. Como o PostgreSQL
-- combina políticas permissivas por OR, deixá-las de pé mantinha um caminho
-- paralelo com a equivalência antiga, e a guarda do resolver deixava de ser o
-- único caminho. São tratadas no LOTE 1, junto com o resto de `profiles`.
-- ============================================================================

BEGIN;

-- ─── Pré-condições ─────────────────────────────────────────────────────────
DO $pre$
BEGIN
  IF to_regprocedure('public.get_my_profile_id()') IS NULL THEN
    RAISE EXCEPTION 'PRECONDICAO: get_my_profile_id() não existe — aplicar o EXPAND (SQL 1) primeiro.';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns
                  WHERE table_schema='public' AND table_name='profiles'
                    AND column_name='auth_user_id') THEN
    RAISE EXCEPTION 'PRECONDICAO: profiles.auth_user_id não existe — aplicar o EXPAND (SQL 1) primeiro.';
  END IF;
END $pre$;

-- ─── absences ──────────────────────────────────────────────────────────────
DROP POLICY IF EXISTS "absences_manager_select" ON public.absences;
CREATE POLICY "absences_manager_select" ON public.absences AS PERMISSIVE FOR SELECT TO public
  USING (((company_id = get_my_company_id()) AND (( SELECT profiles.role
   FROM profiles
  WHERE (profiles.id = public.get_my_profile_id())) = ANY (ARRAY['admin'::text, 'gestor'::text]))));
DROP POLICY IF EXISTS "absences_own_select" ON public.absences;
CREATE POLICY "absences_own_select" ON public.absences AS PERMISSIVE FOR SELECT TO public
  USING ((collaborator_id = public.get_my_profile_id()));

-- ─── app_notice_reads ──────────────────────────────────────────────────────
DROP POLICY IF EXISTS "read own reads" ON public.app_notice_reads;
CREATE POLICY "read own reads" ON public.app_notice_reads AS PERMISSIVE FOR SELECT TO public
  USING ((profile_id = public.get_my_profile_id()));

-- ─── attachments ───────────────────────────────────────────────────────────
DROP POLICY IF EXISTS "company members delete attachments" ON public.attachments;
CREATE POLICY "company members delete attachments" ON public.attachments AS PERMISSIVE FOR DELETE TO public
  USING ((company_id IN ( SELECT profiles.company_id
   FROM profiles
  WHERE (profiles.id = public.get_my_profile_id()))));
DROP POLICY IF EXISTS "company members insert attachments" ON public.attachments;
CREATE POLICY "company members insert attachments" ON public.attachments AS PERMISSIVE FOR INSERT TO public
  WITH CHECK ((company_id IN ( SELECT profiles.company_id
   FROM profiles
  WHERE (profiles.id = public.get_my_profile_id()))));
DROP POLICY IF EXISTS "company members read attachments" ON public.attachments;
CREATE POLICY "company members read attachments" ON public.attachments AS PERMISSIVE FOR SELECT TO public
  USING ((company_id IN ( SELECT profiles.company_id
   FROM profiles
  WHERE (profiles.id = public.get_my_profile_id()))));

-- ─── audit_logs ────────────────────────────────────────────────────────────
DROP POLICY IF EXISTS "audit_logs_admin_read" ON public.audit_logs;
CREATE POLICY "audit_logs_admin_read" ON public.audit_logs AS PERMISSIVE FOR SELECT TO public
  USING (((company_id = ( SELECT profiles.company_id
   FROM profiles
  WHERE (profiles.id = public.get_my_profile_id()))) AND (( SELECT profiles.role
   FROM profiles
  WHERE (profiles.id = public.get_my_profile_id())) = ANY (ARRAY['admin'::text, 'gestor'::text]))));

-- ─── background_jobs ───────────────────────────────────────────────────────
DROP POLICY IF EXISTS "background_jobs_admin_read" ON public.background_jobs;
CREATE POLICY "background_jobs_admin_read" ON public.background_jobs AS PERMISSIVE FOR SELECT TO public
  USING (((( SELECT profiles.role
   FROM profiles
  WHERE (profiles.id = public.get_my_profile_id())) = ANY (ARRAY['admin'::text, 'gestor'::text])) AND ((company_id IS NULL) OR (company_id = ( SELECT profiles.company_id
   FROM profiles
  WHERE (profiles.id = public.get_my_profile_id()))))));

-- ─── bank_accounts ─────────────────────────────────────────────────────────
DROP POLICY IF EXISTS "bank_accounts_admin" ON public.bank_accounts;
CREATE POLICY "bank_accounts_admin" ON public.bank_accounts AS PERMISSIVE FOR ALL TO public
  USING (((company_id = get_my_company_id()) AND (( SELECT profiles.role
   FROM profiles
  WHERE (profiles.id = public.get_my_profile_id())) = ANY (ARRAY['admin'::text, 'gestor'::text]))))
  WITH CHECK (((company_id = get_my_company_id()) AND (( SELECT profiles.role
   FROM profiles
  WHERE (profiles.id = public.get_my_profile_id())) = ANY (ARRAY['admin'::text, 'gestor'::text]))));

-- ─── bank_reconciliation_matches ───────────────────────────────────────────
DROP POLICY IF EXISTS "bank_reconciliation_matches_admin" ON public.bank_reconciliation_matches;
CREATE POLICY "bank_reconciliation_matches_admin" ON public.bank_reconciliation_matches AS PERMISSIVE FOR ALL TO public
  USING (((company_id = get_my_company_id()) AND (( SELECT profiles.role
   FROM profiles
  WHERE (profiles.id = public.get_my_profile_id())) = ANY (ARRAY['admin'::text, 'gestor'::text]))))
  WITH CHECK (((company_id = get_my_company_id()) AND (( SELECT profiles.role
   FROM profiles
  WHERE (profiles.id = public.get_my_profile_id())) = ANY (ARRAY['admin'::text, 'gestor'::text]))));

-- ─── bank_statement_imports ────────────────────────────────────────────────
DROP POLICY IF EXISTS "bank_statement_imports_admin" ON public.bank_statement_imports;
CREATE POLICY "bank_statement_imports_admin" ON public.bank_statement_imports AS PERMISSIVE FOR ALL TO public
  USING (((company_id = get_my_company_id()) AND (( SELECT profiles.role
   FROM profiles
  WHERE (profiles.id = public.get_my_profile_id())) = ANY (ARRAY['admin'::text, 'gestor'::text]))))
  WITH CHECK (((company_id = get_my_company_id()) AND (( SELECT profiles.role
   FROM profiles
  WHERE (profiles.id = public.get_my_profile_id())) = ANY (ARRAY['admin'::text, 'gestor'::text]))));

-- ─── bank_transactions ─────────────────────────────────────────────────────
DROP POLICY IF EXISTS "bank_transactions_admin" ON public.bank_transactions;
CREATE POLICY "bank_transactions_admin" ON public.bank_transactions AS PERMISSIVE FOR ALL TO public
  USING (((company_id = get_my_company_id()) AND (( SELECT profiles.role
   FROM profiles
  WHERE (profiles.id = public.get_my_profile_id())) = ANY (ARRAY['admin'::text, 'gestor'::text]))))
  WITH CHECK (((company_id = get_my_company_id()) AND (( SELECT profiles.role
   FROM profiles
  WHERE (profiles.id = public.get_my_profile_id())) = ANY (ARRAY['admin'::text, 'gestor'::text]))));

-- ─── building_cards ────────────────────────────────────────────────────────
DROP POLICY IF EXISTS "building_cards_company_isolation" ON public.building_cards;
CREATE POLICY "building_cards_company_isolation" ON public.building_cards AS PERMISSIVE FOR ALL TO public
  USING ((company_id IN ( SELECT profiles.company_id
   FROM profiles
  WHERE (profiles.id = public.get_my_profile_id()))));
DROP POLICY IF EXISTS "building_cards_delete" ON public.building_cards;
CREATE POLICY "building_cards_delete" ON public.building_cards AS PERMISSIVE FOR DELETE TO public
  USING ((company_id IN ( SELECT profiles.company_id
   FROM profiles
  WHERE ((profiles.id = public.get_my_profile_id()) AND (profiles.role = ANY (ARRAY['admin'::text, 'gestor'::text]))))));
DROP POLICY IF EXISTS "building_cards_insert" ON public.building_cards;
CREATE POLICY "building_cards_insert" ON public.building_cards AS PERMISSIVE FOR INSERT TO public
  WITH CHECK ((company_id IN ( SELECT profiles.company_id
   FROM profiles
  WHERE ((profiles.id = public.get_my_profile_id()) AND (profiles.role = ANY (ARRAY['admin'::text, 'gestor'::text]))))));
DROP POLICY IF EXISTS "building_cards_update" ON public.building_cards;
CREATE POLICY "building_cards_update" ON public.building_cards AS PERMISSIVE FOR UPDATE TO public
  USING ((company_id IN ( SELECT profiles.company_id
   FROM profiles
  WHERE ((profiles.id = public.get_my_profile_id()) AND (profiles.role = ANY (ARRAY['admin'::text, 'gestor'::text]))))));

-- ─── cash_flow_entries ─────────────────────────────────────────────────────
DROP POLICY IF EXISTS "cash_flow_admin" ON public.cash_flow_entries;
CREATE POLICY "cash_flow_admin" ON public.cash_flow_entries AS PERMISSIVE FOR ALL TO public
  USING (((company_id = get_my_company_id()) AND (( SELECT profiles.role
   FROM profiles
  WHERE (profiles.id = public.get_my_profile_id())) = ANY (ARRAY['admin'::text, 'gestor'::text]))))
  WITH CHECK (((company_id = get_my_company_id()) AND (( SELECT profiles.role
   FROM profiles
  WHERE (profiles.id = public.get_my_profile_id())) = ANY (ARRAY['admin'::text, 'gestor'::text]))));

-- ─── client_notifications ──────────────────────────────────────────────────
DROP POLICY IF EXISTS "managers manage client notifications" ON public.client_notifications;
CREATE POLICY "managers manage client notifications" ON public.client_notifications AS PERMISSIVE FOR ALL TO public
  USING (((company_id = ( SELECT profiles.company_id
   FROM profiles
  WHERE (profiles.id = public.get_my_profile_id()))) AND (( SELECT profiles.role
   FROM profiles
  WHERE (profiles.id = public.get_my_profile_id())) = ANY (ARRAY['admin'::text, 'gestor'::text]))));

-- ─── clients ───────────────────────────────────────────────────────────────
DROP POLICY IF EXISTS "clients_collaborator_select" ON public.clients;
CREATE POLICY "clients_collaborator_select" ON public.clients AS PERMISSIVE FOR SELECT TO public
  USING (((company_id = get_my_company_id()) AND (( SELECT profiles.role
   FROM profiles
  WHERE (profiles.id = public.get_my_profile_id())) <> ALL (ARRAY['admin'::text, 'gestor'::text])) AND (EXISTS ( SELECT 1
   FROM (locations l
     JOIN services s ON ((s.location_id = l.id)))
  WHERE ((l.client_id = clients.id) AND can_access_service(s.id))))));

-- ─── collaborator_documents ────────────────────────────────────────────────
DROP POLICY IF EXISTS "colaboradoras submetem relatórios de avaria" ON public.collaborator_documents;
CREATE POLICY "colaboradoras submetem relatórios de avaria" ON public.collaborator_documents AS PERMISSIVE FOR INSERT TO public
  WITH CHECK (((collaborator_id = public.get_my_profile_id()) AND (category = 'avaria'::text) AND (visible_to_collaborator = true) AND (uploaded_by_role = 'colaboradora'::text)));
DROP POLICY IF EXISTS "colaboradoras veem os seus docs visíveis" ON public.collaborator_documents;
CREATE POLICY "colaboradoras veem os seus docs visíveis" ON public.collaborator_documents AS PERMISSIVE FOR SELECT TO public
  USING (((collaborator_id = public.get_my_profile_id()) AND (visible_to_collaborator = true)));
DROP POLICY IF EXISTS "gestores gerem documentos da empresa" ON public.collaborator_documents;
CREATE POLICY "gestores gerem documentos da empresa" ON public.collaborator_documents AS PERMISSIVE FOR ALL TO public
  USING ((company_id IN ( SELECT profiles.company_id
   FROM profiles
  WHERE ((profiles.id = public.get_my_profile_id()) AND (profiles.role = ANY (ARRAY['gestor'::text, 'admin'::text]))))))
  WITH CHECK ((company_id IN ( SELECT profiles.company_id
   FROM profiles
  WHERE ((profiles.id = public.get_my_profile_id()) AND (profiles.role = ANY (ARRAY['gestor'::text, 'admin'::text]))))));

-- ─── collaborator_ride_assignments ─────────────────────────────────────────
DROP POLICY IF EXISTS "collaborator_ride_company_isolation" ON public.collaborator_ride_assignments;
CREATE POLICY "collaborator_ride_company_isolation" ON public.collaborator_ride_assignments AS PERMISSIVE FOR ALL TO public
  USING ((company_id IN ( SELECT profiles.company_id
   FROM profiles
  WHERE (profiles.id = public.get_my_profile_id()))));
DROP POLICY IF EXISTS "collaborator_ride_delete" ON public.collaborator_ride_assignments;
CREATE POLICY "collaborator_ride_delete" ON public.collaborator_ride_assignments AS PERMISSIVE FOR DELETE TO public
  USING ((company_id IN ( SELECT profiles.company_id
   FROM profiles
  WHERE ((profiles.id = public.get_my_profile_id()) AND (profiles.role = ANY (ARRAY['admin'::text, 'gestor'::text]))))));
DROP POLICY IF EXISTS "collaborator_ride_insert" ON public.collaborator_ride_assignments;
CREATE POLICY "collaborator_ride_insert" ON public.collaborator_ride_assignments AS PERMISSIVE FOR INSERT TO public
  WITH CHECK ((company_id IN ( SELECT profiles.company_id
   FROM profiles
  WHERE ((profiles.id = public.get_my_profile_id()) AND (profiles.role = ANY (ARRAY['admin'::text, 'gestor'::text]))))));
DROP POLICY IF EXISTS "collaborator_ride_update" ON public.collaborator_ride_assignments;
CREATE POLICY "collaborator_ride_update" ON public.collaborator_ride_assignments AS PERMISSIVE FOR UPDATE TO public
  USING ((company_id IN ( SELECT profiles.company_id
   FROM profiles
  WHERE ((profiles.id = public.get_my_profile_id()) AND (profiles.role = ANY (ARRAY['admin'::text, 'gestor'::text]))))));

-- ─── companies ─────────────────────────────────────────────────────────────
DROP POLICY IF EXISTS "users see own company" ON public.companies;
CREATE POLICY "users see own company" ON public.companies AS PERMISSIVE FOR SELECT TO public
  USING ((id = ( SELECT profiles.company_id
   FROM profiles
  WHERE (profiles.id = public.get_my_profile_id()))));

-- ─── company_change_events ─────────────────────────────────────────────────
DROP POLICY IF EXISTS "managers see company change events" ON public.company_change_events;
CREATE POLICY "managers see company change events" ON public.company_change_events AS PERMISSIVE FOR SELECT TO public
  USING (((company_id = ( SELECT profiles.company_id
   FROM profiles
  WHERE (profiles.id = public.get_my_profile_id()))) AND (( SELECT profiles.role
   FROM profiles
  WHERE (profiles.id = public.get_my_profile_id())) = ANY (ARRAY['admin'::text, 'gestor'::text]))));

-- ─── contracts ─────────────────────────────────────────────────────────────
DROP POLICY IF EXISTS "contracts_manager_select" ON public.contracts;
CREATE POLICY "contracts_manager_select" ON public.contracts AS PERMISSIVE FOR SELECT TO public
  USING (((company_id = get_my_company_id()) AND (( SELECT profiles.role
   FROM profiles
  WHERE (profiles.id = public.get_my_profile_id())) = ANY (ARRAY['admin'::text, 'gestor'::text]))));

-- ─── daily_clocks ──────────────────────────────────────────────────────────
DROP POLICY IF EXISTS "daily_clocks_own" ON public.daily_clocks;
CREATE POLICY "daily_clocks_own" ON public.daily_clocks AS PERMISSIVE FOR ALL TO public
  USING ((collaborator_id = public.get_my_profile_id()))
  WITH CHECK ((collaborator_id = public.get_my_profile_id()));

-- ─── expense_categories ────────────────────────────────────────────────────
DROP POLICY IF EXISTS "expense_categories_read" ON public.expense_categories;
CREATE POLICY "expense_categories_read" ON public.expense_categories AS PERMISSIVE FOR SELECT TO public
  USING ((company_id IN ( SELECT profiles.company_id
   FROM profiles
  WHERE (profiles.id = public.get_my_profile_id()))));
DROP POLICY IF EXISTS "expense_categories_write" ON public.expense_categories;
CREATE POLICY "expense_categories_write" ON public.expense_categories AS PERMISSIVE FOR ALL TO public
  USING ((company_id IN ( SELECT profiles.company_id
   FROM profiles
  WHERE ((profiles.id = public.get_my_profile_id()) AND (profiles.role = ANY (ARRAY['admin'::text, 'gestor'::text]))))));

-- ─── financial_periods ─────────────────────────────────────────────────────
DROP POLICY IF EXISTS "financial_periods_read" ON public.financial_periods;
CREATE POLICY "financial_periods_read" ON public.financial_periods AS PERMISSIVE FOR SELECT TO public
  USING ((company_id IN ( SELECT profiles.company_id
   FROM profiles
  WHERE (profiles.id = public.get_my_profile_id()))));
DROP POLICY IF EXISTS "financial_periods_write" ON public.financial_periods;
CREATE POLICY "financial_periods_write" ON public.financial_periods AS PERMISSIVE FOR ALL TO public
  USING ((company_id IN ( SELECT profiles.company_id
   FROM profiles
  WHERE ((profiles.id = public.get_my_profile_id()) AND (profiles.role = ANY (ARRAY['admin'::text, 'gestor'::text]))))));

-- ─── fixed_variable_payments ───────────────────────────────────────────────
DROP POLICY IF EXISTS "company members manage fixed variable payments" ON public.fixed_variable_payments;
CREATE POLICY "company members manage fixed variable payments" ON public.fixed_variable_payments AS PERMISSIVE FOR ALL TO public
  USING ((company_id IN ( SELECT profiles.company_id
   FROM profiles
  WHERE (profiles.id = public.get_my_profile_id()))));

-- ─── invoice_items ─────────────────────────────────────────────────────────
DROP POLICY IF EXISTS "managers manage invoice items" ON public.invoice_items;
CREATE POLICY "managers manage invoice items" ON public.invoice_items AS PERMISSIVE FOR ALL TO public
  USING (((( SELECT invoices.company_id
   FROM invoices
  WHERE (invoices.id = invoice_items.invoice_id)) = ( SELECT profiles.company_id
   FROM profiles
  WHERE (profiles.id = public.get_my_profile_id()))) AND (( SELECT profiles.role
   FROM profiles
  WHERE (profiles.id = public.get_my_profile_id())) = ANY (ARRAY['admin'::text, 'gestor'::text]))));

-- ─── invoices ──────────────────────────────────────────────────────────────
DROP POLICY IF EXISTS "managers manage invoices" ON public.invoices;
CREATE POLICY "managers manage invoices" ON public.invoices AS PERMISSIVE FOR ALL TO public
  USING (((company_id = ( SELECT profiles.company_id
   FROM profiles
  WHERE (profiles.id = public.get_my_profile_id()))) AND (( SELECT profiles.role
   FROM profiles
  WHERE (profiles.id = public.get_my_profile_id())) = ANY (ARRAY['admin'::text, 'gestor'::text]))));

-- ─── locations ─────────────────────────────────────────────────────────────
DROP POLICY IF EXISTS "locations_collaborator_select" ON public.locations;
CREATE POLICY "locations_collaborator_select" ON public.locations AS PERMISSIVE FOR SELECT TO public
  USING (((company_id = get_my_company_id()) AND (( SELECT profiles.role
   FROM profiles
  WHERE (profiles.id = public.get_my_profile_id())) <> ALL (ARRAY['admin'::text, 'gestor'::text])) AND (EXISTS ( SELECT 1
   FROM services s
  WHERE ((s.location_id = locations.id) AND can_access_service(s.id))))));

-- ─── management_tasks ──────────────────────────────────────────────────────
DROP POLICY IF EXISTS "management_tasks_admin" ON public.management_tasks;
CREATE POLICY "management_tasks_admin" ON public.management_tasks AS PERMISSIVE FOR ALL TO public
  USING (((company_id = get_my_company_id()) AND (( SELECT profiles.role
   FROM profiles
  WHERE (profiles.id = public.get_my_profile_id())) = ANY (ARRAY['admin'::text, 'gestor'::text]))))
  WITH CHECK (((company_id = get_my_company_id()) AND (( SELECT profiles.role
   FROM profiles
  WHERE (profiles.id = public.get_my_profile_id())) = ANY (ARRAY['admin'::text, 'gestor'::text]))));

-- ─── notifications ─────────────────────────────────────────────────────────
DROP POLICY IF EXISTS "managers create notifications" ON public.notifications;
CREATE POLICY "managers create notifications" ON public.notifications AS PERMISSIVE FOR INSERT TO public
  WITH CHECK ((company_id = ( SELECT profiles.company_id
   FROM profiles
  WHERE (profiles.id = public.get_my_profile_id()))));
DROP POLICY IF EXISTS "users see own notifications" ON public.notifications;
CREATE POLICY "users see own notifications" ON public.notifications AS PERMISSIVE FOR ALL TO public
  USING ((user_id = public.get_my_profile_id()));

-- ─── payroll_records ───────────────────────────────────────────────────────
DROP POLICY IF EXISTS "collaborators see own payroll" ON public.payroll_records;
CREATE POLICY "collaborators see own payroll" ON public.payroll_records AS PERMISSIVE FOR SELECT TO public
  USING ((collaborator_id = public.get_my_profile_id()));
DROP POLICY IF EXISTS "managers manage payroll" ON public.payroll_records;
CREATE POLICY "managers manage payroll" ON public.payroll_records AS PERMISSIVE FOR ALL TO public
  USING (((company_id = ( SELECT profiles.company_id
   FROM profiles
  WHERE (profiles.id = public.get_my_profile_id()))) AND (( SELECT profiles.role
   FROM profiles
  WHERE (profiles.id = public.get_my_profile_id())) = ANY (ARRAY['admin'::text, 'gestor'::text]))));

-- ─── platform_admins ───────────────────────────────────────────────────────
DROP POLICY IF EXISTS "read own platform admin row" ON public.platform_admins;
CREATE POLICY "read own platform admin row" ON public.platform_admins AS PERMISSIVE FOR SELECT TO public
  USING ((profile_id = public.get_my_profile_id()));

-- ─── push_subscriptions ────────────────────────────────────────────────────
DROP POLICY IF EXISTS "users manage own push subs" ON public.push_subscriptions;
CREATE POLICY "users manage own push subs" ON public.push_subscriptions AS PERMISSIVE FOR ALL TO public
  USING ((user_id = public.get_my_profile_id()));

-- ─── service_photos ────────────────────────────────────────────────────────
DROP POLICY IF EXISTS "service_photos_manager_read" ON public.service_photos;
CREATE POLICY "service_photos_manager_read" ON public.service_photos AS PERMISSIVE FOR SELECT TO public
  USING (((company_id = ( SELECT profiles.company_id
   FROM profiles
  WHERE (profiles.id = public.get_my_profile_id()))) AND (( SELECT profiles.role
   FROM profiles
  WHERE (profiles.id = public.get_my_profile_id())) = ANY (ARRAY['admin'::text, 'gestor'::text]))));
DROP POLICY IF EXISTS "service_photos_own_read" ON public.service_photos;
CREATE POLICY "service_photos_own_read" ON public.service_photos AS PERMISSIVE FOR SELECT TO public
  USING ((collaborator_id = public.get_my_profile_id()));

-- ─── service_reinforcements ────────────────────────────────────────────────
DROP POLICY IF EXISTS "reinforcements_select" ON public.service_reinforcements;
CREATE POLICY "reinforcements_select" ON public.service_reinforcements AS PERMISSIVE FOR SELECT TO public
  USING (((collaborator_id = public.get_my_profile_id()) OR (get_service_company_id(service_id) = get_my_company_id())));

-- ─── team_members ──────────────────────────────────────────────────────────
DROP POLICY IF EXISTS "company team members" ON public.team_members;
CREATE POLICY "company team members" ON public.team_members AS PERMISSIVE FOR ALL TO public
  USING ((( SELECT teams.company_id
   FROM teams
  WHERE (teams.id = team_members.team_id)) = ( SELECT profiles.company_id
   FROM profiles
  WHERE (profiles.id = public.get_my_profile_id()))));

-- ─── teams ─────────────────────────────────────────────────────────────────
DROP POLICY IF EXISTS "company teams" ON public.teams;
CREATE POLICY "company teams" ON public.teams AS PERMISSIVE FOR ALL TO public
  USING ((company_id = ( SELECT profiles.company_id
   FROM profiles
  WHERE (profiles.id = public.get_my_profile_id()))));

-- ─── timesheets ────────────────────────────────────────────────────────────
DROP POLICY IF EXISTS "collaborators create own timesheets" ON public.timesheets;
CREATE POLICY "collaborators create own timesheets" ON public.timesheets AS PERMISSIVE FOR INSERT TO public
  WITH CHECK ((collaborator_id = public.get_my_profile_id()));
DROP POLICY IF EXISTS "collaborators see own timesheets" ON public.timesheets;
CREATE POLICY "collaborators see own timesheets" ON public.timesheets AS PERMISSIVE FOR SELECT TO public
  USING ((collaborator_id = public.get_my_profile_id()));
DROP POLICY IF EXISTS "managers see company timesheets" ON public.timesheets;
CREATE POLICY "managers see company timesheets" ON public.timesheets AS PERMISSIVE FOR ALL TO public
  USING (((company_id = ( SELECT profiles.company_id
   FROM profiles
  WHERE (profiles.id = public.get_my_profile_id()))) AND (( SELECT profiles.role
   FROM profiles
  WHERE (profiles.id = public.get_my_profile_id())) = ANY (ARRAY['admin'::text, 'gestor'::text]))));
DROP POLICY IF EXISTS "timesheets_collaborator_insert" ON public.timesheets;
CREATE POLICY "timesheets_collaborator_insert" ON public.timesheets AS PERMISSIVE FOR INSERT TO public
  WITH CHECK ((collaborator_id = public.get_my_profile_id()));
DROP POLICY IF EXISTS "timesheets_collaborator_update" ON public.timesheets;
CREATE POLICY "timesheets_collaborator_update" ON public.timesheets AS PERMISSIVE FOR UPDATE TO public
  USING ((collaborator_id = public.get_my_profile_id()));
DROP POLICY IF EXISTS "timesheets_manager_select" ON public.timesheets;
CREATE POLICY "timesheets_manager_select" ON public.timesheets AS PERMISSIVE FOR SELECT TO public
  USING (((company_id = get_my_company_id()) AND (( SELECT profiles.role
   FROM profiles
  WHERE (profiles.id = public.get_my_profile_id())) = ANY (ARRAY['admin'::text, 'gestor'::text]))));
DROP POLICY IF EXISTS "timesheets_own_select" ON public.timesheets;
CREATE POLICY "timesheets_own_select" ON public.timesheets AS PERMISSIVE FOR SELECT TO public
  USING ((collaborator_id = public.get_my_profile_id()));

-- ─── vacation_requests ─────────────────────────────────────────────────────
DROP POLICY IF EXISTS "vacation_requests_insert" ON public.vacation_requests;
CREATE POLICY "vacation_requests_insert" ON public.vacation_requests AS PERMISSIVE FOR INSERT TO public
  WITH CHECK (((collaborator_id = public.get_my_profile_id()) AND (company_id = get_my_company_id())));
DROP POLICY IF EXISTS "vacation_requests_select" ON public.vacation_requests;
CREATE POLICY "vacation_requests_select" ON public.vacation_requests AS PERMISSIVE FOR SELECT TO public
  USING (((collaborator_id = public.get_my_profile_id()) OR ((company_id = get_my_company_id()) AND (get_my_role() = ANY (ARRAY['admin'::text, 'gestor'::text])))));

-- ─── vehicle_allocations ───────────────────────────────────────────────────
DROP POLICY IF EXISTS "vehicle_allocations_company_isolation" ON public.vehicle_allocations;
CREATE POLICY "vehicle_allocations_company_isolation" ON public.vehicle_allocations AS PERMISSIVE FOR ALL TO public
  USING ((company_id IN ( SELECT profiles.company_id
   FROM profiles
  WHERE (profiles.id = public.get_my_profile_id()))));
DROP POLICY IF EXISTS "vehicle_allocations_delete" ON public.vehicle_allocations;
CREATE POLICY "vehicle_allocations_delete" ON public.vehicle_allocations AS PERMISSIVE FOR DELETE TO public
  USING ((company_id IN ( SELECT profiles.company_id
   FROM profiles
  WHERE ((profiles.id = public.get_my_profile_id()) AND (profiles.role = ANY (ARRAY['admin'::text, 'gestor'::text]))))));
DROP POLICY IF EXISTS "vehicle_allocations_insert" ON public.vehicle_allocations;
CREATE POLICY "vehicle_allocations_insert" ON public.vehicle_allocations AS PERMISSIVE FOR INSERT TO public
  WITH CHECK ((company_id IN ( SELECT profiles.company_id
   FROM profiles
  WHERE ((profiles.id = public.get_my_profile_id()) AND (profiles.role = ANY (ARRAY['admin'::text, 'gestor'::text]))))));
DROP POLICY IF EXISTS "vehicle_allocations_update" ON public.vehicle_allocations;
CREATE POLICY "vehicle_allocations_update" ON public.vehicle_allocations AS PERMISSIVE FOR UPDATE TO public
  USING ((company_id IN ( SELECT profiles.company_id
   FROM profiles
  WHERE ((profiles.id = public.get_my_profile_id()) AND (profiles.role = ANY (ARRAY['admin'::text, 'gestor'::text]))))));

-- ─── vehicles ──────────────────────────────────────────────────────────────
DROP POLICY IF EXISTS "vehicles_company_isolation" ON public.vehicles;
CREATE POLICY "vehicles_company_isolation" ON public.vehicles AS PERMISSIVE FOR ALL TO public
  USING ((company_id IN ( SELECT profiles.company_id
   FROM profiles
  WHERE (profiles.id = public.get_my_profile_id()))));
DROP POLICY IF EXISTS "vehicles_delete" ON public.vehicles;
CREATE POLICY "vehicles_delete" ON public.vehicles AS PERMISSIVE FOR DELETE TO public
  USING ((company_id IN ( SELECT profiles.company_id
   FROM profiles
  WHERE ((profiles.id = public.get_my_profile_id()) AND (profiles.role = ANY (ARRAY['admin'::text, 'gestor'::text]))))));
DROP POLICY IF EXISTS "vehicles_insert" ON public.vehicles;
CREATE POLICY "vehicles_insert" ON public.vehicles AS PERMISSIVE FOR INSERT TO public
  WITH CHECK ((company_id IN ( SELECT profiles.company_id
   FROM profiles
  WHERE ((profiles.id = public.get_my_profile_id()) AND (profiles.role = ANY (ARRAY['admin'::text, 'gestor'::text]))))));
DROP POLICY IF EXISTS "vehicles_update" ON public.vehicles;
CREATE POLICY "vehicles_update" ON public.vehicles AS PERMISSIVE FOR UPDATE TO public
  USING ((company_id IN ( SELECT profiles.company_id
   FROM profiles
  WHERE ((profiles.id = public.get_my_profile_id()) AND (profiles.role = ANY (ARRAY['admin'::text, 'gestor'::text]))))));

-- ─── Pós-condições ─────────────────────────────────────────────────────────
DO $post$
DECLARE v_restantes int;
BEGIN
  SELECT count(*) INTO v_restantes FROM pg_policies
   WHERE schemaname='public' AND tablename <> 'profiles'
     AND (coalesce(qual,'')||' '||coalesce(with_check,'')) LIKE '%auth.uid()%';
  IF v_restantes <> 0 THEN
    RAISE EXCEPTION 'POSCONDICAO: sobraram % políticas com auth.uid() fora de profiles.', v_restantes;
  END IF;
END $post$;

COMMIT;

-- Rollback do draft collaborator_optional_auth.sql.
-- Recusa se algum colaborador sem conta ja tiver sido criado: apagar essas
-- pessoas para satisfazer a FK antiga seria perda de dados.

BEGIN;

DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM public.profiles
     WHERE auth_user_id IS NULL OR auth_user_id IS DISTINCT FROM id
  ) THEN
    RAISE EXCEPTION 'COLLABORATOR_AUTH_DECOUPLING_ROLLBACK_BLOCKED';
  END IF;
END;
$$;

DROP POLICY IF EXISTS "profiles_select" ON public.profiles;
CREATE POLICY "profiles_select" ON public.profiles FOR SELECT USING (
  id = auth.uid() OR company_id = public.get_my_company_id()
);

DROP POLICY IF EXISTS "profiles_update_own" ON public.profiles;
CREATE POLICY "profiles_update_own" ON public.profiles FOR UPDATE
  USING (id = auth.uid())
  WITH CHECK (id = auth.uid() AND company_id = public.get_my_company_id());

CREATE OR REPLACE FUNCTION public.can_access_service(p_service_id uuid)
RETURNS boolean
LANGUAGE sql
SECURITY DEFINER
STABLE
SET search_path = public
AS $$
  SELECT EXISTS (
    SELECT 1
      FROM public.services s
      JOIN public.profiles p ON p.id = auth.uid() AND p.company_id = s.company_id
     WHERE s.id = p_service_id
       AND (
         EXISTS (
           SELECT 1 FROM public.team_members tm
            WHERE tm.team_id = s.team_id
              AND tm.collaborator_id = auth.uid()
              AND (tm.left_at IS NULL OR tm.left_at > now())
         )
         OR EXISTS (
           SELECT 1 FROM public.service_reinforcements sr
            WHERE sr.service_id = s.id AND sr.collaborator_id = auth.uid()
         )
       )
  );
$$;

DROP POLICY IF EXISTS "timesheets_own_select" ON public.timesheets;
CREATE POLICY "timesheets_own_select" ON public.timesheets FOR SELECT
  USING (collaborator_id = auth.uid());

DROP POLICY IF EXISTS "timesheets_collaborator_insert" ON public.timesheets;
CREATE POLICY "timesheets_collaborator_insert" ON public.timesheets FOR INSERT
  WITH CHECK (collaborator_id = auth.uid());

DROP POLICY IF EXISTS "timesheets_collaborator_update" ON public.timesheets;
CREATE POLICY "timesheets_collaborator_update" ON public.timesheets FOR UPDATE
  USING (collaborator_id = auth.uid());

DROP POLICY IF EXISTS "absences_own_select" ON public.absences;
CREATE POLICY "absences_own_select" ON public.absences FOR SELECT
  USING (collaborator_id = auth.uid());

DROP POLICY IF EXISTS "vacation_requests_select" ON public.vacation_requests;
CREATE POLICY "vacation_requests_select" ON public.vacation_requests FOR SELECT USING (
  collaborator_id = auth.uid()
  OR (company_id = public.get_my_company_id() AND public.get_my_role() IN ('admin', 'gestor'))
);

DROP POLICY IF EXISTS "vacation_requests_insert" ON public.vacation_requests;
CREATE POLICY "vacation_requests_insert" ON public.vacation_requests FOR INSERT WITH CHECK (
  collaborator_id = auth.uid() AND company_id = public.get_my_company_id()
);

DROP POLICY IF EXISTS "collaborators see own payroll" ON public.payroll_records;
CREATE POLICY "collaborators see own payroll" ON public.payroll_records FOR SELECT
  USING (collaborator_id = auth.uid());

DROP POLICY IF EXISTS "users see own notifications" ON public.notifications;
CREATE POLICY "users see own notifications" ON public.notifications FOR ALL
  USING (user_id = auth.uid());

DROP POLICY IF EXISTS "users manage own push subs" ON public.push_subscriptions;
CREATE POLICY "users manage own push subs" ON public.push_subscriptions FOR ALL
  USING (user_id = auth.uid());

DROP POLICY IF EXISTS "colaboradoras veem os seus docs visíveis" ON public.collaborator_documents;
CREATE POLICY "colaboradoras veem os seus docs visíveis"
  ON public.collaborator_documents FOR SELECT USING (
    collaborator_id = auth.uid() AND visible_to_collaborator = true
  );

DROP POLICY IF EXISTS "colaboradoras submetem relatórios de avaria" ON public.collaborator_documents;
CREATE POLICY "colaboradoras submetem relatórios de avaria"
  ON public.collaborator_documents FOR INSERT WITH CHECK (
    collaborator_id = auth.uid()
    AND category = 'avaria'
    AND visible_to_collaborator = true
    AND uploaded_by_role = 'colaboradora'
  );

DROP POLICY IF EXISTS "service_photos_own_read" ON public.service_photos;
CREATE POLICY "service_photos_own_read" ON public.service_photos FOR SELECT
  USING (collaborator_id = auth.uid());

DROP POLICY IF EXISTS daily_clocks_own ON public.daily_clocks;
CREATE POLICY daily_clocks_own ON public.daily_clocks FOR ALL
  USING (collaborator_id = auth.uid())
  WITH CHECK (collaborator_id = auth.uid());

DROP POLICY IF EXISTS "read own platform admin row" ON public.platform_admins;
CREATE POLICY "read own platform admin row" ON public.platform_admins FOR SELECT
  USING (profile_id = auth.uid());

DROP POLICY IF EXISTS "read own reads" ON public.app_notice_reads;
CREATE POLICY "read own reads" ON public.app_notice_reads FOR SELECT
  USING (profile_id = auth.uid());

DROP POLICY IF EXISTS "colaboradores upload avarias storage" ON storage.objects;
CREATE POLICY "colaboradores upload avarias storage" ON storage.objects FOR INSERT
  WITH CHECK (
    bucket_id = 'collaborator-documents'
    AND (storage.foldername(name))[2] = auth.uid()::text
    AND EXISTS (
      SELECT 1 FROM public.profiles WHERE id = auth.uid() AND role = 'colaborador'
    )
  );

DROP POLICY IF EXISTS "colaboradoras select seus docs storage" ON storage.objects;
CREATE POLICY "colaboradoras select seus docs storage" ON storage.objects FOR SELECT
  USING (
    bucket_id = 'collaborator-documents'
    AND (storage.foldername(name))[2] = auth.uid()::text
  );

CREATE OR REPLACE FUNCTION public.get_my_company_id()
RETURNS uuid
LANGUAGE sql
SECURITY DEFINER
STABLE
SET search_path = public
AS $$ SELECT company_id FROM public.profiles WHERE id = auth.uid() LIMIT 1; $$;

CREATE OR REPLACE FUNCTION public.get_my_role()
RETURNS text
LANGUAGE sql
SECURITY DEFINER
STABLE
SET search_path = public
AS $$ SELECT role FROM public.profiles WHERE id = auth.uid() LIMIT 1; $$;

DROP TRIGGER IF EXISTS trg_guard_profile_auth_link ON public.profiles;
DROP FUNCTION IF EXISTS public.fn_guard_profile_auth_link();
DROP FUNCTION IF EXISTS public.get_my_profile_id();

ALTER TABLE public.profiles
  DROP CONSTRAINT profiles_auth_user_id_fkey,
  DROP CONSTRAINT profiles_auth_user_id_key,
  ALTER COLUMN id DROP DEFAULT,
  ADD CONSTRAINT profiles_id_fkey
    FOREIGN KEY (id) REFERENCES auth.users(id) ON DELETE CASCADE,
  DROP COLUMN auth_user_id;

COMMIT;

-- ============================================================================
-- ROLLBACK PROVISIONAL — lote 2 volta ao auth.uid() (PHASE C)
-- ============================================================================
--
-- 🔴 NÃO APLICADO. Repõe as nove políticas na forma que tinham antes.
--
-- Sem guarda, pela mesma razão do lote 1: recriar políticas não perde dados, e
-- as duas formas decidem o mesmo enquanto cada perfil tiver uma conta.
--
-- 🔴 Mas reverter isto **reabre** o acesso que o lote 2 fechou: com
--    `collaborator_id = auth.uid()`, um token forjado com o id de uma pessoa
--    sem conta volta a dar as horas, o recibo, as faltas e o ponto dela. Só
--    reverter em conjunto com o EXPAND, cujo rollback tem a guarda que impede
--    largar a coluna havendo pessoas sem conta.
-- ============================================================================

BEGIN;

DROP POLICY IF EXISTS "collaborators see own timesheets" ON public.timesheets;
CREATE POLICY "collaborators see own timesheets" ON public.timesheets
  FOR SELECT USING (collaborator_id = auth.uid());

DROP POLICY IF EXISTS "timesheets_own_select" ON public.timesheets;
CREATE POLICY "timesheets_own_select" ON public.timesheets
  FOR SELECT USING (collaborator_id = auth.uid());

DROP POLICY IF EXISTS "collaborators see own payroll" ON public.payroll_records;
CREATE POLICY "collaborators see own payroll" ON public.payroll_records
  FOR SELECT USING (collaborator_id = auth.uid());

DROP POLICY IF EXISTS "absences_own_select" ON public.absences;
CREATE POLICY "absences_own_select" ON public.absences
  FOR SELECT USING (collaborator_id = auth.uid());

DROP POLICY IF EXISTS "daily_clocks_own" ON public.daily_clocks;
CREATE POLICY "daily_clocks_own" ON public.daily_clocks
  FOR ALL USING (collaborator_id = auth.uid())
  WITH CHECK (collaborator_id = auth.uid());

DROP POLICY IF EXISTS "users see own notifications" ON public.notifications;
CREATE POLICY "users see own notifications" ON public.notifications
  FOR SELECT USING (user_id = auth.uid());

DROP POLICY IF EXISTS "users manage own push subs" ON public.push_subscriptions;
CREATE POLICY "users manage own push subs" ON public.push_subscriptions
  FOR ALL USING (user_id = auth.uid())
  WITH CHECK (user_id = auth.uid());

DROP POLICY IF EXISTS "service_photos_own_read" ON public.service_photos;
CREATE POLICY "service_photos_own_read" ON public.service_photos
  FOR SELECT USING (collaborator_id = auth.uid());

COMMIT;

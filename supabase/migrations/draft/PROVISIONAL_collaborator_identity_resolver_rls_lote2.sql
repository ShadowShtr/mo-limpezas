-- ============================================================================
-- PROVISIONAL — resolver nas políticas de dados pessoais (PHASE C, lote 2)
-- ============================================================================
--
-- 🔴 NÃO APLICADA. Depende do EXPAND (PHASE A) e do lote 1 (PHASE C).
--    MIGRATION_NUMBER_FINAL = UNASSIGNED
--
-- ---------------------------------------------------------------------------
-- Porque é que este lote vem antes dos outros
-- ---------------------------------------------------------------------------
--
-- O lote 1 tratou `profiles`. Este trata as políticas que dizem
--
--     collaborator_id = auth.uid()
--
-- e são as de maior risco depois do EXPAND, por uma razão que vale a pena
-- dizer devagar: `collaborator_id` é uma chave estrangeira para
-- `profiles(id)` — é o id de **uma pessoa**. `auth.uid()` é o id de **uma
-- sessão**. Compará-los directamente era correcto enquanto os dois eram
-- forçosamente o mesmo número; o EXPAND acabou com essa garantia.
--
-- O que estas políticas protegem não é acessório: as horas de trabalho de cada
-- pessoa, o seu recibo de vencimento, as suas faltas, os seus documentos, o
-- seu registo de ponto. São exactamente os dados que uma pessoa pode ver de si
-- própria e de mais ninguém.
--
--     RLS_POLICIES_MIGRATED_HERE = 9
--     (7 × collaborator_id, 2 × user_id)
--
-- ---------------------------------------------------------------------------
-- O padrão
-- ---------------------------------------------------------------------------
--
--     collaborator_id = auth.uid()   →   collaborator_id = get_my_profile_id()
--
-- Para quem tem conta o resultado é idêntico. O que muda é a pergunta: passa a
-- ser «este registo é meu?» em vez de «este registo tem o id da minha sessão?».
--
-- 🔴 E há um ganho de segurança imediato, não só de correcção futura. Antes
--    deste lote, um token forjado com o `id` de uma pessoa **sem** conta dava
--    acesso às horas, ao recibo e às faltas dela — porque
--    `collaborator_id = auth.uid()` batia certo. O resolver recusa esse id, e
--    `collaborator_id = NULL` nunca é verdadeiro. Há um teste por tabela.
-- ============================================================================

BEGIN;

-- ─── timesheets — horas de trabalho ─────────────────────────────────────────
DROP POLICY IF EXISTS "collaborators see own timesheets" ON public.timesheets;
CREATE POLICY "collaborators see own timesheets" ON public.timesheets
  FOR SELECT USING (collaborator_id = public.get_my_profile_id());

DROP POLICY IF EXISTS "timesheets_own_select" ON public.timesheets;
CREATE POLICY "timesheets_own_select" ON public.timesheets
  FOR SELECT USING (collaborator_id = public.get_my_profile_id());

-- ─── payroll_records — recibo de vencimento ─────────────────────────────────
DROP POLICY IF EXISTS "collaborators see own payroll" ON public.payroll_records;
CREATE POLICY "collaborators see own payroll" ON public.payroll_records
  FOR SELECT USING (collaborator_id = public.get_my_profile_id());

-- ─── absences — faltas ──────────────────────────────────────────────────────
DROP POLICY IF EXISTS "absences_own_select" ON public.absences;
CREATE POLICY "absences_own_select" ON public.absences
  FOR SELECT USING (collaborator_id = public.get_my_profile_id());

-- ─── daily_clocks — registo de ponto ────────────────────────────────────────
--
-- Recriada com a forma que a 042 lhe deu, só com o resolver no lugar do
-- `auth.uid()`. Se a política não existir, o `DROP IF EXISTS` não faz nada e o
-- `CREATE` instala-a — a migration não assume que a 042 já correu.
DROP POLICY IF EXISTS "daily_clocks_own" ON public.daily_clocks;
CREATE POLICY "daily_clocks_own" ON public.daily_clocks
  FOR ALL USING (collaborator_id = public.get_my_profile_id())
  WITH CHECK (collaborator_id = public.get_my_profile_id());

-- ─── notifications e push_subscriptions — `user_id`, mesma ideia ────────────
--
-- 🔴 `user_id` aqui **não** é o id do Auth, apesar do nome: a coluna é
--    `REFERENCES profiles(id)`. É o id da pessoa, como o `collaborator_id`. O
--    nome é herdado e enganador, e é precisamente o tipo de coisa que leva
--    alguém a assumir a equivalência sem a verificar.
DROP POLICY IF EXISTS "users see own notifications" ON public.notifications;
CREATE POLICY "users see own notifications" ON public.notifications
  FOR SELECT USING (user_id = public.get_my_profile_id());

DROP POLICY IF EXISTS "users manage own push subs" ON public.push_subscriptions;
CREATE POLICY "users manage own push subs" ON public.push_subscriptions
  FOR ALL USING (user_id = public.get_my_profile_id())
  WITH CHECK (user_id = public.get_my_profile_id());

-- ─── service_photos — fotografias do serviço ────────────────────────────────
DROP POLICY IF EXISTS "service_photos_own_read" ON public.service_photos;
CREATE POLICY "service_photos_own_read" ON public.service_photos
  FOR SELECT USING (collaborator_id = public.get_my_profile_id());

COMMIT;

-- ============================================================================
-- O que este lote NÃO faz
-- ============================================================================
--
--  · não toca nas 71 políticas com a subconsulta
--    `company_id = (SELECT company_id FROM profiles WHERE id = auth.uid())`.
--    Essas resolvem-se todas de uma vez quando `get_my_company_id()` passar a
--    ser usada em vez da subconsulta escrita à mão — e essa função já foi
--    corrigida no lote 1, portanto **já estão a decidir bem**. Reescrevê-las é
--    arrumação, não correcção, e faz-se com o seu próprio ensaio;
--  · não toca nas políticas de `storage.objects` — vivem noutro schema, com as
--    suas próprias regras, e merecem um lote só delas;
--  · não altera nenhuma tabela nem escreve uma linha de dados.
--
-- Rollback em `rollback/PROVISIONAL_..._lote2.down.sql`.
-- ============================================================================

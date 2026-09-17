-- ============================================================================
-- Os helpers de autorização COMO ESTÃO EM PRODUÇÃO, antes da 101c
-- ============================================================================
--
-- 🔴 Copiados do catálogo vivo, não das migrations.
--
--    `production-baseline.ts` traz `HELPERS_LEGADOS` com `id = auth.uid()`, e
--    diz de si próprio que é «o que a base tem hoje». Já não é: em produção,
--    `get_my_company_id` e `get_my_role` DELEGAM em `get_my_profile_id`, e
--    esta resolve por `auth_user_id` com recurso ao `id` como caminho legado.
--
--    Um ensaio montado sobre os helpers do repositório mediria um mundo que
--    não existe — e é precisamente a diferença entre os dois que a 102 vem
--    tocar. Por isso o ponto de partida é este ficheiro, lido de
--    `pg_get_functiondef` por `scripts/audit-status-authorization-surface.mjs`.
--
-- ----------------------------------------------------------------------------
-- A coluna `auth_user_id`
-- ----------------------------------------------------------------------------
--
-- Existe em produção (confirmado por leitura read-only: `uuid`, anulável, sem
-- default). Não está em `production-schema-shape.sql` porque o dump é
-- anterior, e a migration que a cria continua em `supabase/migrations/draft/`
-- — foi aplicada fora do runner, como tantas outras.
--
-- Fica aqui recriada para o palco ter a forma real. A FK para `auth.users` é
-- a que a migration em draft declara.
-- ============================================================================

ALTER TABLE public.profiles
  ADD COLUMN IF NOT EXISTS auth_user_id uuid;

DO $fk$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'profiles_auth_user_id_fkey'
  ) THEN
    ALTER TABLE public.profiles
      ADD CONSTRAINT profiles_auth_user_id_fkey
      FOREIGN KEY (auth_user_id) REFERENCES auth.users(id) ON DELETE SET NULL;
  END IF;
END $fk$;

CREATE UNIQUE INDEX IF NOT EXISTS uq_profiles_auth_user_id
  ON public.profiles(auth_user_id)
  WHERE auth_user_id IS NOT NULL;

-- ----------------------------------------------------------------------------
-- Os quatro helpers, tal e qual
-- ----------------------------------------------------------------------------

-- 🔴 Repare-se no que NÃO está aqui: nenhuma menção a `status`. É este o
--    buraco — `profiles.status` não participa de decisão de autorização
--    nenhuma na base, e por isso um JWT emitido antes da saída continua a ser
--    aceite pelo PostgREST até expirar.
CREATE OR REPLACE FUNCTION public.get_my_profile_id()
 RETURNS uuid
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
  SELECT id FROM profiles WHERE auth_user_id = auth.uid()
  UNION ALL
  SELECT id FROM profiles p
   WHERE p.id = auth.uid()
     AND EXISTS (SELECT 1 FROM auth.users u WHERE u.id = p.id)
     AND NOT EXISTS (SELECT 1 FROM profiles x WHERE x.auth_user_id = auth.uid())
  LIMIT 1;
$function$;

CREATE OR REPLACE FUNCTION public.get_my_company_id()
 RETURNS uuid
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
  SELECT company_id FROM profiles WHERE id = public.get_my_profile_id() LIMIT 1;
$function$;

CREATE OR REPLACE FUNCTION public.get_my_role()
 RETURNS text
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
  SELECT role FROM profiles WHERE id = public.get_my_profile_id() LIMIT 1;
$function$;

-- 🔴 Esta não delega no helper: junta `profiles` por `auth.uid()` directamente,
--    e compara `team_members.collaborator_id`/`service_reinforcements.collaborator_id`
--    (que são FKs para `profiles.id`) com `auth.uid()`. Assume o modelo legado,
--    e portanto contorna qualquer regra que se ponha no helper.
--
--    Também é a ÚNICA SECURITY DEFINER do schema sem `search_path` fixado
--    (confirmado: 24 SECDEF, 1 sem).
CREATE OR REPLACE FUNCTION public.can_access_service(p_service_id uuid)
 RETURNS boolean
 LANGUAGE sql
 STABLE SECURITY DEFINER
AS $function$
  SELECT EXISTS (
    SELECT 1
    FROM   services s
    INNER  JOIN profiles p ON p.id = auth.uid() AND p.company_id = s.company_id
    WHERE  s.id = p_service_id
    AND (
      EXISTS (
        SELECT 1 FROM team_members tm
        WHERE  tm.team_id        = s.team_id
        AND    tm.collaborator_id = auth.uid()
        AND   (tm.left_at IS NULL OR tm.left_at > NOW())
      )
      OR EXISTS (
        SELECT 1 FROM service_reinforcements sr
        WHERE  sr.service_id     = s.id
        AND    sr.collaborator_id = auth.uid()
      )
    )
  )
$function$;

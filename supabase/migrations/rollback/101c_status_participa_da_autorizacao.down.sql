-- ============================================================================
-- ROLLBACK da 101c — repor os helpers como estavam
-- ============================================================================
--
-- 🔴 O que este rollback repõe é o BURACO, e é preciso dizê-lo em voz alta.
--
--    Correr isto devolve a base ao estado em que `profiles.status` não
--    participa de decisão de autorização nenhuma — ou seja, um JWT emitido
--    antes de uma saída volta a ser aceite pelo PostgREST até expirar, com
--    leitura e escrita.
--
--    Existe porque um rollback que não existe é pior: obriga a improvisar sob
--    pressão. Mas não é uma operação neutra, e quem o correr tem de saber que
--    está a reabrir a janela, não a «voltar ao normal».
--
--    Se a 101c tiver de ser revertida por causar um problema de acesso
--    legítimo, o caminho preferível é corrigir os perfis afectados
--    (`status = 'ativo'` a quem deve ter acesso) em vez de reverter a regra.
--
-- Os corpos abaixo são os que estavam em produção antes da 101c (e que a 101b canonicaliza), copiados de
-- `pg_get_functiondef` — incluindo a ausência de `search_path` em
-- `can_access_service`, que era o estado real.
-- ============================================================================

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

COMMENT ON FUNCTION public.get_my_profile_id() IS NULL;

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

COMMENT ON FUNCTION public.can_access_service(uuid) IS NULL;

-- ============================================================================
-- 107 — building_cards: leitura móvel sem escrita directa pela API
-- ============================================================================
-- A policy geral da 051 era FOR ALL e permissiva. Por isso, combinava por OR
-- com as policies de gestor e autorizava qualquer membro activo da empresa a
-- inserir, alterar e apagar prédios. As gravações reais já passam pelas Server
-- Actions, depois de requireProfile, usando service_role.

-- Falhar fechado se a fundação ou o estado medido pela SEC-01A tiver mudado.
DO $precondicoes$
DECLARE
  v_checksum text;
  v_policies text[];
BEGIN
  IF to_regclass('public.building_cards') IS NULL
     OR to_regprocedure('public.get_my_company_id()') IS NULL THEN
    RAISE EXCEPTION
      'BUILDING_CARDS_107_PRECONDITION_FAILED: tabela ou resolvedor ausente';
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_class
     WHERE oid = 'public.building_cards'::regclass AND relrowsecurity
  ) THEN
    RAISE EXCEPTION
      'BUILDING_CARDS_107_PRECONDITION_FAILED: RLS não está ativa';
  END IF;

  IF to_regclass('public._migrations') IS NULL THEN
    RAISE EXCEPTION
      'BUILDING_CARDS_107_LEDGER_MISSING: public._migrations não existe';
  END IF;

  SELECT checksum INTO v_checksum
    FROM public._migrations
   WHERE name = '106_colaborador_status_autorizacao.sql';

  IF v_checksum IS DISTINCT FROM
     'b5302126663f36a50e1f52d4627076f388b56689d9bf0e9f06c1824137596bb8' THEN
    RAISE EXCEPTION
      'BUILDING_CARDS_107_DEPENDENCY_DIVERGED: checksum da 106 é %', v_checksum;
  END IF;

  SELECT coalesce(array_agg(policyname || ':' || cmd ORDER BY policyname), '{}')
    INTO v_policies
    FROM pg_policies
   WHERE schemaname = 'public' AND tablename = 'building_cards';

  IF v_policies <> ARRAY[
    'building_cards_company_isolation:ALL',
    'building_cards_delete:DELETE',
    'building_cards_insert:INSERT',
    'building_cards_update:UPDATE'
  ] THEN
    RAISE EXCEPTION
      'BUILDING_CARDS_107_UNEXPECTED_POLICIES: %, esperado o estado SEC-01A',
      v_policies;
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_policies
     WHERE schemaname = 'public'
       AND tablename = 'building_cards'
       AND policyname = 'building_cards_company_isolation'
       AND permissive = 'PERMISSIVE'
       AND cmd = 'ALL'
       AND roles = ARRAY['public']::name[]
       AND qual ILIKE '%get_my_profile_id%'
       AND with_check IS NULL
  ) THEN
    RAISE EXCEPTION
      'BUILDING_CARDS_107_PRECONDITION_FAILED: policy geral não é PERMISSIVE FOR ALL';
  END IF;
END
$precondicoes$;

-- Uma só policy, só para a leitura autenticada necessária à aplicação móvel.
-- get_my_company_id() delega no resolvedor da 106, que exige perfil activo.
DROP POLICY building_cards_company_isolation ON public.building_cards;
DROP POLICY building_cards_insert ON public.building_cards;
DROP POLICY building_cards_update ON public.building_cards;
DROP POLICY building_cards_delete ON public.building_cards;

CREATE POLICY building_cards_company_select
  ON public.building_cards
  AS PERMISSIVE
  FOR SELECT
  TO authenticated
  USING (company_id = public.get_my_company_id());

-- Fechar a ACL por conjunto. Isto inclui TRUNCATE, REFERENCES, TRIGGER e
-- MAINTAIN; RLS não protege todas essas operações.
REVOKE ALL PRIVILEGES ON TABLE public.building_cards FROM PUBLIC;
REVOKE ALL PRIVILEGES ON TABLE public.building_cards FROM anon;
REVOKE ALL PRIVILEGES ON TABLE public.building_cards FROM authenticated;
REVOKE ALL PRIVILEGES ON TABLE public.building_cards FROM service_role;

GRANT SELECT ON TABLE public.building_cards TO authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.building_cards TO service_role;

-- A própria migration confere policy e os oito privilégios de cada papel.
DO $posestado$
DECLARE
  r record;
  v_esperado boolean;
  v_policy text[];
BEGIN
  SELECT coalesce(array_agg(policyname || ':' || cmd || ':' || array_to_string(roles, ',')
                            ORDER BY policyname), '{}')
    INTO v_policy
    FROM pg_policies
   WHERE schemaname = 'public' AND tablename = 'building_cards';

  IF v_policy <> ARRAY['building_cards_company_select:SELECT:authenticated'] THEN
    RAISE EXCEPTION
      'BUILDING_CARDS_107_POSTSTATE_POLICY_FAILED: %', v_policy;
  END IF;

  FOR r IN
    SELECT papel, privilegio,
           has_table_privilege(papel, 'public.building_cards', privilegio) AS tem
      FROM unnest(ARRAY['anon', 'authenticated', 'service_role']) AS papel
      CROSS JOIN unnest(ARRAY['SELECT', 'INSERT', 'UPDATE', 'DELETE',
                              'TRUNCATE', 'REFERENCES', 'TRIGGER', 'MAINTAIN']) AS privilegio
  LOOP
    v_esperado := CASE
      WHEN r.papel = 'authenticated' AND r.privilegio = 'SELECT' THEN true
      WHEN r.papel = 'service_role'
       AND r.privilegio IN ('SELECT', 'INSERT', 'UPDATE', 'DELETE') THEN true
      ELSE false
    END;

    IF r.tem <> v_esperado THEN
      RAISE EXCEPTION
        'BUILDING_CARDS_107_POSTSTATE_ACL_FAILED: %.% = %, esperado %',
        r.papel, r.privilegio, r.tem, v_esperado;
    END IF;
  END LOOP;
END
$posestado$;

COMMENT ON TABLE public.building_cards IS
  'Prédios por empresa. Desde a 107, authenticated tem somente SELECT sujeito '
  'a RLS; gravações passam pelas Server Actions autorizadas e service_role.';

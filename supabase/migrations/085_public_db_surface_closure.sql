-- ============================================================================
-- 085 — fechar a superfície pública: duas views e três funções
-- ============================================================================
-- Incidente confirmado por leitura directa do schema de produção e execução
-- read-only com SET ROLE (direcção técnica, 2026-08-29):
--
--     SET ROLE anon → SELECT public.teams_with_members    → devolve linhas
--     SET ROLE anon → SELECT public.monthly_hours_summary → devolve linhas
--
-- As duas views expõem dados de pessoas — nome, telefone, avatar, horas
-- contratadas e trabalhadas — a um papel que não tem sessão nenhuma.
--
-- 🔴 A causa é conhecida e já foi decidida neste repositório. A 030 recriou
--    `services_full` com `security_invoker = true` e escreveu porquê:
--
--        «Without security_invoker=true the view runs as the view owner
--         (postgres), bypassing RLS on clients/locations.»
--
--    As duas views desta migration nasceram na 010, antes dessa decisão, e
--    nunca foram revisitadas. Não é um padrão novo a debater: é a 030 por
--    terminar. O RLS das tabelas subjacentes (`teams`, `team_members`,
--    `profiles`, `timesheets`) existe e está correcto — simplesmente não
--    estava a ser aplicado, porque a view corria como dona.
--
-- ── As três funções ────────────────────────────────────────────────────────
--
--    `archive_expired_documents(uuid)` é a mais grave das três, e por um
--    motivo diferente das outras duas: é SECURITY DEFINER, ESCREVE
--    (UPDATE collaborator_documents SET archived_at = now()), aceita o
--    `company_id` do chamador sem validar identidade, e `anon` tem EXECUTE.
--    Não tem um único caller em todo o repositório.
--
--    `get_documents_to_archive(uuid)` devolve nome, ficheiro, URL e notas de
--    documentos de pessoas, também com o `company_id` vindo do chamador e sem
--    validação de identidade lá dentro.
--
--    `detect_schedule_conflicts(date,date)` devolve `company_id`, `team_id` e
--    horários de serviços, sem filtro de empresa.
--
--    Nenhuma das três é chamada por um caller autenticado: as duas primeiras
--    entram por Server Action com service-role, a terceira pelo cron, também
--    com service-role. Provado por auditoria de callers (ver PR).
--
-- ── Âmbito: só o que está provado ──────────────────────────────────────────
--
--    NÃO entram aqui, deliberadamente, e ficam para task própria:
--
--      · `can_access_service(uuid)` — avalia policies de `services`. Revogar
--        EXECUTE às cegas pode partir a avaliação de RLS. Exige auditoria
--        própria.
--      · `handle_new_user()` — RETURNS trigger; o `search_path` já foi
--        corrigido pela 068, mas o EXECUTE é um achado independente e mexer
--        em grants de um trigger helper exige análise própria.
--      · restantes SECURITY DEFINER e grants históricos amplos.
--
--    Uma migration de incidente fecha o que está provado. O que precisa de
--    caracterização espera pela caracterização.
-- ============================================================================

-- ─── 1. Precondições — UNKNOWN_STATE = FAIL_CLOSED ──────────────────────────
--
-- 🔴 Nada é alterado antes desta guarda passar. Se a base não estiver no
--    estado caracterizado, esta migration não é a migration certa para ela:
--    aplicar mesmo assim seria mudar ACLs sobre um schema que não conhecemos.
--
--    A guarda verifica ESTRUTURA — existência, tipo, security_invoker,
--    assinatura, SECURITY DEFINER, search_path. Nunca dados operacionais:
--    nenhuma contagem de linhas, nenhum PII. Contagens mudam sozinhas e
--    transformariam a guarda numa fonte de falsos vermelhos.
DO $precondicoes$
DECLARE
  v_relkind   char;
  v_opts      text;
  v_prosecdef boolean;
  v_cfg       text;
  v_args      text;
  v_nome      text;
BEGIN
  -- 1a. As duas views existem, são views, e AINDA NÃO têm security_invoker.
  FOREACH v_nome IN ARRAY ARRAY['teams_with_members', 'monthly_hours_summary'] LOOP
    SELECT c.relkind, coalesce(array_to_string(c.reloptions, ','), '')
      INTO v_relkind, v_opts
      FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
     WHERE n.nspname = 'public' AND c.relname = v_nome;

    IF v_relkind IS NULL THEN
      RAISE EXCEPTION
        '085_UNEXPECTED_PUBLIC_SURFACE_STATE: public.% ausente', v_nome
        USING HINT = 'O prestate caracterizado tinha esta view. Nao aplicar sobre um schema diferente.';
    END IF;
    IF v_relkind <> 'v' THEN
      RAISE EXCEPTION
        '085_UNEXPECTED_PUBLIC_SURFACE_STATE: public.% nao e uma view (relkind=%)', v_nome, v_relkind;
    END IF;
    IF v_opts ILIKE '%security_invoker%' THEN
      RAISE EXCEPTION
        '085_UNEXPECTED_PUBLIC_SURFACE_STATE: public.% ja tem security_invoker (%)', v_nome, v_opts
        USING HINT = 'O prestate caracterizado nao tinha. Alguem alterou a view fora do versionamento.';
    END IF;
  END LOOP;

  -- 1b. As três funções existem com a assinatura exacta, são SECURITY DEFINER
  --     e ainda sem search_path — o estado que esta migration corrige.
  FOREACH v_nome IN ARRAY ARRAY['archive_expired_documents', 'get_documents_to_archive', 'detect_schedule_conflicts'] LOOP
    SELECT pg_get_function_identity_arguments(p.oid), p.prosecdef,
           coalesce(array_to_string(p.proconfig, ','), '')
      INTO v_args, v_prosecdef, v_cfg
      FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
     WHERE n.nspname = 'public' AND p.proname = v_nome;

    IF v_args IS NULL THEN
      RAISE EXCEPTION '085_UNEXPECTED_PUBLIC_SURFACE_STATE: public.%() ausente', v_nome;
    END IF;

    IF v_nome = 'detect_schedule_conflicts' THEN
      IF v_args <> 'p_start date, p_end date' THEN
        RAISE EXCEPTION
          '085_UNEXPECTED_PUBLIC_SURFACE_STATE: %(%) — assinatura inesperada', v_nome, v_args;
      END IF;
    ELSE
      IF v_args <> 'p_company_id uuid' THEN
        RAISE EXCEPTION
          '085_UNEXPECTED_PUBLIC_SURFACE_STATE: %(%) — assinatura inesperada', v_nome, v_args;
      END IF;
    END IF;

    IF NOT v_prosecdef THEN
      RAISE EXCEPTION
        '085_UNEXPECTED_PUBLIC_SURFACE_STATE: % nao e SECURITY DEFINER', v_nome;
    END IF;
    IF v_cfg ILIKE '%search_path%' THEN
      RAISE EXCEPTION
        '085_UNEXPECTED_PUBLIC_SURFACE_STATE: % ja tem search_path fixado (%)', v_nome, v_cfg;
    END IF;
  END LOOP;

  -- 1c. Nenhuma assinatura duplicada: um overload inesperado significaria que
  --     os REVOKE/GRANT abaixo fechariam uma e deixariam a outra aberta.
  IF (SELECT count(*) FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
       WHERE n.nspname = 'public'
         AND p.proname IN ('archive_expired_documents','get_documents_to_archive','detect_schedule_conflicts')) <> 3 THEN
    RAISE EXCEPTION
      '085_UNEXPECTED_PUBLIC_SURFACE_STATE: esperadas exactamente 3 funcoes alvo, encontradas %',
      (SELECT count(*) FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
        WHERE n.nspname = 'public'
          AND p.proname IN ('archive_expired_documents','get_documents_to_archive','detect_schedule_conflicts'))
      USING HINT = 'Um overload inesperado deixaria uma assinatura aberta depois dos REVOKE.';
  END IF;
END
$precondicoes$;

-- ─── 2. Views — RLS passa a aplicar-se, e a ACL fecha por conjunto ──────────
--
-- `ALTER VIEW ... SET (security_invoker = true)` preserva a definição e o
-- shape: os consumidores continuam a ver as mesmas colunas. Recriar as views
-- copiaria SQL histórico para aqui e criaria uma segunda cópia a divergir da
-- 010. O que muda é só quem as executa — o chamador, não a dona.
ALTER VIEW public.teams_with_members    SET (security_invoker = true);
ALTER VIEW public.monthly_hours_summary SET (security_invoker = true);

-- 🔴 Fechar por conjunto, não por enumeração: `REVOKE ALL` não depende de
--    sabermos o que lá estava. O incidente mostrou que o que lá estava não era
--    o que se assumia.
REVOKE ALL PRIVILEGES ON public.teams_with_members    FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL PRIVILEGES ON public.monthly_hours_summary FROM PUBLIC, anon, authenticated, service_role;

-- `teams_with_members`: `authenticated` MANTÉM SELECT, e isso é uma decisão
-- medida, não uma cedência. `src/app/(dashboard)/dashboard/contratos/page.tsx`
-- lê esta view pelo cliente de SESSÃO, não pelo service-role. Revogar aqui
-- partiria a página de contratos. Com `security_invoker` ligado, quem filtra
-- as linhas passa a ser o RLS de `teams`/`team_members`/`profiles`, todos
-- company-scoped — que é exactamente onde a decisão deve viver.
GRANT SELECT ON public.teams_with_members TO authenticated;
GRANT SELECT ON public.teams_with_members TO service_role;

-- `monthly_hours_summary`: zero callers autenticados em todo o repositório —
-- `src/`, `scripts/`, policies e migrations. Sem caller legítimo a perder,
-- a autorização mínima é nenhuma para `authenticated`. Se um ecrã precisar
-- dela amanhã, entra por GRANT nomeado e justificado.
GRANT SELECT ON public.monthly_hours_summary TO service_role;

-- `anon` e `PUBLIC` não recebem nada em nenhuma das duas. Era esse o buraco.

-- ─── 3. Funções — search_path fixado, EXECUTE só para o caminho real ────────
--
-- `ALTER FUNCTION ... SET search_path` fixa a resolução de nomes sem tocar no
-- corpo. Reescrever as funções aqui duplicaria SQL da 011 e da 021 e criaria
-- drift entre duas cópias da mesma definição.
--
-- `pg_catalog, public` é o mesmo valor que a 068 usou ao endurecer
-- `handle_new_user` — segue-se o padrão que o repositório já escolheu.
ALTER FUNCTION public.archive_expired_documents(uuid)       SET search_path = pg_catalog, public;
ALTER FUNCTION public.get_documents_to_archive(uuid)        SET search_path = pg_catalog, public;
ALTER FUNCTION public.detect_schedule_conflicts(date, date) SET search_path = pg_catalog, public;

-- 🔴 `archive_expired_documents` ESCREVE, é SECURITY DEFINER, aceita o
--    `company_id` de quem chama sem validar identidade, e `anon` tinha
--    EXECUTE. Zero callers no repositório. Fecha para todos menos service_role.
REVOKE ALL PRIVILEGES ON FUNCTION public.archive_expired_documents(uuid) FROM PUBLIC, anon, authenticated;
GRANT  EXECUTE ON FUNCTION public.archive_expired_documents(uuid) TO service_role;

-- Caller único: `src/app/actions/collaborator-documents.ts`, atrás de
-- `requireProfile({ roles: ['admin','gestor'] })` e com service-role.
REVOKE ALL PRIVILEGES ON FUNCTION public.get_documents_to_archive(uuid) FROM PUBLIC, anon, authenticated;
GRANT  EXECUTE ON FUNCTION public.get_documents_to_archive(uuid) TO service_role;

-- Caller único: `src/app/api/cron/generate-services/route.ts`, com
-- service-role e protegido por CRON_SECRET.
REVOKE ALL PRIVILEGES ON FUNCTION public.detect_schedule_conflicts(date, date) FROM PUBLIC, anon, authenticated;
GRANT  EXECUTE ON FUNCTION public.detect_schedule_conflicts(date, date) TO service_role;

-- ─── 4. Pós-estado — a migration verifica-se a si própria ───────────────────
--
-- Se alguma linha acima não tiver produzido o efeito pretendido, esta
-- migration falha aqui e a transação desfaz tudo. Uma migration de segurança
-- que «aplicou» sem fechar nada é pior do que uma que recusa.
DO $posestado$
DECLARE
  r          record;
  v_esperado boolean;
BEGIN
  -- 4a. As views correm como quem chama.
  FOR r IN
    SELECT c.relname, coalesce(array_to_string(c.reloptions, ','), '') AS opts
      FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
     WHERE n.nspname = 'public'
       AND c.relname IN ('teams_with_members', 'monthly_hours_summary')
  LOOP
    IF r.opts NOT ILIKE '%security_invoker=true%' THEN
      RAISE EXCEPTION
        '085_SURFACE_CLOSURE_POSTSTATE_FAILED: %.reloptions = %, esperado security_invoker=true', r.relname, r.opts;
    END IF;
  END LOOP;

  -- 4b. ACL das views: nominal, papel a papel.
  FOR r IN
    SELECT papel, relname,
           has_table_privilege(papel, 'public.' || relname, 'SELECT') AS tem
      FROM unnest(ARRAY['anon','authenticated','service_role']) AS papel
      CROSS JOIN unnest(ARRAY['teams_with_members','monthly_hours_summary']) AS relname
  LOOP
    v_esperado := CASE
      WHEN r.papel = 'service_role' THEN true
      WHEN r.papel = 'authenticated' AND r.relname = 'teams_with_members' THEN true
      ELSE false
    END;
    IF r.tem <> v_esperado THEN
      RAISE EXCEPTION
        '085_SURFACE_CLOSURE_POSTSTATE_FAILED: SELECT %.% = %, esperado %',
        r.papel, r.relname, r.tem, v_esperado;
    END IF;
  END LOOP;

  -- 4c. PUBLIC sem grants residuais em nenhuma das views — grantee = 0 não
  --     aparece em nenhuma verificação feita por nome de papel.
  FOR r IN
    SELECT c.relname,
           coalesce((SELECT string_agg(DISTINCT a.privilege_type, ',')
                       FROM aclexplode(c.relacl) a WHERE a.grantee = 0), '') AS pub
      FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
     WHERE n.nspname = 'public'
       AND c.relname IN ('teams_with_members', 'monthly_hours_summary')
  LOOP
    IF r.pub <> '' THEN
      RAISE EXCEPTION
        '085_SURFACE_CLOSURE_POSTSTATE_FAILED: % ainda tem grants a PUBLIC (%)', r.relname, r.pub;
    END IF;
  END LOOP;

  -- 4d. search_path fixado e EXECUTE só para service_role nas três funções.
  FOR r IN
    SELECT p.proname,
           coalesce(array_to_string(p.proconfig, ','), '') AS cfg,
           has_function_privilege('anon',          p.oid, 'EXECUTE') AS anon_x,
           has_function_privilege('authenticated', p.oid, 'EXECUTE') AS auth_x,
           has_function_privilege('service_role',  p.oid, 'EXECUTE') AS svc_x
      FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
     WHERE n.nspname = 'public'
       AND p.proname IN ('archive_expired_documents','get_documents_to_archive','detect_schedule_conflicts')
  LOOP
    IF r.cfg NOT ILIKE '%search_path%' THEN
      RAISE EXCEPTION
        '085_SURFACE_CLOSURE_POSTSTATE_FAILED: % sem search_path fixado (proconfig=%)', r.proname, r.cfg;
    END IF;
    IF r.anon_x OR r.auth_x THEN
      RAISE EXCEPTION
        '085_SURFACE_CLOSURE_POSTSTATE_FAILED: % ainda executavel por anon=% authenticated=%',
        r.proname, r.anon_x, r.auth_x;
    END IF;
    IF NOT r.svc_x THEN
      RAISE EXCEPTION
        '085_SURFACE_CLOSURE_POSTSTATE_FAILED: % deixou de ser executavel por service_role', r.proname;
    END IF;
  END LOOP;
END
$posestado$;

COMMENT ON VIEW public.teams_with_members IS
  'Equipas com os membros activos. security_invoker=true desde a 085: as '
  'linhas sao filtradas pelo RLS de teams/team_members/profiles, como em '
  'services_full (030). authenticated mantem SELECT porque o ecra de '
  'contratos a le pelo cliente de sessao; anon nao tem acesso.';

COMMENT ON VIEW public.monthly_hours_summary IS
  'Resumo mensal de horas por colaborador. security_invoker=true desde a 085. '
  'Sem callers autenticados no repositorio: SELECT so para service_role.';

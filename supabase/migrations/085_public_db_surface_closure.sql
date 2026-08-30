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
  v_papel     text;
  v_acl       text;
  v_extra     text;
  v_acl_nulo  boolean;
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

  -- 1d. 🔴 ACL DO PRESTATE — a guarda que faltava.
  --
  --     As verificações acima confirmam a FORMA dos objectos. Nenhuma delas
  --     olha para os privilégios, e é sobre privilégios que esta migration
  --     opera. Sem isto, um `REVOKE ALL` convergiria em silêncio sobre um ACL
  --     que ninguém caracterizou: se alguém tivesse ajustado um grant entre a
  --     leitura de produção e a aplicação, essa decisão desaparecia sem
  --     deixar rasto — e o relatório diria «aplicado com sucesso».
  --
  --         ACL_MUTADO = UNKNOWN_STATE = FAIL_CLOSED
  --
  --     Lê-se `pg_class.relacl` / `pg_proc.proacl` directamente, via
  --     `aclexplode`, e NÃO apenas `has_*_privilege`. A diferença importa: o
  --     `has_*` responde «este papel consegue?», que é verdade também por
  --     herança ou por um grant a PUBLIC — esconde a ORIGEM do privilégio.
  --     Aqui interessa quem o tem por grant directo, porque é isso que o
  --     `REVOKE` a seguir vai apagar.
  FOREACH v_nome IN ARRAY ARRAY['teams_with_members', 'monthly_hours_summary'] LOOP
    -- Vector caracterizado em produção: anon, authenticated e service_role
    -- com os OITO privilégios de PG17, por grant directo.
    FOREACH v_papel IN ARRAY ARRAY['anon', 'authenticated', 'service_role'] LOOP
      SELECT coalesce(string_agg(DISTINCT a.privilege_type, ',' ORDER BY a.privilege_type), '')
        INTO v_acl
        FROM pg_class c
        LEFT JOIN LATERAL aclexplode(c.relacl) a ON a.grantee = to_regrole(v_papel)::oid
        JOIN pg_namespace n ON n.oid = c.relnamespace
       WHERE n.nspname = 'public' AND c.relname = v_nome;

      IF v_acl <> 'DELETE,INSERT,MAINTAIN,REFERENCES,SELECT,TRIGGER,TRUNCATE,UPDATE' THEN
        RAISE EXCEPTION
          '085_UNEXPECTED_PUBLIC_SURFACE_STATE: ACL de %.% para % = [%], esperado os 8 privilegios do prestate caracterizado',
          'public', v_nome, v_papel, v_acl
          USING HINT = 'O ACL mudou desde a caracterizacao. Reler produccao e decidir antes de reaplicar; a 085 nao normaliza ACL desconhecido.';
      END IF;
    END LOOP;

    -- PUBLIC não tinha grant directo nas views. Um grant a PUBLIC aqui chega a
    -- todos os papéis, incluindo `anon`, e escapa a qualquer verificação feita
    -- por nome — por isso é medido à parte, por `grantee = 0`.
    SELECT coalesce(string_agg(DISTINCT a.privilege_type, ',' ORDER BY a.privilege_type), '')
      INTO v_acl
      FROM pg_class c
      LEFT JOIN LATERAL aclexplode(c.relacl) a ON a.grantee = 0
      JOIN pg_namespace n ON n.oid = c.relnamespace
     WHERE n.nspname = 'public' AND c.relname = v_nome;

    IF v_acl <> '' THEN
      RAISE EXCEPTION
        '085_UNEXPECTED_PUBLIC_SURFACE_STATE: public.% tem grant directo a PUBLIC [%], que o prestate caracterizado nao tinha',
        v_nome, v_acl;
    END IF;

    -- 🔴 CONJUNTO EXACTO DE GRANTEES, não apenas «os esperados estão lá».
    --
    --    Verificar que anon/authenticated/service_role têm os 8 privilégios
    --    não diz nada sobre quem MAIS os tem. Um `custom_role` com SELECT
    --    passaria por todas as verificações acima, sobreviveria intacto aos
    --    `REVOKE ... FROM PUBLIC, anon, authenticated, service_role` — que são
    --    nomeados — e o pós-estado não o veria, porque também só mede os
    --    papéis conhecidos. A superfície continuaria aberta com um relatório
    --    a dizer «fechada».
    --
    --        GRANTEE_INESPERADO = UNKNOWN_STATE = FAIL_CLOSED
    --
    --    O owner é derivado de `pg_class.relowner`, nunca comparado com o nome
    --    'postgres': em Supabase, num container descartável e numa restauração
    --    o dono pode ter nomes diferentes, e um nome fixo tornaria a guarda
    --    frágil onde ela precisa de ser exacta. O owner não é exposição
    --    pública — está no ACL por natureza e não se lhe toca.
    SELECT coalesce(string_agg(DISTINCT CASE WHEN a.grantee = 0 THEN 'PUBLIC'
                                             ELSE pg_get_userbyid(a.grantee) END, ', '), '')
      INTO v_acl
      FROM pg_class c
      JOIN pg_namespace n ON n.oid = c.relnamespace
      CROSS JOIN LATERAL aclexplode(c.relacl) a
     WHERE n.nspname = 'public' AND c.relname = v_nome
       AND a.grantee <> c.relowner
       AND a.grantee NOT IN (to_regrole('anon')::oid,
                             to_regrole('authenticated')::oid,
                             to_regrole('service_role')::oid);

    IF v_acl <> '' THEN
      RAISE EXCEPTION
        '085_UNEXPECTED_PUBLIC_SURFACE_STATE: public.% tem grantee(s) inesperado(s) [%] alem do owner e de anon/authenticated/service_role',
        v_nome, v_acl
        USING HINT = 'Um REVOKE nomeado nao os fecharia. Caracterizar cada um e decidir antes de reaplicar.';
    END IF;
  END LOOP;

  -- Funções: o prestate caracterizado é EXECUTE para PUBLIC, anon,
  -- authenticated e service_role.
  --
  -- 🔴 `proacl IS NULL` NÃO significa «sem grants». Significa o default do
  --    PostgreSQL: EXECUTE implícito para PUBLIC — e portanto para toda a
  --    gente. Medido em PG17: com `proacl` a NULL,
  --    `has_function_privilege('anon', …, 'EXECUTE')` devolve `true` e
  --    `aclexplode(NULL)` devolve ZERO linhas. Uma guarda que só olhasse para
  --    `aclexplode` concluiria «nada concedido» exactamente no estado mais
  --    aberto que existe. É por isso que os dois casos são tratados aqui.
  FOREACH v_nome IN ARRAY ARRAY['archive_expired_documents', 'get_documents_to_archive', 'detect_schedule_conflicts'] LOOP
    -- 🔴 `grantee = 0` É o PUBLIC. Não se traduz por `pg_get_userbyid`, que
    --    para o OID 0 devolve o texto 'unknown (OID=0)' em vez de NULL — um
    --    `coalesce` sobre ele nunca dispararia.
    SELECT p.proacl IS NULL,
           coalesce((SELECT string_agg(DISTINCT CASE WHEN a.grantee = 0 THEN 'PUBLIC'
                                                     ELSE pg_get_userbyid(a.grantee) END, ',')
                       FROM aclexplode(p.proacl) a WHERE a.privilege_type = 'EXECUTE'), '')
      INTO v_acl_nulo, v_acl
      FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
     WHERE n.nspname = 'public' AND p.proname = v_nome;

    IF v_acl_nulo THEN
      -- CASO A — default do PostgreSQL: EXECUTE implícito para PUBLIC, e mais
      -- ninguém com grant directo. É um dos dois prestates conhecidos, tratado
      -- explicitamente como tal.
      CONTINUE;
    END IF;

    -- CASO B — ACL materializado. O conjunto de grantees directos tem de ser
    -- EXACTAMENTE {owner, PUBLIC, anon, authenticated, service_role}.
    --
    -- 🔴 Duas verificações, e ambas são precisas:
    --
    --    (i)  nenhum a MAIS — um `custom_rpc_role` com EXECUTE sobreviveria
    --         aos REVOKE nomeados e o pós-estado não o veria;
    --    (ii) nenhum a MENOS — é a guarda de divergência que já existia.
    --
    --    Comparar por conjunto, e não por `LIKE '%anon%'`: uma verificação
    --    textual de presença daria verdadeiro para um papel chamado
    --    `anonimo_legacy` e nunca detectaria um sexto grantee.
    SELECT coalesce(string_agg(DISTINCT CASE WHEN a.grantee = 0 THEN 'PUBLIC'
                                             ELSE pg_get_userbyid(a.grantee) END, ', '), '')
      INTO v_extra
      FROM pg_proc p
      JOIN pg_namespace n ON n.oid = p.pronamespace
      CROSS JOIN LATERAL aclexplode(p.proacl) a
     WHERE n.nspname = 'public' AND p.proname = v_nome
       AND a.grantee <> p.proowner
       AND a.grantee <> 0
       AND a.grantee NOT IN (to_regrole('anon')::oid,
                             to_regrole('authenticated')::oid,
                             to_regrole('service_role')::oid);

    IF v_extra <> '' THEN
      RAISE EXCEPTION
        '085_UNEXPECTED_PUBLIC_SURFACE_STATE: %() tem grantee(s) inesperado(s) [%] alem do owner e de PUBLIC/anon/authenticated/service_role',
        v_nome, v_extra
        USING HINT = 'Um REVOKE nomeado nao os fecharia. Caracterizar cada um e decidir antes de reaplicar.';
    END IF;

    -- Os quatro esperados têm de estar todos presentes, com EXECUTE.
    FOREACH v_papel IN ARRAY ARRAY['PUBLIC', 'anon', 'authenticated', 'service_role'] LOOP
      IF NOT EXISTS (
        SELECT 1
          FROM pg_proc p
          JOIN pg_namespace n ON n.oid = p.pronamespace
          CROSS JOIN LATERAL aclexplode(p.proacl) a
         WHERE n.nspname = 'public' AND p.proname = v_nome
           AND a.privilege_type = 'EXECUTE'
           AND ((v_papel = 'PUBLIC' AND a.grantee = 0)
                OR (v_papel <> 'PUBLIC' AND a.grantee = to_regrole(v_papel)::oid))
      ) THEN
        RAISE EXCEPTION
          '085_UNEXPECTED_PUBLIC_SURFACE_STATE: %() sem EXECUTE para %, que o prestate caracterizado tinha (acl=[%])',
          v_nome, v_papel, v_acl
          USING HINT = 'Alguem ja mexeu no EXECUTE desta funcao. A 085 nao aplica sobre um ACL que nao caracterizou.';
      END IF;
    END LOOP;
  END LOOP;
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

  -- 4b. 🔴 ACL das views: os OITO privilégios, papel a papel.
  --
  --     Verificar só o SELECT deixava sete por medir. Um `REVOKE ALL` que não
  --     tivesse pegado em `UPDATE` ou `TRUNCATE` passaria despercebido — e
  --     TRUNCATE não passa por RLS nenhum. O prestate tinha os oito
  --     concedidos, portanto os oito têm de ser afirmados aqui.
  FOR r IN
    SELECT papel, relname, privilegio,
           has_table_privilege(papel, 'public.' || relname, privilegio) AS tem
      FROM unnest(ARRAY['anon','authenticated','service_role']) AS papel
      CROSS JOIN unnest(ARRAY['teams_with_members','monthly_hours_summary']) AS relname
      CROSS JOIN unnest(ARRAY['SELECT','INSERT','UPDATE','DELETE',
                              'TRUNCATE','REFERENCES','TRIGGER','MAINTAIN']) AS privilegio
  LOOP
    v_esperado := (
      r.privilegio = 'SELECT'
      AND (r.papel = 'service_role'
           OR (r.papel = 'authenticated' AND r.relname = 'teams_with_members'))
    );
    IF r.tem <> v_esperado THEN
      RAISE EXCEPTION
        '085_SURFACE_CLOSURE_POSTSTATE_FAILED: % em %.% para % = %, esperado %',
        r.privilegio, 'public', r.relname, r.papel, r.tem, v_esperado;
    END IF;
  END LOOP;

  -- 4b-bis. 🔴 ACL DIRECTO EXACTO das views: nenhum grantee fora do nominal.
  --
  --     O bloco 4b mede os papéis conhecidos. Não vê um `custom_role` — e é
  --     precisamente esse que sobreviveria a um `REVOKE` nomeado. Aqui
  --     pergunta-se o inverso: quem está no ACL que não devia estar?
  --
  --     Esperado, por view:
  --         teams_with_members    → owner, authenticated (SELECT), service_role (SELECT)
  --         monthly_hours_summary → owner, service_role (SELECT)
  --
  --     Owner derivado de `relowner`, nunca por nome.
  FOR r IN
    SELECT c.relname,
           coalesce(string_agg(DISTINCT CASE WHEN a.grantee = 0 THEN 'PUBLIC'
                                             ELSE pg_get_userbyid(a.grantee) END, ', '), '') AS extra
      FROM pg_class c
      JOIN pg_namespace n ON n.oid = c.relnamespace
      CROSS JOIN LATERAL aclexplode(c.relacl) a
     WHERE n.nspname = 'public'
       AND c.relname IN ('teams_with_members', 'monthly_hours_summary')
       AND a.grantee <> c.relowner
       AND NOT (a.grantee = to_regrole('service_role')::oid)
       AND NOT (a.grantee = to_regrole('authenticated')::oid
                AND c.relname = 'teams_with_members')
     GROUP BY c.relname
  LOOP
    IF r.extra <> '' THEN
      RAISE EXCEPTION
        '085_SURFACE_CLOSURE_POSTSTATE_FAILED: % ficou com grantee(s) fora do conjunto nominal [%]',
        r.relname, r.extra;
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
           coalesce(array_to_string(p.proconfig, ' | '), '') AS cfg,
           -- 🔴 O elemento vem do ARRAY `proconfig`, não de uma string já
           --    juntada: `search_path=pg_catalog, public` contém uma vírgula,
           --    e parti-la por vírgulas destruiria o próprio valor a comparar.
           replace(coalesce((SELECT s FROM unnest(p.proconfig) s
                              WHERE s LIKE 'search_path=%'), ''), ' ', '') AS sp,
           has_function_privilege('anon',          p.oid, 'EXECUTE') AS anon_x,
           has_function_privilege('authenticated', p.oid, 'EXECUTE') AS auth_x,
           has_function_privilege('service_role',  p.oid, 'EXECUTE') AS svc_x
      FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
     WHERE n.nspname = 'public'
       AND p.proname IN ('archive_expired_documents','get_documents_to_archive','detect_schedule_conflicts')
  LOOP
    -- 🔴 Valor EXACTO, não «contém search_path». Um `SET search_path = public`
    --    satisfaria um teste de substring e continuaria a deixar `pg_catalog`
    --    fora do caminho explícito — precisamente o que se está a corrigir.
    --    Compara-se o conteúdo semântico (sem espaços), não a formatação, que
    --    o catálogo pode normalizar.
    IF r.sp <> 'search_path=pg_catalog,public' THEN
      RAISE EXCEPTION
        '085_SURFACE_CLOSURE_POSTSTATE_FAILED: % com search_path inesperado (proconfig=%), esperado pg_catalog, public',
        r.proname, r.cfg;
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

  -- 4e. 🔴 ACL DIRECTO EXACTO das funções: só owner e service_role.
  --
  --     `has_function_privilege` acima responde por papel conhecido. Não
  --     responde «e mais quem?». Um `custom_rpc_role` com EXECUTE passaria
  --     nas três verificações anteriores.
  FOR r IN
    SELECT p.proname,
           coalesce(string_agg(DISTINCT CASE WHEN a.grantee = 0 THEN 'PUBLIC'
                                             ELSE pg_get_userbyid(a.grantee) END, ', '), '') AS extra
      FROM pg_proc p
      JOIN pg_namespace n ON n.oid = p.pronamespace
      CROSS JOIN LATERAL aclexplode(p.proacl) a
     WHERE n.nspname = 'public'
       AND p.proname IN ('archive_expired_documents','get_documents_to_archive','detect_schedule_conflicts')
       AND a.grantee <> p.proowner
       AND a.grantee <> to_regrole('service_role')::oid
     GROUP BY p.proname
  LOOP
    IF r.extra <> '' THEN
      RAISE EXCEPTION
        '085_SURFACE_CLOSURE_POSTSTATE_FAILED: %() ficou com grantee(s) fora do conjunto nominal [%]',
        r.proname, r.extra;
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

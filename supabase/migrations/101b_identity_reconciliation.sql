-- ============================================================================
-- 101b — canonicalizar a identidade que produção JÁ tem
-- ============================================================================
--
-- 🔴 Esta migration não inventa nada. Explica.
--
--    O catálogo de produção tem `profiles.auth_user_id`, `get_my_profile_id()`
--    e sessenta e nove políticas a resolver identidade por essa função. O
--    ledger tem 103 linhas e a última é a `101a`. Nenhuma migration aplicada
--    deste repositório cria nada disso.
--
--    SCHEMA_EFFECT != MIGRATION_PROVENANCE, e essa distância foi medida antes
--    de se escrever uma linha: `scripts/audit-identity-drift-manifest.ts`
--    compara o que o repositório sabe construir com o catálogo vivo e
--    classifica objecto a objecto.
--
-- ----------------------------------------------------------------------------
-- A PROVENIÊNCIA, PROVADA E NÃO ASSUMIDA
-- ----------------------------------------------------------------------------
--
-- Suspeitava-se dos três ficheiros em `supabase/migrations/draft/`. Suspeitar
-- não chega — «vários efeitos estão lá» é compatível com aplicação parcial ou
-- com edições à mão, e as duas mudariam o que esta migration pode assumir.
--
-- Mediu-se: aplicando os três rascunhos ao estado canónico, o domínio de
-- identidade passa de 74 objectos divergentes e 12 só-em-produção para zero
-- divergências nas colunas e nas políticas. E as 69 políticas divergentes
-- explicam-se TODAS por uma única substituição:
--
--     auth.uid()   →   public.get_my_profile_id()
--
-- ============================================================================
-- 🔴 TUDO AQUI É CONDICIONAL. E a razão é uma correcção a mim próprio.
-- ============================================================================
--
-- A primeira versão era a cópia dos rascunhos: 1121 linhas, 72 `DROP POLICY`,
-- 70 `CREATE POLICY`. A segunda substituiu isso por um ciclo que só reescreve
-- as políticas que ainda usam `auth.uid()` — e sobre produção não reescreve
-- nenhuma.
--
-- Mas continuava a correr, incondicionalmente, `ALTER TABLE`, `CREATE INDEX`,
-- três `CREATE OR REPLACE FUNCTION`, `COMMENT` e `REVOKE`/`GRANT`. Com
-- `IF NOT EXISTS` o estado final ficava igual — e «estado final igual» não é
-- «não executou nada». Um `CREATE OR REPLACE FUNCTION` sobre uma função que já
-- está certa muda-lhe o OID e invalida planos; um `COMMENT` reescreve um
-- comentário idêntico; um `REVOKE` altera ACL.
--
-- Agora cada passo pergunta ao catálogo antes de agir. Sobre produção, a
-- migration não executa uma única instrução de DDL: o único efeito é a linha
-- que o runner escreve no ledger, por fora deste ficheiro.
--
-- ============================================================================
-- 🔴 O QUE SAIU DAQUI: O ENDURECIMENTO DE ACL
-- ============================================================================
--
-- A versão anterior fazia `REVOKE ALL ... FROM PUBLIC` nas três funções.
--
-- Leitura fresca de produção: `get_my_company_id` e `get_my_role` TÊM hoje
-- `PUBLIC EXECUTE`. Ou seja, aquele `REVOKE` não reproduzia o estado vivo —
-- MUDAVA-O. Era endurecimento de segurança novo, a viajar à boleia de uma
-- migration de proveniência.
--
-- Não é que seja má ideia; é que não é esta a migration para isso. Fechar
-- `PUBLIC EXECUTE` em duas funções que 60 políticas atravessam merece a sua
-- própria análise de impacto, os seus testes com `anon`, e o seu rollback.
-- Misturado aqui, passaria por «canonicalização» e ninguém lhe olharia duas
-- vezes.
--
-- Fica como task separada. Esta migration reproduz o que está, e mais nada.
--
-- A única excepção é `get_my_profile_id` QUANDO ELA NÃO EXISTE: aí há que lhe
-- dar uma ACL, e a escolhida é exactamente a que produção tem — PUBLIC sem
-- execução, `anon`/`authenticated`/`service_role` com. Reproduzir o alvo, não
-- inventar um.
--
-- ----------------------------------------------------------------------------
-- SEGURANÇA
-- ----------------------------------------------------------------------------
--
-- · Não destrutiva: não apaga perfis, não apaga ids, não reescreve história.
-- · O backfill é GUARDADO — só preenche onde existe mesmo conta no Auth. Um
--   backfill cego poria `auth_user_id` em perfis sem conta e rebentaria contra
--   a FK, ou pior, inventaria uma ligação que ninguém criou. Em produção
--   afecta ZERO linhas: 29 já ligados, 17 sem conta.
-- · Pós-condições no fim. Falhar aqui desfaz tudo, porque o runner envolve a
--   migration numa transação.
--
-- 🔴 SEM `down` DESTRUTIVO — ver
--    `rollback/101b_identity_reconciliation.recovery.sql`.
--
-- O runner envolve cada migration na sua própria transação, com a escrita no
-- ledger. Por isso não há `BEGIN`/`COMMIT` aqui.
-- ============================================================================

-- ----------------------------------------------------------------------------
-- 1. Colunas — só se faltarem mesmo
-- ----------------------------------------------------------------------------
--
-- `ADD COLUMN IF NOT EXISTS` já não bastava: a instrução corre à mesma e pede
-- o lock da tabela. Perguntar primeiro deixa a tabela em paz.
DO $colunas$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
     WHERE table_schema = 'public' AND table_name = 'profiles'
       AND column_name = 'auth_user_id'
  ) THEN
    ALTER TABLE public.profiles ADD COLUMN auth_user_id uuid;
    COMMENT ON COLUMN public.profiles.auth_user_id IS
      'A conta de acesso desta pessoa, ou NULL se não tiver. Separar isto do '
      '`id` é o que permite existir um perfil sem conta.';
    RAISE NOTICE '101b: profiles.auth_user_id criada.';
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
     WHERE table_schema = 'public' AND table_name = 'profiles'
       AND column_name = 'must_change_password'
  ) THEN
    ALTER TABLE public.profiles
      ADD COLUMN must_change_password boolean NOT NULL DEFAULT false;
    COMMENT ON COLUMN public.profiles.must_change_password IS
      'Marca a troca obrigatória de senha no primeiro acesso.';
    RAISE NOTICE '101b: profiles.must_change_password criada.';
  END IF;
END $colunas$;

-- ----------------------------------------------------------------------------
-- 2. Restrições e índices — idem
-- ----------------------------------------------------------------------------
DO $restricoes$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'profiles_auth_user_id_fkey'
  ) THEN
    ALTER TABLE public.profiles
      ADD CONSTRAINT profiles_auth_user_id_fkey
      FOREIGN KEY (auth_user_id) REFERENCES auth.users(id) ON DELETE SET NULL;
    RAISE NOTICE '101b: FK profiles_auth_user_id_fkey criada.';
  END IF;

  -- 🔴 `profiles_id_fkey` sai, e é a alteração mais consequente deste ficheiro.
  --
  --    Era `profiles.id → auth.users.id`: um perfil SÓ podia existir se houvesse
  --    uma conta com o mesmo id. É isso que impede uma pessoa sem acesso, e é
  --    isso que produção já não tem — há hoje 17 perfis sem conta ligada que só
  --    existem por causa disso.
  --
  --    Também é o que faz `deleteUser` deixar de cascatar para o perfil.
  IF EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'profiles_id_fkey') THEN
    ALTER TABLE public.profiles DROP CONSTRAINT profiles_id_fkey;
    RAISE NOTICE '101b: FK profiles_id_fkey removida.';
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_indexes
     WHERE schemaname = 'public' AND indexname = 'uq_profiles_auth_user_id'
  ) THEN
    CREATE UNIQUE INDEX uq_profiles_auth_user_id
      ON public.profiles(auth_user_id) WHERE auth_user_id IS NOT NULL;
    RAISE NOTICE '101b: índice uq_profiles_auth_user_id criado.';
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_indexes
     WHERE schemaname = 'public' AND indexname = 'idx_profiles_company_auth'
  ) THEN
    CREATE INDEX idx_profiles_company_auth ON public.profiles(company_id, auth_user_id);
    RAISE NOTICE '101b: índice idx_profiles_company_auth criado.';
  END IF;
END $restricoes$;

-- ----------------------------------------------------------------------------
-- 3. Backfill guardado
-- ----------------------------------------------------------------------------
--
-- `WHERE auth_user_id IS NULL` torna isto repetível. O `EXISTS` é a guarda que
-- interessa — sem ele, um perfil sem conta ganharia uma ligação inventada para
-- um utilizador que não existe.
--
-- Em produção afecta ZERO linhas, e isso é medido: os 17 perfis sem
-- `auth_user_id` também não têm conta no Auth com o mesmo id.
UPDATE public.profiles
   SET auth_user_id = id
 WHERE auth_user_id IS NULL
   AND EXISTS (SELECT 1 FROM auth.users u WHERE u.id = public.profiles.id);

-- ----------------------------------------------------------------------------
-- 4. As funções — só se não estiverem já na forma alvo
-- ----------------------------------------------------------------------------
--
-- 🔴 A detecção é ESTRUTURAL, não textual.
--
--    Comparar o corpo com um texto esperado seria refém de espaços e
--    comentários — e sabe-se que o corpo guardado em produção NÃO tem os
--    comentários do rascunho que o gerou. Uma comparação literal dava sempre
--    «diferente» e recriava a função a cada corrida.
--
--    O que se pergunta é o que distingue as formas:
--
--      · `get_my_profile_id` na forma alvo MENCIONA `auth_user_id`. A forma
--        antiga (que nem existe) não mencionaria;
--      · `get_my_company_id`/`get_my_role` na forma alvo DELEGAM em
--        `get_my_profile_id`. Na forma legada leem `profiles` por `auth.uid()`.
--
--    São condições fechadas o suficiente: nenhuma variante de espaçamento ou
--    comentário as troca.
DO $funcoes$
DECLARE
  v_corpo text;
BEGIN
  -- ── get_my_profile_id ─────────────────────────────────────────────────────
  SELECT pg_get_functiondef(p.oid) INTO v_corpo
    FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
   WHERE n.nspname = 'public' AND p.proname = 'get_my_profile_id'
     AND p.pronargs = 0;

  IF v_corpo IS NULL THEN
    EXECUTE $cria$
      CREATE FUNCTION public.get_my_profile_id()
      RETURNS uuid LANGUAGE sql SECURITY DEFINER STABLE SET search_path = public
      AS $fn$
        SELECT id FROM profiles WHERE auth_user_id = auth.uid()
        UNION ALL
        SELECT id FROM profiles p
         WHERE p.id = auth.uid()
           AND EXISTS (SELECT 1 FROM auth.users u WHERE u.id = p.id)
           AND NOT EXISTS (SELECT 1 FROM profiles x WHERE x.auth_user_id = auth.uid())
        LIMIT 1;
      $fn$
    $cria$;

    COMMENT ON FUNCTION public.get_my_profile_id IS
      'O id da pessoa autenticada, ou NULL se não houver sessão ou a conta não '
      'estiver ligada a ninguém. Responde pela coluna auth_user_id e, enquanto '
      'a transição durar, também pela convenção antiga em que profiles.id era '
      'o id do Auth.';

    -- 🔴 A ACL aqui REPRODUZ a de produção, não endurece nada.
    --
    --    Em produção esta função tem PUBLIC sem EXECUTE e os três papéis com.
    --    `anon` precisa mesmo: uma política de RLS é avaliada com os
    --    privilégios de quem pede, e sem isto um pedido anónimo rebentaria com
    --    `permission denied for function` em vez de simplesmente não devolver
    --    nada — o erro revela que a função existe.
    --
    --    Não é relaxamento: sem sessão `auth.uid()` é NULL, a função devolve
    --    NULL, e `id = NULL` nunca é verdadeiro.
    EXECUTE 'REVOKE ALL ON FUNCTION public.get_my_profile_id() FROM PUBLIC';
    DECLARE r text;
    BEGIN
      FOREACH r IN ARRAY ARRAY['authenticated', 'anon', 'service_role'] LOOP
        IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = r) THEN
          EXECUTE format('GRANT EXECUTE ON FUNCTION public.get_my_profile_id() TO %I', r);
        END IF;
      END LOOP;
    END;

    RAISE NOTICE '101b: get_my_profile_id() criada.';
  ELSIF position('auth_user_id' in v_corpo) = 0 THEN
    -- Existe, mas numa forma que não conhece a coluna. Não é o estado vivo, e
    -- também não é o canónico — parar é mais honesto do que substituir às
    -- cegas uma função que 69 políticas usam.
    RAISE EXCEPTION
      '101b: get_my_profile_id() existe numa forma inesperada (não menciona auth_user_id). Rever antes de aplicar.';
  END IF;

  -- ── get_my_company_id ─────────────────────────────────────────────────────
  SELECT pg_get_functiondef(p.oid) INTO v_corpo
    FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
   WHERE n.nspname = 'public' AND p.proname = 'get_my_company_id' AND p.pronargs = 0;

  IF v_corpo IS NULL OR position('get_my_profile_id' in v_corpo) = 0 THEN
    EXECUTE $cria$
      CREATE OR REPLACE FUNCTION public.get_my_company_id()
      RETURNS uuid LANGUAGE sql SECURITY DEFINER STABLE SET search_path = public
      AS $fn$
        SELECT company_id FROM profiles WHERE id = public.get_my_profile_id() LIMIT 1;
      $fn$
    $cria$;
    RAISE NOTICE '101b: get_my_company_id() passou a delegar.';
  END IF;

  -- ── get_my_role ───────────────────────────────────────────────────────────
  SELECT pg_get_functiondef(p.oid) INTO v_corpo
    FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
   WHERE n.nspname = 'public' AND p.proname = 'get_my_role' AND p.pronargs = 0;

  IF v_corpo IS NULL OR position('get_my_profile_id' in v_corpo) = 0 THEN
    EXECUTE $cria$
      CREATE OR REPLACE FUNCTION public.get_my_role()
      RETURNS text LANGUAGE sql SECURITY DEFINER STABLE SET search_path = public
      AS $fn$
        SELECT role FROM profiles WHERE id = public.get_my_profile_id() LIMIT 1;
      $fn$
    $cria$;
    RAISE NOTICE '101b: get_my_role() passou a delegar.';
  END IF;

  -- 🔴 Repare-se no que NÃO está aqui: nenhum REVOKE/GRANT sobre estas duas.
  --    Produção dá-lhes PUBLIC EXECUTE hoje. Mudar isso é endurecimento novo,
  --    e sai desta migration de propósito.
END $funcoes$;

-- ----------------------------------------------------------------------------
-- 5. As políticas — só as que ainda faltam
-- ----------------------------------------------------------------------------
--
-- A transformação é uma só, e está provada. O ciclo percorre o catálogo,
-- encontra as políticas cuja expressão ainda menciona `auth.uid()`, e reescreve
-- APENAS essas. Sobre o estado vivo não encontra nenhuma.
--
-- `permissive`, `cmd` e `roles` são preservados tal como o catálogo os tem —
-- reconstruir a partir do catálogo, e não de texto copiado, elimina a classe
-- de erro em que uma política é recriada com condição subtilmente diferente.
DO $rls$
DECLARE
  p          record;
  v_qual     text;
  v_check    text;
  v_sql      text;
  v_migradas int := 0;
BEGIN
  FOR p IN
    SELECT schemaname, tablename, policyname, permissive, roles, cmd, qual, with_check
      FROM pg_policies
     WHERE schemaname = 'public'
       AND (COALESCE(qual, '') || ' ' || COALESCE(with_check, '')) ~ 'auth\.uid\(\)'
     ORDER BY tablename, policyname
  LOOP
    v_qual  := replace(COALESCE(p.qual, ''),       'auth.uid()', 'public.get_my_profile_id()');
    v_check := replace(COALESCE(p.with_check, ''), 'auth.uid()', 'public.get_my_profile_id()');

    EXECUTE format('DROP POLICY IF EXISTS %I ON %I.%I', p.policyname, p.schemaname, p.tablename);

    v_sql := format(
      'CREATE POLICY %I ON %I.%I AS %s FOR %s TO %s',
      p.policyname, p.schemaname, p.tablename,
      CASE WHEN p.permissive = 'PERMISSIVE' THEN 'PERMISSIVE' ELSE 'RESTRICTIVE' END,
      p.cmd,
      array_to_string(p.roles, ', ')
    );
    IF COALESCE(p.qual, '') <> '' THEN
      v_sql := v_sql || format(' USING (%s)', v_qual);
    END IF;
    IF COALESCE(p.with_check, '') <> '' THEN
      v_sql := v_sql || format(' WITH CHECK (%s)', v_check);
    END IF;

    EXECUTE v_sql;
    v_migradas := v_migradas + 1;
  END LOOP;

  IF v_migradas = 0 THEN
    RAISE NOTICE '101b: nenhuma política por migrar — o catálogo já está no alvo.';
  ELSE
    RAISE NOTICE '101b: % políticas migradas para get_my_profile_id().', v_migradas;
  END IF;
END $rls$;

-- ----------------------------------------------------------------------------
-- 6. Pós-condições
-- ----------------------------------------------------------------------------
DO $post$
DECLARE
  v_restantes int;
  v_orfaos    int;
BEGIN
  SELECT count(*) INTO v_restantes
    FROM pg_policies
   WHERE schemaname = 'public'
     AND (COALESCE(qual, '') || ' ' || COALESCE(with_check, '')) ~ 'auth\.uid\(\)';
  IF v_restantes > 0 THEN
    RAISE EXCEPTION '101b: sobraram % políticas a resolver identidade por auth.uid().', v_restantes;
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
     WHERE table_schema = 'public' AND table_name = 'profiles' AND column_name = 'auth_user_id'
  ) THEN
    RAISE EXCEPTION '101b: profiles.auth_user_id não ficou criada.';
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
     WHERE n.nspname = 'public' AND p.proname = 'get_my_profile_id'
  ) THEN
    RAISE EXCEPTION '101b: get_my_profile_id() não ficou criada.';
  END IF;

  -- Uma ligação para uma conta que não existe seria pior do que ligação
  -- nenhuma: a FK é `ON DELETE SET NULL`, por isso isto tem de dar zero.
  SELECT count(*) INTO v_orfaos
    FROM public.profiles p
   WHERE p.auth_user_id IS NOT NULL
     AND NOT EXISTS (SELECT 1 FROM auth.users u WHERE u.id = p.auth_user_id);
  IF v_orfaos > 0 THEN
    RAISE EXCEPTION '101b: % perfis ligados a contas inexistentes.', v_orfaos;
  END IF;
END $post$;

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
-- ----------------------------------------------------------------------------
-- 🔴 PORQUE É QUE ISTO NÃO É A CÓPIA DOS RASCUNHOS
-- ----------------------------------------------------------------------------
--
-- A primeira versão desta migration era exactamente isso: os três rascunhos
-- concatenados. 1121 linhas, 72 `DROP POLICY`, 70 `CREATE POLICY`, 39 tabelas.
--
-- E dizia de si própria que «sobre produção é um no-op». Era falso. O estado
-- final seria equivalente, mas a operação largava e recriava setenta políticas
-- em trinta e nove tabelas vivas para chegar a um sítio onde já estava. Um
-- no-op semântico não é um no-op operacional, e a diferença é toda em
-- produção.
--
-- Como a transformação é UMA — e isso foi provado, não suposto — ela pode ser
-- escrita uma vez e aplicada só onde ainda falta:
--
--   · sobre o estado canónico antigo, o ciclo encontra as políticas por migrar
--     e reescreve-as;
--   · sobre o estado vivo actual, não encontra nenhuma e não executa DDL
--     nenhum. Zero políticas recriadas, zero tabelas tocadas.
--
-- É também menos código para rever do que setenta pares de DROP/CREATE, e
-- torna impossível a classe de erro que um deles teria: uma política recriada
-- com uma condição subtilmente diferente do original.
--
-- ----------------------------------------------------------------------------
-- SEGURANÇA
-- ----------------------------------------------------------------------------
--
-- · Idempotente por construção: tudo o que cria é `IF NOT EXISTS` ou guardado
--   por leitura do catálogo.
-- · Não destrutiva: não apaga perfis, não apaga ids, não reescreve história.
-- · O backfill é GUARDADO — só preenche onde existe mesmo conta no Auth. Um
--   backfill cego poria `auth_user_id` em perfis sem conta e rebentaria contra
--   a FK, ou pior, inventaria uma ligação que ninguém criou. Em produção não
--   toca em linha nenhuma: 21 activos e 8 não-activos já ligados, os restantes
--   sem conta.
-- · Pós-condições no fim. Falhar aqui desfaz tudo, porque o runner envolve a
--   migration numa transação.
--
-- 🔴 SEM `down` DESTRUTIVO — ver
--    `rollback/101b_identity_reconciliation.recovery.sql`.
--
--    Produção já depende desta identidade: 29 contas ligadas, 69 políticas a
--    resolver por `get_my_profile_id()`. Desmontá-la não é «voltar atrás», é
--    partir o login de quem está a trabalhar. FORWARD_RECOVERY.
--
-- O runner envolve cada migration na sua própria transação, com a escrita no
-- ledger. Por isso não há `BEGIN`/`COMMIT` aqui: fechariam essa transação a
-- meio e deixariam o ledger de fora.
-- ============================================================================

-- ----------------------------------------------------------------------------
-- 1. A coluna, a ligação e os índices
-- ----------------------------------------------------------------------------

ALTER TABLE public.profiles
  ADD COLUMN IF NOT EXISTS auth_user_id uuid;

ALTER TABLE public.profiles
  ADD COLUMN IF NOT EXISTS must_change_password boolean NOT NULL DEFAULT false;

COMMENT ON COLUMN public.profiles.auth_user_id IS
  'A conta de acesso desta pessoa, ou NULL se não tiver. Separar isto do `id` '
  'é o que permite existir um perfil sem conta — e é por isso que '
  '`profiles_id_fkey` deixou de fazer sentido.';

COMMENT ON COLUMN public.profiles.must_change_password IS
  'Marca a troca obrigatória de senha no primeiro acesso.';

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

-- 🔴 `profiles_id_fkey` sai, e é a alteração mais consequente deste ficheiro.
--
--    Era `profiles.id → auth.users.id`: um perfil SÓ podia existir se houvesse
--    uma conta com o mesmo id. É isso que impede uma pessoa sem acesso, e é
--    isso que produção já não tem — foi largada quando o rascunho EXPAND lá
--    chegou, e há hoje 17 perfis sem conta ligada que só existem por causa
--    disso.
--
--    Também é o que faz `deleteUser` deixar de cascatar para o perfil. Quem
--    contar com esse cascade está a contar com uma coisa que já não acontece.
ALTER TABLE public.profiles
  DROP CONSTRAINT IF EXISTS profiles_id_fkey;

CREATE UNIQUE INDEX IF NOT EXISTS uq_profiles_auth_user_id
  ON public.profiles(auth_user_id)
  WHERE auth_user_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_profiles_company_auth
  ON public.profiles(company_id, auth_user_id);

-- ----------------------------------------------------------------------------
-- 2. Backfill guardado
-- ----------------------------------------------------------------------------
--
-- `WHERE auth_user_id IS NULL` torna isto repetível: correr duas vezes não
-- sobrescreve nada. O `EXISTS` é a guarda que interessa — sem ele, um perfil
-- sem conta ganharia uma ligação inventada para um utilizador que não existe.
UPDATE public.profiles
   SET auth_user_id = id
 WHERE auth_user_id IS NULL
   AND EXISTS (SELECT 1 FROM auth.users u WHERE u.id = public.profiles.id);

-- ----------------------------------------------------------------------------
-- 3. A camada canónica de identidade
-- ----------------------------------------------------------------------------
--
-- Responde pelas duas vias: a coluna primeiro, a convenção antiga como rede.
-- O ramo de compatibilidade exige que a conta EXISTA no Auth — sem isso, uma
-- pessoa sem conta ficaria alcançável por quem soubesse o seu id.
CREATE OR REPLACE FUNCTION public.get_my_profile_id()
RETURNS uuid
LANGUAGE sql
SECURITY DEFINER
STABLE
SET search_path = public
AS $fn$
  SELECT id FROM profiles WHERE auth_user_id = auth.uid()
  UNION ALL
  SELECT id FROM profiles p
   WHERE p.id = auth.uid()
     AND EXISTS (SELECT 1 FROM auth.users u WHERE u.id = p.id)
     AND NOT EXISTS (SELECT 1 FROM profiles x WHERE x.auth_user_id = auth.uid())
  LIMIT 1;
$fn$;

COMMENT ON FUNCTION public.get_my_profile_id IS
  'O id da pessoa autenticada, ou NULL se não houver sessão ou a conta não '
  'estiver ligada a ninguém. Responde pela coluna auth_user_id e, enquanto a '
  'transição durar, também pela convenção antiga em que profiles.id era o id '
  'do Auth.';

CREATE OR REPLACE FUNCTION public.get_my_company_id()
RETURNS uuid
LANGUAGE sql
SECURITY DEFINER
STABLE
SET search_path = public
AS $fn$
  SELECT company_id FROM profiles WHERE id = public.get_my_profile_id() LIMIT 1;
$fn$;

CREATE OR REPLACE FUNCTION public.get_my_role()
RETURNS text
LANGUAGE sql
SECURITY DEFINER
STABLE
SET search_path = public
AS $fn$
  SELECT role FROM profiles WHERE id = public.get_my_profile_id() LIMIT 1;
$fn$;

-- 🔴 `anon` também executa, e é preciso.
--
--    Uma política de RLS é avaliada com os privilégios de quem faz o pedido.
--    Se `anon` não puder chamar a função, um pedido anónimo rebenta com
--    `permission denied for function` em vez de simplesmente não devolver
--    nada — e o erro revela que a função existe, transformando uma negação
--    silenciosa numa falha ruidosa que o cliente vê.
--
--    Não é relaxamento: sem sessão `auth.uid()` é NULL, a função devolve NULL,
--    e `id = NULL` nunca é verdadeiro.
--
--    Concede-se a quem existir: uma base de ensaio pode não ter os três papéis,
--    e um GRANT a um papel inexistente abortaria a migration inteira.
DO $grants$
DECLARE
  r text;
  f text;
BEGIN
  FOREACH f IN ARRAY ARRAY['get_my_profile_id()', 'get_my_company_id()', 'get_my_role()'] LOOP
    EXECUTE format('REVOKE ALL ON FUNCTION public.%s FROM PUBLIC', f);
    FOREACH r IN ARRAY ARRAY['authenticated', 'anon', 'service_role'] LOOP
      IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = r) THEN
        EXECUTE format('GRANT EXECUTE ON FUNCTION public.%s TO %I', f, r);
      END IF;
    END LOOP;
  END LOOP;
END $grants$;

-- ----------------------------------------------------------------------------
-- 4. As políticas — só as que ainda faltam
-- ----------------------------------------------------------------------------
--
-- 🔴 É aqui que esta migration se distingue de uma cópia dos rascunhos.
--
--    A transformação é uma só, e está provada. Em vez de setenta pares de
--    DROP/CREATE escritos à mão, o ciclo abaixo percorre o catálogo, encontra
--    as políticas cuja expressão ainda menciona `auth.uid()`, e reescreve
--    APENAS essas — com a mesma condição, com a substituição aplicada.
--
--    Sobre o estado vivo actual, `pg_policies` não devolve nenhuma. O bloco
--    não executa um único `DROP POLICY`, não toca em nenhuma das 39 tabelas, e
--    não há churn nenhum. É isso que a pista de produção mede, comparando os
--    OIDs das políticas antes e depois: uma política recriada muda de OID.
--
--    `permissive`, `cmd` e `roles` são preservados tal como o catálogo os tem.
--    Reconstruir a política a partir do catálogo, e não de um texto copiado,
--    também elimina a classe de erro em que uma das setenta era recriada com
--    uma condição subtilmente diferente da original.
DO $rls$
DECLARE
  p            record;
  v_qual       text;
  v_check      text;
  v_sql        text;
  v_migradas   int := 0;
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

    v_sql := format('DROP POLICY IF EXISTS %I ON %I.%I', p.policyname, p.schemaname, p.tablename);
    EXECUTE v_sql;

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
-- 5. Pós-condições
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

-- ============================================================================
-- ROLLBACK PROVISIONAL — identidade de colaborador: EXPAND (PHASE A)
-- ============================================================================
--
-- 🔴 NÃO APLICADO. Desfaz a PHASE A: larga `profiles.auth_user_id`, os seus
--    índices e `get_my_profile_id()`.
--
-- ---------------------------------------------------------------------------
-- A guarda vem antes de tudo
-- ---------------------------------------------------------------------------
--
-- Se já existir **uma** pessoa sem conta de acesso, este rollback recusa-se a
-- correr.
--
-- A razão é simples de dizer: enquanto a coluna existe, `auth_user_id IS NULL`
-- quer dizer «esta pessoa trabalha aqui e não entra na aplicação». Sem a
-- coluna, essa distinção desaparece — e o que fica é um perfil cujo `id` não
-- corresponde a nenhuma conta, que é exactamente a forma de um registo
-- corrompido. A folha de pagamento, os documentos e as equipas continuariam a
-- apontar para alguém que o sistema já não sabe explicar.
--
--     ROLLBACK_WITH_NEW_DATA = BLOCKED
--
-- 🔴 A verificação corre **antes** de qualquer DDL. O `BEGIN`/`COMMIT` já
--    garantia a atomicidade; a ordem torna a intenção legível — pergunta-se
--    primeiro, mexe-se depois.
--
-- Para largar mesmo a coluna é preciso decidir o que fazer a cada uma dessas
-- pessoas. Essa é uma decisão de quem gere a empresa, não um efeito colateral
-- de um rollback de schema.
-- ============================================================================

BEGIN;

-- ─── 1. A guarda ────────────────────────────────────────────────────────────
DO $guard$
DECLARE
  v_sem_acesso bigint;
BEGIN
  IF to_regclass('public.profiles') IS NULL THEN
    RETURN;
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
     WHERE table_schema = 'public' AND table_name = 'profiles'
       AND column_name = 'auth_user_id'
  ) THEN
    -- A coluna não existe: não há nada a proteger nem a largar.
    RETURN;
  END IF;

  SELECT count(*) INTO v_sem_acesso
    FROM public.profiles WHERE auth_user_id IS NULL;

  IF v_sem_acesso > 0 THEN
    RAISE EXCEPTION
      'ROLLBACK_BLOCKED_PROFILES_WITHOUT_AUTH: % pessoa(s) sem conta de acesso. '
      'Largar a coluna apagaria a única coisa que as distingue de um registo '
      'inválido, e a folha, os documentos e as equipas continuariam a apontar '
      'para elas. Decidir primeiro o que fazer a cada uma.', v_sem_acesso
      USING ERRCODE = 'object_not_in_prerequisite_state';
  END IF;
END
$guard$;

-- ─── 2. A camada canónica sai ───────────────────────────────────────────────
--
-- `get_my_profile_id()` lê a coluna: larga-se primeiro, senão fica uma função
-- a referir-se a algo que já não existe.
--
-- 🔴 `get_my_company_id()` e `get_my_role()` **não** se tocam — são da 014 e
--    não têm nada a ver com esta migration.
DROP FUNCTION IF EXISTS public.get_my_profile_id();

-- ─── 3. E a coluna ──────────────────────────────────────────────────────────
--
-- Chegar aqui significa que a guarda passou: toda a gente tem conta, e o valor
-- da coluna é igual ao `id` em todas as linhas. Largá-la não perde informação
-- nenhuma — é o que a torna reversível enquanto ninguém a tiver usado.
DROP INDEX IF EXISTS public.uq_profiles_auth_user_id;
DROP INDEX IF EXISTS public.idx_profiles_company_auth;

ALTER TABLE public.profiles
  DROP CONSTRAINT IF EXISTS profiles_auth_user_id_fkey;

ALTER TABLE public.profiles
  DROP COLUMN IF EXISTS auth_user_id;

-- ─── 4. E a chave estrangeira da 002 volta ──────────────────────────────────
--
-- 🔴 Sem isto o rollback ficava a meio: a coluna desaparecia mas a exigência
--    de que cada pessoa tenha conta não voltava, e a base ficava num estado
--    que nem a 002 nem o EXPAND produzem.
--
--    Só é possível porque a guarda acima já provou que toda a gente tem conta
--    — se houvesse alguém sem ela, esta linha falharia, e é bom que falhasse.
DO $fk002$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
     WHERE conname = 'profiles_id_fkey'
       AND conrelid = 'public.profiles'::regclass
  ) THEN
    ALTER TABLE public.profiles
      ADD CONSTRAINT profiles_id_fkey
      FOREIGN KEY (id) REFERENCES auth.users(id) ON DELETE CASCADE;
  END IF;
END
$fk002$;

COMMIT;

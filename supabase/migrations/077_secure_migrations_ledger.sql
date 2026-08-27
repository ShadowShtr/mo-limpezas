-- ============================================================================
-- 077 - Fecha o acesso público a public._migrations
-- ============================================================================
-- Achado (auditoria read-only da produção, 2026-08-24):
--
--     OWNER          = postgres
--     RLS_ENABLED    = false
--     RLS_FORCED     = false
--     POLICIES_TOTAL = 1
--
--     anon          → SELECT, INSERT, UPDATE, DELETE, TRUNCATE,
--                     REFERENCES, TRIGGER, MAINTAIN
--     authenticated → privilégios igualmente amplos
--
-- A chave `anon` viaja no bundle do browser. Foi provado por chamada real à
-- API que ela **lê** o ledger inteiro: 77 linhas, com nome de ficheiro,
-- checksum e data de cada migration já aplicada — ou seja, o histórico de
-- evolução do schema desta base, disponível a quem abrir as ferramentas de
-- programador.
--
-- Os privilégios de escrita estão presentes ao nível do Postgres. Isso **não**
-- é o mesmo que dizer que foram explorados pela API: não se fez nenhum teste
-- destrutivo, e não se afirma aqui o que não foi medido. Mas um privilégio de
-- DELETE ou TRUNCATE atribuído a `anon` sobre a tabela que regista o que já
-- correu na base não precisa de ter sido usado para estar errado.
--
-- Existe 1 policy anterior. Com RLS desligada, ela não protege nada hoje.
--
-- ---------------------------------------------------------------------------
-- O que esta migration faz, e o que deliberadamente não faz
-- ---------------------------------------------------------------------------
--
--   1. REVOKE ALL de PUBLIC, anon e authenticated;
--   2. ENABLE ROW LEVEL SECURITY;
--   3. uma policy RESTRICTIVE que nega tudo a anon e authenticated.
--
-- Três camadas para o mesmo objetivo, e cada uma cobre uma falha da anterior:
-- os grants podem ser reconcedidos por engano numa migration futura; a RLS
-- sozinha não faz nada sem policies; e uma policy permissiva criada mais tarde
-- não consegue reabrir estes roles enquanto existir uma RESTRICTIVE a negá-los.
--
-- 🔴 NÃO apaga a policy anterior. A sua semântica completa ainda não foi
--    caracterizada, e destruir uma regra que não se percebe é a forma mais
--    fácil de partir alguma coisa a tentar proteger outra. Uma policy
--    RESTRICTIVE bloqueia anon/authenticated **independentemente** do que
--    qualquer policy permissiva diga — por isso não é preciso removê-la para
--    fechar a porta.
--
-- 🔴 NÃO usa FORCE ROW LEVEL SECURITY. O dono da tabela é `postgres`, que é a
--    identidade com que o runner de migrations se liga. FORCE faria as
--    policies aplicarem-se também ao dono — e o próprio runner precisa de
--    fazer `INSERT INTO public._migrations` para registar esta migration,
--    dentro da mesma transação que a executa. Uma migration de segurança que
--    impede o sistema de migrations de registar a sua própria aplicação
--    deixaria a base protegida e o ledger a mentir.
--
-- 🔴 NÃO toca em service_role. Não há evidência de que removê-lo não parta
--    ferramentas legítimas, e o objetivo desta ronda é a superfície pública.
--
-- 🔴 NÃO altera uma única linha de dados. As 77 entradas existentes ficam
--    exatamente como estão — nome, checksum e applied_at. A única linha nova
--    será a desta própria migration, escrita pelo runner, não por este SQL.
--
-- Origem histórica: a intenção vem da antiga `066_secure_migrations_ledger.sql`,
-- que nunca foi aplicada e vive apenas na branch congelada
-- `fix/atomic-contract-calendar-sync`. Aqui é portada e adaptada ao estado
-- real de hoje — não ressuscitada com o número antigo, que pertence a um
-- buraco na sequência que não se preenche por estética.
-- ============================================================================

DO $$
BEGIN
  -- A tabela é a razão de ser desta migration. Se não existir, alguma coisa
  -- está muito diferente do esperado e continuar às cegas seria pior do que
  -- parar.
  IF to_regclass('public._migrations') IS NULL THEN
    RAISE EXCEPTION
      'public._migrations não existe — a 077 protege o ledger e não tem o que proteger.';
  END IF;
END
$$;

-- ── 1. Revogar os privilégios de tabela ────────────────────────────────────
--
-- PUBLIC é revogado explicitamente: um privilégio concedido a PUBLIC aplica-se
-- a todos os roles, presentes e futuros, e não aparece na lista de nenhum
-- deles em particular.
REVOKE ALL ON TABLE public._migrations FROM PUBLIC;

DO $$
BEGIN
  -- Os roles do Supabase existem em produção, mas uma base descartável ou um
  -- ambiente de ensaio pode não os ter. Revogar de um role inexistente é um
  -- erro que abortaria a transação inteira.
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'anon') THEN
    REVOKE ALL ON TABLE public._migrations FROM anon;
  END IF;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'authenticated') THEN
    REVOKE ALL ON TABLE public._migrations FROM authenticated;
  END IF;
END
$$;

-- ── 2. Ligar RLS ───────────────────────────────────────────────────────────
--
-- Sozinha não decide nada; é o interruptor que faz as policies passarem a
-- contar. Sem isto, a policy do passo 3 seria decoração.
ALTER TABLE public._migrations ENABLE ROW LEVEL SECURITY;

-- ── 3. Negação restritiva para os roles públicos ───────────────────────────
--
-- `AS RESTRICTIVE` é a escolha central deste ficheiro. Policies permissivas
-- combinam-se por OR: bastaria uma nova para reabrir o acesso. As restritivas
-- combinam-se por AND — enquanto esta existir, nenhuma policy futura consegue
-- conceder leitura ou escrita a anon/authenticated, mesmo que alguém a crie
-- sem perceber o que está a fazer.
--
-- O `DROP ... IF EXISTS` é só desta policy, pelo nome exato, para a migration
-- ser reexecutável num ambiente de ensaio. Nunca toca nas outras.
DROP POLICY IF EXISTS "_migrations_deny_public_roles" ON public._migrations;

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'anon')
     AND EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'authenticated') THEN
    EXECUTE $policy$
      CREATE POLICY "_migrations_deny_public_roles"
      ON public._migrations
      AS RESTRICTIVE
      FOR ALL
      TO anon, authenticated
      USING (false)
      WITH CHECK (false)
    $policy$;
  END IF;
END
$$;

COMMENT ON TABLE public._migrations IS
  'Ledger interno do runner de migrations. Sem acesso público: os grants de PUBLIC/anon/authenticated foram revogados pela 077 e uma policy RESTRICTIVE nega esses roles. Escrita apenas pelo runner administrativo.';

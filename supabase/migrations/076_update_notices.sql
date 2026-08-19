-- ============================================================
-- MIGRATION 076: Avisos de atualização por perfil
--
-- Duas coisas que este projecto não tinha:
--
--   1. **Administração de plataforma.** `profiles.role` só conhece `admin`,
--      `gestor` e `colaboradora` — todos dentro de um tenant
--      (`profiles.company_id`). Um `admin` é administrador *da sua empresa*,
--      não da plataforma. Publicar um aviso para várias empresas é uma
--      operação acima do tenant, e não havia primitiva para isso.
--
--   2. **Registo de que alguém leu um aviso.** As notas de versão vivem em
--      código (`src/release-notes/`), mas «o João já viu» é estado por perfil.
--
-- 🔴 A identidade de administrador de plataforma é por `profile_id`, nunca por
--    nome, email ou slug. Um mecanismo de autorização que reconheça alguém
--    pelo nome é um mecanismo que se contorna mudando o nome.
-- ============================================================

BEGIN;

-- ── Administração de plataforma ─────────────────────────────────────────────
--
-- Deliberadamente uma tabela, e não uma coluna em `profiles`: um papel que
-- atravessa tenants não pertence a uma linha que é, ela própria, de um tenant.
-- Ficar visível numa listagem separada também torna a pergunta «quem tem este
-- poder?» respondível com um SELECT.

CREATE TABLE IF NOT EXISTS public.platform_admins (
  profile_id uuid        PRIMARY KEY REFERENCES public.profiles(id) ON DELETE CASCADE,
  granted_at timestamptz NOT NULL DEFAULT now(),
  granted_by uuid        REFERENCES public.profiles(id) ON DELETE SET NULL,
  note       text
);

COMMENT ON TABLE public.platform_admins IS
  'Administração ACIMA do tenant: publica avisos para várias empresas. '
  'Distinto de profiles.role = admin, que é administrador de UMA empresa.';

-- ── Avisos ──────────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS public.app_notices (
  id           uuid        PRIMARY KEY DEFAULT gen_random_uuid(),

  -- Identidade estável do aviso. Para as notas automáticas é a chave do
  -- ficheiro em `src/release-notes/`; para os manuais, um valor gerado.
  -- É por aqui que `app_notice_reads` liga, e é o que permite às duas fontes
  -- — código e base — partilharem o mesmo contrato de leitura.
  notice_key   text        NOT NULL UNIQUE,

  kind         text        NOT NULL
               CHECK (kind IN ('correcao', 'novidade', 'aviso', 'manutencao')),
  title        text        NOT NULL CHECK (length(trim(title)) > 0),
  message      text        NOT NULL CHECK (length(trim(message)) > 0),

  -- 'all' | 'companies' | 'profiles' — quem recebe. Os dois últimos leem
  -- `app_notice_targets`.
  audience     text        NOT NULL DEFAULT 'all'
               CHECK (audience IN ('all', 'companies', 'profiles')),

  -- `NULL` = rascunho. Publicar é definir isto, **no servidor**.
  published_at timestamptz,
  archived_at  timestamptz,

  created_by   uuid        REFERENCES public.profiles(id) ON DELETE SET NULL,
  created_at   timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_app_notices_published
  ON public.app_notices (published_at)
  WHERE published_at IS NOT NULL AND archived_at IS NULL;

-- ── Destinatários ───────────────────────────────────────────────────────────
--
-- Uma linha por empresa ou por perfil. `audience = 'all'` não tem linhas —
-- não se materializa a lista de toda a gente, que envelheceria mal quando
-- entrasse uma empresa nova.

CREATE TABLE IF NOT EXISTS public.app_notice_targets (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  notice_id  uuid NOT NULL REFERENCES public.app_notices(id) ON DELETE CASCADE,
  company_id uuid REFERENCES public.companies(id) ON DELETE CASCADE,
  profile_id uuid REFERENCES public.profiles(id)  ON DELETE CASCADE,

  -- Exactamente um dos dois. Uma linha com ambos, ou com nenhum, não
  -- significa nada.
  CONSTRAINT app_notice_targets_um_alvo CHECK (
    (company_id IS NOT NULL AND profile_id IS NULL)
    OR (company_id IS NULL AND profile_id IS NOT NULL)
  )
);

CREATE INDEX IF NOT EXISTS idx_app_notice_targets_notice
  ON public.app_notice_targets (notice_id);

-- 🔴 A mesma empresa (ou o mesmo perfil) não pode ser alvo duas vezes do mesmo
--    aviso. Sem isto, um duplicado no selector do cliente inflava a contagem
--    de destinatários — o painel dizia «enviado para 12 perfis» quando eram 8.
--
--    Parciais porque exactamente uma das colunas é `NULL` em cada linha (ver
--    `app_notice_targets_um_alvo`), e `NULL` não colide com `NULL` num índice
--    único normal.
CREATE UNIQUE INDEX IF NOT EXISTS uq_app_notice_targets_company
  ON public.app_notice_targets (notice_id, company_id) WHERE company_id IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS uq_app_notice_targets_profile
  ON public.app_notice_targets (notice_id, profile_id) WHERE profile_id IS NOT NULL;

-- ── Leituras ────────────────────────────────────────────────────────────────
--
-- 🔴 A chave primária composta É a idempotência. Dois cliques no «Entendi», ou
--    dois separadores abertos, não podem criar duas linhas — e com esta chave
--    a segunda tentativa é um conflito que se ignora, não um duplicado.
--
--    `notice_key` em vez de `notice_id`: as notas automáticas vivem em código
--    e não têm linha em `app_notices`. Ligar pela chave textual deixa as duas
--    fontes usarem exactamente o mesmo registo de leitura.

CREATE TABLE IF NOT EXISTS public.app_notice_reads (
  profile_id uuid        NOT NULL REFERENCES public.profiles(id) ON DELETE CASCADE,
  notice_key text        NOT NULL,
  read_at    timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (profile_id, notice_key)
);

CREATE INDEX IF NOT EXISTS idx_app_notice_reads_profile
  ON public.app_notice_reads (profile_id);

-- ── RLS ─────────────────────────────────────────────────────────────────────
--
-- 🔴 SERVICE_ROLE_BYPASSES_RLS = YES · SERVER_AUTHORIZATION_REQUIRED = YES
--
--    As server actions usam service-role, que ignora RLS por completo. Toda a
--    autorização real — sessão, tenant, `platform_admins` — é feita no
--    servidor, em `src/app/actions/update-notices.ts`.
--
--    Estas policies são a **segunda** camada, independente da primeira. Uma
--    não justifica a ausência da outra: a verificação manual no servidor não
--    torna aceitável uma RLS permissiva, e a RLS não substitui a verificação.
--
-- 🔴 CONTEÚDO E ALVOS: FAIL CLOSED.
--
--    A primeira versão desta migration tinha
--    `FOR SELECT USING (published_at IS NOT NULL AND archived_at IS NULL)`
--    sobre `app_notices` — o que deixava qualquer sessão autenticada ler
--    **todos** os avisos publicados, incluindo os dirigidos a outra empresa ou
--    a um perfil específico. Proteger `app_notice_targets` não protegia o
--    conteúdo: o texto do aviso está em `app_notices`.
--
--    Não há policy de SELECT em `app_notices` nem em `app_notice_targets`. Sem
--    policy, RLS activa nega tudo — e um `select()` acidental a partir do
--    cliente falha em vez de vazar avisos de outros tenants.
--
--    O caminho legítimo é `getPendingNotices`, onde o perfil da sessão decide
--    o que sai.

ALTER TABLE public.platform_admins   ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.app_notices       ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.app_notice_targets ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.app_notice_reads  ENABLE ROW LEVEL SECURITY;

-- Saber se é administrador de plataforma: só sobre si próprio.
DROP POLICY IF EXISTS "read own platform admin row" ON public.platform_admins;
CREATE POLICY "read own platform admin row" ON public.platform_admins
  FOR SELECT USING (profile_id = auth.uid());

-- Remove explicitamente a policy permissiva, caso uma base já a tenha da
-- versão anterior deste ficheiro.
DROP POLICY IF EXISTS "read published notices" ON public.app_notices;
DROP POLICY IF EXISTS "read own targets" ON public.app_notice_targets;

-- Ler as próprias leituras é inofensivo e útil.
DROP POLICY IF EXISTS "read own reads" ON public.app_notice_reads;
CREATE POLICY "read own reads" ON public.app_notice_reads
  FOR SELECT USING (profile_id = auth.uid());

-- 🔴 ESCRITA DE LEITURAS: FAIL CLOSED.
--
--    A primeira versão tinha `FOR INSERT WITH CHECK (profile_id = auth.uid())`,
--    o que parecia seguro — ninguém marcava por outra pessoa. Mas o `WITH
--    CHECK` só valida a **coluna do perfil**: qualquer sessão autenticada podia
--    gravar `(o meu profile_id, uma notice_key à escolha)` e assim marcar como
--    lido um aviso que nunca lhe foi entregue — uma release ainda fora do lote,
--    ou um aviso manual dirigido a outra empresa. O aviso desaparecia sem
--    nunca ter sido mostrado.
--
--    A validação de que a chave pertence ao ciclo actual daquele perfil vive
--    em `markNoticeAsRead`, e uma policy de INSERT permitia contorná-la por
--    completo. Sem policy, o único caminho é a server action.
DROP POLICY IF EXISTS "insert own reads" ON public.app_notice_reads;

COMMIT;

-- ---------------------------------------------------------------------------
-- ROLLBACK
-- ---------------------------------------------------------------------------
--
-- PRE-USE — enquanto não houver avisos publicados nem leituras registadas:
--
--   DROP TABLE IF EXISTS public.app_notice_reads   CASCADE;
--   DROP TABLE IF EXISTS public.app_notice_targets CASCADE;
--   DROP TABLE IF EXISTS public.app_notices        CASCADE;
--   DROP TABLE IF EXISTS public.platform_admins    CASCADE;
--
-- POST-USE — depois de pessoas terem lido avisos, **nunca `DROP`**: as
-- leituras são o que impede um aviso já visto de reaparecer. Reverter o
-- runtime/UI para o deploy anterior preserva as linhas e a feature fica
-- invisível, mas recuperável.

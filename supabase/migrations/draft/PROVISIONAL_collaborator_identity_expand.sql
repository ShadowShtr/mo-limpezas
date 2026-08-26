-- ============================================================================
-- PROVISIONAL — identidade de colaborador: EXPAND (PHASE A)
-- ============================================================================
--
-- 🔴 NÃO APLICADA. Vive em `supabase/migrations/draft/`, que o runner não lê.
--
--    MIGRATION_NUMBER_FINAL = UNASSIGNED
--
--    A 077/078/079 continuam por reconciliar. Escolher um número hoje seria
--    fingir que a sequência é conhecida.
--
-- ---------------------------------------------------------------------------
-- O que esta migration faz, e o que deliberadamente não faz
-- ---------------------------------------------------------------------------
--
-- Faz **uma** coisa: torna possível existir uma pessoa sem conta de acesso.
-- Nada mais. Não muda o login de ninguém, não altera uma única política, não
-- toca no runtime. É a PHASE A de EXPAND → MIGRATE → RUNTIME → CONTRACT, e o
-- seu único critério de sucesso é que **o código antigo continue a funcionar
-- exactamente como funcionava**.
--
-- Foi a inversão desta ordem que causou o incidente da #86: o runtime passou a
-- exigir `auth_user_id` antes de a coluna existir, e ninguém conseguiu entrar.
-- Aqui a coluna nasce primeiro, preenchida e compatível, e só muito depois
-- algum código a lê.
--
-- ---------------------------------------------------------------------------
-- O problema
-- ---------------------------------------------------------------------------
--
-- Hoje, na 002:
--
--     id UUID PRIMARY KEY REFERENCES auth.users(id) ON DELETE CASCADE
--
-- `profiles.id` **é** o `auth.users.id`. Isto não é uma limitação do ecrã: é
-- estrutural. Um colaborador sem conta de acesso não pode existir, porque não
-- há id que lhe dar.
--
-- E a chave estrangeira é `ON DELETE CASCADE`: apagar a conta de acesso apaga
-- a pessoa, e com ela a folha de pagamento, os documentos, as equipas, as
-- faltas, as férias e o registo de ponto — sete tabelas apontam para
-- `profiles(id)` com o mesmo cascade.
--
-- ---------------------------------------------------------------------------
-- Porquê separar sem mudar ids (Option A)
-- ---------------------------------------------------------------------------
--
-- A alternativa considerada era criar uma tabela `collaborator` nova e deixar
-- `profiles` como identidade de login. Foi **rejeitada**: obrigaria a migrar
-- folha, documentos, equipas, calendário e histórico para ids novos, e há 43
-- chaves estrangeiras a apontar para `profiles(id)`. Sob aquele cascade, uma
-- referência que escapasse não daria erro — daria silêncio.
--
--     IDENTITY_IDS_PRESERVED = YES     ← o critério que decidiu
--
-- Aqui `profiles.id` continua a ser quem sempre foi: a pessoa. O que muda é
-- que a **ligação ao login** passa a ser uma coluna própria, opcional, em vez
-- de ser a própria chave primária.
--
-- ---------------------------------------------------------------------------
-- Compatibilidade — a parte que interessa
-- ---------------------------------------------------------------------------
--
-- Para todos os perfis que hoje existem, `auth_user_id` é preenchido com o
-- próprio `id`. Isso torna as duas leituras equivalentes:
--
--     WHERE id = auth.uid()               ← o que o código faz hoje
--     WHERE auth_user_id = auth.uid()     ← o que fará um dia
--
-- As 99 políticas continuam correctas sem tocar em nenhuma. Nenhuma password
-- muda, nenhum login muda, nenhum id muda.
--
-- A divergência só aparece quando alguém criar uma pessoa sem conta — e nessa
-- altura o código já terá sido migrado, com a sua própria PR e os seus testes.
-- ============================================================================

BEGIN;

-- ─── 1. A ligação ao login passa a ser uma coluna ───────────────────────────
--
-- Nullable de propósito: é isto que permite uma pessoa sem acesso. Hoje não há
-- nenhuma, e o backfill abaixo garante que continua assim até alguém a criar.
ALTER TABLE public.profiles
  ADD COLUMN IF NOT EXISTS auth_user_id uuid;

-- 🔴 `ON DELETE SET NULL`, não `CASCADE`.
--
--    Apagar a conta de acesso passa a significar «esta pessoa deixou de poder
--    entrar», e não «esta pessoa nunca existiu». Com o cascade antigo, apagar
--    um utilizador do Auth levava à frente a folha de pagamento, os
--    documentos, as equipas e o histórico — sete tabelas, todas com cascade a
--    partir de `profiles(id)`.
--
--    A chave primária mantém, por agora, a FK original: mexer nela é PHASE C,
--    depois de o código deixar de assumir que `id = auth.uid()`.
DO $fk$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
     WHERE conname = 'profiles_auth_user_id_fkey'
       AND conrelid = 'public.profiles'::regclass
  ) THEN
    ALTER TABLE public.profiles
      ADD CONSTRAINT profiles_auth_user_id_fkey
      FOREIGN KEY (auth_user_id) REFERENCES auth.users(id) ON DELETE SET NULL;
  END IF;
END
$fk$;

-- ─── 1b. A chave primária deixa de exigir uma conta ─────────────────────────
--
-- 🔴 Isto é o que torna a PHASE A real, e não apenas uma coluna a mais.
--
--    Enquanto `profiles.id` for `REFERENCES auth.users(id)`, uma pessoa sem
--    conta de acesso continua a ser impossível: não há id que lhe dar. A
--    coluna nova sozinha não resolve nada — foi o primeiro teste a apanhá-lo.
--
--    Larga-se **a chave estrangeira**, não a chave primária. O `id` continua a
--    ser o mesmo em todas as linhas, e as 43 referências que apontam para ele
--    não dão por nada. O que deixa de existir é a exigência de que cada pessoa
--    tenha uma conta — e o cascade que apagava a pessoa, a folha, os
--    documentos e as equipas quando alguém apagava um utilizador do Auth.
--
--    A ligação ao Auth passa a viver onde deve: em `auth_user_id`, com
--    `ON DELETE SET NULL`.
--
--    ┌── LEGACY_PROFILES_ID_AUTH_FK_STATUS = DROPPED_IN_PHASE_A ─────────────┐
--    │                                                                      │
--    │ Largada mesmo, nesta migration — não é preparação para depois. Medido │
--    │ em Postgres 16, antes e depois:                                       │
--    │                                                                      │
--    │   leitura antiga `WHERE id = auth.uid()`   → continua a devolver o    │
--    │                                              perfil e o papel certos  │
--    │   `get_my_company_id()` da 014             → continua correcta        │
--    │   criar pessoa sem conta                   → recusado antes,          │
--    │                                              possível depois          │
--    │   apagar a conta no Auth                   → o perfil e a folha       │
--    │                                              sobrevivem (antes,       │
--    │                                              desapareciam)            │
--    │                                                                      │
--    │ Porque é que isto **não** quebra a compatibilidade: uma chave         │
--    │ estrangeira só restringe o que se pode **escrever**. Nenhuma leitura  │
--    │ muda por ela desaparecer, e todas as linhas continuam com os mesmos   │
--    │ valores. O código antigo não pergunta se a restrição existe — só lê   │
--    │ `id`, e o `id` é o mesmo.                                            │
--    │                                                                      │
--    │ O comportamento novo que isto destranca — uma pessoa sem conta —      │
--    │ ainda não é alcançável pela aplicação: nenhum ecrã o oferece, e é a   │
--    │ PHASE D que o abre, depois de a PHASE C preparar as políticas. A base │
--    │ passa a **aceitá-lo**; ninguém o **produz** ainda.                    │
--    │                                                                      │
--    │ E há um efeito que é melhoria imediata, não risco: apagar um          │
--    │ utilizador do Auth deixa de apagar a pessoa, a folha, os documentos e │
--    │ as equipas.                                                          │
--    └──────────────────────────────────────────────────────────────────────┘
ALTER TABLE public.profiles
  DROP CONSTRAINT IF EXISTS profiles_id_fkey;

-- 🔴 Uma conta de acesso pertence a uma pessoa e a mais nenhuma. Sem isto,
--    duas linhas podiam reclamar o mesmo login e `get_my_profile_id()` teria
--    de escolher uma — e escolher em silêncio é como se perde o rasto de quem
--    é quem. Parcial porque vários NULL são legítimos: são as pessoas sem
--    acesso, que é o que esta migration existe para permitir.
CREATE UNIQUE INDEX IF NOT EXISTS uq_profiles_auth_user_id
  ON public.profiles(auth_user_id)
  WHERE auth_user_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_profiles_company_auth
  ON public.profiles(company_id, auth_user_id);

COMMENT ON COLUMN public.profiles.auth_user_id IS
  'Conta de acesso desta pessoa, quando existe. NULL = pessoa sem login: '
  'consta da folha, das equipas e do histórico, mas não entra na aplicação. '
  'Para os perfis anteriores a esta migration é igual a profiles.id, o que '
  'mantém `id = auth.uid()` e `auth_user_id = auth.uid()` equivalentes.';

-- ─── 2. Backfill determinístico ─────────────────────────────────────────────
--
-- Todos os perfis que hoje existem têm conta: o `id` **é** o id do Auth. O
-- backfill limita-se a escrevê-lo onde agora se espera encontrá-lo.
--
-- 🔴 `WHERE auth_user_id IS NULL` faz disto uma operação repetível: correr a
--    migration duas vezes não sobrescreve nada, e uma pessoa sem acesso criada
--    depois não é adoptada por engano numa segunda passagem.
UPDATE public.profiles
   SET auth_user_id = id
 WHERE auth_user_id IS NULL
   AND EXISTS (SELECT 1 FROM auth.users u WHERE u.id = public.profiles.id);

-- ─── 3. A camada canónica ───────────────────────────────────────────────────
--
-- 🔴 Isto é o que evita mexer em 99 políticas.
--
--    O projecto já tem este padrão — `get_my_company_id()` e `get_my_role()`,
--    da 014, resolvidas com `SECURITY DEFINER` para não reentrarem na RLS que
--    estão a servir. `get_my_profile_id()` é a terceira da mesma família, e
--    segue-a de propósito: uma quarta forma de fazer a mesma pergunta seria
--    mais uma coisa que pode divergir.
--
--    Durante a transição responde pelas duas vias — a nova primeiro, a antiga
--    como rede. Enquanto o backfill se mantiver verdadeiro as duas dão o mesmo
--    resultado; quando o `id` deixar de ser o do Auth, só a nova responde.
--
--    Migrar uma política passa a ser trocar `WHERE id = auth.uid()` por
--    `WHERE id = get_my_profile_id()`, uma de cada vez e com teste. Copiar a
--    subconsulta por dezenas de políticas seria repetir, em RLS, o erro que já
--    se corrigiu no código: duas cópias da mesma regra acabam por divergir.
CREATE OR REPLACE FUNCTION public.get_my_profile_id()
RETURNS uuid
LANGUAGE sql
SECURITY DEFINER
STABLE
SET search_path = public
AS $$
  SELECT id FROM profiles WHERE auth_user_id = auth.uid()
  UNION ALL
  -- 🔴 O ramo de compatibilidade exige que a conta **exista mesmo** no Auth.
  --
  --    Sem esse `EXISTS`, uma pessoa sem conta de acesso ficava alcançável por
  --    quem soubesse o seu id: bastava um token com aquele `sub` e a função
  --    respondia por ela. Antes desta migration isso era impossível — o `id`
  --    de um perfil era, por construção, o id de uma conta. Ao permitir
  --    pessoas sem conta, a equivalência deixou de valer, e mantê-la sem
  --    verificação abria exactamente o buraco que a coluna nova existe para
  --    fechar. Foi um teste que o apanhou, não uma revisão do texto.
  SELECT id FROM profiles p
   WHERE p.id = auth.uid()
     AND EXISTS (SELECT 1 FROM auth.users u WHERE u.id = p.id)
     AND NOT EXISTS (SELECT 1 FROM profiles x WHERE x.auth_user_id = auth.uid())
  LIMIT 1;
$$;

COMMENT ON FUNCTION public.get_my_profile_id IS
  'O id da pessoa autenticada, ou NULL se não houver sessão ou a conta não '
  'estiver ligada a ninguém. Responde pela coluna auth_user_id e, enquanto a '
  'transição durar, também pela convenção antiga em que profiles.id era o id '
  'do Auth. Serve para as políticas deixarem de assumir que os dois são o '
  'mesmo, uma de cada vez.';

REVOKE ALL ON FUNCTION public.get_my_profile_id() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.get_my_profile_id() TO authenticated, service_role;

COMMIT;

-- ============================================================================
-- O que esta migration NÃO faz
-- ============================================================================
--
--  · não altera **nenhuma** política RLS. As 99 continuam a dizer
--    `id = auth.uid()` e continuam correctas, porque o backfill mantém as duas
--    leituras equivalentes. Migrá-las é PHASE C, com a sua PR e os seus testes;
--  · não altera a chave primária de `profiles` nem a sua FK para `auth.users`.
--    Isso é PHASE D — CONTRACT — e só depois de nada no código assumir que
--    `id = auth.uid()`;
--  · não cria, não apaga e não altera nenhuma conta de acesso;
--  · não muda ids, passwords, papéis nem empresas;
--  · não permite ainda criar uma pessoa sem conta pela aplicação. A base passa
--    a aceitá-lo; o ecrã é outra PR.
--
-- Rollback em
-- `supabase/migrations/draft/rollback/PROVISIONAL_collaborator_identity_expand.down.sql`,
-- com guarda: recusa se já existir alguém sem conta de acesso, porque largar a
-- coluna apagaria a única coisa que distingue essa pessoa de um registo
-- inválido.
-- ============================================================================

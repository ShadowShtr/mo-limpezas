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
--    compara o que o repositório sabe construir com o catálogo vivo, e
--    classifica objecto a objecto.
--
-- ----------------------------------------------------------------------------
-- A PROVENIÊNCIA, PROVADA E NÃO ASSUMIDA
-- ----------------------------------------------------------------------------
--
-- Suspeitava-se dos três ficheiros em `supabase/migrations/draft/`. Suspeitar
-- não chega — «vários efeitos estão lá» é compatível com uma aplicação
-- parcial, ou com edições à mão, e as duas mudariam o que esta migration
-- pode assumir.
--
-- Por isso mediu-se: aplicando os três rascunhos ao estado canónico, o
-- domínio de identidade passa de 74 objectos divergentes e 12 só-em-produção
-- para ZERO divergências nas políticas e nas colunas. As 69 políticas
-- divergentes explicam-se TODAS por uma única substituição,
-- `auth.uid()` → `get_my_profile_id()`.
--
-- O drift é, portanto, exactamente estes três ficheiros. Esta migration é o
-- conteúdo deles, canonicalizado — não uma reescrita de memória, que seria
-- onde um erro de transcrição entraria sem ninguém dar.
--
-- Duas ressalvas, ditas porque são verdade:
--
--   · o corpo de `get_my_profile_id()` guardado em produção não tem os
--     comentários do rascunho. A lógica é a mesma, o texto não é idêntico —
--     o que foi executado não foi byte a byte este ficheiro;
--   · `can_access_service` aparece como divergente no manifesto por o palco
--     canónico não replicar a migration 034 (o dump versionado extrai
--     tabelas e políticas, não funções). Não é drift de identidade; é um
--     limite do palco, e está registado como tal.
--
-- ----------------------------------------------------------------------------
-- SEGURANÇA
-- ----------------------------------------------------------------------------
--
-- · Idempotente: sobre produção é um no-op — tudo o que cria já existe, e as
--   políticas são recriadas com texto idêntico ao que lá está.
-- · Não destrutiva: não apaga perfis, não apaga ids, não reescreve história.
-- · O backfill de `auth_user_id` é GUARDADO — só preenche onde existe mesmo
--   uma conta no Auth com aquele id. Um backfill cego poria `auth_user_id`
--   em perfis sem conta e rebentaria contra a FK, ou pior, inventaria uma
--   ligação que ninguém criou. Em produção não toca em linha nenhuma: 29
--   perfis já ligados, os restantes sem conta.
-- · Pós-condições no fim: se o estado final não for o esperado, falha e a
--   transação do runner desfaz tudo.
--
-- 🔴 SEM `down` DESTRUTIVO — ver
--    `rollback/101b_identity_reconciliation.recovery.sql`.
--
--    Produção já depende desta identidade: 29 contas ligadas por
--    `auth_user_id`, 69 políticas a resolver por `get_my_profile_id()`.
--    Desmontá-la não é «voltar atrás», é partir o login de quem está a
--    trabalhar. FORWARD_RECOVERY.
--
-- Gerada a partir de:
--   draft/PROVISIONAL_collaborator_identity_expand.sql
--   draft/PROVISIONAL_collaborator_identity_resolver_rls.sql
--   draft/PROVISIONAL_collaborator_identity_resolver_rls_lote2.sql
--
-- `BEGIN`/`COMMIT` dos rascunhos retirados: o runner envolve cada migration
-- na sua própria transação, junto com a escrita no ledger. Um `COMMIT` aqui
-- dentro fecharia essa transação a meio e deixaria o ledger de fora.
-- ============================================================================

-- ==========================================================================
-- EXPAND — a coluna, a ligação e os índices
-- ==========================================================================

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

-- (BEGIN do rascunho retirado: o runner abre a transação)
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

-- ─── 1c. Troca de senha obrigatória no primeiro acesso ─────────────────────
--
-- 🔴 `NOT NULL DEFAULT false`, e é essencial que seja assim.
--
--    Se a coluna fosse anulável, todas as contas que já existem ficariam com
--    `NULL` — e um código que tratasse `NULL` como «não sei, é mais seguro
--    obrigar» mandaria todos os administradores e gestores para o ecrã de
--    trocar senha na manhã seguinte. Ninguém lhes definiu senha temporária
--    nenhuma; não têm o que trocar.
--
--    Com `DEFAULT false`, as contas existentes ficam explicitamente com «não
--    tem de trocar», que é a verdade sobre elas. Só quem receber uma senha
--    temporária passa a `true`.
--
--    É a mesma família de erro que causou a #86 — schema novo a mudar o
--    comportamento de quem já lá estava — e evita-se da mesma maneira: o valor
--    por omissão é o que já era verdade.
ALTER TABLE public.profiles
  ADD COLUMN IF NOT EXISTS must_change_password boolean NOT NULL DEFAULT false;

COMMENT ON COLUMN public.profiles.must_change_password IS
  'Verdadeiro quando alguém definiu uma senha temporária a esta pessoa e ela '
  'ainda não a trocou. As contas anteriores a esta coluna ficam false — nunca '
  'receberam senha temporária, e não têm o que trocar.';

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

-- 🔴 `anon` também executa, e é preciso.
--
--    Uma política de RLS é avaliada com os privilégios de quem faz o pedido.
--    Se `anon` não puder chamar a função, um pedido anónimo a uma tabela com
--    esta política rebenta com `permission denied for function` em vez de
--    simplesmente não devolver nada. A diferença importa: um erro revela que a
--    função existe e transforma uma negação silenciosa numa falha ruidosa que
--    o cliente vê.
--
--    Não é um relaxamento. Sem sessão, `auth.uid()` é NULL, a função devolve
--    NULL, e `id = NULL` nunca é verdadeiro — o anónimo continua a não ver
--    nada. Foi um teste com o papel `anon` que apanhou isto.
REVOKE ALL ON FUNCTION public.get_my_profile_id() FROM PUBLIC;

-- 🔴 `anon` também executa, e é preciso.
--
--    Uma política de RLS é avaliada com os privilégios de quem faz o pedido.
--    Se `anon` não puder chamar a função, um pedido anónimo a uma tabela com
--    esta política rebenta com `permission denied for function` em vez de
--    simplesmente não devolver nada. A diferença importa: o erro revela que a
--    função existe e transforma uma negação silenciosa numa falha ruidosa.
--
--    Não é relaxamento. Sem sessão, `auth.uid()` é NULL, a função devolve NULL,
--    e `id = NULL` nunca é verdadeiro — o anónimo continua a não ver nada. Foi
--    um teste com o papel `anon` que apanhou isto.
--
--    Concede-se a quem existir: em Supabase os três papéis existem sempre, mas
--    uma base de ensaio pode não os ter todos, e um `GRANT` a um papel
--    inexistente aborta a migration inteira.
DO $grants$
DECLARE r text;
BEGIN
  FOREACH r IN ARRAY ARRAY['authenticated', 'anon', 'service_role'] LOOP
    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = r) THEN
      EXECUTE format('GRANT EXECUTE ON FUNCTION public.get_my_profile_id() TO %I', r);
    END IF;
  END LOOP;
END
$grants$;

-- (COMMIT do rascunho retirado: o runner fecha a transação)
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


-- ==========================================================================
-- RESOLVER — a função e o primeiro lote de políticas
-- ==========================================================================

-- ============================================================================
-- PROVISIONAL — identidade: as políticas passam a usar o resolver (PHASE C)
-- ============================================================================
--
-- 🔴 NÃO APLICADA. Vive em `supabase/migrations/draft/`, que o runner não lê.
--    Depende do EXPAND (PHASE A), que tem de correr primeiro.
--
--    MIGRATION_NUMBER_FINAL = UNASSIGNED
--
-- ---------------------------------------------------------------------------
-- O que muda, e porquê só isto
-- ---------------------------------------------------------------------------
--
-- Depois do EXPAND, `profiles.id` deixou de ser necessariamente o id de uma
-- conta: uma pessoa pode existir sem login. Todas as políticas que dizem
-- `id = auth.uid()` continuam **correctas** — o backfill mantém as duas
-- leituras equivalentes para quem já existe — mas deixam de estar a fazer a
-- pergunta certa. Estão a perguntar «este perfil é o id da minha sessão?»
-- quando o que querem saber é «este perfil é o meu?».
--
-- A diferença só aparece no dia em que alguém tiver uma conta cujo id não seja
-- o id do seu perfil, e nessa altura já é tarde para descobrir quais das 125
-- políticas assumiam a igualdade.
--
-- Esta migration trata **as três de `profiles`**. São as mais delicadas —
-- controlam quem se vê e quem se altera a si próprio — e servem de molde às
-- restantes, que migram depois, em lotes com os seus próprios ensaios.
--
--     RLS_POLICIES_MIGRATED_HERE = 3 de 125
--
-- Migrar 88 de uma vez seria repetir, em RLS, o erro de âmbito da #86.
--
-- ---------------------------------------------------------------------------
-- Porque é que o resolver não pode ser usado dentro de `profiles`
-- ---------------------------------------------------------------------------
--
-- 🔴 `get_my_profile_id()` lê `profiles`. Uma política **de** `profiles` que o
--    chamasse voltaria a entrar na mesma tabela — e é isso que a 014 existe
--    para evitar (`infinite recursion detected in policy for relation
--    "profiles"`).
--
--    Não é um problema aqui porque o resolver é `SECURITY DEFINER`: corre com
--    os privilégios de quem o definiu e **não** reentra na RLS da tabela. É a
--    mesma razão por que `get_my_company_id()` já podia ser usada na política
--    de `profiles` desde a 014.
--
--    O que **não** se pode fazer é escrever a subconsulta à mão dentro da
--    política. Foi assim que a recursão nasceu da primeira vez.
-- ============================================================================

-- (BEGIN do rascunho retirado: o runner abre a transação)
-- ─── 0. get_my_company_id() e get_my_role() passam pelo resolver ────────────
--
-- 🔴 Isto é uma correcção de segurança, não arrumação.
--
--    As duas funções da 014 dizem `WHERE id = auth.uid()`. Enquanto cada
--    perfil tinha uma conta, era a mesma coisa que perguntar «qual é o meu
--    perfil?». Depois do EXPAND deixou de ser: uma pessoa pode existir sem
--    conta, e o seu `id` não corresponde a sessão nenhuma.
--
--    Consequência medida em Postgres real: um token forjado com o `id` de uma
--    pessoa **sem** conta fazia `get_my_company_id()` devolver a empresa dela.
--    Isso dava acesso de leitura a todos os colegas, através da segunda metade
--    da política `profiles_select`. O `get_my_profile_id()` já recusava esse
--    id — mas as funções da 014 não, e eram elas que decidiam.
--
--    Foi um teste com uma pessoa sem conta que o apanhou. Não aparecia antes
--    do EXPAND porque, antes dele, esse cenário não podia existir.
--
--    A correcção é a mesma ideia do resto da fase: perguntar pelo perfil, não
--    pelo id da sessão. `SECURITY DEFINER` mantém-se — é o que evita a
--    recursão que a 014 existe para resolver.
CREATE OR REPLACE FUNCTION public.get_my_company_id()
RETURNS uuid
LANGUAGE sql
SECURITY DEFINER
STABLE
SET search_path = public
AS $$
  SELECT company_id FROM profiles WHERE id = public.get_my_profile_id() LIMIT 1;
$$;

CREATE OR REPLACE FUNCTION public.get_my_role()
RETURNS text
LANGUAGE sql
SECURITY DEFINER
STABLE
SET search_path = public
AS $$
  SELECT role FROM profiles WHERE id = public.get_my_profile_id() LIMIT 1;
$$;

-- ─── 1. profiles_select ─────────────────────────────────────────────────────
--
-- Antes:  id = auth.uid() OR company_id = get_my_company_id()
-- Agora:  id = get_my_profile_id() OR company_id = get_my_company_id()
--
-- Para quem tem conta, o resultado é o mesmo — o resolver devolve o mesmo id
-- que `auth.uid()` devolvia. O que muda é o significado: passa a ser «o meu
-- perfil», e continuará certo quando o id da conta deixar de ser o do perfil.
DROP POLICY IF EXISTS "profiles_select" ON public.profiles;
CREATE POLICY "profiles_select" ON public.profiles
  FOR SELECT USING (
    id = public.get_my_profile_id()          -- o próprio
    OR company_id = public.get_my_company_id() -- colegas da mesma empresa
  );

-- ─── 2. profiles_update_own ─────────────────────────────────────────────────
--
-- 🔴 Esta é a política que a 069 endureceu, e o `WITH CHECK` explícito é a
--    razão. Sem ele, o Postgres reutiliza o `USING` como `CHECK`, e como o
--    `id` não muda num `UPDATE ... WHERE id = auth.uid()`, qualquer conta
--    autenticada passava a alterar `company_id` e `role` à vontade. Era
--    auto-promoção a admin em qualquer empresa cujo UUID se conhecesse.
--
--    A protecção real da 069 é o trigger `fn_guard_profile_tenant_role`, que
--    esta migration **não toca** — e que não depende de `id = auth.uid()`,
--    porque olha para `auth.role()` e para os helpers da 014. Há testes que o
--    provam antes e depois do EXPAND.
--
--    Mantém-se aqui a mesma forma, com o resolver no lugar do `auth.uid()`.
DROP POLICY IF EXISTS "profiles_update_own" ON public.profiles;
CREATE POLICY "profiles_update_own" ON public.profiles
  FOR UPDATE
  USING (id = public.get_my_profile_id())
  WITH CHECK (
    id = public.get_my_profile_id()
    AND company_id = public.get_my_company_id()
  );

-- ─── 3. profiles_insert_admin ───────────────────────────────────────────────
--
-- 🔴 Correcção. Este ficheiro dizia «UNCHANGED (015)» — e estava errado. Um
--    preflight contra a base real mostrou que a política **usa** `auth.uid()`
--    no ramo de auto-inserção. O segundo ramo (admin/gestor da empresa) cobre
--    o caso normal, mas deixar o primeiro com a equivalência antiga mantinha
--    uma política de identidade legada de pé, e o objectivo é não sobrar
--    nenhuma.
DROP POLICY IF EXISTS "profiles_insert_admin" ON public.profiles;
CREATE POLICY "profiles_insert_admin" ON public.profiles
  FOR INSERT
  WITH CHECK (
    id = public.get_my_profile_id()
    OR (company_id = public.get_my_company_id()
        AND public.get_my_role() = ANY (ARRAY['admin'::text, 'gestor'::text]))
  );

-- ─── 4. Duas políticas órfãs que a base tem e o repositório não ─────────────
--
-- 🔴 `users see own profile` e `users see company profiles` existem em
--    produção e **não existem em nenhuma migration versionada**. São restos da
--    002 que uma substituição posterior não apagou, por ter usado nomes
--    diferentes no `DROP` — exactamente o padrão que causou a recursão de RLS
--    corrigida pela 018.
--
--    Não são inofensivas. O PostgreSQL combina políticas permissivas por
--    **OR**: enquanto `users see own profile` (`id = auth.uid()`) estiver de
--    pé, a `profiles_select` acima deixa de ser o único caminho, e a guarda
--    `EXISTS` que o resolver tem — a que impede alguém de ser tratado como uma
--    pessoa sem conta cujo id conheça — passa a ter uma porta ao lado.
--
--    São apagadas, e não substituídas: o que faziam já é feito pela
--    `profiles_select` e pela `profiles_manage_company`.
DROP POLICY IF EXISTS "users see own profile" ON public.profiles;
DROP POLICY IF EXISTS "users see company profiles" ON public.profiles;

-- ─── 5. profiles_manage_company ─────────────────────────────────────────────
--
-- Não menciona `auth.uid()`: já usava os helpers da 014. Fica **como está**.
-- Recriá-la só para lhe tocar seria arriscar uma diferença de transcrição sem
-- ganhar nada — e uma política mal copiada é uma falha de isolamento.
--
--     `profiles_manage_company` = UNCHANGED

-- ─── Pós-condições ─────────────────────────────────────────────────────────
DO $post$
DECLARE v_restantes int;
BEGIN
  SELECT count(*) INTO v_restantes FROM pg_policies
   WHERE schemaname='public' AND tablename='profiles'
     AND (coalesce(qual,'')||' '||coalesce(with_check,'')) LIKE '%auth.uid()%';
  IF v_restantes <> 0 THEN
    RAISE EXCEPTION 'POSCONDICAO: sobraram % políticas com auth.uid() em profiles.', v_restantes;
  END IF;
END $post$;

-- (COMMIT do rascunho retirado: o runner fecha a transação)
-- ============================================================================
-- O que esta migration NÃO faz
-- ============================================================================
--
--  · não toca nas outras 85 políticas que ainda dizem `id = auth.uid()`. Todas
--    continuam correctas enquanto o backfill se mantiver verdadeiro; migram em
--    lotes próprios, com os seus ensaios;
--  · não toca no trigger da 069 — a protecção contra escalada de privilégios
--    fica exactamente como está;
--  · não altera `get_my_company_id()` nem `get_my_role()`;
--  · não escreve uma linha de dados.
--
-- Rollback em
-- `supabase/migrations/draft/rollback/PROVISIONAL_..._resolver_rls.down.sql`:
-- repõe as três políticas na forma que a 014 e a 069 deixaram. Não precisa de
-- guarda — recriar políticas não perde dados, e as duas formas decidem o mesmo
-- enquanto houver uma conta por perfil.
-- ============================================================================


-- ==========================================================================
-- RESOLVER LOTE 2 — as restantes políticas
-- ==========================================================================

-- ============================================================================
-- PROVISIONAL — identidade de colaborador: RESOLVER NAS POLÍTICAS (LOTE 2)
-- ============================================================================
--
-- 🔴 NÃO APLICADA PELO RUNNER. Vive em `supabase/migrations/draft/`.
--    MIGRATION_NUMBER_FINAL = UNASSIGNED
--
-- ---------------------------------------------------------------------------
-- Porque é que este ficheiro cresceu de 8 políticas para 67
-- ---------------------------------------------------------------------------
--
-- A versão anterior migrava oito políticas. Um preflight read-only contra a
-- base real mostrou que isso era 12% do problema: **71 das 93 políticas do
-- schema `public` resolvem a identidade por `auth.uid()`**, em 39 tabelas.
--
-- Nenhuma delas usa `auth.uid()` com outro significado. Foi verificado uma a
-- uma: todas as 71 comparam `auth.uid()` com um id de perfil, seja
-- directamente (`collaborator_id = auth.uid()`) seja por subconsulta
-- (`SELECT role FROM profiles WHERE id = auth.uid()`). A transformação é, por
-- isso, uniforme e mecânica: `auth.uid()` → `public.get_my_profile_id()`.
--
-- ---------------------------------------------------------------------------
-- Porque é que isto não parte ninguém que hoje funciona
-- ---------------------------------------------------------------------------
--
-- O EXPAND preenche `auth_user_id = id` em todas as pessoas que já têm conta.
-- Para essas — as 30 que existem hoje — `get_my_profile_id()` devolve
-- **exactamente** `auth.uid()`, e cada política reescrita avalia igual à
-- anterior, expressão por expressão. A diferença só aparece para quem tiver
-- uma conta criada pelo fluxo novo, onde `auth.users.id` é gerado pelo GoTrue
-- e não coincide com o id da pessoa. Para esses, a versão antiga destas
-- políticas devolvia falso — o colaborador não conseguia picar o ponto, e um
-- gestor novo perdia o acesso de gestão.
--
-- ---------------------------------------------------------------------------
-- Duas políticas órfãs, e porque são apagadas no LOTE 1
-- ---------------------------------------------------------------------------
--
-- `users see own profile` e `users see company profiles` existem na base e
-- **não existem em nenhuma migration versionada**: são restos da 002 que uma
-- substituição posterior não apagou por usar nomes diferentes — o mesmo
-- padrão que causou a recursão de RLS corrigida pela 018. Como o PostgreSQL
-- combina políticas permissivas por OR, deixá-las de pé mantinha um caminho
-- paralelo com a equivalência antiga, e a guarda do resolver deixava de ser o
-- único caminho. São tratadas no LOTE 1, junto com o resto de `profiles`.
-- ============================================================================

-- (BEGIN do rascunho retirado: o runner abre a transação)
-- ─── Pré-condições ─────────────────────────────────────────────────────────
DO $pre$
BEGIN
  IF to_regprocedure('public.get_my_profile_id()') IS NULL THEN
    RAISE EXCEPTION 'PRECONDICAO: get_my_profile_id() não existe — aplicar o EXPAND (SQL 1) primeiro.';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns
                  WHERE table_schema='public' AND table_name='profiles'
                    AND column_name='auth_user_id') THEN
    RAISE EXCEPTION 'PRECONDICAO: profiles.auth_user_id não existe — aplicar o EXPAND (SQL 1) primeiro.';
  END IF;
END $pre$;

-- ─── absences ──────────────────────────────────────────────────────────────
DROP POLICY IF EXISTS "absences_manager_select" ON public.absences;
CREATE POLICY "absences_manager_select" ON public.absences AS PERMISSIVE FOR SELECT TO public
  USING (((company_id = get_my_company_id()) AND (( SELECT profiles.role
   FROM profiles
  WHERE (profiles.id = public.get_my_profile_id())) = ANY (ARRAY['admin'::text, 'gestor'::text]))));
DROP POLICY IF EXISTS "absences_own_select" ON public.absences;
CREATE POLICY "absences_own_select" ON public.absences AS PERMISSIVE FOR SELECT TO public
  USING ((collaborator_id = public.get_my_profile_id()));

-- ─── app_notice_reads ──────────────────────────────────────────────────────
DROP POLICY IF EXISTS "read own reads" ON public.app_notice_reads;
CREATE POLICY "read own reads" ON public.app_notice_reads AS PERMISSIVE FOR SELECT TO public
  USING ((profile_id = public.get_my_profile_id()));

-- ─── attachments ───────────────────────────────────────────────────────────
DROP POLICY IF EXISTS "company members delete attachments" ON public.attachments;
CREATE POLICY "company members delete attachments" ON public.attachments AS PERMISSIVE FOR DELETE TO public
  USING ((company_id IN ( SELECT profiles.company_id
   FROM profiles
  WHERE (profiles.id = public.get_my_profile_id()))));
DROP POLICY IF EXISTS "company members insert attachments" ON public.attachments;
CREATE POLICY "company members insert attachments" ON public.attachments AS PERMISSIVE FOR INSERT TO public
  WITH CHECK ((company_id IN ( SELECT profiles.company_id
   FROM profiles
  WHERE (profiles.id = public.get_my_profile_id()))));
DROP POLICY IF EXISTS "company members read attachments" ON public.attachments;
CREATE POLICY "company members read attachments" ON public.attachments AS PERMISSIVE FOR SELECT TO public
  USING ((company_id IN ( SELECT profiles.company_id
   FROM profiles
  WHERE (profiles.id = public.get_my_profile_id()))));

-- ─── audit_logs ────────────────────────────────────────────────────────────
DROP POLICY IF EXISTS "audit_logs_admin_read" ON public.audit_logs;
CREATE POLICY "audit_logs_admin_read" ON public.audit_logs AS PERMISSIVE FOR SELECT TO public
  USING (((company_id = ( SELECT profiles.company_id
   FROM profiles
  WHERE (profiles.id = public.get_my_profile_id()))) AND (( SELECT profiles.role
   FROM profiles
  WHERE (profiles.id = public.get_my_profile_id())) = ANY (ARRAY['admin'::text, 'gestor'::text]))));

-- ─── background_jobs ───────────────────────────────────────────────────────
DROP POLICY IF EXISTS "background_jobs_admin_read" ON public.background_jobs;
CREATE POLICY "background_jobs_admin_read" ON public.background_jobs AS PERMISSIVE FOR SELECT TO public
  USING (((( SELECT profiles.role
   FROM profiles
  WHERE (profiles.id = public.get_my_profile_id())) = ANY (ARRAY['admin'::text, 'gestor'::text])) AND ((company_id IS NULL) OR (company_id = ( SELECT profiles.company_id
   FROM profiles
  WHERE (profiles.id = public.get_my_profile_id()))))));

-- ─── bank_accounts ─────────────────────────────────────────────────────────
DROP POLICY IF EXISTS "bank_accounts_admin" ON public.bank_accounts;
CREATE POLICY "bank_accounts_admin" ON public.bank_accounts AS PERMISSIVE FOR ALL TO public
  USING (((company_id = get_my_company_id()) AND (( SELECT profiles.role
   FROM profiles
  WHERE (profiles.id = public.get_my_profile_id())) = ANY (ARRAY['admin'::text, 'gestor'::text]))))
  WITH CHECK (((company_id = get_my_company_id()) AND (( SELECT profiles.role
   FROM profiles
  WHERE (profiles.id = public.get_my_profile_id())) = ANY (ARRAY['admin'::text, 'gestor'::text]))));

-- ─── bank_reconciliation_matches ───────────────────────────────────────────
DROP POLICY IF EXISTS "bank_reconciliation_matches_admin" ON public.bank_reconciliation_matches;
CREATE POLICY "bank_reconciliation_matches_admin" ON public.bank_reconciliation_matches AS PERMISSIVE FOR ALL TO public
  USING (((company_id = get_my_company_id()) AND (( SELECT profiles.role
   FROM profiles
  WHERE (profiles.id = public.get_my_profile_id())) = ANY (ARRAY['admin'::text, 'gestor'::text]))))
  WITH CHECK (((company_id = get_my_company_id()) AND (( SELECT profiles.role
   FROM profiles
  WHERE (profiles.id = public.get_my_profile_id())) = ANY (ARRAY['admin'::text, 'gestor'::text]))));

-- ─── bank_statement_imports ────────────────────────────────────────────────
DROP POLICY IF EXISTS "bank_statement_imports_admin" ON public.bank_statement_imports;
CREATE POLICY "bank_statement_imports_admin" ON public.bank_statement_imports AS PERMISSIVE FOR ALL TO public
  USING (((company_id = get_my_company_id()) AND (( SELECT profiles.role
   FROM profiles
  WHERE (profiles.id = public.get_my_profile_id())) = ANY (ARRAY['admin'::text, 'gestor'::text]))))
  WITH CHECK (((company_id = get_my_company_id()) AND (( SELECT profiles.role
   FROM profiles
  WHERE (profiles.id = public.get_my_profile_id())) = ANY (ARRAY['admin'::text, 'gestor'::text]))));

-- ─── bank_transactions ─────────────────────────────────────────────────────
DROP POLICY IF EXISTS "bank_transactions_admin" ON public.bank_transactions;
CREATE POLICY "bank_transactions_admin" ON public.bank_transactions AS PERMISSIVE FOR ALL TO public
  USING (((company_id = get_my_company_id()) AND (( SELECT profiles.role
   FROM profiles
  WHERE (profiles.id = public.get_my_profile_id())) = ANY (ARRAY['admin'::text, 'gestor'::text]))))
  WITH CHECK (((company_id = get_my_company_id()) AND (( SELECT profiles.role
   FROM profiles
  WHERE (profiles.id = public.get_my_profile_id())) = ANY (ARRAY['admin'::text, 'gestor'::text]))));

-- ─── building_cards ────────────────────────────────────────────────────────
DROP POLICY IF EXISTS "building_cards_company_isolation" ON public.building_cards;
CREATE POLICY "building_cards_company_isolation" ON public.building_cards AS PERMISSIVE FOR ALL TO public
  USING ((company_id IN ( SELECT profiles.company_id
   FROM profiles
  WHERE (profiles.id = public.get_my_profile_id()))));
DROP POLICY IF EXISTS "building_cards_delete" ON public.building_cards;
CREATE POLICY "building_cards_delete" ON public.building_cards AS PERMISSIVE FOR DELETE TO public
  USING ((company_id IN ( SELECT profiles.company_id
   FROM profiles
  WHERE ((profiles.id = public.get_my_profile_id()) AND (profiles.role = ANY (ARRAY['admin'::text, 'gestor'::text]))))));
DROP POLICY IF EXISTS "building_cards_insert" ON public.building_cards;
CREATE POLICY "building_cards_insert" ON public.building_cards AS PERMISSIVE FOR INSERT TO public
  WITH CHECK ((company_id IN ( SELECT profiles.company_id
   FROM profiles
  WHERE ((profiles.id = public.get_my_profile_id()) AND (profiles.role = ANY (ARRAY['admin'::text, 'gestor'::text]))))));
DROP POLICY IF EXISTS "building_cards_update" ON public.building_cards;
CREATE POLICY "building_cards_update" ON public.building_cards AS PERMISSIVE FOR UPDATE TO public
  USING ((company_id IN ( SELECT profiles.company_id
   FROM profiles
  WHERE ((profiles.id = public.get_my_profile_id()) AND (profiles.role = ANY (ARRAY['admin'::text, 'gestor'::text]))))));

-- ─── cash_flow_entries ─────────────────────────────────────────────────────
DROP POLICY IF EXISTS "cash_flow_admin" ON public.cash_flow_entries;
CREATE POLICY "cash_flow_admin" ON public.cash_flow_entries AS PERMISSIVE FOR ALL TO public
  USING (((company_id = get_my_company_id()) AND (( SELECT profiles.role
   FROM profiles
  WHERE (profiles.id = public.get_my_profile_id())) = ANY (ARRAY['admin'::text, 'gestor'::text]))))
  WITH CHECK (((company_id = get_my_company_id()) AND (( SELECT profiles.role
   FROM profiles
  WHERE (profiles.id = public.get_my_profile_id())) = ANY (ARRAY['admin'::text, 'gestor'::text]))));

-- ─── client_notifications ──────────────────────────────────────────────────
DROP POLICY IF EXISTS "managers manage client notifications" ON public.client_notifications;
CREATE POLICY "managers manage client notifications" ON public.client_notifications AS PERMISSIVE FOR ALL TO public
  USING (((company_id = ( SELECT profiles.company_id
   FROM profiles
  WHERE (profiles.id = public.get_my_profile_id()))) AND (( SELECT profiles.role
   FROM profiles
  WHERE (profiles.id = public.get_my_profile_id())) = ANY (ARRAY['admin'::text, 'gestor'::text]))));

-- ─── clients ───────────────────────────────────────────────────────────────
DROP POLICY IF EXISTS "clients_collaborator_select" ON public.clients;
CREATE POLICY "clients_collaborator_select" ON public.clients AS PERMISSIVE FOR SELECT TO public
  USING (((company_id = get_my_company_id()) AND (( SELECT profiles.role
   FROM profiles
  WHERE (profiles.id = public.get_my_profile_id())) <> ALL (ARRAY['admin'::text, 'gestor'::text])) AND (EXISTS ( SELECT 1
   FROM (locations l
     JOIN services s ON ((s.location_id = l.id)))
  WHERE ((l.client_id = clients.id) AND can_access_service(s.id))))));

-- ─── collaborator_documents ────────────────────────────────────────────────
DROP POLICY IF EXISTS "colaboradoras submetem relatórios de avaria" ON public.collaborator_documents;
CREATE POLICY "colaboradoras submetem relatórios de avaria" ON public.collaborator_documents AS PERMISSIVE FOR INSERT TO public
  WITH CHECK (((collaborator_id = public.get_my_profile_id()) AND (category = 'avaria'::text) AND (visible_to_collaborator = true) AND (uploaded_by_role = 'colaboradora'::text)));
DROP POLICY IF EXISTS "colaboradoras veem os seus docs visíveis" ON public.collaborator_documents;
CREATE POLICY "colaboradoras veem os seus docs visíveis" ON public.collaborator_documents AS PERMISSIVE FOR SELECT TO public
  USING (((collaborator_id = public.get_my_profile_id()) AND (visible_to_collaborator = true)));
DROP POLICY IF EXISTS "gestores gerem documentos da empresa" ON public.collaborator_documents;
CREATE POLICY "gestores gerem documentos da empresa" ON public.collaborator_documents AS PERMISSIVE FOR ALL TO public
  USING ((company_id IN ( SELECT profiles.company_id
   FROM profiles
  WHERE ((profiles.id = public.get_my_profile_id()) AND (profiles.role = ANY (ARRAY['gestor'::text, 'admin'::text]))))))
  WITH CHECK ((company_id IN ( SELECT profiles.company_id
   FROM profiles
  WHERE ((profiles.id = public.get_my_profile_id()) AND (profiles.role = ANY (ARRAY['gestor'::text, 'admin'::text]))))));

-- ─── collaborator_ride_assignments ─────────────────────────────────────────
DROP POLICY IF EXISTS "collaborator_ride_company_isolation" ON public.collaborator_ride_assignments;
CREATE POLICY "collaborator_ride_company_isolation" ON public.collaborator_ride_assignments AS PERMISSIVE FOR ALL TO public
  USING ((company_id IN ( SELECT profiles.company_id
   FROM profiles
  WHERE (profiles.id = public.get_my_profile_id()))));
DROP POLICY IF EXISTS "collaborator_ride_delete" ON public.collaborator_ride_assignments;
CREATE POLICY "collaborator_ride_delete" ON public.collaborator_ride_assignments AS PERMISSIVE FOR DELETE TO public
  USING ((company_id IN ( SELECT profiles.company_id
   FROM profiles
  WHERE ((profiles.id = public.get_my_profile_id()) AND (profiles.role = ANY (ARRAY['admin'::text, 'gestor'::text]))))));
DROP POLICY IF EXISTS "collaborator_ride_insert" ON public.collaborator_ride_assignments;
CREATE POLICY "collaborator_ride_insert" ON public.collaborator_ride_assignments AS PERMISSIVE FOR INSERT TO public
  WITH CHECK ((company_id IN ( SELECT profiles.company_id
   FROM profiles
  WHERE ((profiles.id = public.get_my_profile_id()) AND (profiles.role = ANY (ARRAY['admin'::text, 'gestor'::text]))))));
DROP POLICY IF EXISTS "collaborator_ride_update" ON public.collaborator_ride_assignments;
CREATE POLICY "collaborator_ride_update" ON public.collaborator_ride_assignments AS PERMISSIVE FOR UPDATE TO public
  USING ((company_id IN ( SELECT profiles.company_id
   FROM profiles
  WHERE ((profiles.id = public.get_my_profile_id()) AND (profiles.role = ANY (ARRAY['admin'::text, 'gestor'::text]))))));

-- ─── companies ─────────────────────────────────────────────────────────────
DROP POLICY IF EXISTS "users see own company" ON public.companies;
CREATE POLICY "users see own company" ON public.companies AS PERMISSIVE FOR SELECT TO public
  USING ((id = ( SELECT profiles.company_id
   FROM profiles
  WHERE (profiles.id = public.get_my_profile_id()))));

-- ─── company_change_events ─────────────────────────────────────────────────
DROP POLICY IF EXISTS "managers see company change events" ON public.company_change_events;
CREATE POLICY "managers see company change events" ON public.company_change_events AS PERMISSIVE FOR SELECT TO public
  USING (((company_id = ( SELECT profiles.company_id
   FROM profiles
  WHERE (profiles.id = public.get_my_profile_id()))) AND (( SELECT profiles.role
   FROM profiles
  WHERE (profiles.id = public.get_my_profile_id())) = ANY (ARRAY['admin'::text, 'gestor'::text]))));

-- ─── contracts ─────────────────────────────────────────────────────────────
DROP POLICY IF EXISTS "contracts_manager_select" ON public.contracts;
CREATE POLICY "contracts_manager_select" ON public.contracts AS PERMISSIVE FOR SELECT TO public
  USING (((company_id = get_my_company_id()) AND (( SELECT profiles.role
   FROM profiles
  WHERE (profiles.id = public.get_my_profile_id())) = ANY (ARRAY['admin'::text, 'gestor'::text]))));

-- ─── daily_clocks ──────────────────────────────────────────────────────────
DROP POLICY IF EXISTS "daily_clocks_own" ON public.daily_clocks;
CREATE POLICY "daily_clocks_own" ON public.daily_clocks AS PERMISSIVE FOR ALL TO public
  USING ((collaborator_id = public.get_my_profile_id()))
  WITH CHECK ((collaborator_id = public.get_my_profile_id()));

-- ─── expense_categories ────────────────────────────────────────────────────
DROP POLICY IF EXISTS "expense_categories_read" ON public.expense_categories;
CREATE POLICY "expense_categories_read" ON public.expense_categories AS PERMISSIVE FOR SELECT TO public
  USING ((company_id IN ( SELECT profiles.company_id
   FROM profiles
  WHERE (profiles.id = public.get_my_profile_id()))));
DROP POLICY IF EXISTS "expense_categories_write" ON public.expense_categories;
CREATE POLICY "expense_categories_write" ON public.expense_categories AS PERMISSIVE FOR ALL TO public
  USING ((company_id IN ( SELECT profiles.company_id
   FROM profiles
  WHERE ((profiles.id = public.get_my_profile_id()) AND (profiles.role = ANY (ARRAY['admin'::text, 'gestor'::text]))))));

-- ─── financial_periods ─────────────────────────────────────────────────────
DROP POLICY IF EXISTS "financial_periods_read" ON public.financial_periods;
CREATE POLICY "financial_periods_read" ON public.financial_periods AS PERMISSIVE FOR SELECT TO public
  USING ((company_id IN ( SELECT profiles.company_id
   FROM profiles
  WHERE (profiles.id = public.get_my_profile_id()))));
DROP POLICY IF EXISTS "financial_periods_write" ON public.financial_periods;
CREATE POLICY "financial_periods_write" ON public.financial_periods AS PERMISSIVE FOR ALL TO public
  USING ((company_id IN ( SELECT profiles.company_id
   FROM profiles
  WHERE ((profiles.id = public.get_my_profile_id()) AND (profiles.role = ANY (ARRAY['admin'::text, 'gestor'::text]))))));

-- ─── fixed_variable_payments ───────────────────────────────────────────────
DROP POLICY IF EXISTS "company members manage fixed variable payments" ON public.fixed_variable_payments;
CREATE POLICY "company members manage fixed variable payments" ON public.fixed_variable_payments AS PERMISSIVE FOR ALL TO public
  USING ((company_id IN ( SELECT profiles.company_id
   FROM profiles
  WHERE (profiles.id = public.get_my_profile_id()))));

-- ─── invoice_items ─────────────────────────────────────────────────────────
DROP POLICY IF EXISTS "managers manage invoice items" ON public.invoice_items;
CREATE POLICY "managers manage invoice items" ON public.invoice_items AS PERMISSIVE FOR ALL TO public
  USING (((( SELECT invoices.company_id
   FROM invoices
  WHERE (invoices.id = invoice_items.invoice_id)) = ( SELECT profiles.company_id
   FROM profiles
  WHERE (profiles.id = public.get_my_profile_id()))) AND (( SELECT profiles.role
   FROM profiles
  WHERE (profiles.id = public.get_my_profile_id())) = ANY (ARRAY['admin'::text, 'gestor'::text]))));

-- ─── invoices ──────────────────────────────────────────────────────────────
DROP POLICY IF EXISTS "managers manage invoices" ON public.invoices;
CREATE POLICY "managers manage invoices" ON public.invoices AS PERMISSIVE FOR ALL TO public
  USING (((company_id = ( SELECT profiles.company_id
   FROM profiles
  WHERE (profiles.id = public.get_my_profile_id()))) AND (( SELECT profiles.role
   FROM profiles
  WHERE (profiles.id = public.get_my_profile_id())) = ANY (ARRAY['admin'::text, 'gestor'::text]))));

-- ─── locations ─────────────────────────────────────────────────────────────
DROP POLICY IF EXISTS "locations_collaborator_select" ON public.locations;
CREATE POLICY "locations_collaborator_select" ON public.locations AS PERMISSIVE FOR SELECT TO public
  USING (((company_id = get_my_company_id()) AND (( SELECT profiles.role
   FROM profiles
  WHERE (profiles.id = public.get_my_profile_id())) <> ALL (ARRAY['admin'::text, 'gestor'::text])) AND (EXISTS ( SELECT 1
   FROM services s
  WHERE ((s.location_id = locations.id) AND can_access_service(s.id))))));

-- ─── management_tasks ──────────────────────────────────────────────────────
DROP POLICY IF EXISTS "management_tasks_admin" ON public.management_tasks;
CREATE POLICY "management_tasks_admin" ON public.management_tasks AS PERMISSIVE FOR ALL TO public
  USING (((company_id = get_my_company_id()) AND (( SELECT profiles.role
   FROM profiles
  WHERE (profiles.id = public.get_my_profile_id())) = ANY (ARRAY['admin'::text, 'gestor'::text]))))
  WITH CHECK (((company_id = get_my_company_id()) AND (( SELECT profiles.role
   FROM profiles
  WHERE (profiles.id = public.get_my_profile_id())) = ANY (ARRAY['admin'::text, 'gestor'::text]))));

-- ─── notifications ─────────────────────────────────────────────────────────
DROP POLICY IF EXISTS "managers create notifications" ON public.notifications;
CREATE POLICY "managers create notifications" ON public.notifications AS PERMISSIVE FOR INSERT TO public
  WITH CHECK ((company_id = ( SELECT profiles.company_id
   FROM profiles
  WHERE (profiles.id = public.get_my_profile_id()))));
DROP POLICY IF EXISTS "users see own notifications" ON public.notifications;
CREATE POLICY "users see own notifications" ON public.notifications AS PERMISSIVE FOR ALL TO public
  USING ((user_id = public.get_my_profile_id()));

-- ─── payroll_records ───────────────────────────────────────────────────────
DROP POLICY IF EXISTS "collaborators see own payroll" ON public.payroll_records;
CREATE POLICY "collaborators see own payroll" ON public.payroll_records AS PERMISSIVE FOR SELECT TO public
  USING ((collaborator_id = public.get_my_profile_id()));
DROP POLICY IF EXISTS "managers manage payroll" ON public.payroll_records;
CREATE POLICY "managers manage payroll" ON public.payroll_records AS PERMISSIVE FOR ALL TO public
  USING (((company_id = ( SELECT profiles.company_id
   FROM profiles
  WHERE (profiles.id = public.get_my_profile_id()))) AND (( SELECT profiles.role
   FROM profiles
  WHERE (profiles.id = public.get_my_profile_id())) = ANY (ARRAY['admin'::text, 'gestor'::text]))));

-- ─── platform_admins ───────────────────────────────────────────────────────
DROP POLICY IF EXISTS "read own platform admin row" ON public.platform_admins;
CREATE POLICY "read own platform admin row" ON public.platform_admins AS PERMISSIVE FOR SELECT TO public
  USING ((profile_id = public.get_my_profile_id()));

-- ─── push_subscriptions ────────────────────────────────────────────────────
DROP POLICY IF EXISTS "users manage own push subs" ON public.push_subscriptions;
CREATE POLICY "users manage own push subs" ON public.push_subscriptions AS PERMISSIVE FOR ALL TO public
  USING ((user_id = public.get_my_profile_id()));

-- ─── service_photos ────────────────────────────────────────────────────────
DROP POLICY IF EXISTS "service_photos_manager_read" ON public.service_photos;
CREATE POLICY "service_photos_manager_read" ON public.service_photos AS PERMISSIVE FOR SELECT TO public
  USING (((company_id = ( SELECT profiles.company_id
   FROM profiles
  WHERE (profiles.id = public.get_my_profile_id()))) AND (( SELECT profiles.role
   FROM profiles
  WHERE (profiles.id = public.get_my_profile_id())) = ANY (ARRAY['admin'::text, 'gestor'::text]))));
DROP POLICY IF EXISTS "service_photos_own_read" ON public.service_photos;
CREATE POLICY "service_photos_own_read" ON public.service_photos AS PERMISSIVE FOR SELECT TO public
  USING ((collaborator_id = public.get_my_profile_id()));

-- ─── service_reinforcements ────────────────────────────────────────────────
DROP POLICY IF EXISTS "reinforcements_select" ON public.service_reinforcements;
CREATE POLICY "reinforcements_select" ON public.service_reinforcements AS PERMISSIVE FOR SELECT TO public
  USING (((collaborator_id = public.get_my_profile_id()) OR (get_service_company_id(service_id) = get_my_company_id())));

-- ─── team_members ──────────────────────────────────────────────────────────
DROP POLICY IF EXISTS "company team members" ON public.team_members;
CREATE POLICY "company team members" ON public.team_members AS PERMISSIVE FOR ALL TO public
  USING ((( SELECT teams.company_id
   FROM teams
  WHERE (teams.id = team_members.team_id)) = ( SELECT profiles.company_id
   FROM profiles
  WHERE (profiles.id = public.get_my_profile_id()))));

-- ─── teams ─────────────────────────────────────────────────────────────────
DROP POLICY IF EXISTS "company teams" ON public.teams;
CREATE POLICY "company teams" ON public.teams AS PERMISSIVE FOR ALL TO public
  USING ((company_id = ( SELECT profiles.company_id
   FROM profiles
  WHERE (profiles.id = public.get_my_profile_id()))));

-- ─── timesheets ────────────────────────────────────────────────────────────
DROP POLICY IF EXISTS "collaborators create own timesheets" ON public.timesheets;
CREATE POLICY "collaborators create own timesheets" ON public.timesheets AS PERMISSIVE FOR INSERT TO public
  WITH CHECK ((collaborator_id = public.get_my_profile_id()));
DROP POLICY IF EXISTS "collaborators see own timesheets" ON public.timesheets;
CREATE POLICY "collaborators see own timesheets" ON public.timesheets AS PERMISSIVE FOR SELECT TO public
  USING ((collaborator_id = public.get_my_profile_id()));
DROP POLICY IF EXISTS "managers see company timesheets" ON public.timesheets;
CREATE POLICY "managers see company timesheets" ON public.timesheets AS PERMISSIVE FOR ALL TO public
  USING (((company_id = ( SELECT profiles.company_id
   FROM profiles
  WHERE (profiles.id = public.get_my_profile_id()))) AND (( SELECT profiles.role
   FROM profiles
  WHERE (profiles.id = public.get_my_profile_id())) = ANY (ARRAY['admin'::text, 'gestor'::text]))));
DROP POLICY IF EXISTS "timesheets_collaborator_insert" ON public.timesheets;
CREATE POLICY "timesheets_collaborator_insert" ON public.timesheets AS PERMISSIVE FOR INSERT TO public
  WITH CHECK ((collaborator_id = public.get_my_profile_id()));
DROP POLICY IF EXISTS "timesheets_collaborator_update" ON public.timesheets;
CREATE POLICY "timesheets_collaborator_update" ON public.timesheets AS PERMISSIVE FOR UPDATE TO public
  USING ((collaborator_id = public.get_my_profile_id()));
DROP POLICY IF EXISTS "timesheets_manager_select" ON public.timesheets;
CREATE POLICY "timesheets_manager_select" ON public.timesheets AS PERMISSIVE FOR SELECT TO public
  USING (((company_id = get_my_company_id()) AND (( SELECT profiles.role
   FROM profiles
  WHERE (profiles.id = public.get_my_profile_id())) = ANY (ARRAY['admin'::text, 'gestor'::text]))));
DROP POLICY IF EXISTS "timesheets_own_select" ON public.timesheets;
CREATE POLICY "timesheets_own_select" ON public.timesheets AS PERMISSIVE FOR SELECT TO public
  USING ((collaborator_id = public.get_my_profile_id()));

-- ─── vacation_requests ─────────────────────────────────────────────────────
DROP POLICY IF EXISTS "vacation_requests_insert" ON public.vacation_requests;
CREATE POLICY "vacation_requests_insert" ON public.vacation_requests AS PERMISSIVE FOR INSERT TO public
  WITH CHECK (((collaborator_id = public.get_my_profile_id()) AND (company_id = get_my_company_id())));
DROP POLICY IF EXISTS "vacation_requests_select" ON public.vacation_requests;
CREATE POLICY "vacation_requests_select" ON public.vacation_requests AS PERMISSIVE FOR SELECT TO public
  USING (((collaborator_id = public.get_my_profile_id()) OR ((company_id = get_my_company_id()) AND (get_my_role() = ANY (ARRAY['admin'::text, 'gestor'::text])))));

-- ─── vehicle_allocations ───────────────────────────────────────────────────
DROP POLICY IF EXISTS "vehicle_allocations_company_isolation" ON public.vehicle_allocations;
CREATE POLICY "vehicle_allocations_company_isolation" ON public.vehicle_allocations AS PERMISSIVE FOR ALL TO public
  USING ((company_id IN ( SELECT profiles.company_id
   FROM profiles
  WHERE (profiles.id = public.get_my_profile_id()))));
DROP POLICY IF EXISTS "vehicle_allocations_delete" ON public.vehicle_allocations;
CREATE POLICY "vehicle_allocations_delete" ON public.vehicle_allocations AS PERMISSIVE FOR DELETE TO public
  USING ((company_id IN ( SELECT profiles.company_id
   FROM profiles
  WHERE ((profiles.id = public.get_my_profile_id()) AND (profiles.role = ANY (ARRAY['admin'::text, 'gestor'::text]))))));
DROP POLICY IF EXISTS "vehicle_allocations_insert" ON public.vehicle_allocations;
CREATE POLICY "vehicle_allocations_insert" ON public.vehicle_allocations AS PERMISSIVE FOR INSERT TO public
  WITH CHECK ((company_id IN ( SELECT profiles.company_id
   FROM profiles
  WHERE ((profiles.id = public.get_my_profile_id()) AND (profiles.role = ANY (ARRAY['admin'::text, 'gestor'::text]))))));
DROP POLICY IF EXISTS "vehicle_allocations_update" ON public.vehicle_allocations;
CREATE POLICY "vehicle_allocations_update" ON public.vehicle_allocations AS PERMISSIVE FOR UPDATE TO public
  USING ((company_id IN ( SELECT profiles.company_id
   FROM profiles
  WHERE ((profiles.id = public.get_my_profile_id()) AND (profiles.role = ANY (ARRAY['admin'::text, 'gestor'::text]))))));

-- ─── vehicles ──────────────────────────────────────────────────────────────
DROP POLICY IF EXISTS "vehicles_company_isolation" ON public.vehicles;
CREATE POLICY "vehicles_company_isolation" ON public.vehicles AS PERMISSIVE FOR ALL TO public
  USING ((company_id IN ( SELECT profiles.company_id
   FROM profiles
  WHERE (profiles.id = public.get_my_profile_id()))));
DROP POLICY IF EXISTS "vehicles_delete" ON public.vehicles;
CREATE POLICY "vehicles_delete" ON public.vehicles AS PERMISSIVE FOR DELETE TO public
  USING ((company_id IN ( SELECT profiles.company_id
   FROM profiles
  WHERE ((profiles.id = public.get_my_profile_id()) AND (profiles.role = ANY (ARRAY['admin'::text, 'gestor'::text]))))));
DROP POLICY IF EXISTS "vehicles_insert" ON public.vehicles;
CREATE POLICY "vehicles_insert" ON public.vehicles AS PERMISSIVE FOR INSERT TO public
  WITH CHECK ((company_id IN ( SELECT profiles.company_id
   FROM profiles
  WHERE ((profiles.id = public.get_my_profile_id()) AND (profiles.role = ANY (ARRAY['admin'::text, 'gestor'::text]))))));
DROP POLICY IF EXISTS "vehicles_update" ON public.vehicles;
CREATE POLICY "vehicles_update" ON public.vehicles AS PERMISSIVE FOR UPDATE TO public
  USING ((company_id IN ( SELECT profiles.company_id
   FROM profiles
  WHERE ((profiles.id = public.get_my_profile_id()) AND (profiles.role = ANY (ARRAY['admin'::text, 'gestor'::text]))))));

-- ─── Pós-condições ─────────────────────────────────────────────────────────
DO $post$
DECLARE v_restantes int;
BEGIN
  SELECT count(*) INTO v_restantes FROM pg_policies
   WHERE schemaname='public' AND tablename <> 'profiles'
     AND (coalesce(qual,'')||' '||coalesce(with_check,'')) LIKE '%auth.uid()%';
  IF v_restantes <> 0 THEN
    RAISE EXCEPTION 'POSCONDICAO: sobraram % políticas com auth.uid() fora de profiles.', v_restantes;
  END IF;
END $post$;

-- (COMMIT do rascunho retirado: o runner fecha a transação)
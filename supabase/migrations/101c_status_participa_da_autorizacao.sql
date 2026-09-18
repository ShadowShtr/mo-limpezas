-- ============================================================================
-- 101c — o estado do colaborador passa a decidir na própria base
-- ============================================================================
--
-- 🔴 O QUE ESTA MIGRATION FECHA
--
--    «Dar saída» bane a conta no Auth e escreve `profiles.status = 'inativo'`.
--    A camada Next.js já recusa quem está nesse estado. A base não.
--
--    Banir impede um login NOVO. O access token já emitido continua válido
--    até ao `exp`, e o PostgREST aceita-o: avalia a RLS com `auth.uid()` do
--    token, e nenhuma das 97 políticas de `public` consulta `status`. Ou seja,
--    quem levasse saída com a aplicação aberta continuava a LER e a ESCREVER
--    directamente na base durante o resto da validade do token — mesmo com a
--    aplicação a recusá-lo.
--
--    A revogação só é imediata quando chega aqui.
--
-- ----------------------------------------------------------------------------
-- PORQUE É QUE ESTA É A `101c` E NÃO A `102`
-- ----------------------------------------------------------------------------
--
-- O `102` não está livre. O cabeçalho da `101a` reserva-o explicitamente para
-- as visitas comerciais, e a PR #179 — aberta, em rascunho — traz já
-- `102_crm_visitas_comerciais`, `103_crm_orcamentos` e `104_crm_conversao_lead`.
-- Tomar o `102` era empurrar trabalho planeado de outra frente.
--
-- Entre dois inteiros consecutivos não há inteiro: há um sufixo. `101b` e
-- `101c` estavam livres e ordenam onde têm de ordenar — a ordem de aplicação
-- é a lexicográfica do nome, e `101a` < `101b` < `101c` < `102`.
--
-- ----------------------------------------------------------------------------
-- A `101b` VEM ANTES, E NÃO POR ARRUMAÇÃO
-- ----------------------------------------------------------------------------
--
-- Esta migration substitui `get_my_profile_id()` — uma função que o
-- repositório, sozinho, não sabia construir: existe em produção por via de
-- rascunhos aplicados fora do runner. A `101b` canonicaliza esse estado. Sem
-- ela, esta migration depende de um drift que nenhuma migration explica, e a
-- prova de que funciona só responderia «funciona sobre o que já lá está» —
-- nunca «a cadeia do repositório chega aqui».
--
-- ----------------------------------------------------------------------------
-- PORQUE É QUE SÃO DUAS FUNÇÕES, E NÃO NOVENTA E SETE POLÍTICAS
-- ----------------------------------------------------------------------------
--
-- Inventário do catálogo vivo (read-only, `audit-status-authorization-surface`):
--
--   · 97 políticas em `public`;
--   · 0 (ZERO) usam `auth.uid()` directamente — todas passam por helpers;
--   · `get_my_profile_id()` .... 69 políticas + 2 funções;
--   · `get_my_company_id()` .... 40 políticas  → delega em get_my_profile_id;
--   · `get_my_role()` .......... 20 políticas  → delega em get_my_profile_id;
--   · `can_access_service()` ...  3 políticas  → NÃO delega;
--   · 24 SECURITY DEFINER, 0 alcançáveis por `authenticated` sem consultar
--     identidade — ou seja, não há caminho de contorno por RPC.
--
-- Há portanto UM estrangulamento real: `get_my_profile_id()`. Company e role
-- derivam dele. Corrigi-lo cobre 129 consumidores de uma vez, e é a diferença
-- entre uma regra e uma campanha de remendos — que é o que produz o defeito
-- clássico de «uma política corrigida ao lado de quarenta que não».
--
-- `can_access_service()` é a excepção, e por isso vem junto: resolve a
-- identidade por fora do helper e ficaria como porta aberta.
--
-- ----------------------------------------------------------------------------
-- O QUE NÃO MUDA
-- ----------------------------------------------------------------------------
--
-- · `service_role` tem BYPASSRLS. Todas as Server Actions e operações
--   administrativas escrevem por lá e NÃO são afectadas. É o que permite ao
--   painel continuar a listar, editar e reactivar um colaborador inativo —
--   se a administração perdesse isso, desativar seria irreversível.
--
-- · O ALVO de uma operação continua a poder estar inativo. O que passa a ser
--   exigido é o estado de QUEM CHAMA. Uma gestora activa continua a ver e a
--   gerir toda a gente da sua empresa, inativos incluídos.
--
-- · O isolamento entre empresas é o mesmo: continua a vir de `company_id`.
--
-- ----------------------------------------------------------------------------
-- 'ativo' E MAIS NADA
-- ----------------------------------------------------------------------------
--
-- A condição é `status = 'ativo'`, e não «não está em (inativo, suspenso)».
-- Uma lista de exclusão deixa entrar qualquer estado novo que alguém invente,
-- em silêncio, que é o oposto de fechar. `NULL` também não passa — e isso é
-- seguro de afirmar: em produção, `status` NULL = 0 linhas (lido read-only),
-- e o CHECK só admite `ativo | inativo | suspenso`.
--
-- 🔴 IMPACTO OPERACIONAL, MEDIDO E NÃO ESTIMADO
--
--    Leitura read-only de produção: ativo 36, suspenso 9, inativo 1.
--    As DEZ pessoas não-activas perdem acesso à base no instante em que isto
--    for aplicado. Hoje o estado não fazia diferença nenhuma, por isso é
--    possível que alguém esteja marcado `suspenso` e a trabalhar na mesma.
--    Confirmar essa lista ANTES de aplicar faz parte da aplicação.
-- ============================================================================

-- ----------------------------------------------------------------------------
-- Precondições — falhar aqui é melhor do que falhar a meio
-- ----------------------------------------------------------------------------
DO $pre$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'public' AND table_name = 'profiles' AND column_name = 'status'
  ) THEN
    RAISE EXCEPTION '101c: public.profiles.status não existe — nada a fazer aqui.';
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'public' AND table_name = 'profiles' AND column_name = 'auth_user_id'
  ) THEN
    RAISE EXCEPTION '101c: public.profiles.auth_user_id não existe — get_my_profile_id() depende dela.';
  END IF;

  IF NOT EXISTS (SELECT 1 FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
                 WHERE n.nspname = 'public' AND p.proname = 'get_my_profile_id') THEN
    RAISE EXCEPTION '101c: public.get_my_profile_id() não existe — aplicar a 101b primeiro.';
  END IF;
END $pre$;

-- ----------------------------------------------------------------------------
-- O estrangulamento
-- ----------------------------------------------------------------------------
--
-- 🔴 A condição entra nos DOIS ramos, e o `NOT EXISTS` fica como estava.
--
--    O segundo ramo é o caminho legado (`profiles.id = auth.uid()`), e só se
--    aplica quando NENHUM perfil reclama este `auth_user_id`. Esse `NOT
--    EXISTS` é sobre o modelo de identidade, não sobre autorização: filtrá-lo
--    por estado faria um perfil inativo com `auth_user_id` preenchido
--    «libertar» o caminho legado e voltar a resolver. Fica intocado de
--    propósito — um perfil inativo não resolve por ramo nenhum.
CREATE OR REPLACE FUNCTION public.get_my_profile_id()
 RETURNS uuid
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
  SELECT id FROM profiles
   WHERE auth_user_id = auth.uid()
     AND status = 'ativo'
  UNION ALL
  SELECT id FROM profiles p
   WHERE p.id = auth.uid()
     AND p.status = 'ativo'
     AND EXISTS (SELECT 1 FROM auth.users u WHERE u.id = p.id)
     AND NOT EXISTS (SELECT 1 FROM profiles x WHERE x.auth_user_id = auth.uid())
  LIMIT 1;
$function$;

COMMENT ON FUNCTION public.get_my_profile_id() IS
  'Identidade de quem chama, e SÓ quando está activa. `get_my_company_id` e '
  '`get_my_role` derivam daqui, por isso é este o sítio onde a revogação '
  'chega à base — ver a migration 101c.';

-- ----------------------------------------------------------------------------
-- A excepção que resolvia por fora
-- ----------------------------------------------------------------------------
--
-- Três mudanças, e nenhuma é cosmética:
--
--   1. a identidade passa pelo helper — herda a regra do estado;
--   2. `team_members.collaborator_id` e `service_reinforcements.collaborator_id`
--      são FKs para `profiles.id`; compará-las com `auth.uid()` só funciona
--      enquanto os dois ids coincidirem. Deixa de ser assumido;
--   3. ganha `search_path` fixado. Era a única SECURITY DEFINER do schema sem
--      ele, e numa função que corre com privilégios do dono isso é um risco a
--      sério, não um detalhe de estilo.
CREATE OR REPLACE FUNCTION public.can_access_service(p_service_id uuid)
 RETURNS boolean
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
  SELECT EXISTS (
    SELECT 1
    FROM   services s
    INNER  JOIN profiles p
           ON p.id = public.get_my_profile_id()
          AND p.company_id = s.company_id
    WHERE  s.id = p_service_id
    AND (
      EXISTS (
        SELECT 1 FROM team_members tm
        WHERE  tm.team_id         = s.team_id
        AND    tm.collaborator_id = public.get_my_profile_id()
        AND   (tm.left_at IS NULL OR tm.left_at > NOW())
      )
      OR EXISTS (
        SELECT 1 FROM service_reinforcements sr
        WHERE  sr.service_id      = s.id
        AND    sr.collaborator_id = public.get_my_profile_id()
      )
    )
  )
$function$;

COMMENT ON FUNCTION public.can_access_service(uuid) IS
  'Acesso de uma colaboradora a um serviço. Resolve a identidade por '
  'get_my_profile_id(), e portanto exige perfil activo — ver a migration 101c.';

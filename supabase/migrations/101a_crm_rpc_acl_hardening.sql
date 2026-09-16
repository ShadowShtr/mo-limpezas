-- ============================================================================
-- 101a — CRM: fechar o ACL das duas RPC do funil (hotfix da 101)
-- ============================================================================
--
-- O runner é o dono da transação: este ficheiro não abre BEGIN/COMMIT.
--
-- Esta migration não cria nada, não altera nenhuma tabela e não muda nenhum
-- comportamento funcional. Só fecha privilégios e fixa `search_path`.
--
-- ---------------------------------------------------------------------------
-- 🔴 Porque é que existe um `101a` e não um `102`
-- ---------------------------------------------------------------------------
--
-- A 101 **já está aplicada em produção** e o seu checksum está no ledger:
--
--     92fb13678187609c7951faaae6dcf3a3688f04694efb4b34c6f04e23aee46942
--
-- Corrigir o defeito editando `101_crm_leads.sql` criaria checksum drift
-- histórico: o ficheiro no repositório deixaria de bater com a linha do ledger,
-- e o guard de drift passaria a acusar uma divergência que ninguém conseguiria
-- distinguir de uma adulteração real. O ficheiro aplicado é imutável por
-- definição — corrige-se com uma migration nova, nunca por cima.
--
-- O `102` está reservado para as visitas comerciais, que são trabalho
-- FUNCIONAL já desenhado. Este hotfix tem de correr entre a 101 e esse
-- trabalho, e entre dois inteiros consecutivos não há inteiro nenhum.
--
-- Daí o sufixo. A ordem de aplicação é a ordem lexicográfica do nome do
-- ficheiro (`migration-runner-core.mjs`: `readdirSync(...).sort()`), e o
-- sufixo cai exactamente onde se quer:
--
--     101_crm_leads.sql            '_' = 0x5F
--     101a_crm_rpc_acl_hardening.sql  'a' = 0x61   → 0x5F < 0x61, vem depois
--     102_crm_visitas_comerciais.sql  '1','0','1' < '1','0','2' → vem antes
--
-- `src/__tests__/migration-versions.test.ts` passou a conhecer esta forma e
-- continua a impor unicidade: `101` e `101a` são versões DISTINTAS, e duas
-- migrations `101a` colidiriam como quaisquer outras duas com o mesmo número.
--
-- ---------------------------------------------------------------------------
-- 🔴 O defeito, e a sua causa
-- ---------------------------------------------------------------------------
--
-- Medido em produção depois de a 101 ser aplicada:
--
--     move_crm_lead_stage_atomic   anon=EXECUTE  authenticated=EXECUTE
--     reorder_crm_leads_atomic     anon=EXECUTE  authenticated=EXECUTE
--
-- A 101 faz exactamente isto, e não chega:
--
--     REVOKE ALL ON FUNCTION ... FROM PUBLIC;
--     GRANT EXECUTE ON FUNCTION ... TO service_role;
--
-- A causa é que os dois lados não falam do mesmo. `REVOKE ... FROM PUBLIC`
-- remove o privilégio implícito de PUBLIC — o que TODA a gente tem por ser
-- toda a gente. Não toca em grants NOMINAIS.
--
-- E no Supabase os grants a `anon` e `authenticated` são nominais, postos
-- automaticamente à nascença da função pelos DEFAULT PRIVILEGES do papel
-- `postgres` no schema `public`:
--
--     ALTER DEFAULT PRIVILEGES IN SCHEMA public
--       GRANT EXECUTE ON FUNCTIONS TO anon, authenticated, service_role;
--
-- Quando a 101 corre (pelo SQL Editor, como `postgres`), cada `CREATE FUNCTION`
-- nasce já com `anon=X` e `authenticated=X` no `proacl`. O `REVOKE FROM PUBLIC`
-- que vem a seguir remove uma coisa diferente e deixa os dois intactos.
--
-- 🔴 E é pior do que parecer: uma função sem `proacl` (NULL) tem, por omissão
--    do PostgreSQL, `EXECUTE` para PUBLIC. Para funções, o estado «sem ACL» é
--    o estado ABERTO. Por isso o pós-estado abaixo recusa `proacl IS NULL` em
--    vez de o tratar como ausência de problema.
--
-- O que isto abria: `anon` é o papel de quem NÃO está autenticado. As duas RPC
-- são SECURITY INVOKER, por isso o RLS e o ACL das tabelas continuavam a
-- aplicar-se — `anon` não tem privilégio de tabela nenhum sobre `crm_leads`, e
-- a escrita falharia. O buraco real não era escrita: era poder INVOCAR, a
-- partir da Internet e sem sessão, uma função que corre `SELECT ... FOR UPDATE`
-- e toma locks de linha. Isso é superfície de ataque e é consumo de recursos
-- que ninguém autorizou. Não se deixa aberto porque «a camada de baixo trava».
--
-- ---------------------------------------------------------------------------
-- O que esta migration NÃO faz
-- ---------------------------------------------------------------------------
--
--   · não altera o corpo, a assinatura nem o comportamento das duas RPC;
--   · não toca em tabelas, colunas, constraints, índices, policies nem RLS;
--   · não toca no ACL de `crm_leads` nem de `crm_lead_interactions` — esse foi
--     medido e está correcto (authenticated=SELECT, service_role=CRUD,
--     anon=nada);
--   · não altera os DEFAULT PRIVILEGES do schema. Mexer neles mudaria o
--     comportamento de TODAS as funções futuras do projecto, incluindo as que
--     ainda não existem, e é uma decisão de plataforma — não de um hotfix.
--     A consequência assumida é que cada migration nova tem de fechar o seu
--     próprio ACL, e o pós-estado de cada uma é o que o obriga.
-- ============================================================================

-- ───────────────────────────────────────────────────────────────────────────
-- 1. Precondições
-- ───────────────────────────────────────────────────────────────────────────

DO $precondicoes$
BEGIN
  -- As duas RPC da 101 têm de existir, com a assinatura exacta. Se a 101 não
  -- tiver corrido, este ficheiro não tem o que endurecer e não deve fingir
  -- que correu bem.
  IF to_regprocedure(
       'public.move_crm_lead_stage_atomic(uuid, uuid, text, text, uuid, text, text)'
     ) IS NULL THEN
    RAISE EXCEPTION
      'CRM_ACL_101A_PRECONDITION_FAILED: move_crm_lead_stage_atomic ausente (101)';
  END IF;

  IF to_regprocedure(
       'public.reorder_crm_leads_atomic(uuid, text, jsonb, uuid)'
     ) IS NULL THEN
    RAISE EXCEPTION
      'CRM_ACL_101A_PRECONDITION_FAILED: reorder_crm_leads_atomic ausente (101)';
  END IF;

  -- Os três papéis do Supabase. Revogar de um papel inexistente é um erro de
  -- SQL cru e ilegível; esta mensagem diz o que falta.
  IF to_regrole('anon') IS NULL
     OR to_regrole('authenticated') IS NULL
     OR to_regrole('service_role') IS NULL THEN
    RAISE EXCEPTION
      'CRM_ACL_101A_PRECONDITION_FAILED: papeis anon/authenticated/service_role ausentes';
  END IF;
END
$precondicoes$;

-- ───────────────────────────────────────────────────────────────────────────
-- 2. Fechar o ACL
-- ───────────────────────────────────────────────────────────────────────────
--
-- 🔴 `FROM PUBLIC, anon, authenticated` — os três, nomeados.
--
--    PUBLIC porque o privilégio implícito volta a ser o default se alguém
--    recriar a função; `anon` e `authenticated` porque são grants nominais e
--    são a causa provada deste hotfix. Revogar só PUBLIC foi precisamente o
--    que a 101 fez, e é o que não chegou.
--
-- Idempotente: `REVOKE` de um privilégio que já não existe é um no-op.

REVOKE ALL ON FUNCTION
  public.move_crm_lead_stage_atomic(uuid, uuid, text, text, uuid, text, text)
FROM PUBLIC, anon, authenticated;

REVOKE ALL ON FUNCTION
  public.reorder_crm_leads_atomic(uuid, text, jsonb, uuid)
FROM PUBLIC, anon, authenticated;

-- As Server Actions escrevem TODAS por `service_role`. Este GRANT é o que as
-- mantém a funcionar, e é reafirmado aqui para o ACL final desta migration ser
-- completo por construção — e não o resultado de somar o que a 101 deixou.
GRANT EXECUTE ON FUNCTION
  public.move_crm_lead_stage_atomic(uuid, uuid, text, text, uuid, text, text)
TO service_role;

GRANT EXECUTE ON FUNCTION
  public.reorder_crm_leads_atomic(uuid, text, jsonb, uuid)
TO service_role;

-- ───────────────────────────────────────────────────────────────────────────
-- 3. Fixar o `search_path`
-- ───────────────────────────────────────────────────────────────────────────
--
-- 🔴 Isto é endurecimento, não correcção de comportamento — e foi verificado
--    ficheiro a ficheiro antes de ser escrito, não presumido.
--
-- O que os dois corpos referenciam:
--
--   · tabelas: `public.crm_leads` e `public.crm_lead_interactions`, ambas
--     SEMPRE qualificadas com o schema nas duas funções. Nenhuma referência
--     não-qualificada a objecto de `public` existe em nenhuma das duas;
--   · funções e operadores: `jsonb_build_object`, `jsonb_build_array`,
--     `jsonb_array_length`, `jsonb_array_elements`, `jsonb_typeof`, `to_jsonb`,
--     `count`, `array_agg`, `btrim`, `now`, `trunc`, `length`, e os operadores
--     `?`, `@>`, `->`, `->>` sobre jsonb — todos de `pg_catalog`;
--   · tipos: uuid, text, jsonb, integer, numeric — todos de `pg_catalog`.
--
-- Com `pg_catalog, public` tudo continua a resolver para exactamente o mesmo
-- objecto que resolvia antes. O comportamento não muda; o que muda é que deixa
-- de poder mudar por acção de terceiros.
--
-- O que fecha: sem `search_path` fixo, a resolução de nomes segue o
-- `search_path` de QUEM CHAMA. Estas funções são SECURITY INVOKER, o que
-- limita o estrago — mas `pg_temp` é pesquisado antes de `public` quando está
-- no caminho, e um chamador que crie `pg_temp.crm_leads` desvia as referências
-- não-qualificadas. Hoje não há nenhuma; fixar o caminho garante que uma
-- referência não-qualificada acrescentada amanhã não se torna um vector.
--
-- Convenção do projecto: é a forma usada desde a 091
-- (`SECURITY INVOKER` + `SET search_path = pg_catalog, public`), presente em
-- 091-097. A 101 é a excepção, e é isso que se corrige aqui.
--
-- `ALTER FUNCTION ... SET` altera só o `proconfig`. Não recompila o corpo, não
-- mexe na assinatura e não invalida nada — por isso não há risco de a 101
-- deixar de bater consigo própria.

ALTER FUNCTION
  public.move_crm_lead_stage_atomic(uuid, uuid, text, text, uuid, text, text)
  SET search_path = pg_catalog, public;

ALTER FUNCTION
  public.reorder_crm_leads_atomic(uuid, text, jsonb, uuid)
  SET search_path = pg_catalog, public;

-- ───────────────────────────────────────────────────────────────────────────
-- 4. Pós-estado — fail-closed, por função
-- ───────────────────────────────────────────────────────────────────────────
--
-- 🔴 «Não deu erro» não é «ficou como se queria». Um `REVOKE` sobre um
--    privilégio que não existe é silencioso, e um `GRANT` que não chegou a ser
--    preciso também. O que se mede aqui é o ACL FINAL, lido do catálogo.
--
-- Não se usa `has_function_privilege()` para PUBLIC porque não há papel
-- `public` para lhe passar — PUBLIC é o grantee `0` no ACL, e é assim que se
-- lê. Para os papéis nomeados também se lê o ACL directamente, em vez de
-- `has_function_privilege()`: esta última responde TRUE por herança de
-- pertença a outro papel, e aqui o que interessa é o privilégio concedido
-- nesta função, não o caminho por onde alguém lá poderia chegar.

DO $posestado$
DECLARE
  v_fn          regprocedure;
  v_nome        text;
  v_acl         aclitem[];
  v_secdef      boolean;
  v_config      text[];
  v_public      boolean;
  v_anon        boolean;
  v_auth        boolean;
  v_service     boolean;
BEGIN
  FOREACH v_nome IN ARRAY ARRAY[
    'public.move_crm_lead_stage_atomic(uuid, uuid, text, text, uuid, text, text)',
    'public.reorder_crm_leads_atomic(uuid, text, jsonb, uuid)'
  ] LOOP
    v_fn := v_nome::regprocedure;

    SELECT p.proacl, p.prosecdef, p.proconfig
      INTO v_acl, v_secdef, v_config
      FROM pg_proc p
     WHERE p.oid = v_fn;

    -- ── SECURITY INVOKER ──────────────────────────────────────────────────
    --
    -- SECURITY DEFINER faria a função correr com os privilégios do dono
    -- (`postgres`), e aí o ACL seria a ÚNICA barreira — o RLS e o ACL das
    -- tabelas deixariam de se aplicar a quem a invocasse.
    IF v_secdef THEN
      RAISE EXCEPTION
        'CRM_ACL_101A_POSTSTATE_FAILED: % ficou SECURITY DEFINER', v_nome;
    END IF;

    -- ── O ACL não pode ser NULL ───────────────────────────────────────────
    --
    -- Para funções, `proacl IS NULL` significa o default do PostgreSQL, que é
    -- `EXECUTE` para PUBLIC. O estado «sem ACL» é o estado ABERTO.
    IF v_acl IS NULL THEN
      RAISE EXCEPTION
        'CRM_ACL_101A_POSTSTATE_FAILED: % sem ACL explicito = EXECUTE para PUBLIC',
        v_nome;
    END IF;

    SELECT
      bool_or(a.grantee = 0),
      bool_or(a.grantee = to_regrole('anon')::oid),
      bool_or(a.grantee = to_regrole('authenticated')::oid),
      bool_or(a.grantee = to_regrole('service_role')::oid)
      INTO v_public, v_anon, v_auth, v_service
      FROM aclexplode(v_acl) AS a
     WHERE a.privilege_type = 'EXECUTE';

    IF COALESCE(v_public, false) THEN
      RAISE EXCEPTION 'CRM_ACL_101A_POSTSTATE_FAILED: % com EXECUTE para PUBLIC', v_nome;
    END IF;

    IF COALESCE(v_anon, false) THEN
      RAISE EXCEPTION 'CRM_ACL_101A_POSTSTATE_FAILED: % com EXECUTE para anon', v_nome;
    END IF;

    IF COALESCE(v_auth, false) THEN
      RAISE EXCEPTION
        'CRM_ACL_101A_POSTSTATE_FAILED: % com EXECUTE para authenticated', v_nome;
    END IF;

    -- 🔴 E o inverso: fechar de mais partiria a aplicação inteira. Todas as
    --    Server Actions do funil chamam estas RPC por `service_role`.
    IF NOT COALESCE(v_service, false) THEN
      RAISE EXCEPTION
        'CRM_ACL_101A_POSTSTATE_FAILED: % sem EXECUTE para service_role', v_nome;
    END IF;

    -- ── `search_path` fixo ────────────────────────────────────────────────
    -- Não se compara a string inteira: a forma exacta com que o PostgreSQL
    -- normaliza o valor em `proconfig` é detalhe de catálogo, e prendê-la aqui
    -- daria um pós-estado que falha numa versão diferente sem nada de errado
    -- ter acontecido. O que importa é que EXISTE um `search_path` fixo e que
    -- ele inclui `pg_catalog`.
    IF v_config IS NULL
       OR NOT EXISTS (
         SELECT 1 FROM unnest(v_config) AS c
          WHERE c LIKE 'search_path=%' AND c LIKE '%pg_catalog%'
       ) THEN
      RAISE EXCEPTION
        'CRM_ACL_101A_POSTSTATE_FAILED: % sem search_path fixo (proconfig=%)',
        v_nome, v_config;
    END IF;
  END LOOP;
END
$posestado$;

COMMENT ON FUNCTION
  public.move_crm_lead_stage_atomic(uuid, uuid, text, text, uuid, text, text) IS
  'Move a lead no funil: estado e diario na MESMA transacao, com expected_stage '
  'obrigatorio como controlo de concorrencia e a matriz de transicoes aplicada '
  'na base. ACL fechado pela 101a: EXECUTE so para service_role — os grants a '
  'anon/authenticated vinham dos DEFAULT PRIVILEGES do schema e o REVOKE FROM '
  'PUBLIC da 101 nao os removia. search_path fixo em pg_catalog, public.';

COMMENT ON FUNCTION
  public.reorder_crm_leads_atomic(uuid, text, jsonb, uuid) IS
  'Reordena os cartoes de uma coluna do funil, tudo ou nada, trancando todas as '
  'leads-alvo por id em ordem deterministica antes de decidir. ACL fechado pela '
  '101a: EXECUTE so para service_role. search_path fixo em pg_catalog, public.';

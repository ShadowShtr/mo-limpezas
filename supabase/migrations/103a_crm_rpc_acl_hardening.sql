-- ============================================================================
-- 103a — CRM: fechar a ACL das RPC de orçamentos e fixar o search_path
-- ============================================================================
--
-- O runner é o dono da transação: este ficheiro não abre BEGIN/COMMIT.
--
-- ---------------------------------------------------------------------------
-- 🔴 O defeito, e porque é que a 103 não o apanhou
-- ---------------------------------------------------------------------------
--
-- A 103 fez, para cada RPC:
--
--     REVOKE ALL ON FUNCTION ... FROM PUBLIC;
--     GRANT EXECUTE ON FUNCTION ... TO service_role;
--
-- e isso parecia suficiente. Não era. `PUBLIC` e um grant NOMINAL são coisas
-- diferentes, e o que estava aberto eram os nominais:
--
--     proacl = postgres=X/postgres | anon=X/postgres
--            | authenticated=X/postgres | service_role=X/postgres
--
-- A causa está nos DEFAULT PRIVILEGES do papel `postgres` neste schema:
--
--     ALTER DEFAULT PRIVILEGES IN SCHEMA public
--       GRANT EXECUTE ON FUNCTIONS TO anon, authenticated, service_role;
--
-- Cada `CREATE FUNCTION` nasce já com esses três grants escritos na ACL.
-- `REVOKE ... FROM PUBLIC` não lhes toca — PUBLIC é o «toda a gente implícito»,
-- e estes são nomes concretos. É a mesma armadilha que a 101a fechou para as
-- RPC do funil; a 103 repetiu o erro por copiar o padrão incompleto.
--
-- ---------------------------------------------------------------------------
-- Qual é o risco, sem o inflacionar
-- ---------------------------------------------------------------------------
--
-- As três funções são `SECURITY INVOKER`, por isso correm com os privilégios
-- de quem chama: a ACL das tabelas e a RLS continuam a valer, e `anon` não
-- consegue gravar um orçamento por aqui.
--
-- Mas isso é a segunda linha de defesa a segurar o que a primeira devia ter
-- fechado. Antes de bater na ACL das tabelas, uma chamada de `anon` já entrou
-- na função, já correu `SELECT ... FOR UPDATE`, já pediu
-- `pg_advisory_xact_lock` e já percorreu lógica transacional. Uma superfície
-- de RPC aberta a `anon` não é aceitável por o dano final estar contido.
--
-- O contrato da 103 era `EXECUTE = service_role`. Esta migration cumpre-o.
--
-- ---------------------------------------------------------------------------
-- 🔴 Porquê uma migration nova, e não uma correcção à 103
-- ---------------------------------------------------------------------------
--
-- A 103 está aplicada em produção e o seu checksum está no ledger. Editar o
-- ficheiro criaria drift entre o que o ledger regista e o que o repositório
-- tem — exactamente a confusão que este projecto passou meses a desfazer.
--
-- O número fica entre as duas, por ordem lexicográfica:
--
--     103_crm_orcamentos.sql → 103a_crm_rpc_acl_hardening.sql → 104_...
--
-- ---------------------------------------------------------------------------
-- search_path
-- ---------------------------------------------------------------------------
--
-- As três funções têm `proconfig = NULL`: herdam o `search_path` de quem as
-- chama. Passam a ter `pg_catalog, public` fixo.
--
-- 🔴 Verificado antes de mudar, e não presumido. Os corpos não referem
--    `extensions`, `auth` nem `vault`, e todas as tabelas estão qualificadas
--    com `public.`. A única função com duas moradas possíveis é
--    `gen_random_uuid()`, que existe em `pg_catalog` (nativa desde o PG13) e
--    em `extensions` (pgcrypto) — e resolve hoje para a de `pg_catalog`,
--    porque esse schema é implicitamente o primeiro. Fixar o par mantém a
--    mesma resolução.
-- ============================================================================

DO $proveniencia$
DECLARE
  c_103 CONSTANT text := '103_crm_orcamentos.sql';
  c_103_checksum CONSTANT text :=
    '6893946882e2df1af16c79158f3bcbe0324b7cae92845e39d8cb389f8e0260d0';

  c_criar  CONSTANT text := 'public.create_crm_quote_with_items(uuid, uuid, uuid, uuid, text, integer, date, date, text, numeric, boolean, numeric, text, jsonb, text, text, text, uuid, jsonb)';
  c_rever  CONSTANT text := 'public.revise_crm_quote(uuid, uuid, uuid, date, date, numeric, boolean, numeric, text, jsonb)';
  c_estado CONSTANT text := 'public.set_crm_quote_status(uuid, uuid, uuid, text, text)';

  v_ledger boolean;
  v_estados text[];
  v_pre integer;
  v_post integer;
  v_faltam text[];
  v_checksum text;
BEGIN
  IF to_regclass('public._migrations') IS NULL THEN
    RAISE EXCEPTION
      'CRM_103A_LEDGER_AUSENTE: public._migrations não existe — esta migration só corre pelo runner canónico';
  END IF;

  -- ── A 103 tem de estar aplicada, e tem de ser a 103 que conhecemos ────────
  SELECT checksum INTO v_checksum FROM public._migrations WHERE name = c_103;

  IF NOT FOUND THEN
    RAISE EXCEPTION
      'CRM_103A_PRECONDITION_FAILED: % não está no ledger — não há ACL de orçamentos para fechar', c_103;
  END IF;

  IF v_checksum IS DISTINCT FROM c_103_checksum THEN
    RAISE EXCEPTION
      'CRM_103A_CHECKSUM_MISMATCH_103: o ledger guarda % para a 103 — as RPC à frente não são as que esta correcção conhece',
      coalesce(v_checksum, 'NULL');
  END IF;

  -- ── As três RPC, pelas assinaturas exactas ───────────────────────────────
  SELECT array_agg(f.assinatura ORDER BY f.assinatura) INTO v_faltam
    FROM (VALUES (c_criar), (c_rever), (c_estado)) AS f(assinatura)
   WHERE to_regprocedure(f.assinatura) IS NULL;

  IF v_faltam IS NOT NULL THEN
    RAISE EXCEPTION
      'CRM_103A_PRECONDITION_FAILED: RPC em falta ou com outra assinatura: %', v_faltam;
  END IF;

  -- ── Os papéis têm de existir: revogar de um papel inexistente rebenta ─────
  SELECT array_agg(r.nome ORDER BY r.nome) INTO v_faltam
    FROM (VALUES ('anon'), ('authenticated'), ('service_role')) AS r(nome)
   WHERE NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = r.nome);

  IF v_faltam IS NOT NULL THEN
    RAISE EXCEPTION 'CRM_103A_PRECONDITION_FAILED: papéis em falta: %', v_faltam;
  END IF;

  -- ── Proveniência: ledger 103a × estado CANÓNICO de cada RPC ──────────────
  --
  -- 🔴 Classificar CADA função, e só depois decidir. Contar «quantas têm a ACL
  --    fechada» e «quantas têm algum search_path» em separado é insuficiente:
  --    uma RPC com a ACL do poststate e o search_path do prestate contava para
  --    os dois totais e passava como se estivesse coerente. Um estado misto é
  --    desconhecido, e desconhecido falha fechado.
  --
  -- Cada função é exactamente uma de três coisas:
  --
  --   PRE     o que a 103 deixou: PUBLIC não, anon sim, authenticated sim,
  --           service_role sim, sem search_path fixo, SECURITY INVOKER
  --   POST    o que a 103a deixa: só service_role, search_path EXACTAMENTE
  --           `pg_catalog, public`, SECURITY INVOKER
  --   UNKNOWN tudo o resto
  --
  -- 🔴 `proacl IS NULL` é UNKNOWN, nunca «fechada». Numa função, ACL nula é o
  --    default do PostgreSQL — e o default INCLUI `EXECUTE` para PUBLIC. Lê-la
  --    como «ninguém tem EXECUTE» seria ler ao contrário.
  v_ledger := EXISTS (SELECT 1 FROM public._migrations WHERE name = '103a_crm_rpc_acl_hardening.sql');

  WITH alvo(assinatura) AS (VALUES (c_criar), (c_rever), (c_estado)),
  fn AS (
    SELECT a.assinatura, p.oid, p.prosecdef, p.proacl, p.proconfig
      FROM alvo a JOIN pg_proc p ON p.oid = to_regprocedure(a.assinatura)
  ),
  acl AS (
    SELECT fn.assinatura,
           bool_or(coalesce(g.rolname, 'PUBLIC') = 'PUBLIC')   AS tem_public,
           bool_or(g.rolname = 'anon')                          AS tem_anon,
           bool_or(g.rolname = 'authenticated')                 AS tem_auth,
           bool_or(g.rolname = 'service_role')                  AS tem_sr
      FROM fn
      CROSS JOIN LATERAL aclexplode(fn.proacl) x
      LEFT JOIN pg_roles g ON g.oid = x.grantee
     WHERE x.privilege_type = 'EXECUTE'
     GROUP BY fn.assinatura
  )
  SELECT array_agg(
           fn.assinatura || ' = ' ||
           CASE
             -- ACL por omissão: PUBLIC tem EXECUTE. Não é estado canónico nenhum.
             WHEN fn.proacl IS NULL THEN 'UNKNOWN(proacl NULL)'
             WHEN fn.prosecdef       THEN 'UNKNOWN(SECURITY DEFINER)'
             WHEN NOT coalesce(acl.tem_public, false)
              AND coalesce(acl.tem_anon, false)
              AND coalesce(acl.tem_auth, false)
              AND coalesce(acl.tem_sr, false)
              AND NOT EXISTS (SELECT 1 FROM unnest(coalesce(fn.proconfig, '{}')) c
                               WHERE c LIKE 'search_path=%')
               THEN 'PRE'
             WHEN NOT coalesce(acl.tem_public, false)
              AND NOT coalesce(acl.tem_anon, false)
              AND NOT coalesce(acl.tem_auth, false)
              AND coalesce(acl.tem_sr, false)
              AND 'search_path=pg_catalog, public' = ANY(coalesce(fn.proconfig, '{}'))
               THEN 'POST'
             ELSE 'UNKNOWN'
           END
           ORDER BY fn.assinatura)
    INTO v_estados
    FROM fn LEFT JOIN acl ON acl.assinatura = fn.assinatura;

  SELECT count(*) FILTER (WHERE e LIKE '% = PRE'),
         count(*) FILTER (WHERE e LIKE '% = POST')
    INTO v_pre, v_post
    FROM unnest(v_estados) AS e;

  IF v_ledger AND v_post = 3 THEN
    RAISE EXCEPTION
      'CRM_103A_JA_APLICADA: linha de ledger e as três RPC no estado canónico pós-103a — nada a fazer';

  ELSIF v_ledger THEN
    -- Linha presente sem o poststate completo: alguém desfez parte do
    -- endurecimento, ou nunca chegou a ficar inteiro.
    RAISE EXCEPTION
      'CRM_103A_LEDGER_WITHOUT_EFFECT: há linha de ledger da 103a mas o estado não é o pós-103a — %',
      array_to_string(v_estados, ' | ');

  ELSIF v_post = 3 THEN
    RAISE EXCEPTION
      'CRM_103A_EFFECT_WITHOUT_LEDGER: as três RPC já estão no estado pós-103a sem linha de ledger — estado desconhecido, nada foi alterado';

  ELSIF v_pre <> 3 THEN
    -- 🔴 Nem tudo PRE nem tudo POST: mistura. Não se normaliza o que não se
    --    percebe — aplicar aqui seria adoptar um estado que ninguém explicou.
    RAISE EXCEPTION
      'CRM_103A_PARTIAL_OR_UNKNOWN_EFFECT: as RPC não estão todas no estado pré-103a — %',
      array_to_string(v_estados, ' | ');
  END IF;
END
$proveniencia$;

-- ---------------------------------------------------------------------------
-- 1. Fechar a ACL
-- ---------------------------------------------------------------------------
--
-- 🔴 `FROM PUBLIC, anon, authenticated` — os três, e não só o PUBLIC. Era
--    exactamente esta lista que faltava na 103.

REVOKE ALL ON FUNCTION public.create_crm_quote_with_items(uuid, uuid, uuid, uuid, text, integer, date, date, text, numeric, boolean, numeric, text, jsonb, text, text, text, uuid, jsonb)
  FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.revise_crm_quote(uuid, uuid, uuid, date, date, numeric, boolean, numeric, text, jsonb)
  FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.set_crm_quote_status(uuid, uuid, uuid, text, text)
  FROM PUBLIC, anon, authenticated;

GRANT EXECUTE ON FUNCTION public.create_crm_quote_with_items(uuid, uuid, uuid, uuid, text, integer, date, date, text, numeric, boolean, numeric, text, jsonb, text, text, text, uuid, jsonb)
  TO service_role;
GRANT EXECUTE ON FUNCTION public.revise_crm_quote(uuid, uuid, uuid, date, date, numeric, boolean, numeric, text, jsonb)
  TO service_role;
GRANT EXECUTE ON FUNCTION public.set_crm_quote_status(uuid, uuid, uuid, text, text)
  TO service_role;

-- ---------------------------------------------------------------------------
-- 2. Fixar o search_path
-- ---------------------------------------------------------------------------
--
-- Só `ALTER FUNCTION ... SET`: não toca no corpo, no `SECURITY INVOKER`, nem
-- na assinatura.

ALTER FUNCTION public.create_crm_quote_with_items(uuid, uuid, uuid, uuid, text, integer, date, date, text, numeric, boolean, numeric, text, jsonb, text, text, text, uuid, jsonb)
  SET search_path = pg_catalog, public;
ALTER FUNCTION public.revise_crm_quote(uuid, uuid, uuid, date, date, numeric, boolean, numeric, text, jsonb)
  SET search_path = pg_catalog, public;
ALTER FUNCTION public.set_crm_quote_status(uuid, uuid, uuid, text, text)
  SET search_path = pg_catalog, public;

-- ---------------------------------------------------------------------------
-- 3. Pós-estado
-- ---------------------------------------------------------------------------
--
-- 🔴 Medido por `aclexplode`, e não por `has_function_privilege`. Foi essa a
--    diferença que deixou o defeito passar: `has_function_privilege('public',
--    ...)` responde sobre o PUBLIC implícito e diz «não» enquanto `anon` tem
--    um grant nominal a dizer «sim». A ACL lê-se por dentro.

DO $posestado$
DECLARE
  c_criar  CONSTANT text := 'public.create_crm_quote_with_items(uuid, uuid, uuid, uuid, text, integer, date, date, text, numeric, boolean, numeric, text, jsonb, text, text, text, uuid, jsonb)';
  c_rever  CONSTANT text := 'public.revise_crm_quote(uuid, uuid, uuid, date, date, numeric, boolean, numeric, text, jsonb)';
  c_estado CONSTANT text := 'public.set_crm_quote_status(uuid, uuid, uuid, text, text)';
  v_abertas text[];
  v_sem_grant text[];
  v_sem_search text[];
  v_definer text[];
BEGIN
  -- Ninguém indevido com EXECUTE, nominal ou implícito.
  SELECT array_agg(DISTINCT f.assinatura) INTO v_abertas
    FROM (VALUES (c_criar), (c_rever), (c_estado)) AS f(assinatura)
    JOIN pg_proc p ON p.oid = to_regprocedure(f.assinatura)
    CROSS JOIN LATERAL aclexplode(p.proacl) a
    LEFT JOIN pg_roles g ON g.oid = a.grantee
   WHERE a.privilege_type = 'EXECUTE'
     AND coalesce(g.rolname, 'PUBLIC') IN ('PUBLIC', 'anon', 'authenticated');

  IF v_abertas IS NOT NULL THEN
    RAISE EXCEPTION
      'CRM_103A_POSTSTATE_FAILED: ainda há EXECUTE para PUBLIC/anon/authenticated em %', v_abertas;
  END IF;

  -- E `service_role` tem de continuar a conseguir chamar.
  SELECT array_agg(f.assinatura ORDER BY f.assinatura) INTO v_sem_grant
    FROM (VALUES (c_criar), (c_rever), (c_estado)) AS f(assinatura)
   WHERE NOT EXISTS (
     SELECT 1 FROM pg_proc p
       CROSS JOIN LATERAL aclexplode(p.proacl) a
       JOIN pg_roles g ON g.oid = a.grantee
      WHERE p.oid = to_regprocedure(f.assinatura)
        AND a.privilege_type = 'EXECUTE' AND g.rolname = 'service_role'
   );

  IF v_sem_grant IS NOT NULL THEN
    RAISE EXCEPTION
      'CRM_103A_POSTSTATE_FAILED: service_role ficou sem EXECUTE em % — as Server Actions deixariam de funcionar', v_sem_grant;
  END IF;

  SELECT array_agg(f.assinatura ORDER BY f.assinatura) INTO v_sem_search
    FROM (VALUES (c_criar), (c_rever), (c_estado)) AS f(assinatura)
    JOIN pg_proc p ON p.oid = to_regprocedure(f.assinatura)
   WHERE p.proconfig IS NULL
      OR NOT EXISTS (
        SELECT 1 FROM unnest(p.proconfig) cfg
         WHERE cfg = 'search_path=pg_catalog, public'
      );

  IF v_sem_search IS NOT NULL THEN
    RAISE EXCEPTION 'CRM_103A_POSTSTATE_FAILED: search_path não ficou fixo em %', v_sem_search;
  END IF;

  -- O endurecimento não pode ter transformado nada em SECURITY DEFINER.
  SELECT array_agg(f.assinatura ORDER BY f.assinatura) INTO v_definer
    FROM (VALUES (c_criar), (c_rever), (c_estado)) AS f(assinatura)
    JOIN pg_proc p ON p.oid = to_regprocedure(f.assinatura)
   WHERE p.prosecdef;

  IF v_definer IS NOT NULL THEN
    RAISE EXCEPTION
      'CRM_103A_POSTSTATE_FAILED: % ficou SECURITY DEFINER — estas RPC correm com quem chama, por desenho', v_definer;
  END IF;
END
$posestado$;

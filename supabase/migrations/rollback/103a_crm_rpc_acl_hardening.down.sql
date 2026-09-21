-- Rollback da 103a.
--
-- ---------------------------------------------------------------------------
-- 🔴 LER ANTES DE CORRER. Este ficheiro REABRE uma superfície de segurança.
-- ---------------------------------------------------------------------------
--
-- A 103a existe porque as três RPC de orçamentos tinham `EXECUTE` nominal para
-- `anon` e `authenticated`. Desfazê-la devolve exactamente esse estado: uma
-- chamada anónima volta a poder entrar nas funções, correr `SELECT ... FOR
-- UPDATE`, pedir advisory locks e percorrer lógica transacional.
--
-- O caminho operacional normal é **NÃO correr isto**. Um endurecimento de
-- segurança em produção não se desfaz por rotina; se a 103a partiu alguma
-- coisa, o que se corrige é o que partiu — não se reabre a porta.
--
-- Este ficheiro existe para o caso em que a reabertura é mesmo a decisão
-- tomada, e para que essa decisão fique escrita algures.
--
-- ---------------------------------------------------------------------------
-- 🔴 Exige confirmação explícita
-- ---------------------------------------------------------------------------
--
-- Não basta executar o ficheiro. Quem o corre tem de declarar a intenção na
-- mesma transação:
--
--     BEGIN;
--     SET LOCAL crm.reabrir_acl_103a = 'confirmo';
--     \i supabase/migrations/rollback/103a_crm_rpc_acl_hardening.down.sql
--     COMMIT;
--
-- É o equivalente ao `--confirm-production` do runner: obriga a escrever o que
-- se está a fazer, para que não aconteça por arrasto de um script.
--
-- ---------------------------------------------------------------------------
-- O que este rollback NÃO toca
-- ---------------------------------------------------------------------------
--
--   · não apaga nem altera `crm_quotes` ou `crm_quote_items`;
--   · não apaga uma única linha de dados;
--   · não mexe em RLS, políticas, índices, triggers nem nos corpos das RPC;
--   · não toca na 103, nem no ledger dela.
--
-- Desfaz duas coisas, e só essas: os grants nominais e o `search_path` fixo.
-- ---------------------------------------------------------------------------

DO $rollback103a$
DECLARE
  c_migration CONSTANT text := '103a_crm_rpc_acl_hardening.sql';
  c_lf   CONSTANT text := 'bcd107aa0ab837968856150d7ebfa02704cb97f9b4ace10d35ea7dde714ac738';
  c_crlf CONSTANT text := '35c845fbafb10653add6bc8d14dbe9045a94697906949efe739adbd5fa28fdb4';

  c_criar  CONSTANT text := 'public.create_crm_quote_with_items(uuid, uuid, uuid, uuid, text, integer, date, date, text, numeric, boolean, numeric, text, jsonb, text, text, text, uuid, jsonb)';
  c_rever  CONSTANT text := 'public.revise_crm_quote(uuid, uuid, uuid, date, date, numeric, boolean, numeric, text, jsonb)';
  c_estado CONSTANT text := 'public.set_crm_quote_status(uuid, uuid, uuid, text, text)';

  c_103 CONSTANT text := '103_crm_orcamentos.sql';
  c_103_checksum CONSTANT text :=
    '6893946882e2df1af16c79158f3bcbe0324b7cae92845e39d8cb389f8e0260d0';

  v_confirmacao text;
  v_checksum text;
  v_checksum_103 text;
  v_ledger boolean;
  v_faltam text[];
  v_estados text[];
  v_post integer;
  f record;
BEGIN
  -- ── A confirmação explícita, antes de tudo ───────────────────────────────
  v_confirmacao := current_setting('crm.reabrir_acl_103a', true);

  IF v_confirmacao IS DISTINCT FROM 'confirmo' THEN
    RAISE EXCEPTION
      'CRM_103A_ROLLBACK_NAO_CONFIRMADO: este rollback reabre EXECUTE a anon/authenticated nas RPC de orçamentos. Para o correr mesmo assim: SET LOCAL crm.reabrir_acl_103a = ''confirmo'' na mesma transação';
  END IF;

  IF to_regclass('public._migrations') IS NULL THEN
    RAISE EXCEPTION
      'CRM_103A_ROLLBACK_LEDGER_AUSENTE: public._migrations não existe — sem ledger não se prova o que está aplicado';
  END IF;

  -- ── Proveniência exacta: só desfaz o que esta migration fez ──────────────
  SELECT checksum INTO v_checksum
    FROM public._migrations
   WHERE name = c_migration
     FOR UPDATE;

  v_ledger := FOUND;

  IF NOT v_ledger THEN
    RAISE EXCEPTION
      'CRM_103A_ROLLBACK_LEDGER_WITHOUT_ENTRY: não há linha de ledger da 103a — não é este rollback que desfaz o que quer que esteja à frente';
  END IF;

  IF v_checksum IS NULL OR v_checksum NOT IN (c_lf, c_crlf) THEN
    RAISE EXCEPTION
      'CRM_103A_ROLLBACK_CHECKSUM_DIVERGENTE: o ledger guarda % para a 103a — o endurecimento à frente não foi feito pelo ficheiro que este rollback desfaz',
      coalesce(v_checksum, 'NULL');
  END IF;

  SELECT array_agg(x.assinatura ORDER BY x.assinatura) INTO v_faltam
    FROM (VALUES (c_criar), (c_rever), (c_estado)) AS x(assinatura)
   WHERE to_regprocedure(x.assinatura) IS NULL;

  IF v_faltam IS NOT NULL THEN
    RAISE EXCEPTION
      'CRM_103A_ROLLBACK_PRECONDITION_FAILED: RPC em falta ou com outra assinatura: %', v_faltam;
  END IF;

  -- ── A 103a só existe sobre a 103, e sobre ESTA 103 ───────────────────────
  --
  -- Se a proveniência da fundação já estiver partida, não se reabre a ACL nem
  -- se apaga a linha da 103a como se o mundo estivesse normal.
  SELECT checksum INTO v_checksum_103 FROM public._migrations WHERE name = c_103;

  IF NOT FOUND THEN
    RAISE EXCEPTION
      'CRM_103A_ROLLBACK_103_AUSENTE: % não está no ledger — a fundação sobre a qual a 103a existe desapareceu; nada foi alterado', c_103;
  END IF;

  IF v_checksum_103 IS DISTINCT FROM c_103_checksum THEN
    RAISE EXCEPTION
      'CRM_103A_ROLLBACK_103_CHECKSUM_DIVERGENTE: o ledger guarda % para a 103 — a fundação não é a que a 103a endureceu; nada foi alterado',
      coalesce(v_checksum_103, 'NULL');
  END IF;

  -- ── O que está à frente tem de ser EXACTAMENTE o que a 103a deixou ───────
  --
  -- 🔴 Sem isto, o rollback reabria a ACL por cima de um estado que já não
  --    era o dele: uma RPC re-granted à mão, um search_path trocado, um
  --    SECURITY DEFINER aparecido. Repor «o estado anterior» a partir de um
  --    presente desconhecido não repõe nada — inventa.
  --
  --    `proacl IS NULL` conta como drift: ACL nula é o default, e o default
  --    inclui EXECUTE para PUBLIC.
  WITH alvo(assinatura) AS (VALUES (c_criar), (c_rever), (c_estado)),
  fn AS (
    SELECT a.assinatura, p.oid, p.prosecdef, p.proacl, p.proconfig,
           (SELECT r.rolname FROM pg_roles r WHERE r.oid = p.proowner) AS dono
      FROM alvo a JOIN pg_proc p ON p.oid = to_regprocedure(a.assinatura)
  ),
  acl AS (
    -- 🔴 O CONJUNTO de quem tem EXECUTE, e se algum é transmissível. Perguntar
    --    só por PUBLIC/anon/authenticated deixaria passar um grantee novo.
    SELECT fn.assinatura,
           array_agg(DISTINCT coalesce(g.rolname, 'PUBLIC')
                     ORDER BY coalesce(g.rolname, 'PUBLIC')) AS grantees,
           bool_or(x.is_grantable) AS algum_transmissivel
      FROM fn
      CROSS JOIN LATERAL aclexplode(fn.proacl) x
      LEFT JOIN pg_roles g ON g.oid = x.grantee
     WHERE x.privilege_type = 'EXECUTE'
     GROUP BY fn.assinatura
  )
  SELECT array_agg(
           fn.assinatura || ' = ' ||
           CASE
             WHEN fn.proacl IS NULL THEN 'DRIFT(proacl NULL)'
             WHEN fn.prosecdef      THEN 'DRIFT(SECURITY DEFINER)'
             WHEN fn.dono IS NULL   THEN 'DRIFT(dono desconhecido)'
             WHEN coalesce(acl.algum_transmissivel, false)
               THEN 'DRIFT(WITH GRANT OPTION)'
             WHEN acl.grantees = (SELECT array_agg(DISTINCT r ORDER BY r)
                                    FROM unnest(ARRAY[fn.dono, 'service_role']) r)
              AND 'search_path=pg_catalog, public' = ANY(coalesce(fn.proconfig, '{}'))
               THEN 'POST'
             ELSE 'DRIFT(' || coalesce(array_to_string(acl.grantees, '+'), 'sem ACL') || ')'
           END
           ORDER BY fn.assinatura)
    INTO v_estados
    FROM fn LEFT JOIN acl ON acl.assinatura = fn.assinatura;

  SELECT count(*) FILTER (WHERE e LIKE '% = POST') INTO v_post FROM unnest(v_estados) AS e;

  IF v_post <> 3 THEN
    RAISE EXCEPTION
      'CRM_103A_ROLLBACK_POSTSTATE_DRIFT: o estado à frente já não é o que a 103a deixou — %. Nada foi alterado e a linha de ledger ficou intacta',
      array_to_string(v_estados, ' | ');
  END IF;

  -- ── Repor o estado anterior: grants nominais e search_path herdado ───────
  FOR f IN SELECT unnest(ARRAY[c_criar, c_rever, c_estado]) AS assinatura LOOP
    EXECUTE format('GRANT EXECUTE ON FUNCTION %s TO anon, authenticated', f.assinatura);
    EXECUTE format('ALTER FUNCTION %s RESET search_path', f.assinatura);
  END LOOP;

  DELETE FROM public._migrations WHERE name = c_migration;

  RAISE WARNING
    'CRM_103A_ROLLBACK_EXECUTADO: anon e authenticated voltaram a ter EXECUTE nas três RPC de orçamentos. Esta reabertura foi deliberada e está registada aqui.';
END
$rollback103a$;

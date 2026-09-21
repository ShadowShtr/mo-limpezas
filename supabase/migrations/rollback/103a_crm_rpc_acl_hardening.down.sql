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
  c_lf   CONSTANT text := '7b1ea9168085220cd1c315700257668e4225791e21957794a0d1b85f85694ee8';
  c_crlf CONSTANT text := '14183a84f4f67f8558ecde5cc958c82401da55678b613e692648ebd239b832b4';

  c_criar  CONSTANT text := 'public.create_crm_quote_with_items(uuid, uuid, uuid, uuid, text, integer, date, date, text, numeric, boolean, numeric, text, jsonb, text, text, text, uuid, jsonb)';
  c_rever  CONSTANT text := 'public.revise_crm_quote(uuid, uuid, uuid, date, date, numeric, boolean, numeric, text, jsonb)';
  c_estado CONSTANT text := 'public.set_crm_quote_status(uuid, uuid, uuid, text, text)';

  v_confirmacao text;
  v_checksum text;
  v_ledger boolean;
  v_faltam text[];
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

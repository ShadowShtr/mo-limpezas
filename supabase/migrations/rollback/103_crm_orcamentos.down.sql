-- Rollback da 103.
--
-- ---------------------------------------------------------------------------
-- 🔴 NO_DATA_LOSS — este ficheiro recusa-se a apagar orçamentos
-- ---------------------------------------------------------------------------
--
-- A versão anterior fazia `DROP TABLE IF EXISTS` e avisava, em comentário,
-- para exportar antes se algum orçamento já tivesse saído de casa. Um aviso
-- não é uma protecção: quem corre um rollback a seguir a uma aplicação falhada
-- não lê o cabeçalho.
--
-- E aqui o dano é pior do que perder um registo interno. Um orçamento enviado
-- é um documento que está na caixa de correio de um cliente, com um número. Se
-- desaparecer daqui, esse número deixa de corresponder a alguma coisa — e a
-- cadeia de revisões que explica porque é que ele foi substituído desaparece
-- com ele.
--
-- Contrato:
--
--     ledger  tabela
--       0       0     → no-op idempotente
--       0       1     → ALIENADA: a tabela não é desta migration → RAISE
--       1       0     → LEDGER_WITHOUT_EFFECT → RAISE (decisão humana)
--       1       1     → checksum → lock → contar → vazia: DROP + DELETE
--
-- ---------------------------------------------------------------------------
-- 🔴 O lock vem ANTES da contagem
-- ---------------------------------------------------------------------------
--
-- Um bloco `DO` não é um lock. Entre o `count(*)` e o `DROP` cabe uma
-- transação que cria um orçamento e faz commit — e o `DROP`, que só então pede
-- `ACCESS EXCLUSIVE`, espera por ela e apaga-o a seguir. A contagem teria dito
-- zero, e mesmo assim perdia-se um documento.
--
-- As DUAS tabelas são bloqueadas, e pela ordem em que a 103 as criou:
-- `crm_quotes` primeiro, `crm_quote_items` depois. Ordem fixa é o que impede
-- um deadlock contra qualquer outra coisa que as toque na mesma ordem.
--
-- ---------------------------------------------------------------------------
-- 🔴 Simetria com o ledger
-- ---------------------------------------------------------------------------
--
-- Desfazer o efeito sem desfazer a proveniência deixaria `103 = PRESENT` com
-- as tabelas ausentes: o runner consideraria a 103 aplicada e nunca mais a
-- reconstruiria. `DROP` e `DELETE` no mesmo bloco, ou nada.
--
-- ---------------------------------------------------------------------------
-- 🔴 `company_settings.quote_prefix` — fica, mas só se ninguém lhe tocou
-- ---------------------------------------------------------------------------
--
-- A coluna é aditiva, tem valor por omissão (`'ORC'`), e não custa nada ficar.
-- Removê-la obrigaria a reescrever a linha de configurações de cada empresa
-- para apagar um valor que ninguém pediu para apagar — uma escrita destrutiva
-- a mais, num ficheiro cujo propósito é não destruir.
--
-- Mas há um caso em que deixá-la em silêncio seria errado: se alguém já
-- CONFIGUROU um prefixo próprio — `ORÇ`, `PROP`, o que for — esse valor é uma
-- decisão da operação, tomada depois da migration. Desfazer a 103 com essa
-- configuração viva deixaria a base num estado que nem é «antes da 103» nem
-- «depois»: uma coluna órfã com uma escolha que ninguém sabe de onde veio.
--
-- Por isso: prefixo no valor inicial ⇒ segue; prefixo alterado ⇒ RECUSA, e
-- quem opera decide o que fazer à configuração antes de desfazer o resto.
--
--     UNKNOWN_STATE = FAIL_CLOSED
--
-- Não toca em `invoices`, `services`, `contracts` nem em nada financeiro: a
-- 103 também não tocou. Um orçamento aceite que já tenha gerado contrato deixa
-- esse contrato exactamente onde está.
-- ---------------------------------------------------------------------------

DO $rollback103$
DECLARE
  c_migration CONSTANT text := '103_crm_orcamentos.sql';
  c_lf   CONSTANT text := '59c4298988c746b38a63d44836ccf3dce63801ed4910d3d712f68757e75e8dd9';
  c_crlf CONSTANT text := '5b459bcc5228053a4e269b3365e9a6e3e95cb711afe934adca8e530f1cdc7979';
  v_checksum text;
  v_ledger boolean;
  v_tabela boolean;
  v_orcamentos bigint;
  v_linhas bigint;
  v_prefixos text[];
BEGIN
  IF to_regclass('public._migrations') IS NULL THEN
    RAISE EXCEPTION
      'CRM_QUOTES_103_ROLLBACK_LEDGER_AUSENTE: public._migrations não existe — sem ledger não se prova o que estas tabelas são';
  END IF;

  -- `FOR UPDATE` serializa dois rollbacks simultâneos.
  SELECT checksum INTO v_checksum
    FROM public._migrations
   WHERE name = c_migration
     FOR UPDATE;

  v_ledger := FOUND;
  v_tabela := to_regclass('public.crm_quotes') IS NOT NULL;

  IF NOT v_ledger AND NOT v_tabela THEN
    RAISE NOTICE 'CRM_QUOTES_103_ROLLBACK: sem linha de ledger e sem tabela — nada a desfazer';
    RETURN;
  END IF;

  IF NOT v_ledger AND v_tabela THEN
    RAISE EXCEPTION
      'CRM_QUOTES_103_ROLLBACK_TABELA_ALIENADA: public.crm_quotes existe sem linha de ledger da 103 — não foi esta migration que a criou, e não é esta que a apaga';
  END IF;

  IF v_ledger AND NOT v_tabela THEN
    RAISE EXCEPTION
      'CRM_QUOTES_103_ROLLBACK_LEDGER_WITHOUT_EFFECT: há linha de ledger da 103 mas a tabela não existe — apagar a linha aqui esconderia o que aconteceu; reconcilie em primeira pessoa';
  END IF;

  IF v_checksum IS NULL OR v_checksum NOT IN (c_lf, c_crlf) THEN
    RAISE EXCEPTION
      'CRM_QUOTES_103_ROLLBACK_CHECKSUM_DIVERGENTE: o ledger guarda % para a 103 — as tabelas à frente não foram criadas pelo ficheiro que este rollback desfaz',
      coalesce(v_checksum, 'NULL');
  END IF;

  -- 🔴 TODOS os locks antes de TODAS as leituras, e por ordem fixa.
  --
  --    A ordem é sempre esta, do mais partilhado para o mais específico:
  --
  --        company_settings → crm_quotes → crm_quote_items
  --
  --    Ordem determinística é o que impede um deadlock contra qualquer outra
  --    transação que toque nas mesmas tabelas.
  --
  --    `company_settings` entra em `SHARE MODE`, que é o mínimo que bloqueia
  --    um `UPDATE` (ROW EXCLUSIVE) sem impedir leituras. Sem ele havia uma
  --    corrida real: o rollback lia `quote_prefix = 'ORC'`, alguém gravava
  --    `'PROP'` a seguir, e o rollback desfazia a 103 com base numa leitura
  --    que já não era verdade — decidindo com informação velha sobre uma
  --    configuração que entretanto passou a existir.
  IF to_regclass('public.company_settings') IS NOT NULL THEN
    EXECUTE 'LOCK TABLE public.company_settings IN SHARE MODE';
  END IF;
  EXECUTE 'LOCK TABLE public.crm_quotes IN ACCESS EXCLUSIVE MODE';
  IF to_regclass('public.crm_quote_items') IS NOT NULL THEN
    EXECUTE 'LOCK TABLE public.crm_quote_items IN ACCESS EXCLUSIVE MODE';
  END IF;

  EXECUTE 'SELECT count(*) FROM public.crm_quotes' INTO v_orcamentos;

  v_linhas := 0;
  IF to_regclass('public.crm_quote_items') IS NOT NULL THEN
    EXECUTE 'SELECT count(*) FROM public.crm_quote_items' INTO v_linhas;
  END IF;

  IF v_orcamentos > 0 OR v_linhas > 0 THEN
    RAISE EXCEPTION
      'CRM_QUOTES_103_ROLLBACK_RECUSADO: % orçamento(s) e % linha(s) em public.crm_quotes/crm_quote_items — o rollback não apaga documentos que podem ter saído de casa; trate dos dados primeiro',
      v_orcamentos, v_linhas;
  END IF;

  -- 🔴 Configuração posterior do utilizador não se destrói por arrasto.
  IF EXISTS (
    SELECT 1 FROM information_schema.columns
     WHERE table_schema = 'public' AND table_name = 'company_settings'
       AND column_name = 'quote_prefix'
  ) THEN
    EXECUTE $q$
      SELECT array_agg(DISTINCT quote_prefix)
        FROM public.company_settings
       WHERE quote_prefix IS DISTINCT FROM 'ORC'
    $q$ INTO v_prefixos;

    IF v_prefixos IS NOT NULL THEN
      RAISE EXCEPTION
        'CRM_QUOTES_103_ROLLBACK_CONFIG_ALTERADA: company_settings.quote_prefix já foi configurado (%) — é uma decisão posterior à migration; trate dela antes de desfazer a 103',
        array_to_string(v_prefixos, ', ');
    END IF;
  END IF;

  -- As RPC saem antes das tabelas de que dependem.
  DROP FUNCTION IF EXISTS public.set_crm_quote_status(uuid, uuid, uuid, text, text);
  DROP FUNCTION IF EXISTS public.revise_crm_quote(uuid, uuid, uuid, date, date, numeric, boolean, numeric, text, jsonb);
  DROP FUNCTION IF EXISTS public.create_crm_quote_with_items(uuid, uuid, uuid, uuid, text, integer, date, date, text, numeric, boolean, numeric, text, jsonb, text, text, text, uuid, jsonb);

  EXECUTE 'DROP TABLE IF EXISTS public.crm_quote_items';
  EXECUTE 'DROP TABLE public.crm_quotes';

  -- A função do trigger de imutabilidade da proveniência sobrevive ao
  -- `DROP TABLE` (o trigger morre com a tabela, a função não). Sem isto,
  -- reaplicar a 103 encontrava uma função órfã de uma versão anterior.
  DROP FUNCTION IF EXISTS public.crm_quotes_proveniencia_imutavel();

  DELETE FROM public._migrations WHERE name = c_migration;
END
$rollback103$;

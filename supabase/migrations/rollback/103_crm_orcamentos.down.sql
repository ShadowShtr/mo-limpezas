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
--       1       1     → checksum → locks → guardas → DROP tudo + DELETE
--
-- ---------------------------------------------------------------------------
-- 🔴 Os locks vêm ANTES de todas as leituras
-- ---------------------------------------------------------------------------
--
-- Um bloco `DO` não é um lock. Entre o `count(*)` e o `DROP` cabe uma
-- transação que cria um orçamento e faz commit — e o `DROP`, que só então pede
-- `ACCESS EXCLUSIVE`, espera por ela e apaga-o a seguir. A contagem teria dito
-- zero, e mesmo assim perdia-se um documento.
--
-- Ordem fixa, do mais partilhado para o mais específico:
--
--     company_settings → crm_quotes → crm_quote_items
--
-- Todos em `ACCESS EXCLUSIVE`, incluindo `company_settings`: este rollback faz
-- `DROP COLUMN`, que exige esse nível de qualquer forma. Pedi-lo logo evita
-- uma promoção de lock a meio, que com um `UPDATE` concorrente à espera é um
-- deadlock à espera de acontecer.
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
-- 🔴 `company_settings.quote_prefix` sai também
-- ---------------------------------------------------------------------------
--
-- A coluna é um efeito exclusivo da 103 como qualquer tabela ou RPC. Deixá-la
-- para trás criava um resíduo que o portão da migration teria de tratar como
-- excepção — e uma proveniência com excepções é uma proveniência mais fraca.
--
-- Um rollback limpo devolve o estado pré-103 REAL:
--
--     ledger 103 · crm_quotes · crm_quote_items · RPC · trigger · quote_prefix
--                          todos ABSENT
--
-- É isso que torna `APPLY → ROLLBACK → APPLY` um ciclo sem casos especiais.
--
-- NO_DATA_LOSS do prefixo, antes de o apagar e já sob lock:
--
--   · a coluna existe, é `text`, é `NOT NULL` e tem DEFAULT `'ORC'`;
--   · nenhuma empresa tem um valor diferente de `'ORC'`.
--
-- Um prefixo personalizado é uma decisão da operação, tomada depois da
-- migration, e não se apaga por arrasto. Um esquema diferente do esperado
-- também trava: não se normaliza nem se repara o que não se percebe.
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
  c_lf   CONSTANT text := '6893946882e2df1af16c79158f3bcbe0324b7cae92845e39d8cb389f8e0260d0';
  c_crlf CONSTANT text := '86cb0b14e78791feeec4c8f8bdcf78fbf92568ec17fd8305407df761166ee4cf';
  v_checksum text;
  v_ledger boolean;
  v_tabela boolean;
  v_orcamentos bigint;
  v_linhas bigint;
  v_prefixos text[];
  v_tipo text;
  v_nullable text;
  v_default text;
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
  --    🔴 `company_settings` entra já em `ACCESS EXCLUSIVE`, e não em `SHARE`.
  --       Este rollback faz `DROP COLUMN`, que precisa de ACCESS EXCLUSIVE de
  --       qualquer maneira. Pedir o nível final LOGO evita uma promoção de
  --       lock a meio — e uma promoção com um `UPDATE` concorrente já à espera
  --       é um deadlock à espera de acontecer.
  --
  --       Sem este lock havia uma corrida real: o rollback lia
  --       `quote_prefix = 'ORC'`, alguém gravava `'PROP'` a seguir, e a 103
  --       era desfeita com base numa leitura que já não era verdade.
  IF to_regclass('public.company_settings') IS NOT NULL THEN
    EXECUTE 'LOCK TABLE public.company_settings IN ACCESS EXCLUSIVE MODE';
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

  -- 🔴 O prefixo: validar o esquema E os valores antes de apagar a coluna.
  SELECT data_type, is_nullable, column_default
    INTO v_tipo, v_nullable, v_default
    FROM information_schema.columns
   WHERE table_schema = 'public' AND table_name = 'company_settings'
     AND column_name = 'quote_prefix';

  IF FOUND THEN
    -- Um esquema diferente do que a 103 criou significa que alguém lhe mexeu.
    -- Não se normaliza nem se repara o que não se percebe.
    IF v_tipo IS DISTINCT FROM 'text'
       OR v_nullable IS DISTINCT FROM 'NO'
       OR v_default IS DISTINCT FROM '''ORC''::text' THEN
      RAISE EXCEPTION
        'CRM_QUOTES_103_ROLLBACK_CONFIG_ESQUEMA_INESPERADO: quote_prefix é (tipo=%, nullable=%, default=%) e a 103 criou-a como (text, NO, ''ORC''::text) — alguém lhe mexeu; nada foi apagado',
        v_tipo, v_nullable, coalesce(v_default, 'NULL');
    END IF;

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

  -- A coluna de prefixo sai com o resto. Já foi validada acima, sob o lock que
  -- este `DROP COLUMN` exige — nada mudou desde então.
  IF v_tipo IS NOT NULL THEN
    EXECUTE 'ALTER TABLE public.company_settings DROP COLUMN quote_prefix';
  END IF;

  -- A função do trigger de imutabilidade da proveniência sobrevive ao
  -- `DROP TABLE` (o trigger morre com a tabela, a função não). Sem isto,
  -- reaplicar a 103 encontrava uma função órfã de uma versão anterior.
  DROP FUNCTION IF EXISTS public.crm_quotes_proveniencia_imutavel();

  DELETE FROM public._migrations WHERE name = c_migration;
END
$rollback103$;

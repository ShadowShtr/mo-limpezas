-- Rollback da 105.
--
-- ---------------------------------------------------------------------------
-- 🔴 ESTE ROLLBACK É ESTRUTURAL. NÃO DESFAZ EDIÇÕES.
-- ---------------------------------------------------------------------------
--
-- A 105 cria UMA coisa: a RPC `edit_crm_quote_draft`. Este ficheiro remove
-- essa função, apaga a linha de ledger, e mais nada.
--
-- O que ele NUNCA faz, e a razão tem de ser dita por extenso:
--
--     · não repõe linhas de orçamento antigas
--     · não desfaz totais recalculados
--     · não devolve datas, notas ou visitas ao valor anterior
--     · não apaga orçamentos
--
-- Uma edição que já aconteceu substituiu as linhas ANTIGAS pelas novas dentro
-- de uma transação. As antigas deixaram de existir no momento do commit — não
-- há cópia guardada em lado nenhum por esta migration, e inventar uma
-- reconstrução a partir de `data_history` seria adivinhar. Mais: o rascunho
-- editado pode já ter sido enviado, aceite e convertido em cliente pela 104.
-- «Voltar atrás» nesse documento não volta atrás em nada — parte a cadeia que
-- entretanto se agarrou a ele.
--
-- Se a 105 tiver de sair depois de haver edições, o caminho é operacional e
-- não é este ficheiro: parar o runtime que chama a RPC e corrigir para a
-- frente. Recuperação de dados é uma decisão humana, com autorização própria.
--
-- ---------------------------------------------------------------------------
-- Contrato
-- ---------------------------------------------------------------------------
--
--     ledger  efeito
--       0        0     → no-op idempotente
--       0        1     → ALIENADO: a função não é desta migration → RAISE
--       1        0     → LEDGER_WITHOUT_EFFECT → RAISE (decisão humana)
--       1        1     → checksum confere? → remove a RPC + DELETE do ledger
--                        checksum diverge?  → RAISE
--
-- 🔴 Com um só efeito não existe estado PARCIAL possível entre efeitos — mas
--    o princípio mantém-se escrito no contrato acima, porque as linhas
--    `ledger=1, efeito=0` e `ledger=0, efeito=1` são exactamente isso: um
--    estado que nenhum caminho legítimo produz. Normalizá-lo em silêncio
--    apagaria a prova de que algo correu mal — um runner morto a meio, um
--    DROP manual, uma aplicação interrompida. UNKNOWN_STATE = FAIL_CLOSED:
--    quem encontrar isto tem de decidir o que é verdade antes de mexer.
--
-- ---------------------------------------------------------------------------
-- 🔴 O CHECKSUM É VERIFICADO ANTES DE QUALQUER DROP
-- ---------------------------------------------------------------------------
--
-- A linha de ledger diz o nome e o conteúdo. Se o conteúdo não for o desta
-- 105, o que está aplicado é outra coisa com o mesmo nome — e este ficheiro
-- não sabe desfazer o que essa outra coisa fez. Remover a RPC nesse caso seria
-- desfazer às cegas.
--
-- O valor é o `checksumForNewMigration()` do runner: SHA-256 do conteúdo
-- normalizado a LF. Como a 105 é migration NOVA, o runner grava sempre a forma
-- normalizada — não há aqui a ambiguidade CRLF/LF que a história deste
-- repositório tem noutras linhas.
--
-- 🔴 A leitura é `FOR UPDATE`: entre ler o checksum e largar a função não pode
--    haver quem reescreva a linha.
--
-- ---------------------------------------------------------------------------

DO $rollback_105$
DECLARE
  -- 🔴 O checksum canónico desta 105, tal como o runner o grava.
  --    Se o SQL da 105 mudar, este valor TEM de mudar com ele — há um ensaio
  --    que os compara e fica vermelho se divergirem.
  CHECKSUM_105 CONSTANT text := 'bbb9c628fa07d76c8834b0908ddf7798a7a01180db93ce464256ca13b54153bf';
  ASSINATURA CONSTANT text :=
    'public.edit_crm_quote_draft(uuid, uuid, uuid, timestamptz, uuid, date, date, text, numeric, boolean, numeric, text, text, text, text, jsonb)';

  v_checksum  text;
  v_ledger    boolean;
  v_rpc       oid;
  v_rascunhos integer;
BEGIN
  IF to_regclass('public._migrations') IS NULL THEN
    RAISE EXCEPTION
      'CRM_EDIT_105_ROLLBACK_LEDGER_AUSENTE: public._migrations não existe — este rollback só corre pelo runner canónico';
  END IF;

  v_ledger := EXISTS (
    SELECT 1 FROM public._migrations WHERE name = '105_crm_orcamento_editar_rascunho.sql'
  );
  v_rpc := to_regprocedure(ASSINATURA);

  IF NOT v_ledger AND v_rpc IS NULL THEN
    RAISE NOTICE 'CRM_EDIT_105_ROLLBACK_NOOP: nem ledger nem efeito — nada a desfazer';
    RETURN;
  END IF;

  IF NOT v_ledger AND v_rpc IS NOT NULL THEN
    RAISE EXCEPTION
      'CRM_EDIT_105_ROLLBACK_ALIENADO: edit_crm_quote_draft existe sem linha de ledger — não é desta migration, nada foi removido';
  END IF;

  IF v_ledger AND v_rpc IS NULL THEN
    RAISE EXCEPTION
      'CRM_EDIT_105_ROLLBACK_LEDGER_WITHOUT_EFFECT: há linha de ledger e a RPC não existe — decida primeiro o que é verdade';
  END IF;

  -- 🔴 O checksum, antes de tocar em alguma coisa.
  SELECT m.checksum INTO v_checksum
    FROM public._migrations m
   WHERE m.name = '105_crm_orcamento_editar_rascunho.sql'
   FOR UPDATE;

  IF v_checksum IS DISTINCT FROM CHECKSUM_105 THEN
    RAISE EXCEPTION
      'CRM_EDIT_105_ROLLBACK_CHECKSUM_DIVERGENTE: o ledger tem % e esta 105 é % — o que está aplicado não é esta migration; nada foi removido',
      coalesce(v_checksum, 'NULL'), CHECKSUM_105;
  END IF;

  -- 🔴 Avisar, não bloquear.
  --
  --    Rascunhos existentes não impedem o rollback ESTRUTURAL: o que sai é uma
  --    capacidade, não são dados. Mas quem corre isto tem de ficar a saber que
  --    a partir daqui um rascunho volta a não se poder corrigir — anular e
  --    reemitir passa a ser outra vez o único caminho.
  SELECT count(*) INTO v_rascunhos
    FROM public.crm_quotes
   WHERE status = 'rascunho' AND superseded_by_id IS NULL;

  IF v_rascunhos > 0 THEN
    RAISE NOTICE
      'CRM_EDIT_105_ROLLBACK_COM_RASCUNHOS: % rascunho(s) vivo(s). Os documentos FICAM como estão; o que deixa de existir é a forma de os editar in place.',
      v_rascunhos;
  END IF;

  EXECUTE 'DROP FUNCTION IF EXISTS ' || ASSINATURA;

  DELETE FROM public._migrations WHERE name = '105_crm_orcamento_editar_rascunho.sql';

  RAISE NOTICE 'CRM_EDIT_105_ROLLBACK_OK: RPC removida e linha de ledger apagada. Nenhum orçamento foi tocado.';
END;
$rollback_105$;

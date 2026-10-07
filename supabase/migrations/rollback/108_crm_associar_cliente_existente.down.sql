-- Rollback da 108.
--
-- ---------------------------------------------------------------------------
-- 🔴 ESTE ROLLBACK É ESTRUTURAL. NÃO DESFAZ ASSOCIAÇÕES.
-- ---------------------------------------------------------------------------
--
-- A 108 cria UMA coisa: a RPC `link_crm_lead_to_existing_client`. Este
-- ficheiro remove essa função, apaga a linha de ledger, e mais nada.
--
-- Uma lead já associada a um cliente existente FICA associada: o estado que
-- a RPC gravou (lead em «ganho», orçamento endereçado ao cliente, local
-- eventualmente criado, linha de timeline) é o mesmo tipo de estado que a 104
-- grava, e as restrições da 101/104 continuam a valer para ele. Desfazê-lo
-- seria apagar um negócio fechado — decisão humana, com autorização própria.
--
-- Contrato (ledger, efeito):
--   0 0 → no-op · 0 1 → ALIENADO, RAISE · 1 0 → LEDGER_WITHOUT_EFFECT, RAISE
--   1 1 → checksum confere? remove a RPC + DELETE do ledger; diverge? RAISE

DO $rollback_108$
DECLARE
  -- 🔴 O checksum canónico da 108 (SHA-256 do conteúdo normalizado a LF).
  --    Há um ensaio que o recalcula a partir do ficheiro.
  CHECKSUM_108 CONSTANT text := 'c6a14b277bb8a16631e216f137e138f3f31fe9c0390633878514273480059979';
  ASSINATURA CONSTANT text :=
    'public.link_crm_lead_to_existing_client(uuid, uuid, uuid, uuid, uuid, uuid)';

  v_checksum text;
  v_ledger   boolean;
  v_rpc      regprocedure;
BEGIN
  IF to_regclass('public._migrations') IS NULL THEN
    RAISE EXCEPTION
      'CRM_LINK_108_ROLLBACK_LEDGER_AUSENTE: public._migrations não existe — este rollback só corre pelo runner canónico';
  END IF;

  v_ledger := EXISTS (
    SELECT 1 FROM public._migrations WHERE name = '108_crm_associar_cliente_existente.sql'
  );
  v_rpc := to_regprocedure(ASSINATURA);

  IF NOT v_ledger AND v_rpc IS NULL THEN
    RAISE NOTICE 'CRM_LINK_108_ROLLBACK_NOOP: nem ledger nem efeito — nada a desfazer';
    RETURN;
  END IF;

  IF NOT v_ledger AND v_rpc IS NOT NULL THEN
    RAISE EXCEPTION
      'CRM_LINK_108_ROLLBACK_ALIENADO: link_crm_lead_to_existing_client existe sem linha de ledger — não é desta migration, nada foi removido';
  END IF;

  IF v_ledger AND v_rpc IS NULL THEN
    RAISE EXCEPTION
      'CRM_LINK_108_ROLLBACK_LEDGER_WITHOUT_EFFECT: há linha de ledger e a RPC não existe — decida primeiro o que é verdade';
  END IF;

  SELECT m.checksum INTO v_checksum
    FROM public._migrations m
   WHERE m.name = '108_crm_associar_cliente_existente.sql'
   FOR UPDATE;

  IF v_checksum IS DISTINCT FROM CHECKSUM_108 THEN
    RAISE EXCEPTION
      'CRM_LINK_108_ROLLBACK_CHECKSUM_DIVERGENTE: o ledger tem % e esta 108 é % — nada foi removido',
      coalesce(v_checksum, 'NULL'), CHECKSUM_108;
  END IF;

  EXECUTE 'DROP FUNCTION IF EXISTS ' || ASSINATURA;

  DELETE FROM public._migrations WHERE name = '108_crm_associar_cliente_existente.sql';

  RAISE NOTICE 'CRM_LINK_108_ROLLBACK_OK: RPC removida e linha de ledger apagada. Nenhuma lead foi tocada.';
END;
$rollback_108$;

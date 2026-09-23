-- Rollback da 104.
--
-- ---------------------------------------------------------------------------
-- 🔴 ESTE ROLLBACK É ESTRUTURAL. NÃO DESFAZ CONVERSÕES.
-- ---------------------------------------------------------------------------
--
-- A 104 cria três coisas: uma RPC, uma chave candidata e uma FK composta.
-- Este ficheiro remove essas três, e mais nada.
--
-- O que ele NUNCA faz, e a razão tem de ser dita por extenso:
--
--     · não apaga clientes
--     · não apaga locais
--     · não reabre leads ganhas
--     · não devolve orçamentos ao destinatário anterior
--     · não apaga linhas de timeline
--
-- Uma conversão que já aconteceu produziu um CLIENTE REAL. Esse cliente pode
-- já ter contrato, serviços no calendário, facturas e movimentos de caixa
-- pendurados nele — e nada disso é visível a partir daqui. Apagá-lo «para
-- voltar atrás» não volta atrás: parte tudo o que entretanto se agarrou a ele,
-- e a lead deixaria de ter a resposta a «de onde veio este cliente?».
--
-- Se a 104 tiver de sair depois de haver conversões, o caminho é operacional,
-- não é este ficheiro: parar o runtime que chama a RPC e corrigir para a
-- frente. Recuperação de dados é uma decisão humana, com autorização própria.
--
-- ---------------------------------------------------------------------------
-- 🔴 A FK e a chave candidata saem porque são desta migration
-- ---------------------------------------------------------------------------
--
-- `crm_leads_conversao_par_coerente` e `locations_id_client_company_unique`
-- nasceram aqui, por isso saem aqui. Removê-las não perde dados: as linhas
-- convertidas continuam exactamente como estão, apenas deixam de ter a
-- garantia de que o par (cliente, local) é coerente.
--
-- 🔴 A ordem importa: a FK depende do índice único. Largar o índice primeiro
--    falharia com «não é possível remover ... outros objectos dependem dele».
--
-- ---------------------------------------------------------------------------
-- Contrato
-- ---------------------------------------------------------------------------
--
--     ledger  efeitos
--       0        0     → no-op idempotente
--       0        1     → ALIENADO: os objectos não são desta migration → RAISE
--       1        0     → LEDGER_WITHOUT_EFFECT → RAISE (decisão humana)
--       1        1     → remove os três efeitos + DELETE da linha de ledger
--
-- ---------------------------------------------------------------------------

DO $rollback_104$
DECLARE
  v_ledger    boolean;
  v_rpc       oid;
  v_indice    oid;
  v_fk        boolean;
  v_efeitos   integer;
  v_convertidas integer;
BEGIN
  IF to_regclass('public._migrations') IS NULL THEN
    RAISE EXCEPTION
      'CRM_CONV_104_ROLLBACK_LEDGER_AUSENTE: public._migrations não existe — este rollback só corre pelo runner canónico';
  END IF;

  v_ledger := EXISTS (SELECT 1 FROM public._migrations WHERE name = '104_crm_conversao_lead.sql');

  v_rpc := to_regprocedure('public.convert_crm_lead_atomic(uuid, uuid, uuid, uuid)');
  v_indice := to_regclass('public.locations_id_client_company_unique');
  v_fk := EXISTS (
    SELECT 1 FROM pg_constraint
     WHERE conrelid = 'public.crm_leads'::regclass
       AND conname = 'crm_leads_conversao_par_coerente'
  );

  v_efeitos := (CASE WHEN v_rpc IS NULL THEN 0 ELSE 1 END)
             + (CASE WHEN v_indice IS NULL THEN 0 ELSE 1 END)
             + (CASE WHEN v_fk THEN 1 ELSE 0 END);

  IF NOT v_ledger AND v_efeitos = 0 THEN
    RAISE NOTICE 'CRM_CONV_104_ROLLBACK_NOOP: nem ledger nem efeitos — nada a desfazer';
    RETURN;
  END IF;

  IF NOT v_ledger AND v_efeitos > 0 THEN
    RAISE EXCEPTION
      'CRM_CONV_104_ROLLBACK_ALIENADO: existem % efeito(s) da 104 sem linha de ledger — não são desta migration, nada foi removido',
      v_efeitos;
  END IF;

  IF v_ledger AND v_efeitos = 0 THEN
    RAISE EXCEPTION
      'CRM_CONV_104_ROLLBACK_LEDGER_WITHOUT_EFFECT: há linha de ledger e nenhum efeito — decida primeiro o que é verdade';
  END IF;

  -- 🔴 Avisar, não bloquear.
  --
  --    Conversões já feitas não impedem o rollback ESTRUTURAL: as três coisas
  --    que saem são garantias, não dados. Mas quem corre isto tem de ficar a
  --    saber que existem clientes nascidos deste caminho e que eles ficam —
  --    porque a leitura natural de «rollback» é «desfez-se tudo», e aqui não
  --    é isso que acontece.
  SELECT count(*) INTO v_convertidas
    FROM public.crm_leads
   WHERE converted_client_id IS NOT NULL;

  IF v_convertidas > 0 THEN
    RAISE NOTICE
      'CRM_CONV_104_ROLLBACK_COM_DADOS: % lead(s) já convertidas. Os clientes, locais, leads e orçamentos FICAM como estão — este rollback só remove a RPC e as restrições.',
      v_convertidas;
  END IF;

  -- 🔴 Lock antes de mexer na estrutura, e pela ordem em que as dependências
  --    correm: a FK está em `crm_leads` e aponta para `locations`.
  LOCK TABLE public.crm_leads IN ACCESS EXCLUSIVE MODE;
  LOCK TABLE public.locations IN ACCESS EXCLUSIVE MODE;

  ALTER TABLE public.crm_leads DROP CONSTRAINT IF EXISTS crm_leads_conversao_par_coerente;

  -- Só depois da FK que dependia dele.
  DROP INDEX IF EXISTS public.locations_id_client_company_unique;

  DROP FUNCTION IF EXISTS public.convert_crm_lead_atomic(uuid, uuid, uuid, uuid);

  DELETE FROM public._migrations WHERE name = '104_crm_conversao_lead.sql';

  RAISE NOTICE 'CRM_CONV_104_ROLLBACK_OK: RPC, FK e índice removidos; linha de ledger apagada. Nenhum dado de negócio foi tocado.';
END;
$rollback_104$;

-- ============================================================================
-- 104 — CRM: fechar a conversão de uma lead numa só transação
-- ============================================================================
--
-- O runner é o dono da transação: este ficheiro não abre BEGIN/COMMIT.
--
-- Esta migration é FUNDAÇÃO. Cria uma RPC; não muda nenhum ecrã e não cria
-- tabelas.
--
-- ---------------------------------------------------------------------------
-- O que a conversão é, e o que NÃO é
-- ---------------------------------------------------------------------------
--
-- Converter uma lead é dizer: «isto deixou de ser uma oportunidade e passou a
-- ser um cliente». Três coisas têm de ficar verdadeiras ao mesmo tempo:
--
--   1. a lead passa a `ganho`, com data;
--   2. aponta para o cliente e o local que a conversão criou;
--   3. o orçamento aceite aponta para a lead que ele fechou.
--
-- Fazer isto em três `UPDATE` separados, a partir da aplicação, permitiria que
-- o segundo falhasse e ficasse uma lead ganha sem cliente — um estado que o
-- CHECK `crm_leads_conversao_so_se_ganha` da 101 nem sequer deixa existir, e
-- que faria a operação falhar a meio, com parte do trabalho feito.
--
-- 🔴 O que esta RPC NÃO faz: criar o cliente e o local.
--
--    Isso continua a ser `createClienteComLocal`, a Server Action que já
--    existe e que já é usada pelo ecrã de Clientes. Reimplementá-la em SQL
--    daria duas formas de criar um cliente, que divergiriam com o tempo — e a
--    primeira regra do padrão de engenharia é não ter duas fontes da mesma
--    regra.
--
--    A RPC recebe os ids que essa action devolveu e fecha a operação.
--
-- ---------------------------------------------------------------------------
-- Idempotência: converter duas vezes
-- ---------------------------------------------------------------------------
--
-- O `WHERE ... AND converted_client_id IS NULL` é o que torna a repetição
-- segura. Um duplo-clique, um retry de rede ou um refresh a meio não podem
-- criar um segundo cliente para a mesma lead: a segunda tentativa não encontra
-- linha para actualizar e levanta `LEAD_ALREADY_CONVERTED`, que a aplicação
-- traduz numa frase e não num erro técnico.
--
-- ---------------------------------------------------------------------------
-- O que esta migration NÃO faz
-- ---------------------------------------------------------------------------
--
--   · não cria contratos nem serviços. A aceitação do orçamento abre o
--     formulário de contrato PRÉ-PREENCHIDO e o gestor confirma — nada entra
--     no calendário sem uma pessoa decidir. Foi decisão explícita do dono;
--   · não toca em `invoices` nem em `cash_flow_entries`;
--   · não invoca o protocolo de período financeiro: converter uma lead não é
--     um movimento financeiro.
-- ============================================================================

DO $precondicoes$
BEGIN
  IF to_regclass('public.crm_leads') IS NULL OR to_regclass('public.crm_quotes') IS NULL THEN
    RAISE EXCEPTION 'CRM_CONV_104_PRECONDITION_FAILED: crm_leads/crm_quotes ausentes (101/103)';
  END IF;

  IF to_regclass('public.locations_id_company_unique') IS NULL THEN
    RAISE EXCEPTION 'CRM_CONV_104_PRECONDITION_FAILED: índice locations_id_company_unique ausente (101)';
  END IF;

  -- As FKs compostas da 101 são o que impede ligar a lead ao cliente de outra
  -- empresa. Sem elas, esta RPC estaria a escrever sem rede.
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
     WHERE conname = 'crm_leads_cliente_mesma_empresa'
       AND conrelid = 'public.crm_leads'::regclass
  ) THEN
    RAISE EXCEPTION 'CRM_CONV_104_PRECONDITION_FAILED: FK composta do cliente ausente (101)';
  END IF;
END
$precondicoes$;

CREATE OR REPLACE FUNCTION public.link_crm_lead_conversion(
  p_company_id  uuid,
  p_lead_id     uuid,
  p_client_id   uuid,
  p_location_id uuid,
  p_quote_id    uuid,
  p_actor       uuid
)
RETURNS TABLE (lead_id uuid, client_id uuid)
LANGUAGE plpgsql
SECURITY INVOKER
AS $$
DECLARE
  v_nome_lead text;
  v_atualizadas integer;
BEGIN
  -- `FOR UPDATE` serializa dois pedidos de conversão da mesma lead: o segundo
  -- espera, e depois encontra `converted_client_id` já preenchido.
  SELECT l.name INTO v_nome_lead
    FROM public.crm_leads l
   WHERE l.id = p_lead_id AND l.company_id = p_company_id
   FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'LEAD_NOT_FOUND' USING ERRCODE = 'no_data_found';
  END IF;

  -- 🔴 A guarda da idempotência. Converter duas vezes criaria dois clientes
  --    iguais, e só se daria por isso na lista de Clientes, semanas depois.
  UPDATE public.crm_leads
     SET stage = 'ganho',
         won_at = COALESCE(won_at, now()),
         converted_client_id = p_client_id,
         converted_location_id = p_location_id,
         -- Ganhar limpa o desfecho de uma perda anterior: uma lead que esteve
         -- perdida e voltou não pode continuar a contar no relatório de
         -- motivos de perda.
         lost_at = NULL,
         lost_reason = NULL,
         lost_reason_notes = NULL
   WHERE id = p_lead_id
     AND company_id = p_company_id
     AND converted_client_id IS NULL;

  GET DIAGNOSTICS v_atualizadas = ROW_COUNT;

  IF v_atualizadas = 0 THEN
    RAISE EXCEPTION 'LEAD_ALREADY_CONVERTED' USING ERRCODE = 'unique_violation';
  END IF;

  -- O orçamento que fechou o negócio passa a apontar para o cliente. Opcional:
  -- há conversões sem orçamento nenhum (combinou-se por telefone).
  IF p_quote_id IS NOT NULL THEN
    UPDATE public.crm_quotes
       SET client_id = p_client_id,
           lead_id = NULL
     WHERE id = p_quote_id
       AND company_id = p_company_id;
  END IF;

  -- A timeline fica com o momento em que a lead deixou de o ser. É a última
  -- linha da história, e a que explica porque é que não há mais nenhuma.
  INSERT INTO public.crm_lead_interactions (company_id, lead_id, kind, summary, author_id)
  VALUES (
    p_company_id, p_lead_id, 'sistema',
    'Convertida em cliente. A ficha comercial fica aqui; o trabalho passa a ser gerido em Clientes.',
    p_actor
  );

  lead_id := p_lead_id;
  client_id := p_client_id;
  RETURN NEXT;
END;
$$;

COMMENT ON FUNCTION public.link_crm_lead_conversion(uuid, uuid, uuid, uuid, uuid, uuid) IS
  'Fecha a conversao de uma lead: marca ganho, liga cliente+local, aponta o '
  'orcamento ao cliente e escreve a timeline — tudo numa transacao. NAO cria o '
  'cliente nem o local: isso e createClienteComLocal, a action que ja existe, e '
  'reimplementa-la aqui daria duas formas de criar um cliente. Idempotente por '
  'converted_client_id IS NULL: a segunda tentativa levanta LEAD_ALREADY_CONVERTED '
  'em vez de criar um segundo cliente.';

REVOKE ALL ON FUNCTION public.link_crm_lead_conversion(uuid, uuid, uuid, uuid, uuid, uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.link_crm_lead_conversion(uuid, uuid, uuid, uuid, uuid, uuid) TO service_role;

DO $posestado$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
     WHERE n.nspname = 'public' AND p.proname = 'link_crm_lead_conversion'
       AND pg_get_function_identity_arguments(p.oid)
           = 'p_company_id uuid, p_lead_id uuid, p_client_id uuid, p_location_id uuid, p_quote_id uuid, p_actor uuid'
  ) THEN
    RAISE EXCEPTION 'CRM_CONV_104_POSTSTATE_FAILED: link_crm_lead_conversion ausente ou com outra assinatura';
  END IF;
END
$posestado$;

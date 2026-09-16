-- ============================================================================
-- 104 — CRM: converter uma lead em cliente, numa transação só
-- ============================================================================
--
-- O runner é o dono da transação: este ficheiro não abre BEGIN/COMMIT.
--
-- Esta migration é FUNDAÇÃO. Cria uma RPC; não muda nenhum ecrã e não cria
-- tabelas.
--
-- ---------------------------------------------------------------------------
-- 🔴 O que esta versão corrige em relação à primeira
-- ---------------------------------------------------------------------------
--
-- A primeira versão recebia `p_client_id` e `p_location_id` JÁ CRIADOS: a
-- Server Action chamava `createClienteComLocal`, essas duas linhas eram
-- COMMITADAS, e só depois se chamava a RPC para fechar a lead.
--
-- Isso não é uma conversão atómica. É duas operações com uma janela no meio:
--
--   · se a RPC falhasse, ficava um cliente e um local na base e a lead por
--     converter — trabalho a mais, sem nada que o explicasse;
--
--   · em concorrência era pior. Dois pedidos simultâneos criavam DOIS clientes
--     e DOIS locais antes de qualquer um chegar à RPC. A RPC rejeitava o
--     segundo — mas o cliente e o local que ele já tinha criado ficavam lá.
--
-- A RPC antiga era idempotente. O FLUXO não era, e a diferença entre as duas
-- coisas é exactamente onde nascem os registos duplicados que só se descobrem
-- semanas depois.
--
-- Nesta versão a RPC recebe os DADOS e cria tudo dentro da mesma transação:
-- lê a lead com FOR UPDATE, e só depois de saber que é ela quem vai converter
-- é que cria o cliente e o local. Um segundo pedido espera no lock, encontra a
-- lead já convertida, e devolve os ids existentes SEM ter criado nada.
--
-- ---------------------------------------------------------------------------
-- 🔴 Porque é que a criação do cliente vive aqui, e não em createClienteComLocal
-- ---------------------------------------------------------------------------
--
-- Reutilizar a Server Action obrigava a commitar antes — era essa a causa do
-- problema. Não há forma de ter as duas coisas.
--
-- A duplicação é assumida e é PEQUENA: `clients` e `locations` não têm regra
-- de negócio nenhuma na criação além de `trim` e defaults de coluna. O que
-- `createClienteComLocal` tem a mais — autenticação, autorização, revalidação
-- de cache — é responsabilidade da camada de aplicação, não da linha.
--
-- `src/__tests__/crm-conversion.pg.test.ts` compara o que as duas formas
-- produzem, campo a campo, para que não divirjam em silêncio.
--
-- ---------------------------------------------------------------------------
-- Regra de reutilização de cliente — explícita, e sem heurística
-- ---------------------------------------------------------------------------
--
-- 🔴 A conversão NUNCA procura um cliente parecido por nome, email ou NIF.
--    Juntar duas entidades porque «parecem a mesma» é o tipo de automatismo
--    que só se descobre quando já misturou a facturação de dois clientes.
--
-- A única reutilização é a idempotência: se a lead JÁ tem
-- `converted_client_id`, devolve-se esse — e não se cria nada. Fora disso,
-- converter cria sempre um cliente novo. Se for de facto um cliente que já
-- existe, quem converte é que sabe, e trata disso em Clientes.
--
-- ---------------------------------------------------------------------------
-- O que esta migration NÃO faz
-- ---------------------------------------------------------------------------
--
--   · não cria contratos, serviços nem eventos de calendário. A RPC devolve os
--     ids para o runtime abrir o formulário de contrato pré-preenchido, e
--     nada mais. Decisão explícita do proprietário;
--   · não toca em `invoices` nem em `cash_flow_entries`;
--   · não invoca o protocolo de período financeiro: converter uma lead não é
--     um movimento financeiro.
-- ============================================================================

DO $precondicoes$
BEGIN
  IF to_regclass('public.crm_leads') IS NULL OR to_regclass('public.crm_quotes') IS NULL THEN
    RAISE EXCEPTION 'CRM_CONV_104_PRECONDITION_FAILED: crm_leads/crm_quotes ausentes (101/103)';
  END IF;

  IF to_regclass('public.locations_id_company_unique') IS NULL
     OR to_regclass('public.clients_id_company_unique') IS NULL THEN
    RAISE EXCEPTION 'CRM_CONV_104_PRECONDITION_FAILED: chaves candidatas (id, company_id) ausentes';
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

  -- As colunas de `clients`/`locations` que esta RPC escreve têm de existir
  -- com o nome esperado — senão o INSERT falharia só em runtime.
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
     WHERE table_schema='public' AND table_name='locations' AND column_name='hourly_rate'
  ) THEN
    RAISE EXCEPTION 'CRM_CONV_104_PRECONDITION_FAILED: locations.hourly_rate ausente';
  END IF;
END
$precondicoes$;

-- A assinatura mudou por completo em relação à primeira versão. Deixar a
-- antiga viva permitiria à aplicação continuar a chamar o caminho não-atómico
-- sem ninguém dar por isso.
DROP FUNCTION IF EXISTS public.link_crm_lead_conversion(uuid, uuid, uuid, uuid, uuid, uuid);

CREATE OR REPLACE FUNCTION public.convert_crm_lead_atomic(
  p_company_id    uuid,
  p_lead_id       uuid,
  p_actor         uuid,
  p_quote_id      uuid,
  -- Dados do local. O nome e a morada vêm resolvidos pela camada de aplicação
  -- (a morada da visita ganha à da lead); a RPC não decide isso, só grava.
  p_location_name text,
  p_address       text,
  p_service_type  text,
  p_hourly_rate   numeric,
  p_lat           numeric,
  p_lng           numeric
)
RETURNS TABLE (
  lead_id     uuid,
  client_id   uuid,
  location_id uuid,
  ja_convertida boolean
)
LANGUAGE plpgsql
SECURITY INVOKER
AS $converter$
DECLARE
  v_lead    public.crm_leads%ROWTYPE;
  v_quote   public.crm_quotes%ROWTYPE;
  v_client  uuid;
  v_local   uuid;
BEGIN
  -- ── 1. A lead, bloqueada ──────────────────────────────────────────────────
  --
  -- 🔴 O FOR UPDATE é o que serializa dois pedidos simultâneos. O segundo fica
  --    aqui à espera; quando entra, a lead já está convertida e ele sai no
  --    passo 2 — sem ter criado cliente nem local.
  SELECT * INTO v_lead
    FROM public.crm_leads
   WHERE id = p_lead_id AND company_id = p_company_id
   FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'LEAD_NOT_FOUND' USING ERRCODE = 'no_data_found';
  END IF;

  -- ── 2. Já convertida? Devolve o que existe, ANTES de criar seja o que for ─
  IF v_lead.converted_client_id IS NOT NULL THEN
    lead_id := p_lead_id;
    client_id := v_lead.converted_client_id;
    location_id := v_lead.converted_location_id;
    ja_convertida := true;
    RETURN NEXT;
    RETURN;
  END IF;

  -- ── 3. O orçamento, se vier ───────────────────────────────────────────────
  IF p_quote_id IS NOT NULL THEN
    SELECT * INTO v_quote
      FROM public.crm_quotes
     WHERE id = p_quote_id AND company_id = p_company_id
     FOR UPDATE;

    IF NOT FOUND THEN
      RAISE EXCEPTION 'QUOTE_NOT_FOUND' USING ERRCODE = 'no_data_found';
    END IF;

    -- 🔴 O orçamento tem de ser DESTA lead.
    --
    --    Sem esta verificação, dentro da mesma empresa era possível converter
    --    a lead A usando o orçamento aceite da lead B: o preço, as condições e
    --    o histórico de um negócio ficariam colados ao cliente errado. A FK
    --    composta garante a empresa; a empresa não garante a lead.
    IF v_quote.lead_id IS DISTINCT FROM p_lead_id THEN
      RAISE EXCEPTION 'QUOTE_LEAD_MISMATCH: o orçamento não pertence a esta lead'
        USING ERRCODE = 'check_violation';
    END IF;

    -- 🔴 E tem de ser a revisão VIVA.
    --
    --    Validar `status = 'aceite'` não chega: uma revisão antiga fica com o
    --    estado que tinha quando foi substituída, e uma R0 aceite antes de a R1
    --    existir continua a dizer 'aceite' para sempre. Sem esta guarda, a
    --    conversão podia nascer de um preço e de condições que a revisão
    --    seguinte já tinha substituído — e o cliente ficaria criado a partir de
    --    um documento que ninguém considera em vigor.
    IF v_quote.superseded_by_id IS NOT NULL THEN
      RAISE EXCEPTION 'QUOTE_ALREADY_SUPERSEDED: substituido por %', v_quote.superseded_by_id
        USING ERRCODE = 'check_violation';
    END IF;

    -- Converter a partir de um rascunho criaria um cliente com base num preço
    -- que ninguém aprovou.
    IF v_quote.status <> 'aceite' THEN
      RAISE EXCEPTION 'QUOTE_NOT_ACCEPTED: estado %', v_quote.status
        USING ERRCODE = 'check_violation';
    END IF;
  END IF;

  -- ── 4. Validações do local ────────────────────────────────────────────────
  --
  -- `locations.address` é NOT NULL, e um local sem morada não se encontra no
  -- mapa, não dá para navegar até lá e não valida o GPS do clock-in.
  IF p_address IS NULL OR btrim(p_address) = '' THEN
    RAISE EXCEPTION 'CONVERSION_ADDRESS_REQUIRED' USING ERRCODE = 'check_violation';
  END IF;

  -- ── 5. O cliente ──────────────────────────────────────────────────────────
  --
  -- Criado AQUI, dentro da transação. Se qualquer passo a seguir falhar, esta
  -- linha desaparece com ele — que é a diferença em relação à primeira versão.
  INSERT INTO public.clients (company_id, name, type, phone, email, nif, status)
  VALUES (
    p_company_id,
    btrim(v_lead.name),
    v_lead.lead_type,
    NULLIF(btrim(COALESCE(v_lead.phone, '')), ''),
    NULLIF(btrim(COALESCE(v_lead.email, '')), ''),
    NULLIF(btrim(COALESCE(v_lead.nif,   '')), ''),
    'ativo'
  )
  RETURNING id INTO v_client;

  -- ── 6. O local ────────────────────────────────────────────────────────────
  INSERT INTO public.locations (
    company_id, client_id, name, address, service_type, hourly_rate, lat, lng, active
  )
  VALUES (
    p_company_id,
    v_client,
    COALESCE(NULLIF(btrim(COALESCE(p_location_name, '')), ''), btrim(v_lead.name)),
    btrim(p_address),
    COALESCE(NULLIF(btrim(COALESCE(p_service_type, '')), ''), 'limpeza_regular'),
    p_hourly_rate,
    p_lat,
    p_lng,
    true
  )
  RETURNING id INTO v_local;

  -- ── 7. Fechar a lead ──────────────────────────────────────────────────────
  UPDATE public.crm_leads
     SET stage = 'ganho',
         won_at = COALESCE(won_at, now()),
         converted_client_id = v_client,
         converted_location_id = v_local,
         -- Ganhar limpa o desfecho de uma perda anterior: uma lead que esteve
         -- perdida e voltou não pode continuar a contar no relatório de
         -- motivos de perda.
         lost_at = NULL,
         lost_reason = NULL,
         lost_reason_notes = NULL
   WHERE id = p_lead_id
     AND company_id = p_company_id;

  -- ── 8. O orçamento passa a ser do cliente ─────────────────────────────────
  IF p_quote_id IS NOT NULL THEN
    UPDATE public.crm_quotes
       SET client_id = v_client,
           lead_id = NULL
     WHERE id = p_quote_id
       AND company_id = p_company_id;
  END IF;

  -- ── 9. A última linha da história ─────────────────────────────────────────
  INSERT INTO public.crm_lead_interactions (company_id, lead_id, kind, summary, author_id)
  VALUES (
    p_company_id, p_lead_id, 'sistema',
    'Convertida em cliente. A ficha comercial fica aqui; o trabalho passa a ser gerido em Clientes.',
    p_actor
  );

  lead_id := p_lead_id;
  client_id := v_client;
  location_id := v_local;
  ja_convertida := false;
  RETURN NEXT;
END;
$converter$;

COMMENT ON FUNCTION public.convert_crm_lead_atomic(uuid, uuid, uuid, uuid, text, text, text, numeric, numeric, numeric) IS
  'Converte uma lead em cliente + local NUMA SO TRANSACAO: bloqueia a lead, '
  'valida o orcamento (mesma lead e aceite), cria clients e locations, fecha a '
  'lead, aponta o orcamento ao cliente e escreve a timeline. Em qualquer erro, '
  'ROLLBACK de tudo — nao fica cliente orfao. Idempotente: se a lead ja estiver '
  'convertida devolve os ids existentes ANTES de criar seja o que for, e marca '
  'ja_convertida = true. NUNCA deduplica clientes por heuristica de nome/email/'
  'NIF. NAO cria contrato, servico nem evento de calendario — devolve os ids '
  'para o runtime abrir o formulario pre-preenchido, e nada mais.';

REVOKE ALL ON FUNCTION public.convert_crm_lead_atomic(uuid, uuid, uuid, uuid, text, text, text, numeric, numeric, numeric) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.convert_crm_lead_atomic(uuid, uuid, uuid, uuid, text, text, text, numeric, numeric, numeric) TO service_role;

DO $posestado$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
     WHERE n.nspname = 'public' AND p.proname = 'convert_crm_lead_atomic'
       AND pg_get_function_identity_arguments(p.oid)
           = 'p_company_id uuid, p_lead_id uuid, p_actor uuid, p_quote_id uuid, p_location_name text, p_address text, p_service_type text, p_hourly_rate numeric, p_lat numeric, p_lng numeric'
  ) THEN
    RAISE EXCEPTION 'CRM_CONV_104_POSTSTATE_FAILED: convert_crm_lead_atomic ausente ou com outra assinatura';
  END IF;

  -- 🔴 A assinatura antiga não pode sobreviver: seria o caminho não-atómico
  --    ainda disponível para quem se esquecesse de o trocar.
  IF EXISTS (
    SELECT 1 FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
     WHERE n.nspname = 'public' AND p.proname = 'link_crm_lead_conversion'
  ) THEN
    RAISE EXCEPTION 'CRM_CONV_104_POSTSTATE_FAILED: link_crm_lead_conversion ainda existe';
  END IF;
END
$posestado$;

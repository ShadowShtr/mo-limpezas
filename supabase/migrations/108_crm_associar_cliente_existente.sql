-- ============================================================================
-- 108 — Ganhar uma lead que já é cliente: associar em vez de criar
-- ============================================================================
--
-- O problema
-- ---------------------------------------------------------------------------
--
-- A 104 fecha uma lead em «ganho» de uma só forma: cria um cliente NOVO e um
-- local novo. Para quem já era cliente antes de entrar no funil — e houve
-- leads assim, criadas antes de o formulário pesquisar os clientes — isso
-- obrigava a escolher entre duas coisas erradas: deixar a lead presa fora de
-- «ganho», ou converter e ficar com o mesmo cliente duas vezes.
--
-- O que esta migration acrescenta
-- ---------------------------------------------------------------------------
--
-- UMA função: `link_crm_lead_to_existing_client`. Faz o mesmo fecho que a
-- 104 — lead em «ganho», orçamento endereçado ao cliente, linha de timeline —
-- mas o cliente é um que JÁ EXISTE, escolhido por uma pessoa.
--
--   · o local: ou um local que esse cliente já tem (`p_location_id`), ou um
--     novo, criado com as MESMAS regras de morada da 104 (visita primeiro,
--     lead como unidade coerente, nunca inventada);
--   · o cliente NÃO é alterado. Nem nome, nem NIF, nem email, nem telefone.
--     Os dados da lead podem estar desactualizados ou serem de outra pessoa
--     de contacto; sobrescrever a ficha de um cliente activo com eles seria
--     uma escrita que ninguém pediu;
--   · nenhum contrato, serviço, factura ou movimento de caixa — como a 104.
--
-- 🔴 Sem `SELECT ... INTO` em lado nenhum (lição da 107): o SQL Editor do
--    Supabase lê-o como «criar a tabela» e injecta um `ALTER TABLE ... ENABLE
--    ROW LEVEL SECURITY` a meio do corpo. As atribuições são todas
--    `x := (SELECT ...)`; só `RETURNING ... INTO` fica, que o editor aceita.
--
-- 🔴 Isto NÃO é deduplicação. A 104 recusa «parecidos» por nome/NIF/email, e
--    essa regra mantém-se: aqui não há heurística nenhuma. O cliente chega
--    por id, escolhido explicitamente por quem fecha o negócio.
--
-- 🔴 A 104 fica intacta. `convert_crm_lead_atomic` continua a ser o caminho
--    para um cliente novo, com a sua action e os seus ensaios. Esta é uma
--    segunda porta, ao lado, com a mesma ACL.
-- ============================================================================

-- ---------------------------------------------------------------------------
-- 0. Precondições — objectos
-- ---------------------------------------------------------------------------

DO $precondicoes$
DECLARE
  v_faltam text[];
BEGIN
  v_faltam := (
    SELECT array_agg(esperado.nome ORDER BY esperado.nome)
      FROM (VALUES
        ('crm_leads'), ('crm_lead_interactions'), ('crm_visits'),
        ('crm_quotes'), ('clients'), ('locations'), ('profiles')
      ) AS esperado(nome)
     WHERE to_regclass('public.' || esperado.nome) IS NULL
  );

  IF v_faltam IS NOT NULL THEN
    RAISE EXCEPTION 'CRM_LINK_108_PRECONDITION_FAILED: tabelas em falta %', v_faltam;
  END IF;

  IF to_regprocedure('public.convert_crm_lead_atomic(uuid, uuid, uuid, uuid)') IS NULL THEN
    RAISE EXCEPTION
      'CRM_LINK_108_PRECONDITION_FAILED: convert_crm_lead_atomic ausente — a 104 não está aplicada';
  END IF;

  -- As restrições que o fecho tem de satisfazer numa só instrução. A última
  -- é a da 104: prende (local, cliente, empresa) a um local DESSE cliente.
  v_faltam := (
    SELECT array_agg(esperada.nome ORDER BY esperada.nome)
      FROM (VALUES
        ('crm_leads_ganha_exige_data'),
        ('crm_leads_conversao_coerente'),
        ('crm_leads_conversao_so_se_ganha'),
        ('crm_leads_ganho_exige_conversao'),
        ('crm_leads_cliente_mesma_empresa'),
        ('crm_leads_local_mesma_empresa'),
        ('crm_leads_conversao_par_coerente')
      ) AS esperada(nome)
     WHERE NOT EXISTS (
       SELECT 1 FROM pg_constraint
        WHERE conrelid = 'public.crm_leads'::regclass AND conname = esperada.nome
     )
  );

  IF v_faltam IS NOT NULL THEN
    RAISE EXCEPTION 'CRM_LINK_108_PRECONDITION_FAILED: restrições em falta %', v_faltam;
  END IF;
END;
$precondicoes$;

-- ---------------------------------------------------------------------------
-- 0a. Proveniência das dependências — o ledger, não só os objectos
-- ---------------------------------------------------------------------------
--
-- Mesmo raciocínio e mesmos checksums da 105: com `--only`, o runner corre
-- este ficheiro sem olhar para trás, e uma fundação aplicada pelo SQL Editor
-- não deixa linha de ledger. Os valores são os de produção, LF-normalizados.

DO $dependencias$
DECLARE
  v_nomes CONSTANT text[] := ARRAY[
    '101_crm_leads.sql',
    '101a_crm_rpc_acl_hardening.sql',
    '101b_identity_reconciliation.sql',
    '102_crm_visitas_comerciais.sql',
    '103_crm_orcamentos.sql',
    '103a_crm_rpc_acl_hardening.sql',
    '104_crm_conversao_lead.sql'
  ];
  v_checksums CONSTANT text[] := ARRAY[
    '92fb13678187609c7951faaae6dcf3a3688f04694efb4b34c6f04e23aee46942',
    '51aca907d2e9310f36d01901f5bb4911f8a951a536bcb9886071b0ef1d0528fb',
    '33614ef362300bca1a4a9bff8928172b45f2418b9409bb8eaaaa2e1805f4e136',
    '236cfdb6fc18ec8ac52496abb2226e2fe998a5ea4f0187597b9f249d301f4c8e',
    '6893946882e2df1af16c79158f3bcbe0324b7cae92845e39d8cb389f8e0260d0',
    'bcd107aa0ab837968856150d7ebfa02704cb97f9b4ace10d35ea7dde714ac738',
    '963b13b4a2b32422845bd7b22256def3e0edbba88e62e125b5b399881b1a2d9f'
  ];
  v_faltam  text[];
  v_erradas text[];
BEGIN
  IF to_regclass('public._migrations') IS NULL THEN
    RAISE EXCEPTION
      'CRM_LINK_108_LEDGER_AUSENTE: public._migrations não existe — a 108 só corre pelo runner canónico';
  END IF;

  v_faltam := (
    SELECT array_agg(e.nome ORDER BY e.nome)
      FROM unnest(v_nomes, v_checksums) AS e(nome, checksum)
      LEFT JOIN public._migrations m ON m.name = e.nome
     WHERE m.name IS NULL
  );

  v_erradas := (
    SELECT array_agg(e.nome || ' (ledger ' || coalesce(m.checksum, 'NULL') || ')' ORDER BY e.nome)
      FROM unnest(v_nomes, v_checksums) AS e(nome, checksum)
      JOIN public._migrations m ON m.name = e.nome
     WHERE m.checksum IS DISTINCT FROM e.checksum
  );

  IF v_faltam IS NOT NULL THEN
    RAISE EXCEPTION
      'CRM_LINK_108_DEPENDENCY_LEDGER_MISSING: fundações sem linha de ledger % — nada foi criado',
      array_to_string(v_faltam, ', ');
  END IF;

  IF v_erradas IS NOT NULL THEN
    RAISE EXCEPTION
      'CRM_LINK_108_DEPENDENCY_CHECKSUM_DIVERGED: o ledger diz aplicada mas o conteúdo não é o esperado % — nada foi criado',
      array_to_string(v_erradas, ', ');
  END IF;
END;
$dependencias$;

-- ---------------------------------------------------------------------------
-- 0b. Proveniência da própria 108 — um efeito, quatro combinações
-- ---------------------------------------------------------------------------

DO $proveniencia$
DECLARE
  v_ledger boolean;
  v_rpc    regprocedure;
BEGIN
  v_ledger := EXISTS (
    SELECT 1 FROM public._migrations WHERE name = '108_crm_associar_cliente_existente.sql'
  );
  v_rpc := to_regprocedure(
    'public.link_crm_lead_to_existing_client(uuid, uuid, uuid, uuid, uuid, uuid)'
  );

  IF v_ledger AND v_rpc IS NULL THEN
    RAISE EXCEPTION
      'CRM_LINK_108_LEDGER_WITHOUT_EFFECT: há linha de ledger da 108 mas a RPC não existe — decida primeiro o que é verdade';
  ELSIF v_ledger THEN
    RAISE EXCEPTION
      'CRM_LINK_108_JA_APLICADA: linha de ledger e efeito presentes — reaplicar reescreveria a RPC e a sua ACL';
  ELSIF v_rpc IS NOT NULL THEN
    RAISE EXCEPTION
      'CRM_LINK_108_EFFECT_WITHOUT_LEDGER: link_crm_lead_to_existing_client já existe sem linha de ledger — estado desconhecido, nada foi alterado';
  END IF;
END;
$proveniencia$;

-- ---------------------------------------------------------------------------
-- 1. A RPC
-- ---------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION public.link_crm_lead_to_existing_client(
  p_company_id  uuid,
  p_lead_id     uuid,
  p_actor       uuid,
  p_quote_id    uuid,
  p_client_id   uuid,
  -- NULL cria um local novo com a morada da visita/lead; um id reaproveita
  -- um local que o cliente já tem.
  p_location_id uuid
)
RETURNS TABLE (client_id uuid, location_id uuid, ja_convertida boolean)
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = pg_catalog, public
AS $$
DECLARE
  v_lead       public.crm_leads%ROWTYPE;
  v_quote      public.crm_quotes%ROWTYPE;
  v_visita     public.crm_visits%ROWTYPE;
  v_cliente    public.clients%ROWTYPE;
  v_local      public.locations%ROWTYPE;
  v_location   uuid;
  v_address    text;
  v_lat        numeric(10,7);
  v_lng        numeric(10,7);
  v_loc_client uuid;
BEGIN
  IF p_quote_id IS NULL THEN
    RAISE EXCEPTION 'CONVERSION_QUOTE_REQUIRED' USING ERRCODE = 'check_violation';
  END IF;

  IF p_client_id IS NULL THEN
    RAISE EXCEPTION 'LINK_CLIENT_REQUIRED' USING ERRCODE = 'check_violation';
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM public.profiles
     WHERE id = p_actor AND company_id = p_company_id
  ) THEN
    RAISE EXCEPTION 'ACTOR_NOT_IN_COMPANY' USING ERRCODE = 'check_violation';
  END IF;

  -- 🔴 A MESMA ordem de locks da 104: lead → orçamento. Uma conversão da 104
  --    e uma associação desta 108 sobre a mesma lead serializam-se na lead,
  --    e a segunda a entrar já a vê convertida.
  v_lead := (
    SELECT l FROM public.crm_leads l
     WHERE l.id = p_lead_id AND l.company_id = p_company_id
     FOR UPDATE
  );

  IF v_lead.id IS NULL THEN
    RAISE EXCEPTION 'LEAD_NOT_FOUND' USING ERRCODE = 'no_data_found';
  END IF;

  -- ── Já convertida? ───────────────────────────────────────────────────────
  --
  -- Idempotente para a MESMA pergunta: mesmo cliente (e, se foi dado, mesmo
  -- local). Convertida para outro cliente — pela 104 ou por esta — é uma
  -- decisão já tomada, e não se desfaz por cima.
  IF v_lead.converted_client_id IS NOT NULL THEN
    IF v_lead.converted_client_id IS DISTINCT FROM p_client_id
       OR (p_location_id IS NOT NULL
           AND v_lead.converted_location_id IS DISTINCT FROM p_location_id) THEN
      RAISE EXCEPTION
        'LEAD_ALREADY_CONVERTED: a lead já está ligada a outro cliente ou local'
        USING ERRCODE = 'check_violation';
    END IF;

    v_loc_client := (
      SELECT loc.client_id
        FROM public.locations loc
       WHERE loc.id = v_lead.converted_location_id
         AND loc.company_id = p_company_id
    );

    IF v_loc_client IS NULL
       OR v_loc_client IS DISTINCT FROM v_lead.converted_client_id THEN
      RAISE EXCEPTION
        'CONVERSION_STATE_DIVERGED: o local convertido não pertence ao cliente convertido'
        USING ERRCODE = 'check_violation';
    END IF;

    v_quote := (
      SELECT q FROM public.crm_quotes q
       WHERE q.id = p_quote_id AND q.company_id = p_company_id
       FOR UPDATE
    );

    IF v_quote.id IS NULL THEN
      RAISE EXCEPTION 'QUOTE_NOT_FOUND' USING ERRCODE = 'no_data_found';
    END IF;

    IF v_quote.source_lead_id IS DISTINCT FROM p_lead_id THEN
      RAISE EXCEPTION 'QUOTE_LEAD_MISMATCH: o orçamento não nasceu desta lead'
        USING ERRCODE = 'check_violation';
    END IF;

    IF v_quote.client_id IS DISTINCT FROM v_lead.converted_client_id
       OR v_quote.lead_id IS NOT NULL THEN
      RAISE EXCEPTION
        'CONVERSION_STATE_DIVERGED: o orçamento não está endereçado ao cliente convertido'
        USING ERRCODE = 'check_violation';
    END IF;

    IF v_quote.status <> 'aceite' THEN
      RAISE EXCEPTION
        'CONVERSION_STATE_DIVERGED: o orçamento convertido já não está aceite (estado %)',
        v_quote.status USING ERRCODE = 'check_violation';
    END IF;

    IF v_quote.superseded_by_id IS NOT NULL THEN
      RAISE EXCEPTION
        'CONVERSION_STATE_DIVERGED: o orçamento convertido foi substituído por %',
        v_quote.superseded_by_id USING ERRCODE = 'check_violation';
    END IF;

    client_id := v_lead.converted_client_id;
    location_id := v_lead.converted_location_id;
    ja_convertida := true;
    RETURN NEXT;
    RETURN;
  END IF;

  -- ── O orçamento — as mesmas regras da 104 ────────────────────────────────
  v_quote := (
    SELECT q FROM public.crm_quotes q
     WHERE q.id = p_quote_id AND q.company_id = p_company_id
     FOR UPDATE
  );

  IF v_quote.id IS NULL THEN
    RAISE EXCEPTION 'QUOTE_NOT_FOUND' USING ERRCODE = 'no_data_found';
  END IF;

  IF v_quote.source_lead_id IS DISTINCT FROM p_lead_id THEN
    RAISE EXCEPTION 'QUOTE_LEAD_MISMATCH: o orçamento não nasceu desta lead'
      USING ERRCODE = 'check_violation';
  END IF;

  IF v_quote.lead_id IS DISTINCT FROM p_lead_id OR v_quote.client_id IS NOT NULL THEN
    RAISE EXCEPTION 'QUOTE_RECIPIENT_MISMATCH: o orçamento já não está endereçado a esta lead'
      USING ERRCODE = 'check_violation';
  END IF;

  IF v_quote.superseded_by_id IS NOT NULL THEN
    RAISE EXCEPTION 'QUOTE_ALREADY_SUPERSEDED: substituído por %', v_quote.superseded_by_id
      USING ERRCODE = 'check_violation';
  END IF;

  IF v_quote.status <> 'aceite' THEN
    RAISE EXCEPTION 'QUOTE_NOT_ACCEPTED: estado %', v_quote.status
      USING ERRCODE = 'check_violation';
  END IF;

  -- ── O cliente escolhido ──────────────────────────────────────────────────
  --
  -- 🔴 `FOR KEY SHARE`: impede que o cliente seja apagado entre esta leitura
  --    e o commit, sem bloquear quem edita a ficha dele. O cliente NÃO é
  --    escrito — só referenciado.
  v_cliente := (
    SELECT c FROM public.clients c
     WHERE c.id = p_client_id AND c.company_id = p_company_id
     FOR KEY SHARE
  );

  IF v_cliente.id IS NULL THEN
    -- De outra empresa é o mesmo que não existir: não se confirma nada.
    RAISE EXCEPTION 'LINK_CLIENT_NOT_FOUND' USING ERRCODE = 'no_data_found';
  END IF;

  -- ── O local ──────────────────────────────────────────────────────────────
  IF p_location_id IS NOT NULL THEN
    v_local := (
      SELECT loc FROM public.locations loc
       WHERE loc.id = p_location_id AND loc.company_id = p_company_id
       FOR KEY SHARE
    );

    IF v_local.id IS NULL THEN
      RAISE EXCEPTION 'LINK_LOCATION_NOT_FOUND' USING ERRCODE = 'no_data_found';
    END IF;

    -- 🔴 Um local de OUTRO cliente nunca. A FK composta da 104 recusaria na
    --    mesma, mas com um erro cru; aqui diz-se o que está errado.
    IF v_local.client_id IS DISTINCT FROM p_client_id THEN
      RAISE EXCEPTION 'LINK_LOCATION_CLIENT_MISMATCH: o local não pertence a este cliente'
        USING ERRCODE = 'check_violation';
    END IF;

    IF NOT v_local.active THEN
      RAISE EXCEPTION 'LINK_LOCATION_INACTIVE: o local está desactivado'
        USING ERRCODE = 'check_violation';
    END IF;

    v_location := v_local.id;
  ELSE
    -- Morada exactamente como a 104: visita primeiro, como unidade coerente
    -- (morada + coordenadas), lead na falta dela, e nunca inventada.
    v_address := NULL;

    IF v_quote.visit_id IS NOT NULL THEN
      v_visita := (
        SELECT v FROM public.crm_visits v
         WHERE v.id = v_quote.visit_id
           AND v.company_id = p_company_id
      );

      IF v_visita.id IS NULL THEN
        RAISE EXCEPTION
          'CONVERSION_VISIT_MISMATCH: o orçamento aponta para a visita %, que não existe nesta empresa',
          v_quote.visit_id USING ERRCODE = 'check_violation';
      END IF;

      IF v_visita.lead_id IS DISTINCT FROM p_lead_id THEN
        RAISE EXCEPTION
          'CONVERSION_VISIT_MISMATCH: a visita % pertence à lead % e o orçamento é da lead %',
          v_quote.visit_id, coalesce(v_visita.lead_id::text, 'NULL'), p_lead_id
          USING ERRCODE = 'check_violation';
      END IF;

      IF length(btrim(coalesce(v_visita.address, ''))) > 0 THEN
        v_address := btrim(v_visita.address);
        v_lat := v_visita.lat;
        v_lng := v_visita.lng;
      END IF;
    END IF;

    IF v_address IS NULL AND length(btrim(coalesce(v_lead.address, ''))) > 0 THEN
      v_address := btrim(v_lead.address);
      v_lat := v_lead.lat;
      v_lng := v_lead.lng;
    END IF;

    IF v_address IS NULL THEN
      RAISE EXCEPTION 'CONVERSION_ADDRESS_REQUIRED' USING ERRCODE = 'check_violation';
    END IF;

    -- `hourly_rate` a NULL, como na 104: o preço operacional é do contrato.
    INSERT INTO public.locations (
      company_id, client_id, name, address, lat, lng, service_type, active
    )
    VALUES (
      p_company_id,
      p_client_id,
      v_lead.name,
      v_address,
      v_lat,
      v_lng,
      coalesce(v_lead.service_type, 'limpeza_regular'),
      true
    )
    RETURNING id INTO v_location;
  END IF;

  -- ── A lead fecha — a mesma instrução da 104 ──────────────────────────────
  UPDATE public.crm_leads
     SET stage = 'ganho',
         won_at = coalesce(won_at, now()),
         converted_client_id = p_client_id,
         converted_location_id = v_location,
         lost_at = NULL,
         lost_reason = NULL,
         lost_reason_notes = NULL
   WHERE id = p_lead_id;

  -- ── O orçamento muda de destinatário — só este, como na 104 ──────────────
  UPDATE public.crm_quotes
     SET client_id = p_client_id,
         lead_id = NULL
   WHERE id = p_quote_id;

  -- ── A história, dentro da transação ──────────────────────────────────────
  --
  -- Diz o nome do cliente: é a resposta a «porque é que esta lead aponta
  -- para um cliente que já existia antes dela».
  INSERT INTO public.crm_lead_interactions (company_id, lead_id, kind, summary, author_id)
  VALUES (
    p_company_id,
    p_lead_id,
    'sistema',
    'Lead associada ao cliente existente «' || v_cliente.name
      || '» a partir do orçamento ' || v_quote.quote_number || '.',
    p_actor
  );

  client_id := p_client_id;
  location_id := v_location;
  ja_convertida := false;
  RETURN NEXT;
END;
$$;

COMMENT ON FUNCTION public.link_crm_lead_to_existing_client(uuid, uuid, uuid, uuid, uuid, uuid) IS
  'Fecha uma lead em ganho associando-a a um cliente que ja existe, escolhido '
  'por id, a partir de um orcamento aceite e vivo. O local e um do cliente '
  '(p_location_id) ou um novo com a morada da visita/lead (regras da 104). '
  'NAO altera o cliente; NAO deduplica por heuristica; NAO cria contrato, '
  'servico, factura nem caixa. Repetir com o mesmo cliente devolve os mesmos '
  'ids com ja_convertida=true depois de verificar os vinculos.';

-- ---------------------------------------------------------------------------
-- 2. ACL — a mesma da 104, desde o primeiro dia
-- ---------------------------------------------------------------------------

REVOKE ALL ON FUNCTION public.link_crm_lead_to_existing_client(uuid, uuid, uuid, uuid, uuid, uuid)
  FROM PUBLIC, anon, authenticated, service_role;

GRANT EXECUTE ON FUNCTION public.link_crm_lead_to_existing_client(uuid, uuid, uuid, uuid, uuid, uuid)
  TO service_role;

-- ---------------------------------------------------------------------------
-- 3. Pós-estado — a migration recusa-se a ficar aplicada com a segurança errada
-- ---------------------------------------------------------------------------
--
-- O mesmo portão da 104: não basta o REVOKE estar escrito — se alguém o
-- alterar, a aplicação pára em vez de deixar passar.

DO $poststate$
DECLARE
  v_oid oid;
  v_proconfig text[];
  v_security_definer boolean;
  v_grantees text[];
  v_grantable boolean;
BEGIN
  v_oid := to_regprocedure('public.link_crm_lead_to_existing_client(uuid, uuid, uuid, uuid, uuid, uuid)');

  IF v_oid IS NULL THEN
    RAISE EXCEPTION
      'CRM_LINK_108_POSTSTATE_FAILED: link_crm_lead_to_existing_client ausente ou com outra assinatura';
  END IF;

  v_proconfig := (SELECT p.proconfig FROM pg_proc p WHERE p.oid = v_oid);
  v_security_definer := (SELECT p.prosecdef FROM pg_proc p WHERE p.oid = v_oid);

  IF v_security_definer THEN
    RAISE EXCEPTION 'CRM_LINK_108_POSTSTATE_FAILED: a RPC ficou SECURITY DEFINER';
  END IF;

  IF NOT ('search_path=pg_catalog, public' = ANY(coalesce(v_proconfig, '{}'))) THEN
    RAISE EXCEPTION
      'CRM_LINK_108_POSTSTATE_FAILED: search_path não é exactamente `pg_catalog, public` (%)',
      coalesce(array_to_string(v_proconfig, ', '), 'NULL');
  END IF;

  v_grantees := (
    SELECT array_agg(DISTINCT acl.grantee::regrole::text ORDER BY acl.grantee::regrole::text)
      FROM pg_proc p,
           LATERAL aclexplode(coalesce(p.proacl, acldefault('f', p.proowner))) AS acl
     WHERE p.oid = v_oid
       AND acl.privilege_type = 'EXECUTE'
  );

  v_grantable := (
    SELECT bool_or(acl.is_grantable)
      FROM pg_proc p,
           LATERAL aclexplode(coalesce(p.proacl, acldefault('f', p.proowner))) AS acl
     WHERE p.oid = v_oid
       AND acl.privilege_type = 'EXECUTE'
  );

  IF v_grantees IS DISTINCT FROM (
    SELECT array_agg(g ORDER BY g)
      FROM (
        SELECT p.proowner::regrole::text AS g FROM pg_proc p WHERE p.oid = v_oid
        UNION
        SELECT 'service_role'
      ) AS esperado
  ) THEN
    RAISE EXCEPTION
      'CRM_LINK_108_POSTSTATE_FAILED: grantees de EXECUTE são % — esperado apenas o owner e service_role',
      array_to_string(v_grantees, ', ');
  END IF;

  IF coalesce(v_grantable, false) THEN
    RAISE EXCEPTION
      'CRM_LINK_108_POSTSTATE_FAILED: há EXECUTE com WITH GRANT OPTION';
  END IF;
END;
$poststate$;

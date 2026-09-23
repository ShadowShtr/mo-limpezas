-- ============================================================================
-- 104 — CRM: a conversão de uma lead em cliente e local, numa só transação
-- ============================================================================
--
-- O runner é o dono da transação: este ficheiro não abre BEGIN/COMMIT.
--
-- Esta migration é FUNDAÇÃO (DB-only). Cria uma RPC e fecha uma invariante.
-- Não muda nenhum ecrã: o runtime da conversão é a 104-B, e nenhum consumidor
-- pode entrar antes de isto estar aplicado em produção.
--
-- ---------------------------------------------------------------------------
-- O caminho que esta migration desbloqueia
-- ---------------------------------------------------------------------------
--
--     lead → visita → orçamento → aceite → ???
--
-- Hoje o `???` é um beco. `crm_leads_ganho_exige_conversao` (101) obriga uma
-- lead em `ganho` a ter `converted_client_id` e `converted_location_id`, e não
-- existe caminho nenhum para os criar. A lead fica presa depois de o cliente
-- dizer que sim.
--
-- ---------------------------------------------------------------------------
-- 🔴 QUATRO PARÂMETROS, e a contenção é o ponto
-- ---------------------------------------------------------------------------
--
-- Uma versão anterior desta RPC recebia onze: nome do cliente, morada,
-- `service_type`, `hourly_rate`, lat, lng… tudo vindo do browser. Cada um
-- desses é um estado impossível à espera de acontecer — o nome do cliente
-- podia não ser o da lead, a morada podia não ser a da visita, e a base não
-- tinha como saber qual dos dois era verdade.
--
-- Aqui entram só as quatro coisas que ninguém consegue derivar: quem manda
-- (`p_company_id`, `p_actor`), o que se converte (`p_lead_id`) e o documento
-- que o justifica (`p_quote_id`). Tudo o resto sai de dados autoritativos que
-- já estão ligados à lead e ao orçamento.
--
-- ---------------------------------------------------------------------------
-- 🔴 O ORÇAMENTO É OBRIGATÓRIO
-- ---------------------------------------------------------------------------
--
-- Não há `p_quote_id` opcional. No sistema actual, «ganho» quer dizer
-- exactamente uma coisa: houve um orçamento e o cliente aceitou-o. Criar um
-- cliente sem o documento comercial que o justifica seria inventar um ganho
-- sem prova — e mais tarde ninguém saberia responder «porque é que este
-- cliente existe?».
--
-- ---------------------------------------------------------------------------
-- 🔴 O QUE ESTA UNIDADE NÃO FAZ, e porquê
-- ---------------------------------------------------------------------------
--
--   · NÃO cria contrato. O writer de contratos gera ocorrências futuras e
--     alimenta calendário, equipas, valores e cobranças. Converter identidade
--     comercial e agendar trabalho são duas decisões, e a segunda é de uma
--     pessoa, com um formulário à frente;
--
--   · NÃO cria serviço, factura nem movimento de caixa;
--
--   · NÃO infere preço. A versão anterior olhava para a primeira linha do
--     orçamento e, se a unidade fosse `hora`, copiava o preço para
--     `locations.hourly_rate`. É heurística comercial disfarçada de dado: um
--     orçamento pode ter várias linhas à hora, ser mensal, ser preço fixo,
--     ter desconto, ter IVA e misturar unidades. O preço operacional do local
--     é decisão de quem faz o contrato, e fica a NULL até lá;
--
--   · NÃO deduplica clientes. Nenhuma procura por nome, email, NIF ou
--     telefone «parecidos». Heurística de identidade cria fusões silenciosas
--     que ninguém pediu e que não se desfazem. Esta unidade representa uma
--     coisa só: prospect → cliente NOVO. Quem já é cliente recebe orçamento
--     directamente (103-B1) e nunca passa por aqui.
-- ============================================================================

-- ---------------------------------------------------------------------------
-- 0. Precondições — a 104 não se constrói sobre uma 101/103 parcial
-- ---------------------------------------------------------------------------

DO $precondicoes$
DECLARE
  v_faltam text[];
BEGIN
  SELECT array_agg(esperado.nome ORDER BY esperado.nome) INTO v_faltam
    FROM (VALUES
      ('crm_leads'), ('crm_lead_interactions'), ('crm_visits'),
      ('crm_quotes'), ('crm_quote_items'),
      ('clients'), ('locations'), ('profiles')
    ) AS esperado(nome)
   WHERE to_regclass('public.' || esperado.nome) IS NULL;

  IF v_faltam IS NOT NULL THEN
    RAISE EXCEPTION 'CRM_CONV_104_PRECONDITION_FAILED: tabelas em falta %', v_faltam;
  END IF;

  -- As chaves candidatas que as FKs compostas da 101/103 já exigem.
  IF to_regclass('public.clients_id_company_unique') IS NULL
     OR to_regclass('public.locations_id_company_unique') IS NULL THEN
    RAISE EXCEPTION
      'CRM_CONV_104_PRECONDITION_FAILED: chaves candidatas (id, company_id) ausentes (086/101)';
  END IF;

  -- 🔴 `source_lead_id` é a proveniência imutável da 103. Sem ela não há como
  --    ligar o orçamento à lead depois de `lead_id` passar a NULL — que é
  --    exactamente o que esta RPC vai fazer.
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
     WHERE table_schema = 'public' AND table_name = 'crm_quotes'
       AND column_name = 'source_lead_id'
  ) THEN
    RAISE EXCEPTION
      'CRM_CONV_104_PRECONDITION_FAILED: crm_quotes.source_lead_id ausente — a 103 não está completa';
  END IF;

  -- As restrições da 101 que esta RPC tem de satisfazer numa só instrução.
  -- Se alguma tiver sido removida, a conversão passaria a gravar um estado
  -- que a 101 considerava impossível.
  SELECT array_agg(esperada.nome ORDER BY esperada.nome) INTO v_faltam
    FROM (VALUES
      ('crm_leads_ganha_exige_data'),
      ('crm_leads_conversao_coerente'),
      ('crm_leads_conversao_so_se_ganha'),
      ('crm_leads_ganho_exige_conversao'),
      ('crm_leads_cliente_mesma_empresa'),
      ('crm_leads_local_mesma_empresa')
    ) AS esperada(nome)
   WHERE NOT EXISTS (
     SELECT 1 FROM pg_constraint
      WHERE conrelid = 'public.crm_leads'::regclass AND conname = esperada.nome
   );

  IF v_faltam IS NOT NULL THEN
    RAISE EXCEPTION 'CRM_CONV_104_PRECONDITION_FAILED: restrições da 101 em falta %', v_faltam;
  END IF;

  -- O destinatário de um orçamento é exactamente um: é o que permite trocar
  -- `lead_id` por `client_id` sem ambiguidade.
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
     WHERE conrelid = 'public.crm_quotes'::regclass
       AND conname = 'crm_quotes_tem_destinatario'
  ) THEN
    RAISE EXCEPTION
      'CRM_CONV_104_PRECONDITION_FAILED: crm_quotes_tem_destinatario ausente (103)';
  END IF;

  -- 🔴 AS TRÊS RPC da 103, com a assinatura EXACTA — e são mesmo as três.
  --
  --    Uma versão anterior deste bloco dizia «as três» em comentário e
  --    verificava uma. Uma 103 a que faltasse `revise_crm_quote` passava o
  --    portão, e a 104 instalava-se sobre uma fundação incompleta.
  --
  --    `to_regprocedure` com a assinatura completa, e não `to_regproc`: um
  --    overload com outros tipos é outra função, e seria aceite por um teste
  --    que só olhasse para o nome.
  SELECT array_agg(esperada.nome ORDER BY esperada.nome) INTO v_faltam
    FROM (VALUES
      ('create_crm_quote_with_items',
       'public.create_crm_quote_with_items(uuid, uuid, uuid, uuid, text, integer, date, date, text, numeric, boolean, numeric, text, jsonb, text, text, text, uuid, jsonb)'),
      ('revise_crm_quote',
       'public.revise_crm_quote(uuid, uuid, uuid, date, date, numeric, boolean, numeric, text, jsonb)'),
      ('set_crm_quote_status',
       'public.set_crm_quote_status(uuid, uuid, uuid, text, text)')
    ) AS esperada(nome, assinatura)
   WHERE to_regprocedure(esperada.assinatura) IS NULL;

  IF v_faltam IS NOT NULL THEN
    RAISE EXCEPTION
      'CRM_CONV_104_PRECONDITION_FAILED: RPC da 103 em falta ou com outra assinatura %', v_faltam;
  END IF;
END;
$precondicoes$;

-- ---------------------------------------------------------------------------
-- 0a. Proveniência das DEPENDÊNCIAS — o ledger, não só os objectos
-- ---------------------------------------------------------------------------
--
-- 🔴 Porque é que verificar os objectos não chega.
--
--    O bloco acima prova que as tabelas, restrições e RPC existem. Não prova
--    COMO lá chegaram. E o runner deste projecto aceita `--only`:
--
--        node scripts/run-migrations.mjs --apply --only 104_crm_conversao_lead.sql
--
--    Com `--only`, ele corre exactamente esse ficheiro. Não olha para trás,
--    não verifica a cadeia, não exige que a 103a tenha linha no ledger. Se
--    alguém tiver criado os objectos da 103 pelo SQL Editor — que é como
--    dezenas de migrations deste projecto foram aplicadas, e nenhuma delas
--    escreveu no ledger — a 104 instalar-se-ia sobre uma fundação cuja
--    proveniência ninguém consegue reconstruir.
--
--    SCHEMA_EFFECT != MIGRATION_PROVENANCE. A 103 aprendeu isto para si
--    própria; a 104 tem de o aprender para aquilo de que depende.
--
-- 🔴 Os checksums estão FIXOS aqui, e são os de produção (lidos a 23/09).
--
--    Um ledger com a linha certa e conteúdo diferente é pior do que uma linha
--    em falta: diz que a 103 correu, quando o que correu foi outra coisa com
--    o mesmo nome. Fixar o checksum é a única forma de a 104 saber que a
--    fundação sobre a qual assenta é a que ela leu.
--
--    São os checksums LF-normalizados que `checksumForNewMigration()` calcula
--    — o mesmo valor para quem tem o repositório em CRLF.
--
-- 🔴 Este bloco corre ANTES de qualquer CREATE. Nada é criado e depois
--    desfeito: se a cadeia não estiver certa, nada chega a existir.

DO $dependencias$
DECLARE
  v_faltam  text[];
  v_erradas text[];
BEGIN
  IF to_regclass('public._migrations') IS NULL THEN
    RAISE EXCEPTION
      'CRM_CONV_104_LEDGER_AUSENTE: public._migrations não existe — a 104 só corre pelo runner canónico';
  END IF;

  WITH esperado(nome, checksum) AS (
    VALUES
      ('101_crm_leads.sql',              '92fb13678187609c7951faaae6dcf3a3688f04694efb4b34c6f04e23aee46942'),
      ('101a_crm_rpc_acl_hardening.sql', '51aca907d2e9310f36d01901f5bb4911f8a951a536bcb9886071b0ef1d0528fb'),
      ('101b_identity_reconciliation.sql','33614ef362300bca1a4a9bff8928172b45f2418b9409bb8eaaaa2e1805f4e136'),
      ('102_crm_visitas_comerciais.sql', '236cfdb6fc18ec8ac52496abb2226e2fe998a5ea4f0187597b9f249d301f4c8e'),
      ('103_crm_orcamentos.sql',         '6893946882e2df1af16c79158f3bcbe0324b7cae92845e39d8cb389f8e0260d0'),
      ('103a_crm_rpc_acl_hardening.sql', 'bcd107aa0ab837968856150d7ebfa02704cb97f9b4ace10d35ea7dde714ac738')
  )
  SELECT
    array_agg(e.nome ORDER BY e.nome) FILTER (WHERE m.name IS NULL),
    array_agg(e.nome || ' (ledger ' || coalesce(m.checksum, 'NULL') || ')' ORDER BY e.nome)
      FILTER (WHERE m.name IS NOT NULL AND m.checksum IS DISTINCT FROM e.checksum)
    INTO v_faltam, v_erradas
    FROM esperado e
    LEFT JOIN public._migrations m ON m.name = e.nome;

  IF v_faltam IS NOT NULL THEN
    RAISE EXCEPTION
      'CRM_CONV_104_DEPENDENCY_LEDGER_MISSING: fundações sem linha de ledger % — os objectos podem existir, mas a proveniência não; nada foi criado',
      array_to_string(v_faltam, ', ');
  END IF;

  IF v_erradas IS NOT NULL THEN
    RAISE EXCEPTION
      'CRM_CONV_104_DEPENDENCY_CHECKSUM_DIVERGED: o ledger diz aplicada mas o conteúdo não é o esperado % — nada foi criado',
      array_to_string(v_erradas, ', ');
  END IF;
END;
$dependencias$;

-- ---------------------------------------------------------------------------
-- 0b. Proveniência — efeito presente não é migration aplicada
-- ---------------------------------------------------------------------------
--
-- 🔴 SCHEMA_EFFECT != MIGRATION_PROVENANCE. Se os objectos já existirem sem
--    linha de ledger, alguém os criou fora do runner e o estado é
--    desconhecido: não se adopta, não se «reconcilia em silêncio».

DO $proveniencia$
DECLARE
  v_ledger boolean;
  v_efeitos text[];
  v_total_efeitos CONSTANT integer := 3;
BEGIN
  IF to_regclass('public._migrations') IS NULL THEN
    RAISE EXCEPTION
      'CRM_CONV_104_LEDGER_AUSENTE: public._migrations não existe — a 104 só corre pelo runner canónico';
  END IF;

  v_ledger := EXISTS (SELECT 1 FROM public._migrations WHERE name = '104_crm_conversao_lead.sql');

  SELECT array_agg(efeito.nome ORDER BY efeito.nome) INTO v_efeitos
    FROM (VALUES
      ('RPC convert_crm_lead_atomic',
       to_regprocedure('public.convert_crm_lead_atomic(uuid, uuid, uuid, uuid)')::text),
      ('índice locations_id_client_company_unique',
       to_regclass('public.locations_id_client_company_unique')::text),
      ('FK crm_leads_conversao_par_coerente',
       (SELECT 'presente' FROM pg_constraint
         WHERE conrelid = 'public.crm_leads'::regclass
           AND conname = 'crm_leads_conversao_par_coerente'))
    ) AS efeito(nome, presente)
   WHERE efeito.presente IS NOT NULL;

  IF v_ledger AND v_efeitos IS NULL THEN
    RAISE EXCEPTION
      'CRM_CONV_104_LEDGER_WITHOUT_EFFECT: há linha de ledger da 104 mas nenhum dos seus efeitos existe — decida primeiro o que é verdade';
  ELSIF v_ledger AND array_length(v_efeitos, 1) < v_total_efeitos THEN
    RAISE EXCEPTION
      'CRM_CONV_104_LEDGER_WITH_PARTIAL_EFFECT: a linha diz aplicada, mas só % de % efeitos existem (%) — a 104 ficou a meio',
      array_length(v_efeitos, 1), v_total_efeitos, array_to_string(v_efeitos, ', ');
  ELSIF v_ledger THEN
    RAISE EXCEPTION
      'CRM_CONV_104_JA_APLICADA: linha de ledger e efeitos todos presentes — reaplicar alteraria restrições e ACL';
  ELSIF v_efeitos IS NOT NULL THEN
    RAISE EXCEPTION
      'CRM_CONV_104_EFFECT_WITHOUT_LEDGER: já existem efeitos da 104 sem linha de ledger (%) — estado desconhecido, nada foi alterado',
      array_to_string(v_efeitos, ', ');
  END IF;
END;
$proveniencia$;

-- ---------------------------------------------------------------------------
-- 1. A invariante que faltava: o local é DO cliente convertido
-- ---------------------------------------------------------------------------
--
-- 🔴 O que produção garante hoje, e o que NÃO garante.
--
--    A 101 pôs duas FKs compostas em `crm_leads`:
--
--      (converted_client_id, company_id)   → clients   (id, company_id)
--      (converted_location_id, company_id) → locations (id, company_id)
--
--    Cada uma sozinha está certa: o cliente é da empresa, o local é da
--    empresa. Juntas não dizem nada sobre a relação ENTRE eles. Nada impedia:
--
--      lead → cliente A  +  local que pertence ao cliente B
--
--    com A e B da mesma empresa. A lead ficaria a apontar para um local que
--    não é do cliente que ela própria diz ter gerado — e isso não se descobre
--    a olhar para a lead, descobre-se meses depois a facturar o cliente errado.
--
--    Uma FK composta de TRÊS colunas fecha-o: o par tem de existir como par.
--
-- Produção tem `converted_leads = 0`, por isso não há backfill nem
-- reconciliação a fazer. Mesmo assim o preestado é validado abaixo — uma
-- linha incoerente que aparecesse entretanto faria a migration parar antes de
-- criar seja o que for, em vez de rebentar a meio no `ADD CONSTRAINT`.

CREATE UNIQUE INDEX IF NOT EXISTS locations_id_client_company_unique
  ON public.locations (id, client_id, company_id);

COMMENT ON INDEX public.locations_id_client_company_unique IS
  'Chave candidata para a FK tripla de crm_leads: permite exigir que o par '
  '(cliente convertido, local convertido) exista como par, e nao apenas que '
  'cada um pertenca a empresa.';

DO $preestado_par$
DECLARE
  v_incoerentes integer;
BEGIN
  SELECT count(*) INTO v_incoerentes
    FROM public.crm_leads l
    JOIN public.locations loc ON loc.id = l.converted_location_id
   WHERE l.converted_client_id IS NOT NULL
     AND loc.client_id IS DISTINCT FROM l.converted_client_id;

  IF v_incoerentes > 0 THEN
    RAISE EXCEPTION
      'CRM_CONV_104_PREESTADO_INCOERENTE: % lead(s) apontam para um local que não é do cliente convertido — corrigir os dados antes de fechar a invariante',
      v_incoerentes;
  END IF;
END;
$preestado_par$;

ALTER TABLE public.crm_leads
  DROP CONSTRAINT IF EXISTS crm_leads_conversao_par_coerente;
ALTER TABLE public.crm_leads
  ADD CONSTRAINT crm_leads_conversao_par_coerente
  FOREIGN KEY (converted_location_id, converted_client_id, company_id)
  REFERENCES public.locations (id, client_id, company_id)
  ON DELETE RESTRICT;

COMMENT ON CONSTRAINT crm_leads_conversao_par_coerente ON public.crm_leads IS
  'O local convertido tem de pertencer ao cliente convertido. As duas FKs da '
  '101 garantem a empresa de cada um separadamente, e nao a relacao entre os '
  'dois: sem isto, uma lead podia apontar para o cliente A e para um local do '
  'cliente B da mesma empresa.';

-- ---------------------------------------------------------------------------
-- 2. A conversão
-- ---------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION public.convert_crm_lead_atomic(
  p_company_id uuid,
  p_lead_id    uuid,
  p_actor      uuid,
  p_quote_id   uuid
)
RETURNS TABLE (client_id uuid, location_id uuid, ja_convertida boolean)
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = pg_catalog, public
AS $$
DECLARE
  v_lead     public.crm_leads%ROWTYPE;
  v_quote    public.crm_quotes%ROWTYPE;
  v_visita   public.crm_visits%ROWTYPE;
  v_client   uuid;
  v_location uuid;
  v_address  text;
  v_lat      numeric(10,7);
  v_lng      numeric(10,7);
  v_loc_client uuid;
BEGIN
  IF p_quote_id IS NULL THEN
    -- Ver o cabeçalho: «ganho» é «houve orçamento e foi aceite». Sem o
    -- documento não há ganho para representar.
    RAISE EXCEPTION 'CONVERSION_QUOTE_REQUIRED' USING ERRCODE = 'check_violation';
  END IF;

  -- 🔴 O ator tem de ser desta empresa.
  --
  --    A Server Action futura já passa por `requireProfile`, mas a RPC não
  --    pode confiar nisso: ela é que vai carimbar `created_by` e o autor da
  --    linha de timeline. Uma identidade de outra empresa gravaria história
  --    com o nome errado, e isso não se descobre depois.
  IF NOT EXISTS (
    SELECT 1 FROM public.profiles
     WHERE id = p_actor AND company_id = p_company_id
  ) THEN
    RAISE EXCEPTION 'ACTOR_NOT_IN_COMPANY' USING ERRCODE = 'check_violation';
  END IF;

  -- 🔴 `FOR UPDATE` na lead, e é ela que serializa tudo o resto.
  --
  --    Duas conversões simultâneas da mesma lead criariam dois clientes e
  --    dois locais — e a segunda sobrescreveria os ids da primeira, deixando
  --    um cliente órfão que ninguém sabe que existe. Com o lock, a segunda
  --    espera, e quando entra já vê a lead convertida: cai no ramo
  --    idempotente abaixo.
  SELECT * INTO v_lead
    FROM public.crm_leads
   WHERE id = p_lead_id AND company_id = p_company_id
   FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'LEAD_NOT_FOUND' USING ERRCODE = 'no_data_found';
  END IF;

  -- ── Já convertida? ───────────────────────────────────────────────────────
  --
  -- 🔴 Idempotente NÃO quer dizer «devolve o que lá está sem olhar».
  --
  --    Repetir a chamada depois de um sucesso tem de devolver os mesmos ids e
  --    não criar nada. Mas se a lead diz convertida e os vínculos divergem, o
  --    estado é desconhecido — e um estado desconhecido não se repara sozinho.
  --    Devolver «já convertida» nesse caso seria carimbar como bom um estado
  --    que ninguém verificou.
  IF v_lead.converted_client_id IS NOT NULL THEN
    SELECT loc.client_id INTO v_loc_client
      FROM public.locations loc
     WHERE loc.id = v_lead.converted_location_id
       AND loc.company_id = p_company_id;

    IF v_loc_client IS NULL
       OR v_loc_client IS DISTINCT FROM v_lead.converted_client_id THEN
      RAISE EXCEPTION
        'CONVERSION_STATE_DIVERGED: o local convertido não pertence ao cliente convertido'
        USING ERRCODE = 'check_violation';
    END IF;

    -- 🔴 `FOR UPDATE`, e na MESMA ORDEM do caminho normal: lead → quote.
    --
    --    Duas ordens de lock diferentes no mesmo par de linhas é a receita de
    --    um deadlock — e aqui as duas chamadas concorrentes tocam exactamente
    --    nestas duas linhas. Prender também garante que o documento não muda
    --    entre a verificação e a resposta.
    SELECT * INTO v_quote
      FROM public.crm_quotes
     WHERE id = p_quote_id AND company_id = p_company_id
     FOR UPDATE;

    IF NOT FOUND THEN
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

    -- 🔴 O documento tem de continuar a ser o que justificou a conversão.
    --
    --    Verificar só os vínculos (lead ↔ cliente ↔ local ↔ orçamento) não
    --    chega: um orçamento pode ter sido anulado ou substituído por uma
    --    revisão DEPOIS de a conversão ter acontecido. Responder
    --    `ja_convertida = true` nesse caso seria carimbar como bom um estado
    --    que já não é o que foi aceite — e o chamador ficaria convencido de
    --    que está tudo coerente.
    --
    --    Idempotente é «o mesmo resultado para a mesma pergunta», não «não
    --    olhes para o que mudou».
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

  -- ── O orçamento que justifica o ganho ────────────────────────────────────
  --
  -- 🔴 `FOR UPDATE` também aqui: entre a validação e a escrita, outra
  --    transação podia substituí-lo por uma revisão.
  SELECT * INTO v_quote
    FROM public.crm_quotes
   WHERE id = p_quote_id AND company_id = p_company_id
   FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'QUOTE_NOT_FOUND' USING ERRCODE = 'no_data_found';
  END IF;

  -- Proveniência: nasceu desta lead. Imutável, por trigger da 103.
  IF v_quote.source_lead_id IS DISTINCT FROM p_lead_id THEN
    RAISE EXCEPTION 'QUOTE_LEAD_MISMATCH: o orçamento não nasceu desta lead'
      USING ERRCODE = 'check_violation';
  END IF;

  -- 🔴 Destinatário ACTUAL: ainda é a lead. Distinto da proveniência.
  --    Um orçamento já endereçado a um cliente não pode converter outra vez.
  IF v_quote.lead_id IS DISTINCT FROM p_lead_id OR v_quote.client_id IS NOT NULL THEN
    RAISE EXCEPTION 'QUOTE_RECIPIENT_MISMATCH: o orçamento já não está endereçado a esta lead'
      USING ERRCODE = 'check_violation';
  END IF;

  -- 🔴 Uma revisão histórica não converte. O que o cliente aceitou foi a
  --    versão viva; a substituída é o que se dizia antes.
  IF v_quote.superseded_by_id IS NOT NULL THEN
    RAISE EXCEPTION 'QUOTE_ALREADY_SUPERSEDED: substituído por %', v_quote.superseded_by_id
      USING ERRCODE = 'check_violation';
  END IF;

  IF v_quote.status <> 'aceite' THEN
    RAISE EXCEPTION 'QUOTE_NOT_ACCEPTED: estado %', v_quote.status
      USING ERRCODE = 'check_violation';
  END IF;

  -- ── De onde vem a morada ─────────────────────────────────────────────────
  --
  -- 🔴 A fonte é escolhida como UNIDADE COERENTE: ou tudo da visita, ou tudo
  --    da lead.
  --
  --    Misturar a morada da visita com as coordenadas da lead põe um alfinete
  --    no mapa a dizer uma coisa e um endereço a dizer outra — e é o mapa que
  --    a equipa segue para lá chegar. A visita ganha quando existe e tem
  --    morada, porque é onde alguém esteve mesmo.
  v_address := NULL;

  IF v_quote.visit_id IS NOT NULL THEN
    -- 🔴 A visita carrega-se pelo VÍNCULO ESTRUTURAL — o mesmo que a FK da
    --    103 garante — e só DEPOIS se valida a relação com a lead.
    --
    --    A diferença não é de estilo. A versão anterior filtrava as três
    --    condições de uma vez (`id`, `company_id`, `lead_id`) e, quando não
    --    encontrava nada, seguia em frente e usava a morada da lead. Isso
    --    confunde duas situações que não têm nada a ver uma com a outra:
    --
    --      «a visita não tem morada»          → fallback legítimo
    --      «a visita é de OUTRA lead»         → estado impossível
    --
    --    O segundo é drift. A 103 valida o destinatário da visita na CRIAÇÃO
    --    do orçamento, mas a FK persistente só prende `(visit_id, company_id)`
    --    — nada impede que `crm_visits.lead_id` mude depois. Quando isso
    --    acontece, converter usando a morada da lead seria normalizar em
    --    silêncio um estado que ninguém consegue explicar, e produzir um
    --    cliente cuja proveniência aponta para uma visita que já não é dele.
    --
    --    UNKNOWN_STATE = FAIL_CLOSED: não se converte, e não se repara.
    SELECT * INTO v_visita
      FROM public.crm_visits
     WHERE id = v_quote.visit_id
       AND company_id = p_company_id;

    IF NOT FOUND THEN
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

    -- 🔴 Só aqui o fallback é legítimo: a visita é mesmo desta lead, apenas
    --    não tem morada utilizável. Nesse caso usa-se a lead INTEIRA, como
    --    unidade coerente.
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
    -- `locations.address` é NOT NULL, e inventar um texto de preenchimento
    -- daria um local que ninguém consegue visitar.
    RAISE EXCEPTION 'CONVERSION_ADDRESS_REQUIRED' USING ERRCODE = 'check_violation';
  END IF;

  -- ── O cliente ────────────────────────────────────────────────────────────
  --
  -- Tudo derivado da lead. Sem procura por «parecidos»: ver o cabeçalho.
  --
  -- 🔴 SEM `address`, e a ausência é deliberada.
  --
  --    Uma versão anterior gravava aqui `v_address` — que pode ser a morada
  --    da VISITA. São dois conceitos diferentes:
  --
  --      clients.address    identidade e contacto do cliente
  --      locations.address  onde o serviço acontece
  --
  --    Com `lead.address = A` e `visit.address = B`, o local fica com B (é lá
  --    que se trabalha) e o cliente ficava também com B — uma morada de
  --    trabalho carimbada como morada da empresa, que ninguém escolheu e que
  --    ninguém sabe que está errada.
  --
  --    É também o que `createClienteComLocal()` já faz: cria o cliente sem
  --    `address` e grava a morada no local. Duas formas de criar cliente com
  --    regras diferentes seriam duas verdades.
  --
  --    NO_DATA_LOSS: `crm_leads.address` continua a guardar a morada original
  --    da lead, e `locations.address` recebe a operacional. Nada se perde —
  --    deixa apenas de ser copiado para onde não pertence.
  INSERT INTO public.clients (company_id, name, nif, email, phone, type, status)
  VALUES (
    p_company_id,
    v_lead.name,
    v_lead.nif,
    v_lead.email,
    v_lead.phone,
    v_lead.lead_type,      -- o CHECK de lead_type espelha o de clients.type
    'ativo'
  )
  RETURNING id INTO v_client;

  -- ── O local ──────────────────────────────────────────────────────────────
  --
  -- 🔴 `hourly_rate` fica a NULL de propósito. Ver o cabeçalho: o preço
  --    operacional é decisão de quem faz o contrato, não uma leitura das
  --    linhas do orçamento.
  INSERT INTO public.locations (
    company_id, client_id, name, address, lat, lng, service_type, active
  )
  VALUES (
    p_company_id,
    v_client,
    v_lead.name,
    v_address,
    v_lat,
    v_lng,
    coalesce(v_lead.service_type, 'limpeza_regular'),
    true
  )
  RETURNING id INTO v_location;

  -- ── A lead fecha ─────────────────────────────────────────────────────────
  --
  -- Tudo numa instrução: as restrições da 101 verificam a linha inteira, e
  -- pôr `stage = 'ganho'` antes dos ids violaria `crm_leads_ganho_exige_conversao`.
  --
  -- 🔴 O estado de perda é limpo. Uma lead que tinha sido dada como perdida e
  --    agora ganhou não pode ficar com `lost_reason` — e
  --    `crm_leads_perdida_exige_motivo` só olha para `stage = 'perdido'`, por
  --    isso não seria a base a apanhar a incoerência.
  UPDATE public.crm_leads
     SET stage = 'ganho',
         won_at = coalesce(won_at, now()),
         converted_client_id = v_client,
         converted_location_id = v_location,
         lost_at = NULL,
         lost_reason = NULL,
         lost_reason_notes = NULL
   WHERE id = p_lead_id;

  -- ── O orçamento muda de destinatário ─────────────────────────────────────
  --
  -- 🔴 SÓ este. As revisões históricas ficam como estão: são a história de
  --    quando o destinatário era a lead, e reescrevê-las apagaria o registo
  --    do que foi enviado nessa altura.
  --
  -- 🔴 `source_lead_id` NÃO é tocado — é imutável por trigger, e é o que
  --    mantém a cadeia navegável depois de `lead_id` ficar a NULL.
  --
  -- Preços, totais, estado, `accepted_at`, `sent_at`, `revision` e
  -- `root_quote_id` também não se tocam: a conversão muda a quem o documento
  -- está endereçado, não o que ele diz.
  UPDATE public.crm_quotes
     SET client_id = v_client,
         lead_id = NULL
   WHERE id = p_quote_id;

  -- ── A história ───────────────────────────────────────────────────────────
  --
  -- 🔴 DENTRO da transação, e não best-effort.
  --
  --    Nas outras escritas do CRM a timeline é uma projecção derivada e uma
  --    falha nela não desfaz a operação. Aqui é diferente: a lead passa a
  --    dizer «ganho» e a apontar para um cliente que nasceu agora. Sem a linha
  --    que explica a conversão, ninguém consegue responder de onde veio o
  --    cliente — e essa pergunta é a razão de a lead continuar a existir
  --    depois de convertida. Se isto falhar, a conversão inteira reverte.
  INSERT INTO public.crm_lead_interactions (company_id, lead_id, kind, summary, author_id)
  VALUES (
    p_company_id,
    p_lead_id,
    'sistema',
    'Lead convertida em cliente a partir do orçamento ' || v_quote.quote_number || '.',
    p_actor
  );

  client_id := v_client;
  location_id := v_location;
  ja_convertida := false;
  RETURN NEXT;
END;
$$;

COMMENT ON FUNCTION public.convert_crm_lead_atomic(uuid, uuid, uuid, uuid) IS
  'Converte uma lead num cliente e num local, numa so transacao, a partir de '
  'um orcamento aceite e vivo. Quatro parametros: tudo o resto e derivado da '
  'lead e do orcamento. NAO cria contrato, servico, factura nem movimento de '
  'caixa; NAO infere preco operacional; NAO deduplica clientes. Repetir a '
  'chamada devolve os mesmos ids com ja_convertida=true, mas so depois de '
  'verificar que os vinculos existentes sao coerentes — divergencia e '
  'CONVERSION_STATE_DIVERGED, nunca reparacao automatica.';

-- ---------------------------------------------------------------------------
-- 3. ACL — canónica desde o primeiro dia
-- ---------------------------------------------------------------------------
--
-- 🔴 `FROM PUBLIC, anon, authenticated, service_role` — os quatro.
--
--    Foi exactamente esta lista que faltou na 103 e obrigou à 103a. Este
--    projecto tem `ALTER DEFAULT PRIVILEGES ... GRANT EXECUTE ON FUNCTIONS TO
--    anon, authenticated, service_role`: uma função nova nasce executável por
--    esses três papéis, e `REVOKE ... FROM PUBLIC` não lhes toca, porque
--    PUBLIC é o «toda a gente implícito» e não a soma dos grantees nomeados.
--
--    `service_role` também entra no REVOKE para que o GRANT seguinte seja a
--    única origem do seu privilégio — sem `WITH GRANT OPTION` herdado.

REVOKE ALL ON FUNCTION public.convert_crm_lead_atomic(uuid, uuid, uuid, uuid)
  FROM PUBLIC, anon, authenticated, service_role;

GRANT EXECUTE ON FUNCTION public.convert_crm_lead_atomic(uuid, uuid, uuid, uuid)
  TO service_role;

-- `search_path` já vai fixo na própria definição (`SET search_path` acima), e
-- não num `ALTER FUNCTION` posterior: uma função nova não precisa de ser
-- corrigida depois de nascer.

-- ---------------------------------------------------------------------------
-- 4. Pós-estado — o que esta migration promete ter deixado
-- ---------------------------------------------------------------------------

DO $poststate$
DECLARE
  v_oid oid;
  v_proconfig text[];
  v_security_definer boolean;
  v_grantees text[];
  v_grantable boolean;
BEGIN
  v_oid := to_regprocedure('public.convert_crm_lead_atomic(uuid, uuid, uuid, uuid)');

  IF v_oid IS NULL THEN
    RAISE EXCEPTION
      'CRM_CONV_104_POSTSTATE_FAILED: convert_crm_lead_atomic ausente ou com outra assinatura';
  END IF;

  SELECT p.proconfig, p.prosecdef INTO v_proconfig, v_security_definer
    FROM pg_proc p WHERE p.oid = v_oid;

  IF v_security_definer THEN
    RAISE EXCEPTION 'CRM_CONV_104_POSTSTATE_FAILED: a RPC ficou SECURITY DEFINER';
  END IF;

  IF NOT ('search_path=pg_catalog, public' = ANY(coalesce(v_proconfig, '{}'))) THEN
    RAISE EXCEPTION
      'CRM_CONV_104_POSTSTATE_FAILED: search_path não é exactamente `pg_catalog, public` (%)',
      coalesce(array_to_string(v_proconfig, ', '), 'NULL');
  END IF;

  -- 🔴 O CONJUNTO de grantees, e não a presença de nomes. Um papel a mais com
  --    EXECUTE responde «sim» a «service_role pode?» e continua errado.
  --
  --    O owner é derivado de `proowner`, nunca escrito à mão: em produção
  --    pode não ser o mesmo nome que numa base de ensaio.
  SELECT array_agg(DISTINCT acl.grantee::regrole::text ORDER BY acl.grantee::regrole::text),
         bool_or(acl.is_grantable)
    INTO v_grantees, v_grantable
    FROM pg_proc p,
         LATERAL aclexplode(coalesce(
           p.proacl,
           acldefault('f', p.proowner)
         )) AS acl
   WHERE p.oid = v_oid
     AND acl.privilege_type = 'EXECUTE';

  IF v_grantees IS DISTINCT FROM (
    SELECT array_agg(g ORDER BY g)
      FROM (
        SELECT p.proowner::regrole::text AS g FROM pg_proc p WHERE p.oid = v_oid
        UNION
        SELECT 'service_role'
      ) AS esperado
  ) THEN
    RAISE EXCEPTION
      'CRM_CONV_104_POSTSTATE_FAILED: grantees de EXECUTE são % — esperado apenas o owner e service_role',
      array_to_string(v_grantees, ', ');
  END IF;

  IF coalesce(v_grantable, false) THEN
    RAISE EXCEPTION
      'CRM_CONV_104_POSTSTATE_FAILED: há EXECUTE com WITH GRANT OPTION';
  END IF;

  IF to_regclass('public.locations_id_client_company_unique') IS NULL THEN
    RAISE EXCEPTION
      'CRM_CONV_104_POSTSTATE_FAILED: índice locations_id_client_company_unique ausente';
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
     WHERE conrelid = 'public.crm_leads'::regclass
       AND conname = 'crm_leads_conversao_par_coerente'
  ) THEN
    RAISE EXCEPTION
      'CRM_CONV_104_POSTSTATE_FAILED: FK crm_leads_conversao_par_coerente ausente';
  END IF;
END;
$poststate$;

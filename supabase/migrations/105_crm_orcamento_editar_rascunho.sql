-- ============================================================================
-- 105 — editar um orçamento em RASCUNHO, in place, numa só transação
-- ============================================================================
--
-- O que esta migration fecha, em linguagem de quem usa o produto: hoje, um
-- rascunho com um erro não se corrige. Anula-se e emite-se outro, com número
-- novo. O ciclo de autoria fica com buracos na sequência por causa de uma
-- gralha numa descrição.
--
-- ---------------------------------------------------------------------------
-- 🔴 PORQUE É QUE ISTO TEM DE SER UMA RPC, E NÃO TRÊS ESCRITAS
-- ---------------------------------------------------------------------------
--
-- Substituir as linhas de um orçamento é, em SQL, três operações:
--
--       UPDATE crm_quotes   (cabeçalho e totais novos)
--       DELETE crm_quote_items  (as linhas antigas)
--       INSERT crm_quote_items  (as linhas novas)
--
-- Feitas em três chamadas separadas a partir do runtime, cada intervalo entre
-- elas é um estado que alguém pode ler:
--
--       header novo + items antigos   → o total não bate com as linhas
--       header novo + zero items      → um documento a zero
--       items novos + header antigo   → as linhas não batem com o total
--
-- Nenhum destes três estados é recuperável por retry: quem ler no intervalo
-- leu um documento que nunca foi verdade. E o intervalo não é teórico — entre
-- o DELETE e o INSERT há sempre uma janela, e um erro de rede no meio deixa-a
-- aberta para sempre.
--
-- Dentro de uma função plpgsql as três correm na MESMA transação. Ou o
-- documento inteiro muda, ou não muda nada. É essa a única coisa que esta
-- migration acrescenta ao sistema.
--
-- ---------------------------------------------------------------------------
-- 🔴 EDIÇÃO IN PLACE NÃO É REVISÃO
-- ---------------------------------------------------------------------------
--
-- A 103 já distingue as duas, e `revise_crm_quote` recusa um rascunho com
-- `QUOTE_DRAFT_EDIT_IN_PLACE` — a sentinela ficou lá escrita à espera desta
-- migration.
--
--   · um rascunho NUNCA saiu para o cliente. Ninguém lá fora viu o preço
--     antigo. Corrigi-lo em cima não falsifica nada, e criar uma R1 de algo
--     que nunca foi enviado enche a sequência de documentos fantasma;
--
--   · um ENVIADO já está nas mãos de alguém. Mudar-lhe os números por baixo é
--     falsificar o que essa pessoa tem à frente. Por isso edita-se por
--     revisão, com número novo, e a anterior fica legível como história.
--
-- Daí o guard mais importante deste ficheiro: `status = 'rascunho'`. Sem ele,
-- esta RPC seria uma forma de reescrever um orçamento aceite sem deixar rasto.
--
-- ---------------------------------------------------------------------------
-- 🔴 O QUE UMA EDIÇÃO NÃO PODE MUDAR
-- ---------------------------------------------------------------------------
--
-- A identidade do documento e a sua proveniência não são campos de formulário:
--
--       id · quote_number · quote_year · quote_seq · revision · root_quote_id
--       source_lead_id · lead_id/client_id (destinatário) · created_by
--       created_at
--
-- Nenhuma delas aparece no `UPDATE` lá em baixo, e isso não é distracção — é
-- o mecanismo. Em particular o DESTINATÁRIO: permitir «editar» o orçamento da
-- lead A para a lead B, ou de uma lead para um cliente, faria a conversão da
-- 104 apontar para quem nunca pediu aquele preço. Se o destinatário está
-- errado, o caminho é anular e emitir outro.
--
-- `source_lead_id` tem ainda o trigger `crm_quotes_proveniencia_imutavel` da
-- 103 por trás — cinto e suspensórios, de propósito: uma coluna que nunca
-- muda deve ser defendida no sítio onde a escrita acontece, e não só na
-- disciplina de quem escreve a próxima RPC.
--
-- ---------------------------------------------------------------------------
-- 🔴 O ANO DO NÚMERO NÃO SE MOVE
-- ---------------------------------------------------------------------------
--
-- `quote_number` e `quote_year` foram atribuídos na criação, sob advisory lock,
-- e o sequencial é por empresa E ANO. Deixar a edição mudar `issue_date` para
-- outro ano produziria:
--
--       ORC2026/007  com  issue_date = 2027-01-02
--
-- — um documento de 2027 a ocupar o 007 de 2026, e o 007 de 2027 livre para
-- ser atribuído a outro. A sequência deixaria de significar o que diz.
--
-- Corrigir o dia ou o mês dentro do mesmo ano é legítimo e passa. Mudar de ano
-- é emitir outro documento: anula-se e cria-se, com número do ano certo.
--
-- ---------------------------------------------------------------------------
-- 🔴 UNKNOWN_STATE = FAIL_CLOSED
-- ---------------------------------------------------------------------------
--
-- Um rascunho coerente não tem `sent_at`, `accepted_at`, `rejected_at` nem
-- `rejection_reason`. Se o `status` diz «rascunho» mas um desses factos
-- históricos já existe, o documento está num estado que nenhum caminho legítimo
-- produz — e esta RPC não o repara. Não limpa timestamps, não normaliza, não
-- adivinha qual das duas versões é a verdadeira. Recusa com
-- `QUOTE_DRAFT_STATE_DIVERGED` e deixa a prova intacta para quem tiver de
-- decidir.
--
-- Reparar em silêncio um estado que não se percebe é apagar a única pista de
-- que algo correu mal.
--
-- ---------------------------------------------------------------------------
-- O que esta migration NÃO traz
-- ---------------------------------------------------------------------------
--
--   · nenhum runtime. Não há Server Action, nem botão, nem release note. A
--     ordem é DB → merge → autorização → apply → só depois o código que chama.
--     CODE CANNOT CALL DB OBJECT ABSENT FROM PRODUCTION;
--   · nenhum `proposed_weekdays`. O runtime actual mantém esse campo sem
--     consumidor, deliberadamente. Criar hoje um campo editável que o produto
--     não usa é criar superfície para manter sem ninguém do outro lado;
--   · nenhuma idempotência por conteúdo. Repetir a mesma edição com o mesmo
--     payload executa outra vez e termina no mesmo estado — o que é inofensivo
--     e verdadeiro. Um `mutation_id` sem um problema concreto a resolver seria
--     complexidade a adivinhar futuro;
--   · nada de email, PDF, storage ou outbox. Outra unidade, outra conversa.
--
-- ---------------------------------------------------------------------------
-- A aritmética
-- ---------------------------------------------------------------------------
--
-- 🔴 É a MESMA de `create_crm_quote_with_items` e `revise_crm_quote`, linha
--    por linha:
--
--        subtotal = Σ round(quantity × unit_price, 2)
--        base     = round(subtotal × (1 - discount/100), 2)
--        iva      = round(base × vat_rate/100, 2)   quando se aplica
--        total    = base + iva
--
--    Está duplicada, e a duplicação é uma escolha. Extrair um helper SQL comum
--    obrigaria a reescrever duas RPC já aplicadas em produção e já provadas —
--    incluindo a paridade contra o runtime, medida em Postgres real. O risco
--    de mexer em writers provados para poupar seis linhas é maior do que o de
--    as repetir. Há um ensaio que compara os três resultados sobre os mesmos
--    dados: se alguém alterar uma das fórmulas, fica vermelho.
-- ============================================================================

-- ---------------------------------------------------------------------------
-- 0. Precondições — o que tem de existir antes desta migration
-- ---------------------------------------------------------------------------

DO $precondicoes$
DECLARE
  v_faltam text[];
BEGIN
  SELECT array_agg(t ORDER BY t) INTO v_faltam
    FROM unnest(ARRAY[
      'public.crm_leads', 'public.crm_visits', 'public.crm_quotes',
      'public.crm_quote_items', 'public.clients', 'public.profiles'
    ]) AS t
   WHERE to_regclass(t) IS NULL;

  IF v_faltam IS NOT NULL THEN
    RAISE EXCEPTION 'CRM_EDIT_105_PRECONDITION_FAILED: tabelas em falta %',
      array_to_string(v_faltam, ', ');
  END IF;

  -- As colunas de identidade e de proveniência que a edição tem de preservar.
  -- Se alguma não existir, a 103 não é a que este ficheiro leu.
  SELECT array_agg(c ORDER BY c) INTO v_faltam
    FROM unnest(ARRAY[
      'source_lead_id', 'quote_number', 'quote_year', 'quote_seq',
      'revision', 'root_quote_id', 'superseded_by_id', 'created_by'
    ]) AS c
   WHERE NOT EXISTS (
     SELECT 1 FROM information_schema.columns
      WHERE table_schema = 'public' AND table_name = 'crm_quotes' AND column_name = c
   );

  IF v_faltam IS NOT NULL THEN
    RAISE EXCEPTION
      'CRM_EDIT_105_PRECONDITION_FAILED: colunas de crm_quotes em falta % — a 103 não está completa',
      array_to_string(v_faltam, ', ');
  END IF;

  -- 🔴 O trigger de imutabilidade da proveniência. Esta RPC não escreve
  --    `source_lead_id`, mas conta com ele como segunda linha de defesa.
  IF NOT EXISTS (
    SELECT 1 FROM pg_trigger
     WHERE tgrelid = 'public.crm_quotes'::regclass
       AND tgname = 'crm_quotes_proveniencia_imutavel'
       AND NOT tgisinternal
  ) THEN
    RAISE EXCEPTION
      'CRM_EDIT_105_PRECONDITION_FAILED: trigger crm_quotes_proveniencia_imutavel ausente (103)';
  END IF;

  -- O índice de posição, que é o que torna a substituição de linhas ordenada.
  IF to_regclass('public.uq_crm_quote_items_posicao') IS NULL THEN
    RAISE EXCEPTION
      'CRM_EDIT_105_PRECONDITION_FAILED: índice uq_crm_quote_items_posicao ausente (103)';
  END IF;

  -- As restrições que esta RPC assume ao não as reimplementar.
  SELECT array_agg(n ORDER BY n) INTO v_faltam
    FROM unnest(ARRAY[
      'crm_quotes_tem_destinatario', 'crm_quotes_validade_coerente'
    ]) AS n
   WHERE NOT EXISTS (
     SELECT 1 FROM pg_constraint
      WHERE conrelid = 'public.crm_quotes'::regclass AND conname = n
   );

  IF v_faltam IS NOT NULL THEN
    RAISE EXCEPTION 'CRM_EDIT_105_PRECONDITION_FAILED: restrições da 103 em falta %',
      array_to_string(v_faltam, ', ');
  END IF;

  -- 🔴 As TRÊS RPC da 103 e a da 104, com a assinatura exacta.
  --
  --    Não é decorativo: esta RPC é a quarta de uma família, e a sua
  --    aritmética TEM de ser a mesma das outras duas. Se as anteriores não
  --    estiverem lá com a forma que este ficheiro leu, a fundação não é a que
  --    se julga.
  SELECT array_agg(f ORDER BY f) INTO v_faltam
    FROM unnest(ARRAY[
      'public.create_crm_quote_with_items(uuid, uuid, uuid, uuid, text, integer, date, date, text, numeric, boolean, numeric, text, jsonb, text, text, text, uuid, jsonb)',
      'public.revise_crm_quote(uuid, uuid, uuid, date, date, numeric, boolean, numeric, text, jsonb)',
      'public.set_crm_quote_status(uuid, uuid, uuid, text, text)',
      'public.convert_crm_lead_atomic(uuid, uuid, uuid, uuid)'
    ]) AS f
   WHERE to_regprocedure(f) IS NULL;

  IF v_faltam IS NOT NULL THEN
    RAISE EXCEPTION
      'CRM_EDIT_105_PRECONDITION_FAILED: RPC da cadeia em falta ou com outra assinatura %',
      array_to_string(v_faltam, ', ');
  END IF;
END;
$precondicoes$;

-- ---------------------------------------------------------------------------
-- 0a. Proveniência das DEPENDÊNCIAS — o ledger, não só os objectos
-- ---------------------------------------------------------------------------
--
-- 🔴 SCHEMA_EFFECT != MIGRATION_PROVENANCE.
--
--    O bloco acima prova que os objectos existem. Não prova COMO lá chegaram,
--    e o runner deste projecto aceita `--only`:
--
--        node scripts/run-migrations.mjs --apply --only 105_crm_orcamento_editar_rascunho.sql
--
--    Com `--only` ele corre exactamente esse ficheiro, sem olhar para trás.
--    Se a 103 ou a 104 tiverem sido criadas pelo SQL Editor — que é como
--    dezenas de migrations deste repositório foram aplicadas, e nenhuma delas
--    escreveu no ledger — a 105 instalar-se-ia sobre uma fundação cuja
--    proveniência ninguém consegue reconstruir.
--
-- 🔴 Os checksums são os de PRODUÇÃO, lidos a 23/09/2026, e são os mesmos que
--    a 104 já fixa para a parte da cadeia que partilham. São os valores
--    LF-normalizados que `checksumForNewMigration()` calcula — iguais para
--    quem tem o repositório em CRLF. Há um ensaio que os recalcula a partir
--    dos ficheiros e fica vermelho se divergirem.

DO $dependencias$
DECLARE
  v_faltam  text[];
  v_erradas text[];
BEGIN
  IF to_regclass('public._migrations') IS NULL THEN
    RAISE EXCEPTION
      'CRM_EDIT_105_LEDGER_AUSENTE: public._migrations não existe — a 105 só corre pelo runner canónico';
  END IF;

  WITH esperado(nome, checksum) AS (
    VALUES
      ('101_crm_leads.sql',              '92fb13678187609c7951faaae6dcf3a3688f04694efb4b34c6f04e23aee46942'),
      ('101a_crm_rpc_acl_hardening.sql', '51aca907d2e9310f36d01901f5bb4911f8a951a536bcb9886071b0ef1d0528fb'),
      ('101b_identity_reconciliation.sql','33614ef362300bca1a4a9bff8928172b45f2418b9409bb8eaaaa2e1805f4e136'),
      ('102_crm_visitas_comerciais.sql', '236cfdb6fc18ec8ac52496abb2226e2fe998a5ea4f0187597b9f249d301f4c8e'),
      ('103_crm_orcamentos.sql',         '6893946882e2df1af16c79158f3bcbe0324b7cae92845e39d8cb389f8e0260d0'),
      ('103a_crm_rpc_acl_hardening.sql', 'bcd107aa0ab837968856150d7ebfa02704cb97f9b4ace10d35ea7dde714ac738'),
      ('104_crm_conversao_lead.sql',     '963b13b4a2b32422845bd7b22256def3e0edbba88e62e125b5b399881b1a2d9f')
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
      'CRM_EDIT_105_DEPENDENCY_LEDGER_MISSING: fundações sem linha de ledger % — os objectos podem existir, mas a proveniência não; nada foi criado',
      array_to_string(v_faltam, ', ');
  END IF;

  IF v_erradas IS NOT NULL THEN
    RAISE EXCEPTION
      'CRM_EDIT_105_DEPENDENCY_CHECKSUM_DIVERGED: o ledger diz aplicada mas o conteúdo não é o esperado % — nada foi criado',
      array_to_string(v_erradas, ', ');
  END IF;
END;
$dependencias$;

-- ---------------------------------------------------------------------------
-- 0b. Proveniência da própria 105 — efeito presente não é migration aplicada
-- ---------------------------------------------------------------------------
--
-- A 105 tem UM efeito exclusivo: a RPC `edit_crm_quote_draft`. As quatro
-- combinações possíveis de (ledger, efeito) decidem-se aqui, e três delas
-- falham fechado.

DO $proveniencia$
DECLARE
  v_ledger  boolean;
  v_efeitos text[];
  v_total_efeitos CONSTANT integer := 1;
BEGIN
  IF to_regclass('public._migrations') IS NULL THEN
    RAISE EXCEPTION
      'CRM_EDIT_105_LEDGER_AUSENTE: public._migrations não existe — a 105 só corre pelo runner canónico';
  END IF;

  v_ledger := EXISTS (
    SELECT 1 FROM public._migrations WHERE name = '105_crm_orcamento_editar_rascunho.sql'
  );

  SELECT array_agg(efeito.nome ORDER BY efeito.nome) INTO v_efeitos
    FROM (VALUES
      ('RPC edit_crm_quote_draft',
       to_regprocedure('public.edit_crm_quote_draft(uuid, uuid, uuid, uuid, date, date, text, numeric, boolean, numeric, text, text, text, text, jsonb)')::text)
    ) AS efeito(nome, presente)
   WHERE efeito.presente IS NOT NULL;

  IF v_ledger AND v_efeitos IS NULL THEN
    RAISE EXCEPTION
      'CRM_EDIT_105_LEDGER_WITHOUT_EFFECT: há linha de ledger da 105 mas o seu efeito não existe — decida primeiro o que é verdade';
  ELSIF v_ledger AND array_length(v_efeitos, 1) < v_total_efeitos THEN
    RAISE EXCEPTION
      'CRM_EDIT_105_LEDGER_WITH_PARTIAL_EFFECT: a linha diz aplicada, mas só % de % efeitos existem (%) — a 105 ficou a meio',
      array_length(v_efeitos, 1), v_total_efeitos, array_to_string(v_efeitos, ', ');
  ELSIF v_ledger THEN
    RAISE EXCEPTION
      'CRM_EDIT_105_JA_APLICADA: linha de ledger e efeito presentes — reaplicar reescreveria a RPC e a sua ACL';
  ELSIF v_efeitos IS NOT NULL THEN
    RAISE EXCEPTION
      'CRM_EDIT_105_EFFECT_WITHOUT_LEDGER: já existe efeito da 105 sem linha de ledger (%) — estado desconhecido, nada foi alterado',
      array_to_string(v_efeitos, ', ');
  END IF;
END;
$proveniencia$;

-- ---------------------------------------------------------------------------
-- 1. A RPC
-- ---------------------------------------------------------------------------
--
-- 🔴 `CREATE OR REPLACE` e não `CREATE`: o portão acima já provou que a função
--    não existe. Se existisse aqui, algo correu entre os dois blocos — e o
--    `OR REPLACE` é o que mantém o ficheiro reexecutável num palco de ensaio
--    depois de um rollback limpo.

CREATE OR REPLACE FUNCTION public.edit_crm_quote_draft(
  p_company_id         uuid,
  p_quote_id           uuid,
  p_actor              uuid,
  p_visit_id           uuid,
  p_issue_date         date,
  p_valid_until        date,
  p_pricing_kind       text,
  p_discount_pct       numeric,
  p_apply_vat          boolean,
  p_vat_rate           numeric,
  p_proposed_frequency text,
  p_payment_terms      text,
  p_notes              text,
  p_internal_notes     text,
  p_items              jsonb
)
RETURNS TABLE (quote_id uuid, quote_number text, updated_at timestamptz)
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = pg_catalog, public
AS $$
DECLARE
  -- 🔴 O limite da coluna `numeric(10,2)`: oito dígitos inteiros e duas casas.
  MAX_MONTANTE CONSTANT numeric := 99999999.99;
  MAX_ITENS    CONSTANT integer := 100;

  v_quote    public.crm_quotes%ROWTYPE;
  v_item     jsonb;
  v_qty      numeric;
  v_preco    numeric;
  v_unidade  text;
  v_linha    numeric;
  -- 🔴 Sem precisão declarada, de propósito. Um `numeric(10,2)` aqui
  --    rebentaria com `numeric field overflow` ANTES da verificação explícita
  --    lá em baixo, e o utilizador receberia um 22003 cru em vez da sentinela
  --    que diz o que se passa.
  v_subtotal numeric := 0;
  v_base     numeric;
  v_iva      numeric;
  v_total    numeric;
  v_itens    integer;
  v_updated  timestamptz;
BEGIN
  -- ── 1. Lock do cabeçalho ────────────────────────────────────────────────
  --
  -- 🔴 `FOR UPDATE` é o que serializa esta operação contra tudo o resto que
  --    toca no mesmo documento: outra edição, uma mudança de estado, uma
  --    revisão. Quem chegar depois espera, relê a linha JÁ ACTUALIZADA e
  --    revalida. É por isso que uma edição não pode passar por baixo de um
  --    envio concorrente: se o envio ganhar a corrida, esta função acorda a
  --    ver `status = 'enviado'` e recusa.
  --
  --    Ler sem lock e validar depois seria validar um passado.
  SELECT * INTO v_quote
    FROM public.crm_quotes
   WHERE id = p_quote_id AND company_id = p_company_id
   FOR UPDATE;

  IF NOT FOUND THEN
    -- Cobre também o `p_quote_id` NULL e o orçamento de outra empresa: em
    -- ambos os casos não há documento desta empresa com este id, e dizer
    -- «existe mas não é seu» seria confirmar a existência a quem não devia.
    RAISE EXCEPTION 'QUOTE_NOT_FOUND' USING ERRCODE = 'no_data_found';
  END IF;

  -- ── 2. O estado autorizado ──────────────────────────────────────────────
  --
  -- 🔴 O substituído vem primeiro: uma revisão histórica é história, e história
  --    não se edita, seja qual for o estado em que ficou congelada.
  IF v_quote.superseded_by_id IS NOT NULL THEN
    RAISE EXCEPTION 'QUOTE_ALREADY_SUPERSEDED: substituído por %', v_quote.superseded_by_id
      USING ERRCODE = 'check_violation';
  END IF;

  IF v_quote.status <> 'rascunho' THEN
    RAISE EXCEPTION 'QUOTE_NOT_DRAFT: estado %', v_quote.status
      USING ERRCODE = 'check_violation';
  END IF;

  -- 🔴 UNKNOWN_STATE = FAIL_CLOSED. Ver o cabeçalho: um rascunho com data de
  --    envio ou de decisão está num estado que nenhum caminho legítimo produz.
  --    Não se limpa, não se normaliza, não se adivinha.
  IF v_quote.sent_at IS NOT NULL
     OR v_quote.accepted_at IS NOT NULL
     OR v_quote.rejected_at IS NOT NULL
     OR v_quote.rejection_reason IS NOT NULL THEN
    RAISE EXCEPTION
      'QUOTE_DRAFT_STATE_DIVERGED: diz rascunho mas tem sent_at=%, accepted_at=%, rejected_at=%, rejection_reason=%',
      coalesce(v_quote.sent_at::text, 'NULL'),
      coalesce(v_quote.accepted_at::text, 'NULL'),
      coalesce(v_quote.rejected_at::text, 'NULL'),
      coalesce(v_quote.rejection_reason, 'NULL')
      USING ERRCODE = 'check_violation';
  END IF;

  -- ── 3. O actor ──────────────────────────────────────────────────────────
  --
  -- 🔴 O actor não é decorativo nem vem do browser: as Server Actions escrevem
  --    com `service_role`, que é BYPASSRLS. Sem esta verificação, um actor de
  --    outra empresa editaria documentos desta.
  IF p_actor IS NULL OR NOT EXISTS (
    SELECT 1 FROM public.profiles
     WHERE id = p_actor AND company_id = p_company_id
  ) THEN
    RAISE EXCEPTION 'ACTOR_NOT_IN_COMPANY' USING ERRCODE = 'check_violation';
  END IF;

  -- ── 4. A visita ─────────────────────────────────────────────────────────
  --
  -- A visita PODE ser corrigida enquanto o documento é rascunho — trocar a
  -- visita errada é justamente uma das correcções que faltavam. O que não pode
  -- é apontar para a visita de OUTRO destinatário: as áreas e as horas dessa
  -- visita entrariam num preço que não lhes diz respeito.
  --
  -- 🔴 A validação é contra o destinatário ACTUAL do documento, lido sob lock,
  --    e não contra o que o browser diga que ele é.
  IF p_visit_id IS NOT NULL THEN
    PERFORM 1
       FROM public.crm_visits v
      WHERE v.id = p_visit_id
        AND v.company_id = p_company_id
        AND (
          (v_quote.lead_id   IS NOT NULL AND v.lead_id   IS NOT DISTINCT FROM v_quote.lead_id)
       OR (v_quote.client_id IS NOT NULL AND v.client_id IS NOT DISTINCT FROM v_quote.client_id)
        );

    IF NOT FOUND THEN
      RAISE EXCEPTION 'QUOTE_VISIT_MISMATCH: a visita não pertence a este destinatário'
        USING ERRCODE = 'check_violation';
    END IF;
  END IF;

  -- ── 5. As datas ─────────────────────────────────────────────────────────
  --
  -- 🔴 O ano do número não se move. Ver o cabeçalho.
  --
  --    `p_issue_date` a NULL cai aqui de propósito: `extract` devolve NULL,
  --    `IS DISTINCT FROM` é verdadeiro, e a operação recusa. Um documento sem
  --    data de emissão não é um documento.
  IF extract(year FROM p_issue_date)::integer IS DISTINCT FROM v_quote.quote_year::integer THEN
    RAISE EXCEPTION
      'QUOTE_DRAFT_YEAR_IMMUTABLE: o número % é de %, a data pedida é % — para mudar de ano, anule e emita outro',
      v_quote.quote_number, v_quote.quote_year, coalesce(p_issue_date::text, 'NULL')
      USING ERRCODE = 'check_violation';
  END IF;

  -- 🔴 Escrito com os NULL à frente e uma comparação `<`, e não
  --    `NOT (p_valid_until >= p_issue_date)`: com um NULL, essa forma dá NULL,
  --    o `IF` não dispara e a validação passa ao lado em silêncio.
  IF p_valid_until IS NULL OR p_issue_date IS NULL OR p_valid_until < p_issue_date THEN
    RAISE EXCEPTION 'QUOTE_VALIDITY_INVALID: validade % anterior à emissão %',
      coalesce(p_valid_until::text, 'NULL'), coalesce(p_issue_date::text, 'NULL')
      USING ERRCODE = 'check_violation';
  END IF;

  -- ── 6. O cabeçalho de preço ─────────────────────────────────────────────
  --
  -- 🔴 Sem `COALESCE` a valores por omissão. Uma edição é uma SUBSTITUIÇÃO do
  --    documento, e não um patch: aceitar `p_vat_rate` NULL e assumir 0
  --    apagaria o IVA de um orçamento por causa de um campo que o runtime
  --    esqueceu de enviar. Um valor em falta é um erro de quem chama, e
  --    diz-se.
  IF p_pricing_kind IS NULL OR p_pricing_kind NOT IN ('pontual', 'mensal') THEN
    RAISE EXCEPTION 'QUOTE_PRICING_KIND_INVALID: %', coalesce(p_pricing_kind, 'NULL')
      USING ERRCODE = 'check_violation';
  END IF;

  IF p_discount_pct IS NULL OR p_discount_pct < 0 OR p_discount_pct > 100 THEN
    RAISE EXCEPTION 'QUOTE_DISCOUNT_INVALID: %', coalesce(p_discount_pct::text, 'NULL')
      USING ERRCODE = 'check_violation';
  END IF;

  IF p_apply_vat IS NULL THEN
    RAISE EXCEPTION 'QUOTE_APPLY_VAT_REQUIRED' USING ERRCODE = 'check_violation';
  END IF;

  IF p_vat_rate IS NULL OR p_vat_rate < 0 OR p_vat_rate > 100 THEN
    RAISE EXCEPTION 'QUOTE_VAT_RATE_INVALID: %', coalesce(p_vat_rate::text, 'NULL')
      USING ERRCODE = 'check_violation';
  END IF;

  -- ── 7. As linhas ────────────────────────────────────────────────────────
  IF p_items IS NULL OR jsonb_typeof(p_items) IS DISTINCT FROM 'array' OR jsonb_array_length(p_items) = 0 THEN
    RAISE EXCEPTION 'QUOTE_ITEMS_REQUIRED: um orçamento sem linhas é um documento a zero que parece emitido'
      USING ERRCODE = 'check_violation';
  END IF;

  IF jsonb_array_length(p_items) > MAX_ITENS THEN
    RAISE EXCEPTION 'QUOTE_ITEMS_TOO_MANY: % linhas, máximo %',
      jsonb_array_length(p_items), MAX_ITENS
      USING ERRCODE = 'check_violation';
  END IF;

  -- 🔴 O domínio de cada linha é verificado AQUI, e não só pelas restrições da
  --    tabela.
  --
  --    As restrições apanham o mesmo erro, mas devolvem um `check_violation`
  --    com o nome de uma constraint — que não diz a quem está do outro lado do
  --    ecrã qual das linhas está errada nem porquê. E `(i->>'quantity')::numeric`
  --    sobre um texto que não é número rebenta com `invalid_text_representation`,
  --    um 22P02 cru.
  --
  -- 🔴 `jsonb_typeof(...) = 'number'` exige um NÚMERO em JSON, não uma string
  --    que se pareça com um. É um contrato estrito de propósito: aceitar "1,5"
  --    e adivinhar a vírgula decimal é como nascem os preços errados.
  FOR v_item IN SELECT jsonb_array_elements(p_items) LOOP
    IF jsonb_typeof(v_item) IS DISTINCT FROM 'object' THEN
      RAISE EXCEPTION 'QUOTE_ITEM_SHAPE_INVALID: cada linha tem de ser um objecto'
        USING ERRCODE = 'check_violation';
    END IF;

    -- 🔴 `IS DISTINCT FROM`, e não `<>`.
    --
    --    Numa chave AUSENTE, `v_item->'description'` é NULL de SQL e
    --    `jsonb_typeof(NULL)` devolve NULL. `NULL <> 'string'` é NULL, o `IF`
    --    não dispara, e a validação passava ao lado — a linha seguia para o
    --    INSERT e rebentava com «null value in column "description" violates
    --    not-null constraint», um erro cru que não diz qual das linhas está
    --    errada. Falha aberta apanhada por ensaio.
    IF jsonb_typeof(v_item->'description') IS DISTINCT FROM 'string'
       OR length(btrim(v_item->>'description')) = 0 THEN
      RAISE EXCEPTION 'QUOTE_ITEM_DESCRIPTION_REQUIRED' USING ERRCODE = 'check_violation';
    END IF;

    IF jsonb_typeof(v_item->'quantity') IS DISTINCT FROM 'number' THEN
      RAISE EXCEPTION 'QUOTE_ITEM_QUANTITY_INVALID: %',
        coalesce(v_item->>'quantity', 'NULL') USING ERRCODE = 'check_violation';
    END IF;
    v_qty := (v_item->>'quantity')::numeric;

    -- 🔴 `> MAX_MONTANTE` e `round(...) <> v_qty` separam duas coisas
    --    diferentes: o que não cabe na coluna, e o que cabe mas seria
    --    silenciosamente arredondado. Gravar 1,555 como 1,56 sem avisar é
    --    mudar o documento por baixo de quem o escreveu.
    IF v_qty <= 0 OR v_qty > MAX_MONTANTE OR round(v_qty, 2) <> v_qty THEN
      RAISE EXCEPTION 'QUOTE_ITEM_QUANTITY_INVALID: %', v_qty
        USING ERRCODE = 'check_violation';
    END IF;

    IF jsonb_typeof(v_item->'unit_price') IS DISTINCT FROM 'number' THEN
      RAISE EXCEPTION 'QUOTE_ITEM_PRICE_INVALID: %',
        coalesce(v_item->>'unit_price', 'NULL') USING ERRCODE = 'check_violation';
    END IF;
    v_preco := (v_item->>'unit_price')::numeric;

    IF v_preco < 0 OR v_preco > MAX_MONTANTE OR round(v_preco, 2) <> v_preco THEN
      RAISE EXCEPTION 'QUOTE_ITEM_PRICE_INVALID: %', v_preco
        USING ERRCODE = 'check_violation';
    END IF;

    -- A unidade em falta é o default da 103, não um erro.
    v_unidade := coalesce(v_item->>'unit', 'servico');
    IF v_unidade NOT IN ('hora', 'm2', 'unidade', 'mes', 'servico') THEN
      RAISE EXCEPTION 'QUOTE_ITEM_UNIT_INVALID: %', v_unidade
        USING ERRCODE = 'check_violation';
    END IF;

    v_linha := round(v_qty * v_preco, 2);
    IF v_linha > MAX_MONTANTE THEN
      RAISE EXCEPTION 'QUOTE_AMOUNT_OVERFLOW: a linha % × % dá %, acima do máximo %',
        v_qty, v_preco, v_linha, MAX_MONTANTE
        USING ERRCODE = 'check_violation';
    END IF;

    v_subtotal := v_subtotal + v_linha;
  END LOOP;

  -- ── 8. Os totais ────────────────────────────────────────────────────────
  --
  -- A MESMA aritmética de `create_crm_quote_with_items` e `revise_crm_quote`.
  -- Ver o cabeçalho para a razão de estar duplicada.
  v_base := round(v_subtotal * (1 - p_discount_pct / 100), 2);
  v_iva  := CASE WHEN p_apply_vat AND p_vat_rate > 0
                 THEN round(v_base * p_vat_rate / 100, 2)
                 ELSE 0 END;
  v_total := v_base + v_iva;

  -- 🔴 Antes de escrever, e não depois de rebentar. Sem isto, o `UPDATE`
  --    falharia com `numeric field overflow` — que reverte na mesma, mas não
  --    diz nada a quem tem de corrigir o documento.
  IF v_subtotal > MAX_MONTANTE OR v_total > MAX_MONTANTE THEN
    RAISE EXCEPTION 'QUOTE_AMOUNT_OVERFLOW: subtotal % e total % acima do máximo %',
      v_subtotal, v_total, MAX_MONTANTE
      USING ERRCODE = 'check_violation';
  END IF;

  -- ── 9. O cabeçalho ──────────────────────────────────────────────────────
  --
  -- 🔴 A LISTA DE COLUNAS É O MECANISMO DA IMUTABILIDADE.
  --
  --    Não há aqui `quote_number`, `quote_year`, `quote_seq`, `revision`,
  --    `root_quote_id`, `source_lead_id`, `lead_id`, `client_id`, `created_by`
  --    nem `created_at` — e a ausência é a garantia. Acrescentar qualquer uma
  --    delas transformaria esta RPC num caminho para reescrever a identidade
  --    ou o destinatário de um documento. Há ensaios que ficam vermelhos se
  --    isso acontecer.
  --
  --    `status` também não está: uma edição não envia, não aceita e não anula.
  --    `updated_at` é do trigger `crm_quotes_updated_at` da 103 — escrevê-lo
  --    aqui seria ter duas fontes para o mesmo facto.
  UPDATE public.crm_quotes
     SET visit_id           = p_visit_id,
         issue_date         = p_issue_date,
         valid_until        = p_valid_until,
         pricing_kind       = p_pricing_kind,
         subtotal           = v_subtotal,
         discount_pct       = p_discount_pct,
         apply_vat          = p_apply_vat,
         vat_rate           = p_vat_rate,
         vat_amount         = v_iva,
         total              = v_total,
         proposed_frequency = p_proposed_frequency,
         payment_terms      = p_payment_terms,
         notes              = p_notes,
         internal_notes     = p_internal_notes
   WHERE id = p_quote_id
   RETURNING crm_quotes.updated_at INTO v_updated;

  -- ── 10. As linhas, substituídas por inteiro ─────────────────────────────
  --
  -- 🔴 DELETE seguido de INSERT, e não um merge linha a linha.
  --
  --    `uq_crm_quote_items_posicao` é único em (quote_id, position) e NÃO é
  --    deferrable: um merge que reordenasse as linhas colidiria a meio consigo
  --    próprio. Substituir o conjunto inteiro é a única forma que não depende
  --    da ordem em que as posições mudam.
  --
  --    E é seguro precisamente porque estamos dentro de uma transação: entre o
  --    DELETE e o INSERT não existe estado visível a mais ninguém. Se o INSERT
  --    falhar — por um domínio recusado, por overflow, por o que for — o
  --    ROLLBACK devolve as linhas ANTIGAS, intactas. Essa é a prova central
  --    desta unidade, e tem um ensaio dedicado.
  --
  -- 🔴 O alias `it.` também aqui, e pela mesma razão do passo 11: `quote_id` é
  --    parâmetro de SAÍDA desta função. Sem alias, `WHERE quote_id = ...` é uma
  --    referência ambígua — e num DELETE isso apagaria as linhas erradas ou
  --    nenhuma, conforme a resolução.
  DELETE FROM public.crm_quote_items it WHERE it.quote_id = p_quote_id;

  INSERT INTO public.crm_quote_items (
    company_id, quote_id, position, description, quantity, unit, unit_price, line_total
  )
  SELECT
    p_company_id,
    p_quote_id,
    (ordinalidade - 1)::smallint,
    i->>'description',
    (i->>'quantity')::numeric,
    coalesce(i->>'unit', 'servico'),
    (i->>'unit_price')::numeric,
    round((i->>'quantity')::numeric * (i->>'unit_price')::numeric, 2)
  FROM jsonb_array_elements(p_items) WITH ORDINALITY AS t(i, ordinalidade);

  -- ── 11. A prova de que as linhas todas entraram ─────────────────────────
  --
  -- 🔴 O alias `it.` é obrigatório. `quote_id` é ao mesmo tempo coluna de
  --    `crm_quote_items` e parâmetro de SAÍDA desta função, e o plpgsql
  --    resolve a favor do parâmetro: sem o alias isto rebenta com «column
  --    reference "quote_id" is ambiguous». A 094 deixou o aviso escrito, a 103
  --    voltou a apanhá-lo, e aqui vale igual.
  SELECT count(*) INTO v_itens
    FROM public.crm_quote_items it
   WHERE it.quote_id = p_quote_id;

  IF v_itens <> jsonb_array_length(p_items) THEN
    RAISE EXCEPTION 'CRM_QUOTE_ITEMS_MISMATCH: esperadas %, gravadas %',
      jsonb_array_length(p_items), v_itens USING ERRCODE = 'check_violation';
  END IF;

  quote_id := p_quote_id;
  quote_number := v_quote.quote_number;
  updated_at := v_updated;
  RETURN NEXT;
END;
$$;

COMMENT ON FUNCTION public.edit_crm_quote_draft(uuid, uuid, uuid, uuid, date, date, text, numeric, boolean, numeric, text, text, text, text, jsonb) IS
  'Edita IN PLACE um orcamento vivo em rascunho, numa so transacao: cabecalho, '
  'totais recalculados no servidor e substituicao integral das linhas. NAO cria '
  'revisao, NAO atribui numero novo e NAO muda identidade, proveniencia nem '
  'destinatario — quote_number, quote_year, quote_seq, revision, root_quote_id, '
  'source_lead_id, lead_id/client_id, created_by e created_at ficam como estavam. '
  'So rascunho vivo: enviado, aceite, recusado, expirado, anulado ou substituido '
  'sao recusados. Um rascunho com sent_at/accepted_at/rejected_at e '
  'QUOTE_DRAFT_STATE_DIVERGED, nunca reparacao automatica. issue_date tem de '
  'ficar no ano do numero ja atribuido.';

-- ---------------------------------------------------------------------------
-- 2. ACL — canónica desde o primeiro dia
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

REVOKE ALL ON FUNCTION public.edit_crm_quote_draft(uuid, uuid, uuid, uuid, date, date, text, numeric, boolean, numeric, text, text, text, text, jsonb)
  FROM PUBLIC, anon, authenticated, service_role;

GRANT EXECUTE ON FUNCTION public.edit_crm_quote_draft(uuid, uuid, uuid, uuid, date, date, text, numeric, boolean, numeric, text, text, text, text, jsonb)
  TO service_role;

-- ---------------------------------------------------------------------------
-- 3. Pós-estado — o que esta migration promete ter deixado
-- ---------------------------------------------------------------------------
--
-- 🔴 Se alguma destas promessas não se cumprir, a migration FALHA e nada fica
--    aplicado. Uma RPC que nasce SECURITY DEFINER, ou com `anon` a poder
--    executá-la, é pior do que uma RPC que não existe: parece instalada.

DO $poststate$
DECLARE
  v_oid oid;
  v_proconfig text[];
  v_security_definer boolean;
  v_grantees text[];
  v_grantable boolean;
BEGIN
  v_oid := to_regprocedure(
    'public.edit_crm_quote_draft(uuid, uuid, uuid, uuid, date, date, text, numeric, boolean, numeric, text, text, text, text, jsonb)');

  IF v_oid IS NULL THEN
    RAISE EXCEPTION
      'CRM_EDIT_105_POSTSTATE_FAILED: edit_crm_quote_draft ausente ou com outra assinatura';
  END IF;

  SELECT p.proconfig, p.prosecdef INTO v_proconfig, v_security_definer
    FROM pg_proc p WHERE p.oid = v_oid;

  IF v_security_definer THEN
    RAISE EXCEPTION 'CRM_EDIT_105_POSTSTATE_FAILED: a RPC ficou SECURITY DEFINER';
  END IF;

  IF NOT ('search_path=pg_catalog, public' = ANY(coalesce(v_proconfig, '{}'))) THEN
    RAISE EXCEPTION
      'CRM_EDIT_105_POSTSTATE_FAILED: search_path não é exactamente `pg_catalog, public` (%)',
      coalesce(array_to_string(v_proconfig, ', '), 'NULL');
  END IF;

  -- 🔴 O CONJUNTO de grantees, e não a presença de nomes. Um papel a mais com
  --    EXECUTE responde «sim» a «service_role pode?» e continua errado.
  --
  --    O owner é derivado de `proowner`, nunca escrito à mão: em produção pode
  --    não ser o mesmo nome que numa base de ensaio.
  SELECT array_agg(DISTINCT acl.grantee::regrole::text ORDER BY acl.grantee::regrole::text),
         bool_or(acl.is_grantable)
    INTO v_grantees, v_grantable
    FROM pg_proc p,
         LATERAL aclexplode(coalesce(p.proacl, acldefault('f', p.proowner))) AS acl
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
      'CRM_EDIT_105_POSTSTATE_FAILED: grantees de EXECUTE são % — esperado apenas o owner e service_role',
      coalesce(array_to_string(v_grantees, ', '), 'NENHUM');
  END IF;

  IF coalesce(v_grantable, false) THEN
    RAISE EXCEPTION
      'CRM_EDIT_105_POSTSTATE_FAILED: há EXECUTE com WITH GRANT OPTION';
  END IF;
END;
$poststate$;

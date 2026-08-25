-- ============================================================================
-- 078 - Fundação canónica de mutation, change event e sequência por empresa
-- ============================================================================
-- Esta migration NÃO cria um outbox novo. Adota e canonicaliza o esqueleto que
-- já existe em produção, materializado parcialmente pelo incidente de
-- 2026-08-05 e sem consumidores desde então.
--
-- Caracterização read-only da produção, 2026-08-24:
--
--   company_change_events   PRESENTE, 0 linhas
--   domain_mutations        PRESENTE, 0 linhas
--   company_sync_state      AUSENTE
--
-- Criar `outbox_events` ao lado destas daria três tabelas sobrepostas para dois
-- conceitos. Cada conceito passa a ter uma estrutura, e só uma:
--
--   domain_mutations        recibo de idempotência — «esta intenção já foi
--                           processada?»
--   company_change_events   log append-only de mudanças — «algo mudou nesta
--                           empresa, estas áreas precisam de refetch»
--   company_sync_state      sequência monotónica por empresa — «perdi eventos
--                           enquanto estive desligado?»
--
-- São três perguntas diferentes, e `audit_logs` responde a uma quarta («quem
-- fez o quê»). Nenhuma delas se funde com as outras.
--
-- ---------------------------------------------------------------------------
-- O que a materialização órfã tem de diferente do desenho canónico
-- ---------------------------------------------------------------------------
--
--   company_change_events.affected_range  tstzrange   → afetação é data civil
--   company_change_events.delivered_at    timestamptz → não há worker nenhum
--   domain_mutations                      sem operation/request_hash/completed_at
--
-- A última é a mais séria: sem `request_hash` não é possível distinguir um
-- retry legítimo (mesmo comando) de uma reutilização de `mutation_id` com
-- outro payload. É precisamente essa distinção que dá sentido ao recibo.
--
-- ---------------------------------------------------------------------------
-- Porque é seguro transformar, e sob que condições
-- ---------------------------------------------------------------------------
--
-- Ambas as tabelas estão vazias hoje. Isso permite mudar a forma sem migrar
-- uma única linha — mas «estava vazia quando olhámos» não é o mesmo que
-- «estará vazia quando isto correr». Por isso as duas condições são
-- reverificadas **dentro da própria transação**, imediatamente antes de
-- qualquer alteração destrutiva:
--
--   1. fingerprint exato do shape legado conhecido;
--   2. contagem de linhas igual a zero.
--
-- Qualquer desvio levanta exceção e reverte tudo. Não há conversão automática
-- de linhas, não há backfill, e não se tenta «fazer caber» um shape que não se
-- reconhece — um shape inesperado significa que a base não é a que
-- caracterizámos, e nesse caso o correto é parar.
--
-- Numa base nova, onde nada disto existe, as tabelas nascem já canónicas. Os
-- dois caminhos têm de terminar no mesmo sítio, e há um teste que compara os
-- dois fingerprints finais.
--
-- ---------------------------------------------------------------------------
-- O que esta migration deliberadamente NÃO faz
-- ---------------------------------------------------------------------------
--
-- 🔴 Não toca em `delete_client_atomic` nem em `set_invoice_status_atomic`.
--    Existem em produção, com `mutation_id` e `expected_revision`, e sem
--    consumidores no código. A sua existência prova que alguém as escreveu —
--    não prova que continuam compatíveis com as regras, o RLS, o modelo
--    financeiro e o formato de resposta de hoje. Ficam em quarentena:
--    preservadas, não chamadas, não removidas. A decisão é do P0J.
--
-- 🔴 Não altera a pertença a nenhuma publicação Realtime. Não se sabe se
--    `company_change_events` está publicada, e não se sabe que consumidores
--    externos possam existir fora deste repositório. Acrescentar seria abrir
--    uma superfície antes de existir consumidor; remover seria partir algo que
--    não conseguimos ver. O P0K decide, depois de auditar quem lê.
--
-- 🔴 Não cria nenhuma RPC de negócio. A fundação termina onde a infraestrutura
--    fica disponível e provada — a antiga 067 dizia o mesmo, e tinha razão.
--
-- 🔴 Não adiciona estado de entrega (`delivered_at`, tentativas, dead-letter).
--    Não existe worker. Quando existir, terá a sua própria migration.
--
-- Predecessor operacional exigido: 077 (segurança do ledger). Não é uma
-- dependência técnica — a 078 corre sem ela — é a ordem que decidimos.
-- ============================================================================

-- ─── Fingerprint do que a produção tem hoje ────────────────────────────────
--
-- Aceita dois mundos e mais nenhum: a tabela não existe (base nova), ou existe
-- exatamente com o shape que caracterizámos. Qualquer terceira hipótese é
-- LEGACY_SCHEMA_UNEXPECTED.

CREATE OR REPLACE FUNCTION pg_temp.assert_coluna(
  p_tabela text, p_coluna text, p_tipo text, p_nullable boolean
) RETURNS void LANGUAGE plpgsql AS $$
DECLARE
  v_tipo text;
  v_null boolean;
BEGIN
  SELECT data_type, is_nullable = 'YES'
    INTO v_tipo, v_null
  FROM information_schema.columns
  WHERE table_schema = 'public' AND table_name = p_tabela AND column_name = p_coluna;

  IF v_tipo IS NULL THEN
    RAISE EXCEPTION 'LEGACY_SCHEMA_UNEXPECTED: %.% não existe', p_tabela, p_coluna;
  END IF;
  IF v_tipo <> p_tipo THEN
    RAISE EXCEPTION 'LEGACY_SCHEMA_UNEXPECTED: %.% é %, esperado %',
      p_tabela, p_coluna, v_tipo, p_tipo;
  END IF;
  IF v_null <> p_nullable THEN
    RAISE EXCEPTION 'LEGACY_SCHEMA_UNEXPECTED: %.% nullable=%, esperado %',
      p_tabela, p_coluna, v_null, p_nullable;
  END IF;
END
$$;

CREATE OR REPLACE FUNCTION pg_temp.assert_vazia(p_tabela text)
RETURNS void LANGUAGE plpgsql AS $$
DECLARE v_n bigint;
BEGIN
  EXECUTE format('SELECT count(*) FROM public.%I', p_tabela) INTO v_n;
  IF v_n <> 0 THEN
    RAISE EXCEPTION
      'NONEMPTY_LEGACY_TABLE: public.% tem % linha(s). A 078 transforma a forma sem migrar dados e recusa-se a decidir o que fazer a linhas existentes.',
      p_tabela, v_n;
  END IF;
END
$$;

-- ─── 1. company_change_events ──────────────────────────────────────────────

DO $$
BEGIN
  IF to_regclass('public.company_change_events') IS NULL THEN
    -- Base nova: nasce canónica.
    CREATE TABLE public.company_change_events (
      id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      company_id    uuid NOT NULL REFERENCES public.companies(id) ON DELETE CASCADE,
      sequence      bigint NOT NULL,
      mutation_id   uuid NOT NULL,
      domain        text NOT NULL,
      event_type    text NOT NULL,
      entity_ids    uuid[] NOT NULL DEFAULT '{}',
      scopes        text[] NOT NULL DEFAULT '{}',
      affected_from date,
      affected_to   date,
      payload       jsonb NOT NULL DEFAULT '{}'::jsonb,
      created_at    timestamptz NOT NULL DEFAULT now()
    );
  ELSE
    -- Produção: confirmar que é o esqueleto que caracterizámos, e só depois
    -- mexer. A ordem importa — fingerprint e contagem antes de qualquer DROP.
    PERFORM pg_temp.assert_coluna('company_change_events', 'id',             'uuid', false);
    PERFORM pg_temp.assert_coluna('company_change_events', 'company_id',     'uuid', false);
    PERFORM pg_temp.assert_coluna('company_change_events', 'sequence',       'bigint', false);
    PERFORM pg_temp.assert_coluna('company_change_events', 'mutation_id',    'uuid', false);
    PERFORM pg_temp.assert_coluna('company_change_events', 'domain',         'text', false);
    PERFORM pg_temp.assert_coluna('company_change_events', 'event_type',     'text', false);
    PERFORM pg_temp.assert_coluna('company_change_events', 'entity_ids',     'ARRAY', false);
    PERFORM pg_temp.assert_coluna('company_change_events', 'scopes',         'ARRAY', false);
    PERFORM pg_temp.assert_coluna('company_change_events', 'affected_range', 'tstzrange', true);
    PERFORM pg_temp.assert_coluna('company_change_events', 'payload',        'jsonb', false);
    PERFORM pg_temp.assert_coluna('company_change_events', 'delivered_at',   'timestamp with time zone', true);
    PERFORM pg_temp.assert_coluna('company_change_events', 'created_at',     'timestamp with time zone', false);

    PERFORM pg_temp.assert_vazia('company_change_events');

    -- A afetação de um evento é um intervalo de datas civis (Europe/Lisbon),
    -- não um intervalo de instantes. A mesma classe de erro que já se corrigiu
    -- no ponto e nas faltas.
    ALTER TABLE public.company_change_events DROP COLUMN affected_range;
    ALTER TABLE public.company_change_events ADD COLUMN affected_from date;
    ALTER TABLE public.company_change_events ADD COLUMN affected_to date;

    -- Estado de entrega sem entregador. Quando houver worker, terá a sua
    -- própria migration e o seu próprio desenho.
    ALTER TABLE public.company_change_events DROP COLUMN delivered_at;

    ALTER TABLE public.company_change_events ALTER COLUMN entity_ids SET DEFAULT '{}';
    ALTER TABLE public.company_change_events ALTER COLUMN scopes     SET DEFAULT '{}';
    ALTER TABLE public.company_change_events ALTER COLUMN payload    SET DEFAULT '{}'::jsonb;
    ALTER TABLE public.company_change_events ALTER COLUMN created_at SET DEFAULT now();
  END IF;
END
$$;

-- Uma mutation de negócio produz UM evento-resumo. Se tocar em contratos,
-- serviços e calendário, isso descreve-se em `scopes` — não em três eventos.
-- É o que torna a idempotência e a ordenação tratáveis.
ALTER TABLE public.company_change_events
  DROP CONSTRAINT IF EXISTS company_change_events_company_sequence_key;
ALTER TABLE public.company_change_events
  ADD CONSTRAINT company_change_events_company_sequence_key UNIQUE (company_id, sequence);

ALTER TABLE public.company_change_events
  DROP CONSTRAINT IF EXISTS company_change_events_company_mutation_key;
ALTER TABLE public.company_change_events
  ADD CONSTRAINT company_change_events_company_mutation_key UNIQUE (company_id, mutation_id);

-- Ou não há intervalo, ou há um intervalo coerente. «Só o início preenchido»
-- é um estado que nenhum consumidor saberia interpretar.
ALTER TABLE public.company_change_events
  DROP CONSTRAINT IF EXISTS company_change_events_affected_range_check;
ALTER TABLE public.company_change_events
  ADD CONSTRAINT company_change_events_affected_range_check CHECK (
    (affected_from IS NULL AND affected_to IS NULL)
    OR (affected_from IS NOT NULL AND affected_to IS NOT NULL AND affected_from <= affected_to)
  );

CREATE INDEX IF NOT EXISTS idx_company_change_events_company_sequence
  ON public.company_change_events (company_id, sequence);

-- ─── 2. domain_mutations ───────────────────────────────────────────────────

DO $$
BEGIN
  IF to_regclass('public.domain_mutations') IS NULL THEN
    CREATE TABLE public.domain_mutations (
      id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      company_id   uuid NOT NULL REFERENCES public.companies(id) ON DELETE CASCADE,
      mutation_id  uuid NOT NULL,
      domain       text NOT NULL,
      operation    text NOT NULL,
      entity_id    uuid,
      request_hash text NOT NULL,
      status       text NOT NULL,
      result       jsonb NOT NULL DEFAULT '{}'::jsonb,
      completed_at timestamptz NOT NULL DEFAULT now(),
      created_at   timestamptz NOT NULL DEFAULT now()
    );
  ELSE
    PERFORM pg_temp.assert_coluna('domain_mutations', 'id',          'uuid', false);
    PERFORM pg_temp.assert_coluna('domain_mutations', 'company_id',  'uuid', false);
    PERFORM pg_temp.assert_coluna('domain_mutations', 'mutation_id', 'uuid', false);
    PERFORM pg_temp.assert_coluna('domain_mutations', 'domain',      'text', false);
    PERFORM pg_temp.assert_coluna('domain_mutations', 'status',      'text', false);
    PERFORM pg_temp.assert_coluna('domain_mutations', 'result',      'jsonb', false);
    PERFORM pg_temp.assert_coluna('domain_mutations', 'created_at',  'timestamp with time zone', false);

    -- As três que faltam têm de faltar mesmo. Se já existirem, alguém alterou
    -- esta tabela por outro caminho e a 078 não sabe o que assumir.
    IF EXISTS (
      SELECT 1 FROM information_schema.columns
      WHERE table_schema = 'public' AND table_name = 'domain_mutations'
        AND column_name IN ('operation', 'request_hash', 'completed_at')
    ) THEN
      RAISE EXCEPTION
        'LEGACY_SCHEMA_UNEXPECTED: domain_mutations já tem operation/request_hash/completed_at — não é o esqueleto caracterizado.';
    END IF;

    PERFORM pg_temp.assert_vazia('domain_mutations');

    -- NOT NULL sem default numa tabela vazia é seguro; numa tabela com linhas
    -- seria impossível, e é por isso que a contagem vem antes.
    ALTER TABLE public.domain_mutations ADD COLUMN operation    text NOT NULL;
    ALTER TABLE public.domain_mutations ADD COLUMN entity_id    uuid;
    ALTER TABLE public.domain_mutations ADD COLUMN request_hash text NOT NULL;
    ALTER TABLE public.domain_mutations ADD COLUMN completed_at timestamptz NOT NULL DEFAULT now();

    ALTER TABLE public.domain_mutations ALTER COLUMN result     SET DEFAULT '{}'::jsonb;
    ALTER TABLE public.domain_mutations ALTER COLUMN created_at SET DEFAULT now();
  END IF;
END
$$;

-- Sem isto, dois retries concorrentes criam dois recibos para a mesma
-- intenção — e o segundo pedido deixaria de ser um replay.
ALTER TABLE public.domain_mutations
  DROP CONSTRAINT IF EXISTS domain_mutations_company_mutation_key;
ALTER TABLE public.domain_mutations
  ADD CONSTRAINT domain_mutations_company_mutation_key UNIQUE (company_id, mutation_id);

-- Uma falha técnica reverte a transação e não deixa recibo — o retry deve
-- poder tentar de novo. Por isso não há `processing`, `failed` nem
-- `dead_letter`: não existe estado intermédio para guardar.
ALTER TABLE public.domain_mutations
  DROP CONSTRAINT IF EXISTS domain_mutations_status_check;
ALTER TABLE public.domain_mutations
  ADD CONSTRAINT domain_mutations_status_check CHECK (status IN ('succeeded', 'rejected'));

ALTER TABLE public.domain_mutations
  DROP CONSTRAINT IF EXISTS domain_mutations_operation_check;
ALTER TABLE public.domain_mutations
  ADD CONSTRAINT domain_mutations_operation_check CHECK (operation ~ '^[a-z][a-z0-9_]*$');

-- ─── 3. company_sync_state ─────────────────────────────────────────────────
--
-- O reconciliador de Realtime atual sabe lidar com duplicados e ordem enquanto
-- a sessão está viva, mas a sua memória morre com a sessão. Uma sequência
-- durável por empresa é o que permite, ao reconectar, responder à única
-- pergunta que hoje não tem resposta: «perdi alguma coisa enquanto estive
-- fora?». Último visto 120, atual 124 → houve lacuna → refetch autoritativo.

CREATE TABLE IF NOT EXISTS public.company_sync_state (
  company_id uuid PRIMARY KEY REFERENCES public.companies(id) ON DELETE CASCADE,
  sequence   bigint NOT NULL DEFAULT 0,
  updated_at timestamptz NOT NULL DEFAULT now()
);

-- ─── 4. Funções internas ───────────────────────────────────────────────────
--
-- 🔴 A assinatura legada de `record_company_change_event` em produção não tem
--    parâmetros de intervalo, e a do ficheiro 067 tem — ou seja, o que está na
--    base não corresponde ao ficheiro que julgávamos ser a origem. Como a
--    ordem posicional real dos argumentos não é conhecida com certeza,
--    `DROP FUNCTION` com uma lista de tipos escrita à mão seria um palpite.
--
--    Este bloco apaga **todas** as assinaturas do nome, seja qual for a forma,
--    usando `regprocedure` derivado do catálogo. `CREATE OR REPLACE` com uma
--    lista de argumentos diferente criaria uma sobrecarga, não uma
--    substituição — e duas funções com o mesmo nome tornam cada chamada
--    ambígua.

DO $$
DECLARE r record;
BEGIN
  FOR r IN
    SELECT p.oid::regprocedure AS assinatura
    FROM pg_proc p
    JOIN pg_namespace n ON n.oid = p.pronamespace
    WHERE n.nspname = 'public'
      AND p.proname IN (
        'record_company_change_event',
        'next_company_sequence',
        'lock_domain_mutation',
        'find_or_conflict_domain_mutation',
        'complete_domain_mutation'
      )
  LOOP
    EXECUTE format('DROP FUNCTION %s', r.assinatura);
  END LOOP;
END
$$;

-- Sequência monotónica por empresa. Empresas diferentes não se bloqueiam
-- entre si; a mesma empresa serializa no `FOR UPDATE`.
CREATE FUNCTION public.next_company_sequence(p_company_id uuid)
RETURNS bigint
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE v_seq bigint;
BEGIN
  INSERT INTO public.company_sync_state (company_id)
  VALUES (p_company_id)
  ON CONFLICT (company_id) DO NOTHING;

  SELECT sequence INTO v_seq
  FROM public.company_sync_state
  WHERE company_id = p_company_id
  FOR UPDATE;

  v_seq := v_seq + 1;

  UPDATE public.company_sync_state
  SET sequence = v_seq, updated_at = now()
  WHERE company_id = p_company_id;

  RETURN v_seq;
END
$$;

-- Serializa pedidos concorrentes com a mesma intenção. Uma colisão de hash faz
-- dois pares diferentes esperarem um pelo outro — custa latência, nunca
-- mistura dados, porque a decisão real é sempre tomada a seguir por
-- `find_or_conflict_domain_mutation` sobre a chave verdadeira.
CREATE FUNCTION public.lock_domain_mutation(p_company_id uuid, p_mutation_id uuid)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
BEGIN
  PERFORM pg_advisory_xact_lock(hashtext(p_company_id::text), hashtext(p_mutation_id::text));
END
$$;

-- Três respostas possíveis, e nenhuma delas é um erro de SQL cru:
--   NULL                        → nunca visto, prossegue
--   {ok:true, replay:true, …}   → mesmo comando, devolve o resultado guardado
--   {ok:false, MUTATION_REUSE_CONFLICT} → mesmo id, outro comando
CREATE FUNCTION public.find_or_conflict_domain_mutation(
  p_company_id   uuid,
  p_mutation_id  uuid,
  p_operation    text,
  p_request_hash text
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE r public.domain_mutations%ROWTYPE;
BEGIN
  SELECT * INTO r
  FROM public.domain_mutations
  WHERE company_id = p_company_id AND mutation_id = p_mutation_id;

  IF NOT FOUND THEN
    RETURN NULL;
  END IF;

  IF r.operation IS DISTINCT FROM p_operation
     OR r.request_hash IS DISTINCT FROM p_request_hash THEN
    RETURN jsonb_build_object(
      'ok', false,
      'code', 'MUTATION_REUSE_CONFLICT',
      'stored_operation', r.operation
    );
  END IF;

  RETURN jsonb_build_object(
    'ok', true,
    'replay', true,
    'status', r.status,
    'result', r.result,
    'entity_id', r.entity_id
  );
END
$$;

-- Insert-only, e de propósito. Um `ON CONFLICT DO UPDATE` transformaria um
-- retry em reescrita do recibo — que é exatamente o que o recibo existe para
-- impedir. Quem não fez `lock` + `find` antes bate na constraint única.
CREATE FUNCTION public.complete_domain_mutation(
  p_company_id   uuid,
  p_mutation_id  uuid,
  p_domain       text,
  p_operation    text,
  p_request_hash text,
  p_status       text,
  p_result       jsonb DEFAULT '{}'::jsonb,
  p_entity_id    uuid DEFAULT NULL
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE r public.domain_mutations%ROWTYPE;
BEGIN
  IF p_request_hash IS NULL OR p_request_hash = '' THEN
    RAISE EXCEPTION 'REQUEST_HASH_REQUIRED: sem hash não há como distinguir retry de reutilização.';
  END IF;

  INSERT INTO public.domain_mutations (
    company_id, mutation_id, domain, operation, entity_id,
    request_hash, status, result
  )
  VALUES (
    p_company_id, p_mutation_id, p_domain, p_operation, p_entity_id,
    p_request_hash, p_status, COALESCE(p_result, '{}'::jsonb)
  )
  RETURNING * INTO r;

  RETURN jsonb_build_object('ok', true, 'mutation_id', r.mutation_id, 'status', r.status);
END
$$;

-- Append-only. Um replay devolve o evento que já existe — nunca o reescreve,
-- mesmo que quem chama envie outro payload. A deteção de payload divergente
-- pertence a `domain_mutations`, que corre antes; aqui a idempotência é
-- apenas por `mutation_id`.
CREATE FUNCTION public.record_company_change_event(
  p_company_id    uuid,
  p_mutation_id   uuid,
  p_domain        text,
  p_event_type    text,
  p_entity_ids    uuid[] DEFAULT '{}',
  p_scopes        text[] DEFAULT '{}',
  p_affected_from date DEFAULT NULL,
  p_affected_to   date DEFAULT NULL,
  p_payload       jsonb DEFAULT '{}'::jsonb
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_existente public.company_change_events%ROWTYPE;
  v_seq bigint;
  v_novo public.company_change_events%ROWTYPE;
BEGIN
  SELECT * INTO v_existente
  FROM public.company_change_events
  WHERE company_id = p_company_id AND mutation_id = p_mutation_id;

  IF FOUND THEN
    RETURN jsonb_build_object(
      'ok', true, 'replay', true,
      'sequence', v_existente.sequence, 'event_id', v_existente.id
    );
  END IF;

  v_seq := public.next_company_sequence(p_company_id);

  INSERT INTO public.company_change_events (
    company_id, sequence, mutation_id, domain, event_type,
    entity_ids, scopes, affected_from, affected_to, payload
  )
  VALUES (
    p_company_id, v_seq, p_mutation_id, p_domain, p_event_type,
    COALESCE(p_entity_ids, '{}'), COALESCE(p_scopes, '{}'),
    p_affected_from, p_affected_to, COALESCE(p_payload, '{}'::jsonb)
  )
  RETURNING * INTO v_novo;

  RETURN jsonb_build_object(
    'ok', true, 'replay', false,
    'sequence', v_novo.sequence, 'event_id', v_novo.id
  );
END
$$;

-- ─── 5. Segurança ──────────────────────────────────────────────────────────
--
-- Nenhuma destas três tabelas tem consumidor no browser hoje. Abrir leitura
-- antes de existir consumidor é criar superfície para ninguém — e o P0K
-- decidirá, com os consumidores à frente, quem precisa de ver o quê.

ALTER TABLE public.company_change_events ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.domain_mutations      ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.company_sync_state    ENABLE ROW LEVEL SECURITY;

REVOKE ALL ON TABLE public.company_change_events FROM PUBLIC;
REVOKE ALL ON TABLE public.domain_mutations      FROM PUBLIC;
REVOKE ALL ON TABLE public.company_sync_state    FROM PUBLIC;

DO $$
DECLARE
  t text;
  f text;
BEGIN
  FOREACH t IN ARRAY ARRAY['company_change_events', 'domain_mutations', 'company_sync_state'] LOOP
    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'anon') THEN
      EXECUTE format('REVOKE ALL ON TABLE public.%I FROM anon', t);
    END IF;
    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'authenticated') THEN
      EXECUTE format('REVOKE ALL ON TABLE public.%I FROM authenticated', t);
    END IF;
  END LOOP;

  -- Helpers internos não são API pública. Uma RPC de negócio futura chama-os
  -- de dentro da sua própria transação; o browser nunca lhes toca.
  FOREACH f IN ARRAY ARRAY[
    'next_company_sequence(uuid)',
    'lock_domain_mutation(uuid,uuid)',
    'find_or_conflict_domain_mutation(uuid,uuid,text,text)',
    'complete_domain_mutation(uuid,uuid,text,text,text,text,jsonb,uuid)',
    'record_company_change_event(uuid,uuid,text,text,uuid[],text[],date,date,jsonb)'
  ] LOOP
    EXECUTE format('REVOKE ALL ON FUNCTION public.%s FROM PUBLIC', f);
    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'anon') THEN
      EXECUTE format('REVOKE ALL ON FUNCTION public.%s FROM anon', f);
    END IF;
    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'authenticated') THEN
      EXECUTE format('REVOKE ALL ON FUNCTION public.%s FROM authenticated', f);
    END IF;
  END LOOP;
END
$$;

COMMENT ON TABLE public.domain_mutations IS
  'Recibo de idempotência por (company_id, mutation_id). Responde a "esta intenção já foi processada?". Não é log de auditoria nem sinal de mudança.';
COMMENT ON TABLE public.company_change_events IS
  'Log append-only de mudanças por empresa, com sequência monotónica. Sinal de refetch — nunca a fonte do estado de negócio.';
COMMENT ON TABLE public.company_sync_state IS
  'Sequência monotónica por empresa. Permite detetar lacunas depois de uma desconexão e disparar refetch autoritativo.';

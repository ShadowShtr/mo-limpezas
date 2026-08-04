-- ============================================================================
-- 067 - Fundacao do outbox: sequencia atomica por empresa,
--        domain_mutations idempotente, company_change_events imutavel
-- ============================================================================
-- Escopo desta migration: SO a fundacao do outbox e as permissoes
-- relacionadas. Nao toca em nenhuma RPC de negocio (set_invoice_status_atomic,
-- archive_client_atomic, delete_empty_client_atomic, delete_client_atomic)
-- nem em contratos/servicos - fica para uma fase separada, so depois de esta
-- fundacao estar provada e aplicada.
--
-- domain_mutations e company_change_events foram reconfirmadas vazias nesta
-- mesma sessao (T03) - por isso as transformacoes abaixo nao precisam de
-- backfill, mas cada uma comeca por um guarda explicito que aborta a
-- migration inteira (ROLLBACK automatico da transacao do runner) se alguma
-- linha aparecer entretanto.

CREATE EXTENSION IF NOT EXISTS pgcrypto;

-- ============================================================================
-- 1. company_sync_state - sequencia por empresa
-- ============================================================================

CREATE TABLE IF NOT EXISTS public.company_sync_state (
  company_id uuid PRIMARY KEY REFERENCES public.companies(id) ON DELETE CASCADE,
  sequence bigint NOT NULL DEFAULT 0,
  updated_at timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE public.company_sync_state ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "company sync state locked" ON public.company_sync_state;
CREATE POLICY "company sync state locked" ON public.company_sync_state
  FOR ALL USING (false) WITH CHECK (false);

REVOKE ALL ON public.company_sync_state FROM PUBLIC, anon, authenticated;

-- Atomica e segura sob concorrencia: SELECT ... FOR UPDATE bloqueia a LINHA
-- desta empresa ate ao fim da transacao chamadora. Uma segunda transacao a
-- pedir sequencia para a MESMA empresa espera (nao falha, nao gera
-- duplicado); empresas diferentes nunca se bloqueiam entre si (linhas
-- diferentes). SECURITY DEFINER + REVOKE de anon/authenticated: so pode ser
-- chamada de dentro de outra funcao SECURITY DEFINER ou pela service role.
CREATE OR REPLACE FUNCTION public.next_company_sequence(p_company_id uuid)
RETURNS bigint
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_sequence bigint;
BEGIN
  INSERT INTO public.company_sync_state(company_id, sequence, updated_at)
  VALUES (p_company_id, 0, now())
  ON CONFLICT (company_id) DO NOTHING;

  SELECT sequence INTO v_sequence
  FROM public.company_sync_state
  WHERE company_id = p_company_id
  FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'COMPANY_SYNC_STATE_NOT_FOUND' USING ERRCODE = 'P0001';
  END IF;

  v_sequence := v_sequence + 1;

  UPDATE public.company_sync_state
     SET sequence = v_sequence, updated_at = now()
   WHERE company_id = p_company_id;

  RETURN v_sequence;
END;
$$;

REVOKE ALL ON FUNCTION public.next_company_sequence(uuid) FROM PUBLIC, anon, authenticated;

-- ============================================================================
-- 2. domain_mutations - idempotencia por (company_id, mutation_id) +
--    deteccao de reutilizacao por request_hash
-- ============================================================================

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM public.domain_mutations LIMIT 1) THEN
    RAISE EXCEPTION 'DOMAIN_MUTATIONS_NOT_EMPTY_MANUAL_BACKFILL_REQUIRED' USING ERRCODE = 'P0001';
  END IF;
END;
$$;

ALTER TABLE public.domain_mutations ADD COLUMN IF NOT EXISTS operation text;
ALTER TABLE public.domain_mutations ADD COLUMN IF NOT EXISTS entity_id uuid;
ALTER TABLE public.domain_mutations ADD COLUMN IF NOT EXISTS request_hash text;
ALTER TABLE public.domain_mutations ADD COLUMN IF NOT EXISTS completed_at timestamptz;

ALTER TABLE public.domain_mutations ALTER COLUMN operation SET NOT NULL;
ALTER TABLE public.domain_mutations ALTER COLUMN request_hash SET NOT NULL;
ALTER TABLE public.domain_mutations ALTER COLUMN completed_at SET NOT NULL;
ALTER TABLE public.domain_mutations ALTER COLUMN completed_at SET DEFAULT now();

ALTER TABLE public.domain_mutations DROP CONSTRAINT IF EXISTS domain_mutations_status_check;
ALTER TABLE public.domain_mutations ALTER COLUMN status SET DEFAULT 'succeeded';
ALTER TABLE public.domain_mutations ADD CONSTRAINT domain_mutations_status_check
  CHECK (status IN ('succeeded', 'rejected'));

-- "operation" tem de ser um identificador (snake_case), nao texto livre.
-- Nao usamos um enum fechado com nomes de operacoes de negocio porque
-- NENHUMA RPC de negocio escreve aqui ainda nesta fase - inventar nomes
-- agora seria especulativo. Cada RPC de negocio futura que passe a usar
-- domain_mutations traz a sua propria migration a estender isto, se um
-- dia se justificar apertar para um enum fechado.
ALTER TABLE public.domain_mutations DROP CONSTRAINT IF EXISTS domain_mutations_operation_format_check;
ALTER TABLE public.domain_mutations ADD CONSTRAINT domain_mutations_operation_format_check
  CHECK (operation ~ '^[a-z][a-z0-9_]*$');

REVOKE ALL ON public.domain_mutations FROM PUBLIC, anon, authenticated;

-- Lock por (company_id, mutation_id): serializa chamadas concorrentes com o
-- MESMO mutation_id (replay em corrida, duplo clique, retry de rede) sem
-- bloquear chamadas de mutation_id diferentes.
CREATE OR REPLACE FUNCTION public.lock_domain_mutation(
  p_company_id uuid,
  p_mutation_id uuid
)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
BEGIN
  PERFORM pg_advisory_xact_lock(
    hashtext(p_company_id::text),
    hashtext(p_mutation_id::text)
  );
END;
$$;

REVOKE ALL ON FUNCTION public.lock_domain_mutation(uuid, uuid) FROM PUBLIC, anon, authenticated;

-- Devolve o recibo existente se (company_id, mutation_id) ja foi concluido
-- com o MESMO operation+request_hash (replay idempotente); devolve um
-- conflito estruturado se o mutation_id foi reutilizado com payload
-- diferente; devolve NULL se e mesmo a primeira vez (o chamador segue em
-- frente e grava com complete_domain_mutation).
CREATE OR REPLACE FUNCTION public.find_or_conflict_domain_mutation(
  p_company_id uuid,
  p_mutation_id uuid,
  p_operation text,
  p_request_hash text
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_existing public.domain_mutations;
BEGIN
  SELECT * INTO v_existing
  FROM public.domain_mutations
  WHERE company_id = p_company_id AND mutation_id = p_mutation_id;

  IF NOT FOUND THEN
    RETURN NULL;
  END IF;

  IF v_existing.operation = p_operation AND v_existing.request_hash = p_request_hash THEN
    RETURN v_existing.result;
  END IF;

  RETURN jsonb_build_object('ok', false, 'code', 'MUTATION_REUSE_CONFLICT');
END;
$$;

REVOKE ALL ON FUNCTION public.find_or_conflict_domain_mutation(uuid, uuid, text, text) FROM PUBLIC, anon, authenticated;

CREATE OR REPLACE FUNCTION public.complete_domain_mutation(
  p_company_id uuid,
  p_mutation_id uuid,
  p_domain text,
  p_operation text,
  p_entity_id uuid,
  p_request_hash text,
  p_status text,
  p_result jsonb
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
BEGIN
  IF p_status NOT IN ('succeeded', 'rejected') THEN
    RAISE EXCEPTION 'INVALID_DOMAIN_MUTATION_STATUS status=%', p_status USING ERRCODE = 'P0001';
  END IF;

  INSERT INTO public.domain_mutations(
    company_id, mutation_id, domain, status, operation, entity_id, request_hash, result, completed_at
  )
  VALUES (
    p_company_id, p_mutation_id, p_domain, p_status, p_operation, p_entity_id, p_request_hash, p_result, now()
  );

  RETURN p_result;
END;
$$;

REVOKE ALL ON FUNCTION public.complete_domain_mutation(uuid, uuid, text, text, uuid, text, text, jsonb) FROM PUBLIC, anon, authenticated;

-- ============================================================================
-- 3. company_change_events - sequencia por empresa (nao IDENTITY global),
--    datas em vez de tstzrange, sem delivered_at
-- ============================================================================

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM public.company_change_events LIMIT 1) THEN
    RAISE EXCEPTION 'COMPANY_CHANGE_EVENTS_NOT_EMPTY_MANUAL_BACKFILL_REQUIRED' USING ERRCODE = 'P0001';
  END IF;
END;
$$;

ALTER TABLE public.company_change_events ADD COLUMN IF NOT EXISTS affected_from date;
ALTER TABLE public.company_change_events ADD COLUMN IF NOT EXISTS affected_to date;

ALTER TABLE public.company_change_events DROP CONSTRAINT IF EXISTS company_change_events_company_id_mutation_id_domain_event_t_key;
ALTER TABLE public.company_change_events DROP CONSTRAINT IF EXISTS company_change_events_company_id_sequence_key;

ALTER TABLE public.company_change_events ALTER COLUMN sequence DROP IDENTITY IF EXISTS;
ALTER TABLE public.company_change_events ALTER COLUMN sequence DROP DEFAULT;

ALTER TABLE public.company_change_events DROP COLUMN IF EXISTS delivered_at;
ALTER TABLE public.company_change_events DROP COLUMN IF EXISTS affected_range;

ALTER TABLE public.company_change_events ADD CONSTRAINT company_change_events_company_id_sequence_key
  UNIQUE (company_id, sequence);

ALTER TABLE public.company_change_events ADD CONSTRAINT company_change_events_company_id_mutation_id_key
  UNIQUE (company_id, mutation_id);

-- affected_from/affected_to coerentes: os dois nulos, ou os dois presentes
-- com from <= to. Nunca um intervalo invertido nem um lado orfao.
ALTER TABLE public.company_change_events DROP CONSTRAINT IF EXISTS company_change_events_affected_range_check;
ALTER TABLE public.company_change_events ADD CONSTRAINT company_change_events_affected_range_check
  CHECK (
    (affected_from IS NULL AND affected_to IS NULL)
    OR (affected_from IS NOT NULL AND affected_to IS NOT NULL AND affected_from <= affected_to)
  );

CREATE INDEX IF NOT EXISTS idx_company_change_events_company_created
  ON public.company_change_events(company_id, created_at DESC);

-- Grants: so authenticated le (via RLS existente, ver policy "managers see
-- company change events" - nao alterada por esta migration), nunca
-- INSERT/UPDATE/DELETE/TRUNCATE pelo navegador. anon sem nenhum privilegio.
REVOKE ALL ON public.company_change_events FROM PUBLIC, anon, authenticated;
GRANT SELECT ON public.company_change_events TO authenticated;

-- ============================================================================
-- 4. record_company_change_event - append-only, nunca atualiza evento
--    existente (era ON CONFLICT DO UPDATE; passa a devolver o evento
--    existente tal como esta, sem tocar em nenhum campo)
-- ============================================================================

DROP FUNCTION IF EXISTS public.record_company_change_event(uuid, uuid, text, text, uuid[], text[], tstzrange, jsonb);

CREATE OR REPLACE FUNCTION public.record_company_change_event(
  p_company_id uuid,
  p_mutation_id uuid,
  p_domain text,
  p_event_type text,
  p_entity_ids uuid[],
  p_scopes text[],
  p_affected_from date DEFAULT NULL,
  p_affected_to date DEFAULT NULL,
  p_payload jsonb DEFAULT '{}'::jsonb
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_event public.company_change_events;
  v_sequence bigint;
BEGIN
  -- Sem isto, duas chamadas concorrentes com o MESMO mutation_id podem
  -- ambas passar pelo SELECT sem encontrar nada, ambas tentar INSERT, e a
  -- segunda falhar com violacao de unicidade em vez de devolver o evento
  -- idempotente da primeira. O advisory lock por (company_id, mutation_id)
  -- serializa as duas chamadas: a segunda so continua depois da primeira
  -- terminar (commit ou rollback), e nessa altura o SELECT abaixo encontra
  -- o evento ja gravado pela primeira.
  PERFORM public.lock_domain_mutation(p_company_id, p_mutation_id);

  SELECT * INTO v_event
  FROM public.company_change_events
  WHERE company_id = p_company_id AND mutation_id = p_mutation_id;

  IF FOUND THEN
    -- Replay idempotente: devolve o evento tal como foi gravado da
    -- primeira vez. Nunca atualiza payload nem nenhum outro campo.
    RETURN to_jsonb(v_event);
  END IF;

  v_sequence := public.next_company_sequence(p_company_id);

  INSERT INTO public.company_change_events (
    company_id, sequence, mutation_id, domain, event_type,
    entity_ids, scopes, affected_from, affected_to, payload
  )
  VALUES (
    p_company_id, v_sequence, p_mutation_id, p_domain, p_event_type,
    COALESCE(p_entity_ids, '{}'), COALESCE(p_scopes, '{}'),
    p_affected_from, p_affected_to, COALESCE(p_payload, '{}'::jsonb)
  )
  RETURNING * INTO v_event;

  RETURN to_jsonb(v_event);
END;
$$;

REVOKE ALL ON FUNCTION public.record_company_change_event(uuid, uuid, text, text, uuid[], text[], date, date, jsonb) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.record_company_change_event(uuid, uuid, text, text, uuid[], text[], date, date, jsonb) TO service_role;

-- ============================================================================
-- 5. Publicacao Realtime - so depois de RLS/grants de company_change_events
--    estarem corrigidos (secao 3, acima nesta mesma transacao)
-- ============================================================================

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_publication WHERE pubname = 'supabase_realtime')
     AND NOT EXISTS (
      SELECT 1
        FROM pg_publication_tables
       WHERE pubname = 'supabase_realtime'
         AND schemaname = 'public'
         AND tablename = 'company_change_events'
    )
  THEN
    ALTER PUBLICATION supabase_realtime ADD TABLE public.company_change_events;
  END IF;
END;
$$;

-- Verificacao esperada apos aplicar:
-- SELECT table_name, grantee, privilege_type FROM information_schema.role_table_grants
--  WHERE table_schema='public' AND table_name IN ('company_sync_state','domain_mutations','company_change_events')
--    AND grantee IN ('anon','authenticated') ORDER BY 1,2,3;
-- (esperado: so 1 linha - company_change_events/authenticated/SELECT)

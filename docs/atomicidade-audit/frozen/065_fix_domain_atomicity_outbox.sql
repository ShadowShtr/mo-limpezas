-- ============================================================================
-- 065 - Corrige atomicidade de dominio, recibos idempotentes e outbox
-- ============================================================================
-- Migration corretiva para o estado parcial produzido/refletido pela 064.
-- Nao depende de as tabelas estarem vazias.

CREATE EXTENSION IF NOT EXISTS pgcrypto;

ALTER TABLE public.clients ADD COLUMN IF NOT EXISTS revision integer NOT NULL DEFAULT 1;
ALTER TABLE public.locations ADD COLUMN IF NOT EXISTS revision integer NOT NULL DEFAULT 1;
ALTER TABLE public.contracts ADD COLUMN IF NOT EXISTS revision integer NOT NULL DEFAULT 1;
ALTER TABLE public.services ADD COLUMN IF NOT EXISTS revision integer NOT NULL DEFAULT 1;
ALTER TABLE public.teams ADD COLUMN IF NOT EXISTS revision integer NOT NULL DEFAULT 1;
ALTER TABLE public.team_members ADD COLUMN IF NOT EXISTS revision integer NOT NULL DEFAULT 1;
ALTER TABLE public.invoices ADD COLUMN IF NOT EXISTS revision integer NOT NULL DEFAULT 1;
ALTER TABLE public.invoice_items ADD COLUMN IF NOT EXISTS revision integer NOT NULL DEFAULT 1;
ALTER TABLE public.services ADD COLUMN IF NOT EXISTS override_fields text[] NOT NULL DEFAULT '{}';

ALTER TABLE public.clients ALTER COLUMN revision TYPE bigint;
ALTER TABLE public.locations ALTER COLUMN revision TYPE bigint;
ALTER TABLE public.contracts ALTER COLUMN revision TYPE bigint;
ALTER TABLE public.services ALTER COLUMN revision TYPE bigint;
ALTER TABLE public.teams ALTER COLUMN revision TYPE bigint;
ALTER TABLE public.team_members ALTER COLUMN revision TYPE bigint;
ALTER TABLE public.invoices ALTER COLUMN revision TYPE bigint;
ALTER TABLE public.invoice_items ALTER COLUMN revision TYPE bigint;

CREATE OR REPLACE FUNCTION public.fn_increment_revision()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = public, pg_temp
AS $$
BEGIN
  NEW.revision := COALESCE(OLD.revision, 0) + 1;
  RETURN NEW;
END;
$$;

-- Normaliza todos os triggers que chamam exatamente public.fn_increment_revision.
-- A detecção de outras funções que alteram NEW.revision é textual e conservadora.
DO $$
DECLARE
  v_table text;
  v_canonical_trigger text;
  v_trigger record;
  v_conflict record;
  v_count integer;
BEGIN
  FOREACH v_table IN ARRAY ARRAY[
    'clients',
    'locations',
    'contracts',
    'services',
    'teams',
    'team_members',
    'invoices',
    'invoice_items'
  ]
  LOOP
    IF to_regclass(format('public.%I', v_table)) IS NULL THEN
      CONTINUE;
    END IF;

    IF NOT EXISTS (
      SELECT 1
      FROM information_schema.columns
      WHERE table_schema = 'public'
        AND table_name = v_table
        AND column_name = 'revision'
    ) THEN
      RAISE EXCEPTION 'REVISION_COLUMN_MISSING table=%', v_table USING ERRCODE = 'P0001';
    END IF;

    FOR v_conflict IN
      SELECT
        t.tgname AS trigger_name,
        pn.nspname || '.' || p.proname AS function_name
      FROM pg_trigger t
      JOIN pg_class c ON c.oid = t.tgrelid
      JOIN pg_namespace cn ON cn.oid = c.relnamespace
      JOIN pg_proc p ON p.oid = t.tgfoid
      JOIN pg_namespace pn ON pn.oid = p.pronamespace
      WHERE cn.nspname = 'public'
        AND c.relname = v_table
        AND NOT t.tgisinternal
        AND NOT (pn.nspname = 'public' AND p.proname = 'fn_increment_revision')
        AND position(
          'NEW.REVISION' IN regexp_replace(upper(pg_get_functiondef(p.oid)), '\s+', '', 'g')
        ) > 0
    LOOP
      RAISE EXCEPTION 'REVISION_TRIGGER_CONFLICT table=%, trigger=%, function=%',
        v_table,
        v_conflict.trigger_name,
        v_conflict.function_name
        USING ERRCODE = 'P0001';
    END LOOP;

    FOR v_trigger IN
      SELECT t.tgname AS trigger_name
      FROM pg_trigger t
      JOIN pg_class c ON c.oid = t.tgrelid
      JOIN pg_namespace cn ON cn.oid = c.relnamespace
      JOIN pg_proc p ON p.oid = t.tgfoid
      JOIN pg_namespace pn ON pn.oid = p.pronamespace
      WHERE cn.nspname = 'public'
        AND c.relname = v_table
        AND NOT t.tgisinternal
        AND pn.nspname = 'public'
        AND p.proname = 'fn_increment_revision'
    LOOP
      EXECUTE format('DROP TRIGGER IF EXISTS %I ON public.%I', v_trigger.trigger_name, v_table);
    END LOOP;

    v_canonical_trigger := 'trg_' || v_table || '_revision';
    EXECUTE format(
      'CREATE TRIGGER %I BEFORE UPDATE ON public.%I FOR EACH ROW EXECUTE FUNCTION public.fn_increment_revision()',
      v_canonical_trigger,
      v_table
    );

    SELECT count(*)::integer
      INTO v_count
    FROM pg_trigger t
    JOIN pg_class c ON c.oid = t.tgrelid
    JOIN pg_namespace cn ON cn.oid = c.relnamespace
    JOIN pg_proc p ON p.oid = t.tgfoid
    JOIN pg_namespace pn ON pn.oid = p.pronamespace
    WHERE cn.nspname = 'public'
      AND c.relname = v_table
      AND NOT t.tgisinternal
      AND pn.nspname = 'public'
      AND p.proname = 'fn_increment_revision';

    IF v_count <> 1 THEN
      RAISE EXCEPTION 'REVISION_TRIGGER_COUNT_INVALID table=%, count=%', v_table, v_count USING ERRCODE = 'P0001';
    END IF;
  END LOOP;
END;
$$;

-- Auditoria esperada apos aplicar a 065:
-- SELECT event_object_table, trigger_name, action_statement
-- FROM information_schema.triggers
-- WHERE trigger_schema = 'public'
--   AND action_statement ILIKE '%fn_increment_revision%';

CREATE TABLE IF NOT EXISTS public.company_sync_state (
  company_id uuid PRIMARY KEY REFERENCES public.companies(id) ON DELETE CASCADE,
  sequence bigint NOT NULL DEFAULT 0,
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS public.domain_mutations (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id uuid NOT NULL REFERENCES public.companies(id) ON DELETE CASCADE,
  mutation_id uuid NOT NULL,
  domain text NOT NULL,
  status text NOT NULL DEFAULT 'succeeded',
  operation text,
  entity_id uuid,
  request_hash text,
  result jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  completed_at timestamptz,
  CONSTRAINT domain_mutations_status_check CHECK (status IN ('succeeded', 'rejected')),
  UNIQUE(company_id, mutation_id)
);

CREATE TABLE IF NOT EXISTS public.company_change_events (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id uuid NOT NULL REFERENCES public.companies(id) ON DELETE CASCADE,
  sequence bigint NOT NULL,
  mutation_id uuid NOT NULL,
  domain text NOT NULL,
  event_type text NOT NULL,
  entity_ids uuid[] NOT NULL DEFAULT '{}',
  scopes text[] NOT NULL DEFAULT '{}',
  affected_from date,
  affected_to date,
  payload jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE(company_id, sequence),
  UNIQUE(company_id, mutation_id)
);

ALTER TABLE public.company_sync_state ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "company sync state locked" ON public.company_sync_state;
CREATE POLICY "company sync state locked" ON public.company_sync_state
  FOR ALL USING (false) WITH CHECK (false);

CREATE OR REPLACE FUNCTION public.assert_company_manager(
  p_company_id uuid,
  p_actor uuid
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_profile record;
BEGIN
  IF p_actor IS NULL THEN
    RETURN jsonb_build_object('ok', false, 'code', 'FORBIDDEN_ACTOR');
  END IF;

  SELECT id, company_id, role
    INTO v_profile
  FROM public.profiles
  WHERE id = p_actor;

  IF NOT FOUND THEN
    RETURN jsonb_build_object('ok', false, 'code', 'FORBIDDEN_ACTOR');
  END IF;

  IF v_profile.company_id <> p_company_id THEN
    RETURN jsonb_build_object('ok', false, 'code', 'FORBIDDEN_ACTOR');
  END IF;

  IF v_profile.role NOT IN ('admin', 'gestor') THEN
    RETURN jsonb_build_object('ok', false, 'code', 'FORBIDDEN_ACTOR');
  END IF;

  PERFORM set_config('app.actor_id', p_actor::text, true);

  RETURN jsonb_build_object(
    'ok', true,
    'id', v_profile.id,
    'company_id', v_profile.company_id,
    'role', v_profile.role
  );
END;
$$;

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

  SELECT sequence
    INTO v_sequence
  FROM public.company_sync_state
  WHERE company_id = p_company_id
  FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'COMPANY_SYNC_STATE_NOT_FOUND' USING ERRCODE = 'P0001';
  END IF;

  v_sequence := v_sequence + 1;

  UPDATE public.company_sync_state
     SET sequence = v_sequence,
         updated_at = now()
   WHERE company_id = p_company_id;

  RETURN v_sequence;
END;
$$;

ALTER TABLE public.domain_mutations ADD COLUMN IF NOT EXISTS operation text;
ALTER TABLE public.domain_mutations ADD COLUMN IF NOT EXISTS entity_id uuid;
ALTER TABLE public.domain_mutations ADD COLUMN IF NOT EXISTS request_hash text;
ALTER TABLE public.domain_mutations ADD COLUMN IF NOT EXISTS completed_at timestamptz;
ALTER TABLE public.domain_mutations DROP CONSTRAINT IF EXISTS domain_mutations_status_check;

UPDATE public.domain_mutations
   SET operation = COALESCE(operation, 'legacy'),
       request_hash = COALESCE(request_hash, 'legacy:' || mutation_id::text),
       status = CASE
         WHEN status IN ('succeeded', 'rejected') THEN status
         WHEN status = 'completed' THEN 'succeeded'
         ELSE 'succeeded'
       END,
       completed_at = COALESCE(completed_at, created_at, now()),
       result = COALESCE(result, '{}'::jsonb) ||
         jsonb_build_object('legacy_receipt', true)
 WHERE operation IS NULL
    OR request_hash IS NULL
    OR status NOT IN ('succeeded', 'rejected')
    OR completed_at IS NULL;

ALTER TABLE public.domain_mutations ALTER COLUMN operation SET NOT NULL;
ALTER TABLE public.domain_mutations ALTER COLUMN request_hash SET NOT NULL;
ALTER TABLE public.domain_mutations ALTER COLUMN completed_at SET NOT NULL;
ALTER TABLE public.domain_mutations ALTER COLUMN status SET DEFAULT 'succeeded';
ALTER TABLE public.domain_mutations ADD CONSTRAINT domain_mutations_status_check
  CHECK (status IN ('succeeded', 'rejected'));

ALTER TABLE public.company_change_events ADD COLUMN IF NOT EXISTS affected_from date;
ALTER TABLE public.company_change_events ADD COLUMN IF NOT EXISTS affected_to date;

ALTER TABLE public.company_change_events DROP CONSTRAINT IF EXISTS company_change_events_company_id_mutation_id_domain_event_t_key;
ALTER TABLE public.company_change_events DROP CONSTRAINT IF EXISTS company_change_events_company_id_sequence_key;
ALTER TABLE public.company_change_events DROP CONSTRAINT IF EXISTS company_change_events_company_id_mutation_id_key;
DROP INDEX IF EXISTS public.idx_company_change_events_pending;

ALTER TABLE public.company_change_events ALTER COLUMN sequence DROP IDENTITY IF EXISTS;
ALTER TABLE public.company_change_events ALTER COLUMN sequence DROP DEFAULT;

WITH ordered AS (
  SELECT id,
         row_number() OVER (PARTITION BY company_id ORDER BY created_at, id) AS new_sequence
    FROM public.company_change_events
)
UPDATE public.company_change_events e
   SET sequence = ordered.new_sequence
  FROM ordered
 WHERE e.id = ordered.id;

INSERT INTO public.company_sync_state(company_id, sequence, updated_at)
SELECT company_id, COALESCE(max(sequence), 0), now()
  FROM public.company_change_events
 GROUP BY company_id
ON CONFLICT (company_id) DO UPDATE
  SET sequence = GREATEST(public.company_sync_state.sequence, EXCLUDED.sequence),
      updated_at = now();

DO $$
BEGIN
  IF EXISTS (
    SELECT 1
      FROM information_schema.columns
     WHERE table_schema = 'public'
       AND table_name = 'company_change_events'
       AND column_name = 'affected_range'
  ) THEN
    EXECUTE $sql$
      UPDATE public.company_change_events
         SET affected_from = COALESCE(affected_from, lower(affected_range)::date),
             affected_to = COALESCE(affected_to, upper(affected_range)::date)
       WHERE affected_range IS NOT NULL
    $sql$;
  END IF;
END;
$$;

DO $$
BEGIN
  IF EXISTS (
    SELECT 1
      FROM public.company_change_events
     GROUP BY company_id, mutation_id
    HAVING count(*) > 1
  ) THEN
    RAISE EXCEPTION 'DUPLICATE_EVENTS_BY_MUTATION_REQUIRE_MANUAL_BACKFILL'
      USING ERRCODE = 'P0001';
  END IF;
END;
$$;

ALTER TABLE public.company_change_events DROP COLUMN IF EXISTS delivered_at;
ALTER TABLE public.company_change_events DROP COLUMN IF EXISTS affected_range;

ALTER TABLE public.company_change_events ADD CONSTRAINT company_change_events_company_id_sequence_key
  UNIQUE (company_id, sequence);

ALTER TABLE public.company_change_events ADD CONSTRAINT company_change_events_company_id_mutation_id_key
  UNIQUE (company_id, mutation_id);

CREATE INDEX IF NOT EXISTS idx_company_change_events_company_created
  ON public.company_change_events(company_id, created_at DESC);

DROP FUNCTION IF EXISTS public.record_company_change_event(uuid, uuid, text, text, uuid[], text[], tstzrange, jsonb);
DROP FUNCTION IF EXISTS public.set_invoice_status_atomic(uuid, uuid, uuid, text, text, uuid, integer);
DROP FUNCTION IF EXISTS public.delete_client_atomic(uuid, uuid, uuid, uuid, integer);
DROP FUNCTION IF EXISTS public.complete_domain_mutation(uuid, uuid, text, text, uuid, text, jsonb);

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
  SELECT *
    INTO v_event
  FROM public.company_change_events
  WHERE company_id = p_company_id
    AND mutation_id = p_mutation_id;

  IF FOUND THEN
    RETURN to_jsonb(v_event);
  END IF;

  v_sequence := public.next_company_sequence(p_company_id);

  INSERT INTO public.company_change_events (
    company_id,
    sequence,
    mutation_id,
    domain,
    event_type,
    entity_ids,
    scopes,
    affected_from,
    affected_to,
    payload
  )
  VALUES (
    p_company_id,
    v_sequence,
    p_mutation_id,
    p_domain,
    p_event_type,
    COALESCE(p_entity_ids, '{}'),
    COALESCE(p_scopes, '{}'),
    p_affected_from,
    p_affected_to,
    COALESCE(p_payload, '{}'::jsonb)
  )
  RETURNING * INTO v_event;

  RETURN to_jsonb(v_event);
END;
$$;

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
  SELECT *
    INTO v_existing
  FROM public.domain_mutations
  WHERE company_id = p_company_id
    AND mutation_id = p_mutation_id;

  IF NOT FOUND THEN
    RETURN NULL;
  END IF;

  IF v_existing.operation = p_operation AND v_existing.request_hash = p_request_hash THEN
    RETURN v_existing.result;
  END IF;

  RETURN jsonb_build_object(
    'ok', false,
    'code', 'MUTATION_REUSE_CONFLICT'
  );
END;
$$;

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
    company_id,
    mutation_id,
    domain,
    status,
    operation,
    entity_id,
    request_hash,
    result,
    completed_at
  )
  VALUES (
    p_company_id,
    p_mutation_id,
    p_domain,
    p_status,
    p_operation,
    p_entity_id,
    p_request_hash,
    p_result,
    now()
  );

  RETURN p_result;
END;
$$;

CREATE OR REPLACE FUNCTION public.set_invoice_status_atomic(
  p_invoice_id uuid,
  p_company_id uuid,
  p_actor uuid,
  p_status text,
  p_payment_method text,
  p_mutation_id uuid,
  p_expected_revision bigint
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_existing jsonb;
  v_actor_auth jsonb;
  v_request_hash text;
  v_before jsonb;
  v_invoice jsonb;
  v_inv record;
  v_client_name text;
  v_cash record;
  v_cash_flow_entry jsonb;
  v_event jsonb;
  v_result jsonb;
BEGIN
  IF p_invoice_id IS NULL
     OR p_company_id IS NULL
     OR p_mutation_id IS NULL
     OR p_status IS NULL
     OR p_expected_revision IS NULL THEN
    RETURN jsonb_build_object('ok', false, 'code', 'INVALID_INPUT');
  END IF;

  v_actor_auth := public.assert_company_manager(p_company_id, p_actor);
  IF (v_actor_auth ->> 'code') = 'FORBIDDEN_ACTOR'
     OR NOT COALESCE((v_actor_auth ->> 'ok')::boolean, false) THEN
    RETURN v_actor_auth;
  END IF;

  PERFORM public.lock_domain_mutation(p_company_id, p_mutation_id);

  v_request_hash := encode(digest(jsonb_build_object(
    'operation', 'set_invoice_status_atomic',
    'invoice_id', p_invoice_id,
    'company_id', p_company_id,
    'status', p_status,
    'payment_method', p_payment_method,
    'expected_revision', p_expected_revision
  )::text, 'sha256'), 'hex');

  v_existing := public.find_or_conflict_domain_mutation(
    p_company_id,
    p_mutation_id,
    'set_invoice_status_atomic',
    v_request_hash
  );
  IF v_existing IS NOT NULL THEN
    RETURN v_existing;
  END IF;

  IF p_status NOT IN ('rascunho', 'pendente', 'pago', 'vencido', 'cancelado') THEN
    v_result := jsonb_build_object('ok', false, 'code', 'INVALID_INPUT');
    RETURN public.complete_domain_mutation(
      p_company_id,
      p_mutation_id,
      'billing',
      'set_invoice_status_atomic',
      p_invoice_id,
      v_request_hash,
      'rejected',
      v_result
    );
  END IF;

  SELECT *
    INTO v_inv
  FROM public.invoices
  WHERE id = p_invoice_id
    AND company_id = p_company_id
  FOR UPDATE;

  IF NOT FOUND THEN
    v_result := jsonb_build_object('ok', false, 'code', 'NOT_FOUND');
    RETURN public.complete_domain_mutation(
      p_company_id,
      p_mutation_id,
      'billing',
      'set_invoice_status_atomic',
      p_invoice_id,
      v_request_hash,
      'rejected',
      v_result
    );
  END IF;

  IF v_inv.revision <> p_expected_revision THEN
    v_result := jsonb_build_object(
      'ok', false,
      'code', 'REVISION_CONFLICT',
      'current_revision', v_inv.revision,
      'expected_revision', p_expected_revision
    );
    RETURN public.complete_domain_mutation(
      p_company_id,
      p_mutation_id,
      'billing',
      'set_invoice_status_atomic',
      p_invoice_id,
      v_request_hash,
      'rejected',
      v_result
    );
  END IF;

  v_before := to_jsonb(v_inv);

  UPDATE public.invoices
     SET status = p_status,
         paid_at = CASE WHEN p_status = 'pago' THEN COALESCE(v_inv.paid_at, now()) ELSE NULL END,
         payment_method = CASE WHEN p_status = 'pago' THEN p_payment_method ELSE NULL END
   WHERE id = p_invoice_id
     AND company_id = p_company_id
     AND revision = p_expected_revision
   RETURNING * INTO v_inv;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'INVOICE_UPDATE_FAILED' USING ERRCODE = 'P0001';
  END IF;

  IF p_status = 'pago' AND COALESCE(v_inv.total, 0) > 0 THEN
    SELECT name
      INTO v_client_name
    FROM public.clients
    WHERE id = v_inv.client_id
      AND company_id = p_company_id;

    INSERT INTO public.cash_flow_entries (
      company_id,
      type,
      amount,
      description,
      category,
      date,
      reference_id,
      reference_type,
      status,
      created_by
    )
    VALUES (
      p_company_id,
      'entrada',
      v_inv.total,
      'Fatura ' || v_inv.invoice_number || ' - ' || COALESCE(v_client_name, 'Cliente'),
      'faturacao',
      (now() AT TIME ZONE 'Europe/Lisbon')::date,
      p_invoice_id,
      'invoice',
      'confirmado',
      p_actor
    )
    ON CONFLICT (company_id, reference_type, reference_id)
    WHERE reference_type IS NOT NULL AND reference_id IS NOT NULL
    DO UPDATE SET
      amount = EXCLUDED.amount,
      description = EXCLUDED.description,
      date = EXCLUDED.date,
      status = EXCLUDED.status,
      created_by = EXCLUDED.created_by
    RETURNING * INTO v_cash;
    v_cash_flow_entry := to_jsonb(v_cash);
  ELSE
    DELETE FROM public.cash_flow_entries
     WHERE company_id = p_company_id
       AND reference_type = 'invoice'
       AND reference_id = p_invoice_id
     RETURNING * INTO v_cash;
    v_cash_flow_entry := CASE WHEN FOUND THEN to_jsonb(v_cash) ELSE NULL END;
  END IF;

  v_invoice := to_jsonb(v_inv);

  INSERT INTO public.audit_logs(company_id, actor_id, action, entity_type, entity_id, meta)
  VALUES (
    p_company_id,
    p_actor,
    'invoice_status_changed',
    'invoice',
    p_invoice_id::text,
    jsonb_build_object(
      'before', v_before,
      'after', v_invoice,
      'cash_flow_entry', v_cash_flow_entry,
      'mutation_id', p_mutation_id
    )
  );

  v_event := public.record_company_change_event(
    p_company_id,
    p_mutation_id,
    'billing',
    'invoice_status_changed',
    ARRAY[p_invoice_id],
    ARRAY['cobrancas', 'financeiro'],
    NULL,
    NULL,
    jsonb_build_object(
      'invoice', v_invoice,
      'cash_flow_entry', v_cash_flow_entry
    )
  );

  v_result := jsonb_build_object(
    'ok', true,
    'code', 'OK',
    'mutation_id', p_mutation_id,
    'sequence', (v_event ->> 'sequence')::bigint,
    'invoice', v_invoice,
    'cash_flow_entry', v_cash_flow_entry,
    'event', v_event
  );

  RETURN public.complete_domain_mutation(
    p_company_id,
    p_mutation_id,
    'billing',
    'set_invoice_status_atomic',
    p_invoice_id,
    v_request_hash,
    'succeeded',
    v_result
  );
END;
$$;

CREATE OR REPLACE FUNCTION public.archive_client_atomic(
  p_client_id uuid,
  p_company_id uuid,
  p_actor uuid,
  p_mutation_id uuid,
  p_expected_revision bigint
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_existing jsonb;
  v_actor_auth jsonb;
  v_request_hash text;
  v_client record;
  v_client_updated record;
  v_client_after jsonb;
  v_contracts_closed integer := 0;
  v_future_services_cancelled integer := 0;
  v_event jsonb;
  v_result jsonb;
BEGIN
  IF p_client_id IS NULL
     OR p_company_id IS NULL
     OR p_mutation_id IS NULL
     OR p_expected_revision IS NULL THEN
    RETURN jsonb_build_object('ok', false, 'code', 'INVALID_INPUT');
  END IF;

  v_actor_auth := public.assert_company_manager(p_company_id, p_actor);
  IF (v_actor_auth ->> 'code') = 'FORBIDDEN_ACTOR'
     OR NOT COALESCE((v_actor_auth ->> 'ok')::boolean, false) THEN
    RETURN v_actor_auth;
  END IF;

  PERFORM public.lock_domain_mutation(p_company_id, p_mutation_id);

  v_request_hash := encode(digest(jsonb_build_object(
    'operation', 'archive_client_atomic',
    'client_id', p_client_id,
    'company_id', p_company_id,
    'expected_revision', p_expected_revision
  )::text, 'sha256'), 'hex');

  v_existing := public.find_or_conflict_domain_mutation(
    p_company_id,
    p_mutation_id,
    'archive_client_atomic',
    v_request_hash
  );
  IF v_existing IS NOT NULL THEN
    RETURN v_existing;
  END IF;

  SELECT *
    INTO v_client
  FROM public.clients
  WHERE id = p_client_id
    AND company_id = p_company_id
  FOR UPDATE;

  IF NOT FOUND THEN
    v_result := jsonb_build_object('ok', false, 'code', 'NOT_FOUND');
    RETURN public.complete_domain_mutation(
      p_company_id,
      p_mutation_id,
      'clients',
      'archive_client_atomic',
      p_client_id,
      v_request_hash,
      'rejected',
      v_result
    );
  END IF;

  IF v_client.revision <> p_expected_revision THEN
    v_result := jsonb_build_object(
      'ok', false,
      'code', 'REVISION_CONFLICT',
      'current_revision', v_client.revision,
      'expected_revision', p_expected_revision
    );
    RETURN public.complete_domain_mutation(
      p_company_id,
      p_mutation_id,
      'clients',
      'archive_client_atomic',
      p_client_id,
      v_request_hash,
      'rejected',
      v_result
    );
  END IF;

  PERFORM 1
    FROM public.locations
   WHERE client_id = p_client_id
     AND company_id = p_company_id
   FOR UPDATE;

  UPDATE public.contracts c
     SET status = 'cancelado',
         ends_on = COALESCE(ends_on, (now() AT TIME ZONE 'Europe/Lisbon')::date)
    FROM public.locations l
   WHERE c.location_id = l.id
     AND l.client_id = p_client_id
     AND c.company_id = p_company_id
     AND c.status = 'ativo';
  GET DIAGNOSTICS v_contracts_closed = ROW_COUNT;

  UPDATE public.services s
     SET status = 'cancelado',
         cancelled_at = COALESCE(cancelled_at, now()),
         cancelled_by = COALESCE(cancelled_by, p_actor),
         cancel_type = COALESCE(cancel_type, 'operational'),
         cancel_reason = COALESCE(cancel_reason, 'Cliente arquivado')
    FROM public.locations l
   WHERE s.location_id = l.id
     AND l.client_id = p_client_id
     AND s.company_id = p_company_id
     AND s.status IN ('agendado', 'sem_cobertura')
     AND s.scheduled_start >= now();
  GET DIAGNOSTICS v_future_services_cancelled = ROW_COUNT;

  UPDATE public.clients
     SET status = 'inativo'
   WHERE id = p_client_id
     AND company_id = p_company_id
   RETURNING * INTO v_client_updated;

  v_client_after := to_jsonb(v_client_updated);

  INSERT INTO public.audit_logs(company_id, actor_id, action, entity_type, entity_id, meta)
  VALUES (
    p_company_id,
    p_actor,
    'client_archived',
    'client',
    p_client_id::text,
    jsonb_build_object(
      'contracts_closed', v_contracts_closed,
      'future_services_cancelled', v_future_services_cancelled,
      'mutation_id', p_mutation_id
    )
  );

  v_event := public.record_company_change_event(
    p_company_id,
    p_mutation_id,
    'clients',
    'client_archived',
    ARRAY[p_client_id],
    ARRAY['clientes', 'calendario', 'contratos', 'cobrancas'],
    (now() AT TIME ZONE 'Europe/Lisbon')::date,
    NULL,
    jsonb_build_object(
      'client', v_client_after,
      'contracts_closed', v_contracts_closed,
      'future_services_cancelled', v_future_services_cancelled
    )
  );

  v_result := jsonb_build_object(
    'ok', true,
    'code', 'OK',
    'mutation_id', p_mutation_id,
    'sequence', (v_event ->> 'sequence')::bigint,
    'client_id', p_client_id,
    'client', v_client_after,
    'contracts_closed', v_contracts_closed,
    'future_services_cancelled', v_future_services_cancelled,
    'event', v_event
  );

  RETURN public.complete_domain_mutation(
    p_company_id,
    p_mutation_id,
    'clients',
    'archive_client_atomic',
    p_client_id,
    v_request_hash,
    'succeeded',
    v_result
  );
END;
$$;

CREATE OR REPLACE FUNCTION public.delete_empty_client_atomic(
  p_client_id uuid,
  p_company_id uuid,
  p_actor uuid,
  p_mutation_id uuid,
  p_expected_revision bigint
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_existing jsonb;
  v_actor_auth jsonb;
  v_request_hash text;
  v_client record;
  v_location_ids uuid[];
  v_locations_deleted integer := 0;
  v_services_history integer := 0;
  v_timesheets_history integer := 0;
  v_invoices_history integer := 0;
  v_cash_flow_history integer := 0;
  v_contracts_history integer := 0;
  v_history jsonb;
  v_event jsonb;
  v_result jsonb;
BEGIN
  IF p_client_id IS NULL
     OR p_company_id IS NULL
     OR p_mutation_id IS NULL
     OR p_expected_revision IS NULL THEN
    RETURN jsonb_build_object('ok', false, 'code', 'INVALID_INPUT');
  END IF;

  v_actor_auth := public.assert_company_manager(p_company_id, p_actor);
  IF (v_actor_auth ->> 'code') = 'FORBIDDEN_ACTOR'
     OR NOT COALESCE((v_actor_auth ->> 'ok')::boolean, false) THEN
    RETURN v_actor_auth;
  END IF;

  PERFORM public.lock_domain_mutation(p_company_id, p_mutation_id);

  v_request_hash := encode(digest(jsonb_build_object(
    'operation', 'delete_empty_client_atomic',
    'client_id', p_client_id,
    'company_id', p_company_id,
    'expected_revision', p_expected_revision
  )::text, 'sha256'), 'hex');

  v_existing := public.find_or_conflict_domain_mutation(
    p_company_id,
    p_mutation_id,
    'delete_empty_client_atomic',
    v_request_hash
  );
  IF v_existing IS NOT NULL THEN
    RETURN v_existing;
  END IF;

  SELECT *
    INTO v_client
  FROM public.clients
  WHERE id = p_client_id
    AND company_id = p_company_id
  FOR UPDATE;

  IF NOT FOUND THEN
    v_result := jsonb_build_object('ok', false, 'code', 'NOT_FOUND');
    RETURN public.complete_domain_mutation(
      p_company_id,
      p_mutation_id,
      'clients',
      'delete_empty_client_atomic',
      p_client_id,
      v_request_hash,
      'rejected',
      v_result
    );
  END IF;

  IF v_client.revision <> p_expected_revision THEN
    v_result := jsonb_build_object(
      'ok', false,
      'code', 'REVISION_CONFLICT',
      'current_revision', v_client.revision,
      'expected_revision', p_expected_revision
    );
    RETURN public.complete_domain_mutation(
      p_company_id,
      p_mutation_id,
      'clients',
      'delete_empty_client_atomic',
      p_client_id,
      v_request_hash,
      'rejected',
      v_result
    );
  END IF;

  PERFORM 1
    FROM public.locations
   WHERE client_id = p_client_id
     AND company_id = p_company_id
   FOR UPDATE;

  SELECT COALESCE(array_agg(id), '{}')
    INTO v_location_ids
  FROM public.locations
  WHERE client_id = p_client_id
    AND company_id = p_company_id;

  PERFORM 1 FROM public.contracts
   WHERE company_id = p_company_id
     AND location_id = ANY(v_location_ids)
   FOR UPDATE;

  PERFORM 1 FROM public.services
   WHERE company_id = p_company_id
     AND location_id = ANY(v_location_ids)
   FOR UPDATE;

  PERFORM 1 FROM public.invoices
   WHERE company_id = p_company_id
     AND client_id = p_client_id
   FOR UPDATE;

  PERFORM 1
    FROM public.cash_flow_entries cf
    JOIN public.invoices i ON i.id = cf.reference_id
   WHERE cf.company_id = p_company_id
     AND cf.reference_type = 'invoice'
     AND i.client_id = p_client_id
   FOR UPDATE OF cf;

  PERFORM 1
    FROM public.cash_flow_entries cf
    JOIN public.services s ON s.id = cf.reference_id
   WHERE cf.company_id = p_company_id
     AND cf.reference_type = 'service_payment'
     AND s.location_id = ANY(v_location_ids)
   FOR UPDATE OF cf;

  PERFORM 1
    FROM public.timesheets t
    JOIN public.services s ON s.id = t.service_id
   WHERE t.company_id = p_company_id
     AND s.location_id = ANY(v_location_ids)
   FOR UPDATE OF t;

  SELECT count(*)::integer INTO v_services_history
  FROM public.services s
  WHERE s.company_id = p_company_id
    AND s.location_id = ANY(v_location_ids)
    AND (
      s.status IN ('concluido', 'em_curso')
      OR (s.status = 'cancelado' AND (s.actual_start IS NOT NULL OR s.actual_end IS NOT NULL OR s.paid_at IS NOT NULL OR COALESCE(s.paid_amount, 0) > 0))
    );

  SELECT count(*)::integer INTO v_timesheets_history
  FROM public.timesheets t
  JOIN public.services s ON s.id = t.service_id
  WHERE t.company_id = p_company_id
    AND s.location_id = ANY(v_location_ids);

  SELECT count(*)::integer INTO v_invoices_history
  FROM public.invoices
  WHERE company_id = p_company_id
    AND client_id = p_client_id;

  SELECT count(*)::integer INTO v_cash_flow_history
  FROM public.cash_flow_entries cf
  WHERE cf.company_id = p_company_id
    AND (
      EXISTS (
        SELECT 1 FROM public.invoices i
        WHERE i.id = cf.reference_id
          AND cf.reference_type = 'invoice'
          AND i.company_id = p_company_id
          AND i.client_id = p_client_id
      )
      OR EXISTS (
        SELECT 1 FROM public.services s
        WHERE s.id = cf.reference_id
          AND cf.reference_type = 'service_payment'
          AND s.company_id = p_company_id
          AND s.location_id = ANY(v_location_ids)
      )
    );

  SELECT count(*)::integer INTO v_contracts_history
  FROM public.contracts
  WHERE company_id = p_company_id
    AND location_id = ANY(v_location_ids)
    AND (
      status <> 'ativo'
      OR ends_on IS NOT NULL
      OR COALESCE(array_length(excluded_dates, 1), 0) > 0
      OR EXISTS (
        SELECT 1 FROM public.services s
        WHERE s.contract_id = public.contracts.id
          AND s.company_id = p_company_id
          AND s.status IN ('concluido', 'em_curso', 'cancelado')
      )
    );

  v_history := jsonb_build_object(
    'services', v_services_history,
    'timesheets', v_timesheets_history,
    'invoices', v_invoices_history,
    'cash_flow_entries', v_cash_flow_history,
    'contracts', v_contracts_history
  );

  IF v_services_history > 0
     OR v_timesheets_history > 0
     OR v_invoices_history > 0
     OR v_cash_flow_history > 0
     OR v_contracts_history > 0 THEN
    v_result := jsonb_build_object(
      'ok', false,
      'code', 'CLIENT_HAS_HISTORY',
      'client_id', p_client_id,
      'revision', v_client.revision,
      'history', v_history
    );

    RETURN public.complete_domain_mutation(
      p_company_id,
      p_mutation_id,
      'clients',
      'delete_empty_client_atomic',
      p_client_id,
      v_request_hash,
      'rejected',
      v_result
    );
  END IF;

  DELETE FROM public.services
   WHERE company_id = p_company_id
     AND location_id = ANY(v_location_ids);

  DELETE FROM public.contracts
   WHERE company_id = p_company_id
     AND location_id = ANY(v_location_ids);

  DELETE FROM public.locations
   WHERE company_id = p_company_id
     AND client_id = p_client_id;
  GET DIAGNOSTICS v_locations_deleted = ROW_COUNT;

  DELETE FROM public.clients
   WHERE id = p_client_id
     AND company_id = p_company_id;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'CLIENT_DELETE_FAILED' USING ERRCODE = 'P0001';
  END IF;

  INSERT INTO public.audit_logs(company_id, actor_id, action, entity_type, entity_id, meta)
  VALUES (
    p_company_id,
    p_actor,
    'client_empty_deleted',
    'client',
    p_client_id::text,
    jsonb_build_object('locations_deleted', v_locations_deleted, 'mutation_id', p_mutation_id)
  );

  v_event := public.record_company_change_event(
    p_company_id,
    p_mutation_id,
    'clients',
    'client_empty_deleted',
    ARRAY[p_client_id],
    ARRAY['clientes'],
    NULL,
    NULL,
    jsonb_build_object(
      'client_id', p_client_id,
      'locations_deleted', v_locations_deleted
    )
  );

  v_result := jsonb_build_object(
    'ok', true,
    'code', 'OK',
    'mutation_id', p_mutation_id,
    'sequence', (v_event ->> 'sequence')::bigint,
    'client_id', p_client_id,
    'locations_deleted', v_locations_deleted,
    'event', v_event
  );

  RETURN public.complete_domain_mutation(
    p_company_id,
    p_mutation_id,
    'clients',
    'delete_empty_client_atomic',
    p_client_id,
    v_request_hash,
    'succeeded',
    v_result
  );
END;
$$;

CREATE OR REPLACE FUNCTION public.delete_client_atomic(
  p_client_id uuid,
  p_company_id uuid,
  p_actor uuid,
  p_mutation_id uuid,
  p_expected_revision bigint
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
BEGIN
  RAISE EXCEPTION 'DESTRUCTIVE_CLIENT_DELETE_DISABLED_USE_ARCHIVE_OR_DELETE_EMPTY'
    USING ERRCODE = 'P0001';
END;
$$;

DROP POLICY IF EXISTS "service role domain mutations" ON public.domain_mutations;
CREATE POLICY "service role domain mutations" ON public.domain_mutations
  FOR ALL USING (false) WITH CHECK (false);

DROP POLICY IF EXISTS "managers see company change events" ON public.company_change_events;
CREATE POLICY "managers see company change events" ON public.company_change_events
  FOR SELECT TO authenticated
  USING (
    company_id = (SELECT company_id FROM public.profiles WHERE id = auth.uid())
    AND (SELECT role FROM public.profiles WHERE id = auth.uid()) IN ('admin', 'gestor')
  );

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

GRANT SELECT ON public.company_change_events TO authenticated;
REVOKE INSERT, UPDATE, DELETE ON public.company_change_events FROM anon, authenticated;
REVOKE ALL ON public.domain_mutations FROM anon, authenticated;
REVOKE ALL ON public.company_sync_state FROM anon, authenticated;

REVOKE ALL ON FUNCTION public.assert_company_manager(uuid, uuid) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.lock_domain_mutation(uuid, uuid) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.next_company_sequence(uuid) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.find_or_conflict_domain_mutation(uuid, uuid, text, text) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.complete_domain_mutation(uuid, uuid, text, text, uuid, text, text, jsonb) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.record_company_change_event(uuid, uuid, text, text, uuid[], text[], date, date, jsonb) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.set_invoice_status_atomic(uuid, uuid, uuid, text, text, uuid, bigint) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.archive_client_atomic(uuid, uuid, uuid, uuid, bigint) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.delete_empty_client_atomic(uuid, uuid, uuid, uuid, bigint) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.delete_client_atomic(uuid, uuid, uuid, uuid, bigint) FROM PUBLIC, anon, authenticated;

GRANT EXECUTE ON FUNCTION public.set_invoice_status_atomic(uuid, uuid, uuid, text, text, uuid, bigint) TO service_role;
GRANT EXECUTE ON FUNCTION public.archive_client_atomic(uuid, uuid, uuid, uuid, bigint) TO service_role;
GRANT EXECUTE ON FUNCTION public.delete_empty_client_atomic(uuid, uuid, uuid, uuid, bigint) TO service_role;

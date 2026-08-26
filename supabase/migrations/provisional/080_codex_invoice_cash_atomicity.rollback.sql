-- PROVISIONAL ROLLBACK: restores the canonical function definition that
-- preceded 080. Do not execute in production without the migration-ledger gate.

BEGIN;

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

REVOKE ALL ON FUNCTION public.set_invoice_status_atomic(uuid, uuid, uuid, text, text, uuid, bigint)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.set_invoice_status_atomic(uuid, uuid, uuid, text, text, uuid, bigint)
  TO service_role;

COMMIT;

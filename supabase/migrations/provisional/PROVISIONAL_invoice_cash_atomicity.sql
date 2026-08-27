-- ============================================================================
-- MIGRATION_NUMBER_FINAL = UNASSIGNED
-- ============================================================================
--
-- Este ficheiro chamou-se `080_codex_invoice_cash_atomicity.sql`. O 080 nao
-- lhe pertence: esta atribuido a `080_payment_cashflow_provenance.sql`, da
-- onda 077->081 que ja esta revista e com CI verde. Dois ficheiros a reclamar
-- o mesmo numero e drift a nascer — e drift de numeracao foi exactamente o
-- que custou a TASK 1 a reconciliar.
--
-- O numero nao se troca por outro agora, e de proposito. Este ramo esta
-- assente num master anterior a frente dos colaboradores, e o numero final so
-- se atribui depois do rebase e da reconciliacao contra o master da altura —
-- escolher ja um seria adivinhar a sequencia outra vez.
--
--     FILA = FIN-INVOICE-HARDENING
--     REQUER = rebase e reconciliacao completa contra o master actual
--
-- Enquanto vive em `provisional/`, nenhum runner lhe toca.
-- ============================================================================

-- PROVISIONAL: number 080 is not reserved. Do not move this file into the
-- active migration directory until the migration ledger and 077-079 ordering
-- have been reconciled.
--
-- Replaces the existing canonical function. It does not create a second
-- invoice/cash API and performs no data backfill.

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
SET search_path = pg_catalog, public, pg_temp
AS $fn$
DECLARE
  v_existing jsonb;
  v_actor_auth jsonb;
  v_request_hash text;
  v_before jsonb;
  v_invoice jsonb;
  v_inv public.invoices%ROWTYPE;
  v_client_name text;
  v_cash public.cash_flow_entries%ROWTYPE;
  v_cash_found boolean := false;
  v_cash_changed boolean := false;
  v_invoice_changed boolean := false;
  v_cash_flow_entry jsonb;
  v_event jsonb;
  v_result jsonb;
  v_invoice_date date;
  v_cash_date date;
BEGIN
  IF p_invoice_id IS NULL
     OR p_company_id IS NULL
     OR p_actor IS NULL
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

  v_request_hash := encode(public.digest(jsonb_build_object(
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
    RETURN jsonb_build_object('ok', false, 'code', 'INVALID_INPUT');
  END IF;

  SELECT *
    INTO v_inv
    FROM public.invoices
   WHERE id = p_invoice_id
     AND company_id = p_company_id
   FOR UPDATE;

  IF NOT FOUND THEN
    RETURN jsonb_build_object('ok', false, 'code', 'NOT_FOUND');
  END IF;

  IF v_inv.revision <> p_expected_revision THEN
    RETURN jsonb_build_object(
      'ok', false,
      'code', 'REVISION_CONFLICT',
      'current_revision', v_inv.revision
    );
  END IF;

  v_invoice_date := v_inv.invoice_date;
  IF NOT public.is_financial_period_open(
    p_company_id,
    EXTRACT(YEAR FROM v_invoice_date)::integer,
    EXTRACT(MONTH FROM v_invoice_date)::integer
  ) THEN
    RETURN jsonb_build_object('ok', false, 'code', 'FINANCIAL_PERIOD_CLOSED', 'period_kind', 'invoice');
  END IF;

  SELECT *
    INTO v_cash
    FROM public.cash_flow_entries
   WHERE company_id = p_company_id
     AND reference_type = 'invoice'
     AND reference_id = p_invoice_id
   FOR UPDATE;
  v_cash_found := FOUND;

  IF v_cash_found THEN
    IF v_cash.type IS DISTINCT FROM 'entrada'
       OR v_cash.amount IS DISTINCT FROM v_inv.total
       OR v_cash.status IS DISTINCT FROM 'confirmado' THEN
      RETURN jsonb_build_object('ok', false, 'code', 'CASHFLOW_INVOICE_MISMATCH');
    END IF;
    v_cash_date := v_cash.date;
  ELSE
    v_cash_date := COALESCE(
      (v_inv.paid_at AT TIME ZONE 'Europe/Lisbon')::date,
      (now() AT TIME ZONE 'Europe/Lisbon')::date
    );
  END IF;

  IF p_status = 'pago' OR v_cash_found THEN
    IF NOT public.is_financial_period_open(
      p_company_id,
      EXTRACT(YEAR FROM v_cash_date)::integer,
      EXTRACT(MONTH FROM v_cash_date)::integer
    ) THEN
      RETURN jsonb_build_object('ok', false, 'code', 'FINANCIAL_PERIOD_CLOSED', 'period_kind', 'cash');
    END IF;
  END IF;

  IF p_status <> 'pago' AND v_cash_found AND EXISTS (
    SELECT 1
      FROM public.bank_reconciliation_matches m
     WHERE m.company_id = p_company_id
       AND m.cash_flow_entry_id = v_cash.id
       AND m.status = 'confirmed'
  ) THEN
    RETURN jsonb_build_object('ok', false, 'code', 'RECONCILED_CASHFLOW');
  END IF;

  v_before := to_jsonb(v_inv);
  v_invoice_changed := v_inv.status IS DISTINCT FROM p_status
    OR (p_status = 'pago' AND v_inv.payment_method IS DISTINCT FROM p_payment_method)
    OR (p_status <> 'pago' AND (v_inv.paid_at IS NOT NULL OR v_inv.payment_method IS NOT NULL));

  IF v_invoice_changed THEN
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
  END IF;

  IF p_status = 'pago' AND COALESCE(v_inv.total, 0) > 0 AND NOT v_cash_found THEN
    SELECT name
      INTO v_client_name
      FROM public.clients
     WHERE id = v_inv.client_id
       AND company_id = p_company_id;

    INSERT INTO public.cash_flow_entries (
      company_id, type, amount, description, category, date,
      reference_id, reference_type, status, created_by
    ) VALUES (
      p_company_id, 'entrada', v_inv.total,
      'Fatura ' || v_inv.invoice_number || ' - ' || COALESCE(v_client_name, 'Cliente'),
      'faturacao', v_cash_date, p_invoice_id, 'invoice', 'confirmado', p_actor
    )
    RETURNING * INTO v_cash;
    v_cash_found := true;
    v_cash_changed := true;
  ELSIF p_status <> 'pago' AND v_cash_found THEN
    DELETE FROM public.cash_flow_entries
     WHERE id = v_cash.id
       AND company_id = p_company_id;
    v_cash_changed := true;
    v_cash_found := false;
  END IF;

  v_invoice := to_jsonb(v_inv);
  v_cash_flow_entry := CASE WHEN v_cash_found THEN to_jsonb(v_cash) ELSE NULL END;

  IF v_invoice_changed OR v_cash_changed THEN
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
      ARRAY['cobrancas', 'financeiro', 'clientes', 'relatorios', 'conciliacao'],
      v_invoice_date,
      v_cash_date,
      jsonb_build_object('invoice', v_invoice, 'cash_flow_entry', v_cash_flow_entry)
    );
  ELSE
    v_event := NULL;
  END IF;

  v_result := jsonb_build_object(
    'ok', true,
    'code', 'OK',
    'mutation_id', p_mutation_id,
    'invoice', v_invoice,
    'cash_flow_entry', v_cash_flow_entry,
    'event', v_event,
    'no_change', NOT (v_invoice_changed OR v_cash_changed)
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
$fn$;

REVOKE ALL ON FUNCTION public.set_invoice_status_atomic(uuid, uuid, uuid, text, text, uuid, bigint)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.set_invoice_status_atomic(uuid, uuid, uuid, text, text, uuid, bigint)
  TO service_role;

COMMIT;

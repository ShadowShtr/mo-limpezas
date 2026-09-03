-- NOT_FOR_PRODUCTION
-- NOT_A_MIGRATION
-- MIGRATION_NUMBER_PENDING_TECHNICAL_DIRECTION
--
-- Candidato de schema para a edição atómica de contrato + ocorrências.
-- Não está em supabase/migrations/ e não pode ser aplicado pelo runner.
-- Depende apenas do schema operacional existente (contracts, locations,
-- services, audit_logs). A identidade futura da ocorrência continua fora desta
-- função: o plano usa service_id para UPDATE/REMOVE e scheduled_start para
-- deduplicar CREATE, até a direção aprovar a evolução de identidade.
--
-- A decisão de recorrência é feita no runtime pelo motor canónico. Esta função
-- só aplica o patch e o plano dentro de uma única transação PostgreSQL.

CREATE OR REPLACE FUNCTION public.apply_contract_change_atomic(
  p_company_id uuid,
  p_contract_id uuid,
  p_expected_updated_at timestamptz,
  p_contract_patch jsonb,
  p_update_location_hourly_rate boolean,
  p_location_hourly_rate numeric,
  p_plan jsonb,
  p_actor_id uuid,
  p_audit_meta jsonb DEFAULT NULL
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_contract record;
  v_location record;
  v_item jsonb;
  v_payload jsonb;
  v_decision text;
  v_service_id uuid;
  v_next_ref bigint;
  v_created integer := 0;
  v_updated integer := 0;
  v_removed integer := 0;
BEGIN
  -- Serializa o contrato e impede que um snapshot velho seja aplicado depois
  -- de outra gravação. Contratos de empresas diferentes não partilham lock.
  SELECT id, company_id, updated_at
    INTO v_contract
    FROM public.contracts
   WHERE id = p_contract_id
     AND company_id = p_company_id
   FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'INTERVENTION_NOT_FOUND' USING ERRCODE = 'P0002';
  END IF;

  IF p_expected_updated_at IS NOT NULL
     AND v_contract.updated_at IS DISTINCT FROM p_expected_updated_at THEN
    RAISE EXCEPTION 'STALE_CONFLICT' USING ERRCODE = '40001';
  END IF;

  IF NOT (p_contract_patch ?& ARRAY[
    'location_id', 'frequency', 'interval_days', 'weekdays', 'schedule_days',
    'starts_on', 'ends_on', 'status', 'name', 'notes', 'cleaning_type',
    'payment_status', 'upholstery_type', 'upholstery_notes',
    'upholstery_units', 'upholstery_unit_price', 'fixed_price',
    'fixed_monthly', 'apply_vat', 'num_people'
  ]) THEN
    RAISE EXCEPTION 'INCOMPLETE_CONTRACT_PATCH' USING ERRCODE = '22023';
  END IF;

  SELECT id
    INTO v_location
    FROM public.locations
   WHERE id = (p_contract_patch->>'location_id')::uuid
     AND company_id = p_company_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'INVALID_LOCATION' USING ERRCODE = '23503';
  END IF;

  IF EXISTS (
    SELECT 1
      FROM jsonb_array_elements(COALESCE(p_contract_patch->'schedule_days', '[]'::jsonb)) AS day
     WHERE NULLIF(day->>'team_id', '') IS NOT NULL
       AND NOT EXISTS (
         SELECT 1 FROM public.teams t
          WHERE t.id = (day->>'team_id')::uuid
            AND t.company_id = p_company_id
       )
  ) THEN
    RAISE EXCEPTION 'INVALID_TEAM' USING ERRCODE = '23503';
  END IF;

  -- false = campo ausente no formulário; nesse caso preserva o preço do local.
  -- true + null = limpeza explícita pedida pelo utilizador.
  IF p_update_location_hourly_rate THEN
    UPDATE public.locations
       SET hourly_rate = p_location_hourly_rate
     WHERE id = v_location.id
       AND company_id = p_company_id;
  END IF;

  UPDATE public.contracts
     SET location_id = (p_contract_patch->>'location_id')::uuid,
         name = NULLIF(p_contract_patch->>'name', ''),
         frequency = p_contract_patch->>'frequency',
         interval_days = (p_contract_patch->>'interval_days')::integer,
         weekdays = CASE WHEN p_contract_patch->'weekdays' = 'null'::jsonb THEN NULL ELSE ARRAY(SELECT value::integer FROM jsonb_array_elements_text(p_contract_patch->'weekdays')) END,
         schedule_days = p_contract_patch->'schedule_days',
         starts_on = (p_contract_patch->>'starts_on')::date,
         ends_on = NULLIF(p_contract_patch->>'ends_on', '')::date,
         status = p_contract_patch->>'status',
         notes = NULLIF(p_contract_patch->>'notes', ''),
         cleaning_type = NULLIF(p_contract_patch->>'cleaning_type', ''),
         payment_status = NULLIF(p_contract_patch->>'payment_status', ''),
         upholstery_type = NULLIF(p_contract_patch->>'upholstery_type', ''),
         upholstery_notes = NULLIF(p_contract_patch->>'upholstery_notes', ''),
         upholstery_units = NULLIF(p_contract_patch->>'upholstery_units', '')::numeric,
         upholstery_unit_price = NULLIF(p_contract_patch->>'upholstery_unit_price', '')::numeric,
         fixed_price = NULLIF(p_contract_patch->>'fixed_price', '')::numeric,
         fixed_monthly = COALESCE((p_contract_patch->>'fixed_monthly')::boolean, false),
         apply_vat = COALESCE((p_contract_patch->>'apply_vat')::boolean, false),
         num_people = NULLIF(p_contract_patch->>'num_people', '')::integer
   WHERE id = p_contract_id
     AND company_id = p_company_id;

  -- Um lock por empresa fecha a janela de colisão de reference_number entre
  -- chamadas deste RPC. O cron antigo deve ser migrado para o mesmo protocolo.
  PERFORM pg_advisory_xact_lock(hashtextextended(p_company_id::text, 0));

  FOR v_item IN SELECT * FROM jsonb_array_elements(COALESCE(p_plan, '[]'::jsonb))
  LOOP
    v_decision := v_item->>'decision';
    v_payload := v_item->'payload';
    v_service_id := NULLIF(v_item->>'service_id', '')::uuid;

    IF v_decision = 'CREATE' THEN
      IF v_payload IS NULL OR v_payload = 'null'::jsonb THEN
        RAISE EXCEPTION 'CREATE_WITHOUT_PAYLOAD' USING ERRCODE = '22023';
      END IF;

      IF NOT EXISTS (
        SELECT 1 FROM public.services
         WHERE company_id = p_company_id
           AND contract_id = p_contract_id
           AND scheduled_start = (v_payload->>'scheduled_start')::timestamptz
      ) THEN
        SELECT COALESCE(MAX(NULLIF(regexp_replace(reference_number, '[^0-9]', '', 'g'), '')::bigint), 0) + 1
          INTO v_next_ref
          FROM public.services
         WHERE company_id = p_company_id;

        INSERT INTO public.services (
          company_id, location_id, team_id, contract_id, reference_number,
          scheduled_start, scheduled_end, hourly_rate, calculated_value,
          apply_vat, num_people, status, cleaning_type, payment_status,
          upholstery_type, upholstery_notes, upholstery_units, upholstery_unit_price,
          created_by
        ) VALUES (
          p_company_id, (v_payload->>'location_id')::uuid,
          NULLIF(v_payload->>'team_id', '')::uuid, p_contract_id,
          LPAD(v_next_ref::text, 4, '0'),
          (v_payload->>'scheduled_start')::timestamptz,
          (v_payload->>'scheduled_end')::timestamptz,
          NULLIF(v_payload->>'hourly_rate', '')::numeric,
          NULLIF(v_payload->>'calculated_value', '')::numeric,
          COALESCE((v_payload->>'apply_vat')::boolean, false),
          COALESCE((v_payload->>'num_people')::integer, 1), 'agendado',
          NULLIF(v_payload->>'cleaning_type', ''), NULLIF(v_payload->>'payment_status', ''),
          NULLIF(v_payload->>'upholstery_type', ''), NULLIF(v_payload->>'upholstery_notes', ''),
          NULLIF(v_payload->>'upholstery_units', '')::numeric,
          NULLIF(v_payload->>'upholstery_unit_price', '')::numeric,
          p_actor_id
        );
        v_created := v_created + 1;
      END IF;

    ELSIF v_decision = 'UPDATE_FROM_CONTRACT' THEN
      IF v_service_id IS NULL OR v_payload IS NULL OR v_payload = 'null'::jsonb THEN
        RAISE EXCEPTION 'UPDATE_WITHOUT_ID_OR_PAYLOAD' USING ERRCODE = '22023';
      END IF;

      UPDATE public.services
         SET location_id = (v_payload->>'location_id')::uuid,
             team_id = NULLIF(v_payload->>'team_id', '')::uuid,
             scheduled_start = (v_payload->>'scheduled_start')::timestamptz,
             scheduled_end = (v_payload->>'scheduled_end')::timestamptz,
             hourly_rate = NULLIF(v_payload->>'hourly_rate', '')::numeric,
             calculated_value = NULLIF(v_payload->>'calculated_value', '')::numeric,
             apply_vat = COALESCE((v_payload->>'apply_vat')::boolean, false),
             num_people = COALESCE((v_payload->>'num_people')::integer, 1),
             cleaning_type = NULLIF(v_payload->>'cleaning_type', ''),
             payment_status = NULLIF(v_payload->>'payment_status', ''),
             upholstery_type = NULLIF(v_payload->>'upholstery_type', ''),
             upholstery_notes = NULLIF(v_payload->>'upholstery_notes', ''),
             upholstery_units = NULLIF(v_payload->>'upholstery_units', '')::numeric,
             upholstery_unit_price = NULLIF(v_payload->>'upholstery_unit_price', '')::numeric,
             contract_synced_at = now()
       WHERE id = v_service_id
         AND company_id = p_company_id
         AND contract_id = p_contract_id
         AND status = 'agendado'
         AND is_exception = false;
      IF NOT FOUND THEN
        RAISE EXCEPTION 'SERVICE_STALE_OR_PROTECTED' USING ERRCODE = '40001';
      END IF;
      v_updated := v_updated + 1;

    ELSIF v_decision = 'REMOVE_ORPHAN' THEN
      IF v_service_id IS NULL THEN
        RAISE EXCEPTION 'REMOVE_WITHOUT_ID' USING ERRCODE = '22023';
      END IF;

      DELETE FROM public.services
       WHERE id = v_service_id
         AND company_id = p_company_id
         AND contract_id = p_contract_id
         AND status = 'agendado'
         AND is_exception = false;
      IF NOT FOUND THEN
        RAISE EXCEPTION 'SERVICE_STALE_OR_PROTECTED' USING ERRCODE = '40001';
      END IF;
      v_removed := v_removed + 1;
    ELSE
      RAISE EXCEPTION 'UNKNOWN_PLAN_DECISION' USING ERRCODE = '22023';
    END IF;
  END LOOP;

  IF p_actor_id IS NOT NULL AND p_audit_meta IS NOT NULL THEN
    INSERT INTO public.audit_logs (company_id, actor_id, action, entity_type, entity_id, meta)
    VALUES (p_company_id, p_actor_id,
      COALESCE(p_audit_meta->>'action', 'contract_intervention_updated'),
      'contract', p_contract_id, p_audit_meta - 'action');
  END IF;

  RETURN jsonb_build_object(
    'contract_id', p_contract_id,
    'created', v_created,
    'updated', v_updated,
    'removed', v_removed
  );
END;
$$;

REVOKE ALL ON FUNCTION public.apply_contract_change_atomic(uuid, uuid, timestamptz, jsonb, boolean, numeric, jsonb, uuid, jsonb) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.apply_contract_change_atomic(uuid, uuid, timestamptz, jsonb, boolean, numeric, jsonb, uuid, jsonb) TO service_role;

-- Validação descartável obrigatória antes de qualquer numeração:
-- 1. aplicar em base descartável com schema operacional atual;
-- 2. sucesso: contrato + services + audit_logs ficam todos commitados;
-- 3. introduzir team_id/location_id inválido no item seguinte ao primeiro write;
--    a chamada falha e contrato, services e audit_logs permanecem inalterados;
-- 4. duas sessões com updated_at antigo: a segunda devolve STALE_CONFLICT;
-- 5. verificar que UPDATE não toca is_exception, cancelados ou ocorrências passadas.

-- ============================================================================
-- 062 — DELETE DO CALENDÁRIO ATÓMICO + ACTOR NO HISTÓRICO (auditoria F)
-- ============================================================================
-- Falha 2 da auditoria F: deleteCalendarService fazia delete primeiro e o
-- bookkeeping (excluded_dates / arquivar contrato) depois — se o 2º passo
-- falhasse, ficava estado meio-aplicado e o cron podia recriar o dia apagado.
-- Esta função corre TUDO numa única transação (funções plpgsql são atómicas):
-- qualquer erro → rollback total, nada meio-aplicado.
--
-- Falha 4: data_history.actor vinha sempre null nas escritas via service role
-- (auth.uid() é null). Dentro de uma função JÁ é possível registar o ator:
-- a action passa p_actor e a função publica-o via set_config('app.actor_id')
-- para os triggers de histórico desta transação. fn_capture_history passa a
-- usar COALESCE(app.actor_id, auth.uid()).
-- ============================================================================

-- ────────────────────────────────────────────────────────────────────────────
-- 1. fn_capture_history v3 — actor via app.actor_id com fallback auth.uid()
-- ────────────────────────────────────────────────────────────────────────────

CREATE OR REPLACE FUNCTION public.fn_capture_history()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_old jsonb;
  v_new jsonb;
  v_changed text[];
  v_actor uuid;
BEGIN
  v_actor := COALESCE(
    NULLIF(current_setting('app.actor_id', true), '')::uuid,
    auth.uid()
  );
  v_old := to_jsonb(OLD);

  IF TG_OP = 'DELETE' THEN
    INSERT INTO public.data_history (table_name, row_id, op, old_data, actor, company_id)
    VALUES (
      TG_TABLE_NAME, OLD.id, 'DELETE', v_old, v_actor,
      NULLIF(v_old ->> 'company_id', '')::uuid
    );
    RETURN OLD;
  END IF;

  v_new := to_jsonb(NEW);
  IF v_old IS DISTINCT FROM v_new THEN
    SELECT array_agg(key) INTO v_changed
    FROM jsonb_each(v_new)
    WHERE v_old -> key IS DISTINCT FROM v_new -> key;

    INSERT INTO public.data_history
      (table_name, row_id, op, old_data, new_data, actor, company_id, changed_fields)
    VALUES (
      TG_TABLE_NAME, OLD.id, 'UPDATE', v_old, v_new, v_actor,
      NULLIF(v_new ->> 'company_id', '')::uuid, v_changed
    );
  END IF;
  RETURN NEW;
END;
$$;

-- ────────────────────────────────────────────────────────────────────────────
-- 2. RPC atómica: delete_calendar_service_safe
-- ────────────────────────────────────────────────────────────────────────────
-- Ordem fail-safe DENTRO da transação (e mesmo que algo falhe, rollback total):
--   single: 1º regista excluded_dates no contrato, 2º apaga o serviço;
--   all:    1º arquiva o contrato (status=cancelado), 2º apaga as ocorrências.
-- A autorização (sessão + papel admin/gestor) é feita na server action;
-- esta função valida pertença à empresa passada.

CREATE OR REPLACE FUNCTION public.delete_calendar_service_safe(
  p_service_id uuid,
  p_scope text,
  p_company_id uuid,
  p_actor uuid DEFAULT NULL
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_svc record;
  v_deleted int := 0;
  v_recurring boolean;
  v_date date;
  v_already boolean;
BEGIN
  IF p_scope NOT IN ('single', 'all') THEN
    RAISE EXCEPTION 'scope inválido: %', p_scope;
  END IF;

  -- Ator desta transação → triggers de histórico registam quem foi.
  IF p_actor IS NOT NULL THEN
    PERFORM set_config('app.actor_id', p_actor::text, true);
  END IF;

  SELECT id, contract_id, scheduled_start, location_id
    INTO v_svc
  FROM public.services
  WHERE id = p_service_id AND company_id = p_company_id
  FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Serviço não encontrado (já eliminado ou de outra empresa). Atualize a página.';
  END IF;

  v_recurring := v_svc.contract_id IS NOT NULL;

  IF p_scope = 'all' AND v_svc.contract_id IS NOT NULL THEN
    -- 1º arquivar a recorrência (se falhar, nada foi apagado)
    UPDATE public.contracts
       SET status = 'cancelado'
     WHERE id = v_svc.contract_id AND company_id = p_company_id;
    IF NOT FOUND THEN
      RAISE EXCEPTION 'Não foi possível arquivar a recorrência — nada foi eliminado.';
    END IF;

    -- 2º apagar todas as ocorrências
    DELETE FROM public.services
     WHERE company_id = p_company_id AND contract_id = v_svc.contract_id;
    GET DIAGNOSTICS v_deleted = ROW_COUNT;
    IF v_deleted = 0 THEN
      RAISE EXCEPTION 'Nada foi eliminado — nenhuma alteração aplicada.';
    END IF;
  ELSE
    -- single: 1º registar a data como exceção permanente no contrato
    IF v_svc.contract_id IS NOT NULL THEN
      -- excluded_dates é date[]; a data da ocorrência em hora de Lisboa.
      v_date := (v_svc.scheduled_start AT TIME ZONE 'Europe/Lisbon')::date;
      SELECT v_date = ANY(COALESCE(excluded_dates, '{}')) INTO v_already
        FROM public.contracts
       WHERE id = v_svc.contract_id AND company_id = p_company_id
       FOR UPDATE;
      IF NOT FOUND THEN
        RAISE EXCEPTION 'Contrato da ocorrência não encontrado — nada foi eliminado.';
      END IF;
      IF NOT COALESCE(v_already, false) THEN
        UPDATE public.contracts
           SET excluded_dates = array_append(COALESCE(excluded_dates, '{}'), v_date)
         WHERE id = v_svc.contract_id AND company_id = p_company_id;
      END IF;
    END IF;

    -- 2º apagar a ocorrência
    DELETE FROM public.services
     WHERE id = p_service_id AND company_id = p_company_id;
    GET DIAGNOSTICS v_deleted = ROW_COUNT;
    IF v_deleted = 0 THEN
      RAISE EXCEPTION 'Nada foi eliminado — nenhuma alteração aplicada (rollback total).';
    END IF;
  END IF;

  RETURN jsonb_build_object(
    'deleted', v_deleted,
    'recurring', v_recurring,
    'location_id', v_svc.location_id,
    'contract_id', v_svc.contract_id
  );
END;
$$;

-- Só chamável com service role (as server actions); nunca pelo browser.
REVOKE ALL ON FUNCTION public.delete_calendar_service_safe(uuid, text, uuid, uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.delete_calendar_service_safe(uuid, text, uuid, uuid) FROM anon, authenticated;

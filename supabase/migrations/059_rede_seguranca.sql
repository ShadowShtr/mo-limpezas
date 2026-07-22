-- ============================================================================
-- 059 — REDE DE SEGURANÇA (rota de fuga contra perda/reversão de dados)
-- ============================================================================
-- Três proteções ao nível da BASE DE DADOS, independentes do código da app —
-- funcionam mesmo que um bug novo apareça no site, num script ou em SQL manual:
--
--   1. HISTÓRICO UNIVERSAL (data_history): todo UPDATE/DELETE em tabelas
--      críticas guarda o estado ANTERIOR completo. Nada se perde de forma
--      irrecuperável; qualquer valor pode ser restaurado
--      (ver scripts/restore-from-history.mjs).
--
--   2. EXCEÇÕES AUTOMÁTICAS (services.is_exception): qualquer edição manual
--      de horário/equipa/valor num serviço de contrato marca is_exception=true
--      NA PRÓPRIA BASE — a reescrita automática do contrato nunca mais pode
--      reverter uma edição manual, venha ela do site, de um script ou de SQL.
--      A sincronização legítima do contrato declara-se preenchendo
--      services.contract_synced_at (nova coluna) no mesmo UPDATE.
--
--   3. GUARDA DO VALOR/HORA (locations.hourly_rate): a base RECUSA apagar o
--      valor/hora de um local que tenha contrato por hora ativo (foi assim que
--      39 locais ficaram a calcular serviços de 0€).
-- ============================================================================

-- ────────────────────────────────────────────────────────────────────────────
-- 1. HISTÓRICO UNIVERSAL
-- ────────────────────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS public.data_history (
  id          bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  table_name  text        NOT NULL,
  row_id      uuid        NOT NULL,
  op          text        NOT NULL CHECK (op IN ('UPDATE', 'DELETE')),
  old_data    jsonb       NOT NULL,  -- estado ANTES da alteração (sempre)
  new_data    jsonb,                 -- estado DEPOIS (só em UPDATE)
  actor       uuid,                  -- auth.uid() quando disponível (null = service role/SQL)
  changed_at  timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_data_history_row
  ON public.data_history (table_name, row_id, changed_at DESC);
CREATE INDEX IF NOT EXISTS idx_data_history_changed
  ON public.data_history (changed_at);

-- Só o service role acede (RLS ativa sem policies). A função de captura é
-- SECURITY DEFINER para que escritas feitas por utilizadores autenticados
-- (via RLS) também consigam gravar histórico.
ALTER TABLE public.data_history ENABLE ROW LEVEL SECURITY;

CREATE OR REPLACE FUNCTION public.fn_capture_history()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    INSERT INTO public.data_history (table_name, row_id, op, old_data, actor)
    VALUES (TG_TABLE_NAME, OLD.id, 'DELETE', to_jsonb(OLD), auth.uid());
    RETURN OLD;
  END IF;

  -- UPDATE: só regista se algo mudou de facto (evita ruído de updates no-op)
  IF to_jsonb(OLD) IS DISTINCT FROM to_jsonb(NEW) THEN
    INSERT INTO public.data_history (table_name, row_id, op, old_data, new_data, actor)
    VALUES (TG_TABLE_NAME, OLD.id, 'UPDATE', to_jsonb(OLD), to_jsonb(NEW), auth.uid());
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_history ON public.clients;
CREATE TRIGGER trg_history AFTER UPDATE OR DELETE ON public.clients
  FOR EACH ROW EXECUTE FUNCTION public.fn_capture_history();

DROP TRIGGER IF EXISTS trg_history ON public.locations;
CREATE TRIGGER trg_history AFTER UPDATE OR DELETE ON public.locations
  FOR EACH ROW EXECUTE FUNCTION public.fn_capture_history();

DROP TRIGGER IF EXISTS trg_history ON public.contracts;
CREATE TRIGGER trg_history AFTER UPDATE OR DELETE ON public.contracts
  FOR EACH ROW EXECUTE FUNCTION public.fn_capture_history();

DROP TRIGGER IF EXISTS trg_history ON public.services;
CREATE TRIGGER trg_history AFTER UPDATE OR DELETE ON public.services
  FOR EACH ROW EXECUTE FUNCTION public.fn_capture_history();

DROP TRIGGER IF EXISTS trg_history ON public.invoices;
CREATE TRIGGER trg_history AFTER UPDATE OR DELETE ON public.invoices
  FOR EACH ROW EXECUTE FUNCTION public.fn_capture_history();

DROP TRIGGER IF EXISTS trg_history ON public.invoice_items;
CREATE TRIGGER trg_history AFTER UPDATE OR DELETE ON public.invoice_items
  FOR EACH ROW EXECUTE FUNCTION public.fn_capture_history();

-- ────────────────────────────────────────────────────────────────────────────
-- 2. EXCEÇÕES AUTOMÁTICAS EM SERVIÇOS DE CONTRATO
-- ────────────────────────────────────────────────────────────────────────────
-- A sincronização legítima (updateFutureServiceValuesForContract) preenche
-- contract_synced_at no seu UPDATE — o trigger reconhece-a e não mexe.
-- Qualquer OUTRO update que altere horário/equipa/valor de um serviço de
-- contrato é, por definição, uma edição manual → is_exception = true.

ALTER TABLE public.services
  ADD COLUMN IF NOT EXISTS contract_synced_at timestamptz;

COMMENT ON COLUMN public.services.contract_synced_at IS
  'Preenchido pela sincronização automática do contrato. Serve de marcador para o trigger trg_services_mark_exception distinguir sync legítima de edição manual.';

CREATE OR REPLACE FUNCTION public.fn_services_mark_exception()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  -- Sincronização declarada pelo contrato → não é edição manual.
  IF NEW.contract_synced_at IS DISTINCT FROM OLD.contract_synced_at THEN
    RETURN NEW;
  END IF;

  IF NEW.contract_id IS NOT NULL
     AND COALESCE(NEW.is_exception, false) = false
     AND (
       NEW.scheduled_start IS DISTINCT FROM OLD.scheduled_start OR
       NEW.scheduled_end   IS DISTINCT FROM OLD.scheduled_end   OR
       NEW.team_id         IS DISTINCT FROM OLD.team_id         OR
       NEW.manual_value    IS DISTINCT FROM OLD.manual_value    OR
       NEW.apply_vat       IS DISTINCT FROM OLD.apply_vat       OR
       NEW.num_people      IS DISTINCT FROM OLD.num_people
     )
  THEN
    NEW.is_exception := true;
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_services_mark_exception ON public.services;
CREATE TRIGGER trg_services_mark_exception BEFORE UPDATE ON public.services
  FOR EACH ROW EXECUTE FUNCTION public.fn_services_mark_exception();

-- ────────────────────────────────────────────────────────────────────────────
-- 3. GUARDA DO VALOR/HORA DO LOCAL
-- ────────────────────────────────────────────────────────────────────────────
-- Recusa hourly_rate NOT NULL → NULL enquanto houver contrato POR HORA ativo
-- no local. Para uma operação consciente (ex.: restauro/manutenção), correr
-- antes na mesma sessão SQL:  SET app.allow_unsafe = 'on';

CREATE OR REPLACE FUNCTION public.fn_guard_location_rate()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  IF OLD.hourly_rate IS NOT NULL AND NEW.hourly_rate IS NULL THEN
    IF current_setting('app.allow_unsafe', true) = 'on' THEN
      RETURN NEW;
    END IF;
    IF EXISTS (
      SELECT 1 FROM public.contracts c
      WHERE c.location_id = NEW.id
        AND c.status = 'ativo'
        AND c.fixed_monthly = false
        AND (c.fixed_price IS NULL OR c.fixed_price = 0)
    ) THEN
      RAISE EXCEPTION
        'Bloqueado pela rede de segurança: este local tem contrato POR HORA ativo — apagar o valor/hora deixaria os serviços a calcular 0 EUR. Termine ou ajuste o contrato primeiro.';
    END IF;
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_guard_location_rate ON public.locations;
CREATE TRIGGER trg_guard_location_rate BEFORE UPDATE ON public.locations
  FOR EACH ROW EXECUTE FUNCTION public.fn_guard_location_rate();

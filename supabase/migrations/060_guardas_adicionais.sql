-- ============================================================================
-- 060 — GUARDAS ADICIONAIS (complementa a rede de segurança da 059)
-- ============================================================================
-- Três reforços validados da proposta "rota de fuga em 7 camadas":
--
--   1. AVENÇA NUNCA FICA SEM VALOR: trigger recusa fixed_price → null/0 num
--      contrato de avença mensal ativo (mesmo que um formulário bugado o envie).
--
--   2. AVENÇA DUPLICADA É IMPOSSÍVEL: constraint de exclusão (EXCLUDE) impede
--      dois contratos fixed_monthly ativos no mesmo local com períodos
--      sobrepostos — ao nível do Postgres, nenhum código consegue contornar.
--
--   3. HISTÓRICO MAIS RICO: data_history ganha company_id e changed_fields
--      (lista das colunas alteradas) para alimentar o painel de recuperação
--      em /dashboard/sistema/auditoria com filtros úteis.
-- ============================================================================

-- ────────────────────────────────────────────────────────────────────────────
-- 1. GUARDA DO VALOR DA AVENÇA
-- ────────────────────────────────────────────────────────────────────────────
-- Escape consciente para manutenção: SET app.allow_unsafe = 'on';

CREATE OR REPLACE FUNCTION public.fn_guard_contract_fixed_price()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF current_setting('app.allow_unsafe', true) = 'on' THEN
    RETURN NEW;
  END IF;

  IF NEW.fixed_monthly = true
     AND NEW.status = 'ativo'
     AND OLD.fixed_price IS NOT NULL AND OLD.fixed_price > 0
     AND (NEW.fixed_price IS NULL OR NEW.fixed_price = 0)
  THEN
    RAISE EXCEPTION
      'Bloqueado pela rede de segurança: um contrato de avença mensal ATIVO não pode ficar sem valor (fixed_price %.2f -> vazio). Se a intenção é terminar a avença, altere primeiro o tipo de faturação ou o estado do contrato.',
      OLD.fixed_price;
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_guard_contract_fixed_price ON public.contracts;
CREATE TRIGGER trg_guard_contract_fixed_price BEFORE UPDATE ON public.contracts
  FOR EACH ROW EXECUTE FUNCTION public.fn_guard_contract_fixed_price();

-- ────────────────────────────────────────────────────────────────────────────
-- 2. AVENÇA DUPLICADA IMPOSSÍVEL (constraint de exclusão)
-- ────────────────────────────────────────────────────────────────────────────
-- O código já valida (hasOverlappingMonthlyContract) — isto garante que nem
-- SQL manual nem código futuro conseguem criar o duplicado. A auditoria de
-- 2026-07-22 confirmou 0 duplicados existentes, por isso a constraint valida.

CREATE EXTENSION IF NOT EXISTS btree_gist;

DO $$
BEGIN
  ALTER TABLE public.contracts
    ADD CONSTRAINT contracts_no_duplicate_monthly
    EXCLUDE USING gist (
      location_id WITH =,
      daterange(starts_on, COALESCE(ends_on, 'infinity'::date), '[]') WITH &&
    )
    WHERE (status = 'ativo' AND fixed_monthly = true);
EXCEPTION
  WHEN duplicate_object THEN NULL;  -- já existe (migração re-aplicada)
END $$;

-- ────────────────────────────────────────────────────────────────────────────
-- 3. HISTÓRICO MAIS RICO (company_id + changed_fields)
-- ────────────────────────────────────────────────────────────────────────────

ALTER TABLE public.data_history ADD COLUMN IF NOT EXISTS company_id uuid;
ALTER TABLE public.data_history ADD COLUMN IF NOT EXISTS changed_fields text[];

CREATE INDEX IF NOT EXISTS idx_data_history_company
  ON public.data_history (company_id, changed_at DESC);

-- Recria a função de captura preenchendo os campos novos.
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
BEGIN
  v_old := to_jsonb(OLD);

  IF TG_OP = 'DELETE' THEN
    INSERT INTO public.data_history (table_name, row_id, op, old_data, actor, company_id)
    VALUES (
      TG_TABLE_NAME, OLD.id, 'DELETE', v_old, auth.uid(),
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
      TG_TABLE_NAME, OLD.id, 'UPDATE', v_old, v_new, auth.uid(),
      NULLIF(v_new ->> 'company_id', '')::uuid, v_changed
    );
  END IF;
  RETURN NEW;
END;
$$;

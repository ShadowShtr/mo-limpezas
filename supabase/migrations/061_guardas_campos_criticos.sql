-- ============================================================================
-- 061 — GUARDAS DE CAMPOS CRÍTICOS (resposta à Falha 4 da auditoria E)
-- ============================================================================
-- Bloqueia ao nível do banco os apagamentos que NUNCA são legítimos, com o
-- mesmo escape consciente das guardas anteriores (SET app.allow_unsafe = 'on').
--
-- DECISÃO DE DESENHO (porquê NÃO bloquear tudo o que a proposta pedia):
-- campos como clients.notes/type, contracts.cleaning_type/payment_status,
-- services.manual_value têm fluxos LEGÍTIMOS de limpeza/alternância na UI
-- (limpar notas, tirar o valor manual para voltar ao calculado, mudar estado
-- de pagamento). Bloqueá-los no banco partiria o uso normal. A proteção deles
-- é em três camadas que já existem: (1) requireAll anti-undefined nas server
-- actions; (2) histórico universal com restauro em 1 clique; (3) auditLog.
--
-- O que ESTA migração bloqueia (null-out nunca é legítimo aqui):
--   1. contracts.schedule_days → null/[] num contrato ATIVO
--      (sem padrão de dias, a geração de serviços fica silenciosamente morta);
--   2. locations.pricing_type → null (o local perde o modo de faturação);
--   3. locations.fixed_price → null num local com pricing_type='fixed'
--      (espelho da guarda do hourly_rate para locais de preço fixo).
-- ============================================================================

CREATE OR REPLACE FUNCTION public.fn_guard_contract_schedule()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF current_setting('app.allow_unsafe', true) = 'on' THEN
    RETURN NEW;
  END IF;

  IF NEW.status = 'ativo'
     AND OLD.schedule_days IS NOT NULL
     AND jsonb_array_length(to_jsonb(OLD.schedule_days)) > 0
     AND (NEW.schedule_days IS NULL OR jsonb_array_length(to_jsonb(NEW.schedule_days)) = 0)
  THEN
    RAISE EXCEPTION
      'Bloqueado pela rede de segurança: um contrato ATIVO não pode ficar sem padrão de dias (schedule_days) — a geração de serviços morreria em silêncio. Termine o contrato primeiro se for essa a intenção.';
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_guard_contract_schedule ON public.contracts;
CREATE TRIGGER trg_guard_contract_schedule BEFORE UPDATE ON public.contracts
  FOR EACH ROW EXECUTE FUNCTION public.fn_guard_contract_schedule();

CREATE OR REPLACE FUNCTION public.fn_guard_location_pricing()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF current_setting('app.allow_unsafe', true) = 'on' THEN
    RETURN NEW;
  END IF;

  IF OLD.pricing_type IS NOT NULL AND NEW.pricing_type IS NULL THEN
    RAISE EXCEPTION
      'Bloqueado pela rede de segurança: o modo de faturação do local (pricing_type) não pode ser apagado — escolha outro modo em vez de o deixar vazio.';
  END IF;

  IF NEW.pricing_type = 'fixed'
     AND OLD.fixed_price IS NOT NULL
     AND NEW.fixed_price IS NULL
  THEN
    RAISE EXCEPTION
      'Bloqueado pela rede de segurança: um local com faturação de preço FIXO não pode ficar sem fixed_price (%.2f -> vazio) — os serviços passariam a 0 EUR.',
      OLD.fixed_price;
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_guard_location_pricing ON public.locations;
CREATE TRIGGER trg_guard_location_pricing BEFORE UPDATE ON public.locations
  FOR EACH ROW EXECUTE FUNCTION public.fn_guard_location_pricing();

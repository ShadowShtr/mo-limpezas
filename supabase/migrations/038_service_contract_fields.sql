-- 038 — Tipo de limpeza, estado de pagamento e detalhes de estofos
-- Acrescenta campos descritivos a contratos e serviços para suportar o wizard de
-- contratos e a criação rápida de serviços pelo calendário.
--
-- Todos os campos são NULLABLE e sem default obrigatório: contratos/serviços
-- antigos continuam válidos com valor NULL. Sem remoção de dados.
--
-- cleaning_type    — categoria comercial da limpeza (distinta de locations.service_type)
-- payment_status   — lembrete de sinal/total (Geral e Pós-Obra)
-- upholstery_type  — tipo de estofado (apenas Estofos)
-- upholstery_notes — especificação livre do estofado (apenas Estofos)

-- ── Contratos ────────────────────────────────────────────────────────────────
ALTER TABLE contracts ADD COLUMN IF NOT EXISTS cleaning_type    TEXT;
ALTER TABLE contracts ADD COLUMN IF NOT EXISTS payment_status   TEXT;
ALTER TABLE contracts ADD COLUMN IF NOT EXISTS upholstery_type  TEXT;
ALTER TABLE contracts ADD COLUMN IF NOT EXISTS upholstery_notes TEXT;

-- ── Serviços ─────────────────────────────────────────────────────────────────
ALTER TABLE services ADD COLUMN IF NOT EXISTS cleaning_type    TEXT;
ALTER TABLE services ADD COLUMN IF NOT EXISTS payment_status   TEXT;
ALTER TABLE services ADD COLUMN IF NOT EXISTS upholstery_type  TEXT;
ALTER TABLE services ADD COLUMN IF NOT EXISTS upholstery_notes TEXT;

-- Restrições de domínio (permitem NULL → não quebram registos existentes).
DO $$ BEGIN
  ALTER TABLE contracts ADD CONSTRAINT contracts_cleaning_type_chk
    CHECK (cleaning_type IS NULL OR cleaning_type IN (
      'manutencao', 'manutencao_lisboa', 'pos_obra', 'pos_obra_lisboa',
      'geral', 'geral_lisboa', 'estofos'));
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  ALTER TABLE contracts ADD CONSTRAINT contracts_payment_status_chk
    CHECK (payment_status IS NULL OR payment_status IN (
      'nao_informado', 'sinal_50', 'pago_total'));
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  ALTER TABLE contracts ADD CONSTRAINT contracts_upholstery_type_chk
    CHECK (upholstery_type IS NULL OR upholstery_type IN (
      'sofa', 'poltrona', 'cadeira', 'tapete', 'colchao', 'outro'));
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  ALTER TABLE services ADD CONSTRAINT services_cleaning_type_chk
    CHECK (cleaning_type IS NULL OR cleaning_type IN (
      'manutencao', 'manutencao_lisboa', 'pos_obra', 'pos_obra_lisboa',
      'geral', 'geral_lisboa', 'estofos'));
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  ALTER TABLE services ADD CONSTRAINT services_payment_status_chk
    CHECK (payment_status IS NULL OR payment_status IN (
      'nao_informado', 'sinal_50', 'pago_total'));
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  ALTER TABLE services ADD CONSTRAINT services_upholstery_type_chk
    CHECK (upholstery_type IS NULL OR upholstery_type IN (
      'sofa', 'poltrona', 'cadeira', 'tapete', 'colchao', 'outro'));
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

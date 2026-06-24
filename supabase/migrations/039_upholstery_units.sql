-- 039 — Estofos por unidade: quantidade × preço unitário
-- Acrescenta o tipo de estofado "unidade" e os campos para calcular o valor
-- (nº de unidades × preço por unidade) em contratos e serviços.
-- Campos NULLABLE — registos antigos continuam válidos.

-- ── Novas colunas ────────────────────────────────────────────────────────────
ALTER TABLE contracts ADD COLUMN IF NOT EXISTS upholstery_units      INTEGER;
ALTER TABLE contracts ADD COLUMN IF NOT EXISTS upholstery_unit_price NUMERIC(10,2);
ALTER TABLE services  ADD COLUMN IF NOT EXISTS upholstery_units      INTEGER;
ALTER TABLE services  ADD COLUMN IF NOT EXISTS upholstery_unit_price NUMERIC(10,2);

-- ── Atualizar o CHECK de upholstery_type para incluir 'unidade' ──────────────
ALTER TABLE contracts DROP CONSTRAINT IF EXISTS contracts_upholstery_type_chk;
ALTER TABLE services  DROP CONSTRAINT IF EXISTS services_upholstery_type_chk;

DO $$ BEGIN
  ALTER TABLE contracts ADD CONSTRAINT contracts_upholstery_type_chk
    CHECK (upholstery_type IS NULL OR upholstery_type IN (
      'sofa', 'poltrona', 'cadeira', 'tapete', 'colchao', 'unidade', 'outro'));
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  ALTER TABLE services ADD CONSTRAINT services_upholstery_type_chk
    CHECK (upholstery_type IS NULL OR upholstery_type IN (
      'sofa', 'poltrona', 'cadeira', 'tapete', 'colchao', 'unidade', 'outro'));
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

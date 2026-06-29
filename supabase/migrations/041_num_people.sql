-- 041 — Valor por nº de pessoas da equipa
-- O valor/hora é cobrado POR colaboradora: 12€/h com 3 pessoas = 36€/h.
-- contracts.num_people  → override manual (NULL = usar o tamanho da equipa atribuída).
-- services.num_people   → nº de pessoas efetivamente usado no cálculo da ocorrência.
-- Campos compatíveis com registos antigos (default 1).

ALTER TABLE contracts ADD COLUMN IF NOT EXISTS num_people INTEGER;
ALTER TABLE services  ADD COLUMN IF NOT EXISTS num_people INTEGER NOT NULL DEFAULT 1;

COMMENT ON COLUMN contracts.num_people IS
  'Override do nº de pessoas que multiplica o valor/hora. NULL = usar o tamanho da equipa.';
COMMENT ON COLUMN services.num_people IS
  'Nº de pessoas usado no cálculo do valor desta ocorrência (>= 1).';

-- Garante coerência: nunca menos de 1 pessoa.
DO $$ BEGIN
  ALTER TABLE services ADD CONSTRAINT services_num_people_chk CHECK (num_people >= 1);
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  ALTER TABLE contracts ADD CONSTRAINT contracts_num_people_chk
    CHECK (num_people IS NULL OR num_people >= 1);
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

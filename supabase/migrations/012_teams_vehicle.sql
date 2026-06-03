-- ============================================================
-- MIGRATION 012: adicionar coluna vehicle à tabela teams
-- Regista a viatura atribuída a cada equipa para o dia
-- ============================================================

ALTER TABLE teams ADD COLUMN IF NOT EXISTS vehicle VARCHAR(50);

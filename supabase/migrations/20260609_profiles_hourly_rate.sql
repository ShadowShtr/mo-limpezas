-- Migration: adicionar hourly_rate à tabela profiles
-- Esta coluna é usada para calcular a folha de pagamento por colaborador.
-- Se não estiver definida, o sistema usa o valor padrão da empresa.

ALTER TABLE profiles
  ADD COLUMN IF NOT EXISTS hourly_rate NUMERIC(8,2) DEFAULT NULL;

COMMENT ON COLUMN profiles.hourly_rate IS
  'Taxa horária individual. Se NULL, usa o valor padrão definido em company_settings.';

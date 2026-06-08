-- =====================================================================
-- Migração: Limites horários para bater ponto (2026-06-09)
-- Correr no Supabase Dashboard > SQL Editor
-- =====================================================================

-- Adicionar colunas à company_settings para controlar janela de ponto
ALTER TABLE company_settings
  ADD COLUMN IF NOT EXISTS checkin_before_minutes integer NOT NULL DEFAULT 40,
  ADD COLUMN IF NOT EXISTS checkout_after_minutes integer NOT NULL DEFAULT 60;

-- Comentários descritivos
COMMENT ON COLUMN company_settings.checkin_before_minutes IS
  'Minutos antes do scheduled_start que o colaborador pode fazer clock-in (padrão: 40)';
COMMENT ON COLUMN company_settings.checkout_after_minutes IS
  'Minutos após o scheduled_end que o sistema força clock-out automático (padrão: 60)';

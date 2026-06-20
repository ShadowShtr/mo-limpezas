-- ============================================================
-- MIGRATION 032: Campos de saída manual e distância no clock-out
-- Simetria com manual_checkin / gps_accuracy_m já existentes (migration 025).
-- Permite ao relatório distinguir entradas e saídas manuais,
-- e à gestora ver aviso de distância no checkout.
-- ============================================================

ALTER TABLE timesheets
  ADD COLUMN IF NOT EXISTS manual_checkout            BOOLEAN NOT NULL DEFAULT FALSE,
  ADD COLUMN IF NOT EXISTS clock_out_distance_m       INTEGER,
  ADD COLUMN IF NOT EXISTS clock_out_accuracy_m       INTEGER,
  ADD COLUMN IF NOT EXISTS clock_out_location_warning BOOLEAN NOT NULL DEFAULT FALSE;

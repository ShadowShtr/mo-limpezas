-- ============================================================
-- MIGRATION 019: Campos de cancelamento em services
-- ============================================================

ALTER TABLE services
  ADD COLUMN IF NOT EXISTS cancel_type      TEXT CHECK (cancel_type IN (
    'client_request', 'weather', 'operational', 'equipment', 'other'
  )),
  ADD COLUMN IF NOT EXISTS cancel_reason    TEXT,
  ADD COLUMN IF NOT EXISTS cancelled_at     TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS cancelled_by     UUID REFERENCES profiles(id),
  ADD COLUMN IF NOT EXISTS is_late_cancel   BOOLEAN DEFAULT FALSE;

COMMENT ON COLUMN services.cancel_type IS 'Motivo de cancelamento: client_request | weather | operational | equipment | other';
COMMENT ON COLUMN services.is_late_cancel IS 'TRUE quando cancelado com menos de 24h de antecedência';

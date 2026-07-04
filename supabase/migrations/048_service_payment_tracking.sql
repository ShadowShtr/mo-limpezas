-- 048 — Controlo diário de cobrança por serviço
--
-- paid_amount: valor efetivamente recebido deste serviço (entrada parcial ou
--   total). NULL = nada registado. Permite registar valores livres além dos
--   estados 50%/100% (payment_status já existe desde 038).
-- paid_at: quando o pagamento foi registado/atualizado pela última vez. Permite
--   distinguir "limpeza de dia 2, paga dia 3" no acompanhamento diário.

ALTER TABLE services
  ADD COLUMN IF NOT EXISTS paid_amount numeric(10,2),
  ADD COLUMN IF NOT EXISTS paid_at timestamptz;

COMMENT ON COLUMN services.paid_amount IS 'Valor recebido (entrada parcial ou total); NULL = nada registado';
COMMENT ON COLUMN services.paid_at IS 'Última atualização do estado de pagamento';

-- Índice para a lista de pendentes (serviços passados ainda não pagos a 100%)
CREATE INDEX IF NOT EXISTS idx_services_payment_pending
  ON services (company_id, payment_status, scheduled_start);

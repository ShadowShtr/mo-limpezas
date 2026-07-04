-- Permite reference_type = 'service_payment' em cash_flow_entries: espelha o
-- pagamento registado na Cobrança Diária (daily-billing.ts:setServicePayment),
-- que antes marcava services.payment_status como pago sem nunca criar um
-- lançamento correspondente no Fluxo de Caixa (auditoria 2026-07-04, item
-- crítico 10.1 do AUDITORIA_COMPLETA.txt).
ALTER TABLE cash_flow_entries
  DROP CONSTRAINT IF EXISTS cash_flow_entries_reference_type_check;

ALTER TABLE cash_flow_entries
  ADD CONSTRAINT cash_flow_entries_reference_type_check
  CHECK (reference_type IN ('invoice', 'payroll', 'service_payment'));

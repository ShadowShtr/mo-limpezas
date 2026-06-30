-- 045 — IVA por serviço
-- Permite marcar, por serviço, se é faturado com IVA. Default = true (mantém o
-- comportamento atual: todos os serviços levam IVA na fatura, exceto clientes
-- isentos). Quando false, a fatura não soma IVA para esse serviço.

ALTER TABLE services
  ADD COLUMN IF NOT EXISTS apply_vat boolean NOT NULL DEFAULT true;

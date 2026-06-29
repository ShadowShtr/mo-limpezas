-- 044 — Valor fixo nos contratos
-- Permite faturar um contrato por VALOR FIXO por serviço (em vez de valor/hora).
-- Quando fixed_price > 0, cada ocorrência gerada usa esse valor como
-- calculated_value e ignora o cálculo por hora.

ALTER TABLE contracts
  ADD COLUMN IF NOT EXISTS fixed_price numeric(10,2);

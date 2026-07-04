-- 046 — IVA no contrato + mecânica de faturação por valor fixo mensal
--
-- apply_vat: liga/desliga o IVA ao nível do contrato (chavinha). Propaga-se aos
--   serviços gerados (services.apply_vat) e a faturação já respeita esse campo.
--   Default = false (contratos novos começam sem IVA; liga-se quando é preciso).
--
-- fixed_monthly: mecânica de faturação do contrato.
--   false (default) = por hora / por-serviço (comportamento atual).
--   true  = valor fixo MENSAL (avença). Reutiliza a coluna fixed_price como o
--           valor mensal. Os serviços continuam a ser gerados no calendário nos
--           dias/horas do contrato, mas com valor 0 — a faturação passa a ser uma
--           única linha mensal (dia 1 ao fim do mês), independente do nº de serviços.

ALTER TABLE contracts
  ADD COLUMN IF NOT EXISTS apply_vat     boolean NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS fixed_monthly boolean NOT NULL DEFAULT false;

-- 047 — Datas excluídas de um contrato (exceções permanentes)
--
-- Quando se apaga UMA ocorrência de um contrato recorrente ("Excluir só este dia"),
-- a data fica registada aqui. A geração de serviços (cron mensal e ao editar o
-- contrato) passa a saltar estas datas, por isso o dia nunca é recriado.

ALTER TABLE contracts
  ADD COLUMN IF NOT EXISTS excluded_dates date[] NOT NULL DEFAULT '{}';

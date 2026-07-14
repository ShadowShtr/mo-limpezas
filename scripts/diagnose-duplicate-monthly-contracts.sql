-- Diagnóstico: contratos de avença mensal (fixed_monthly) ATIVOS duplicados
-- para o mesmo local — causa da cobrança duplicada (ex.: "Parque Norte /
-- Alvorada Principal" com duas linhas de 542,62€ na mesma fatura).
--
-- Correr no SQL Editor do Supabase. Ajustar as datas do período se necessário.

SELECT
  cli.name AS cliente,
  loc.name AS local,
  c.location_id,
  c.fixed_price,
  c.apply_vat,
  COUNT(*) AS contratos_ativos,
  ARRAY_AGG(c.id ORDER BY c.created_at) AS contratos_ids,
  ARRAY_AGG(c.starts_on || ' até ' || COALESCE(c.ends_on::text, 'sem fim') ORDER BY c.created_at) AS periodos
FROM contracts c
JOIN locations loc ON loc.id = c.location_id
JOIN clients cli ON cli.id = loc.client_id
WHERE c.status = 'ativo'
  AND c.fixed_monthly = true
  AND c.fixed_price IS NOT NULL
  AND c.fixed_price > 0
  AND c.starts_on <= DATE '2026-07-31'
  AND (c.ends_on IS NULL OR c.ends_on >= DATE '2026-07-01')
GROUP BY
  cli.name,
  loc.name,
  c.location_id,
  c.fixed_price,
  c.apply_vat
HAVING COUNT(*) > 1
ORDER BY cli.name, loc.name;

-- Correção manual (depois de confirmar visualmente qual dos IDs é o antigo/
-- errado — NÃO corre automaticamente, é só um exemplo com placeholder):
--
-- UPDATE contracts
-- SET
--   status = 'cancelado',
--   ends_on = DATE '2026-06-30',
--   updated_at = NOW()
-- WHERE id = 'ID_DO_CONTRATO_DUPLICADO';

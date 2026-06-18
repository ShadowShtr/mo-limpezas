-- Migration 026: chave física vs código do prédio por morada
-- - has_key: a equipa tem/leva uma chave física do local
-- - key_label: etiqueta/identificação da chave (ex: "Chave nº 1974")
-- access_code mantém-se como o CÓDIGO do prédio/porta.
-- Recria a view services_full para expor os novos campos à app móvel e ao calendário.

ALTER TABLE locations ADD COLUMN IF NOT EXISTS has_key BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE locations ADD COLUMN IF NOT EXISTS key_label TEXT;

CREATE OR REPLACE VIEW services_full AS
SELECT
  s.id,
  s.company_id,
  s.reference_number,
  s.scheduled_start,
  s.scheduled_end,
  s.actual_start,
  s.actual_end,
  s.status,
  s.notes,
  s.calculated_value,
  s.manual_value,
  s.contract_id,
  s.is_exception,

  -- Location
  l.id           AS location_id,
  l.name         AS location_name,
  l.address      AS location_address,
  l.lat          AS location_lat,
  l.lng          AS location_lng,
  l.access_code  AS location_access_code,
  l.instructions AS location_instructions,

  -- Client
  c.id           AS client_id,
  c.name         AS client_name,
  c.phone        AS client_phone,
  c.email        AS client_email,

  -- Team
  t.id           AS team_id,
  t.name         AS team_name,
  t.color        AS team_color,

  -- Novos campos (acrescentados no fim: CREATE OR REPLACE VIEW não permite
  -- inserir colunas no meio de uma view já existente)
  l.has_key      AS location_has_key,
  l.key_label    AS location_key_label

FROM services s
JOIN locations l ON s.location_id = l.id
JOIN clients c ON l.client_id = c.id
LEFT JOIN teams t ON s.team_id = t.id;

-- Migration 020: adicionar client_phone + client_email à view services_full
-- Necessário para WhatsApp no painel de cancelamento e email no painel de notificações

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
  t.color        AS team_color

FROM services s
JOIN locations l ON s.location_id = l.id
JOIN clients c ON l.client_id = c.id
LEFT JOIN teams t ON s.team_id = t.id;

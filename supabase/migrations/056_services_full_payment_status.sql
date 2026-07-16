-- Expõe payment_status na view services_full — o calendário passa a mostrar
-- e permitir alterar o estado de pagamento (N/I · 50% · 100%) direto no card
-- do serviço, sem abrir o painel de detalhe. CREATE OR REPLACE VIEW só pode
-- acrescentar colunas no fim, por isso repete a definição completa da
-- migration 030 (a mais recente) com payment_status adicionado no fim.
CREATE OR REPLACE VIEW services_full
WITH (security_invoker = true)
AS
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
  l.has_key      AS location_has_key,
  l.key_label    AS location_key_label,

  -- Client
  c.id           AS client_id,
  c.name         AS client_name,
  c.phone        AS client_phone,
  c.email        AS client_email,

  -- Team
  t.id           AS team_id,
  t.name         AS team_name,
  t.color        AS team_color,

  -- Pagamento (novo)
  s.payment_status

FROM services s
JOIN locations l ON s.location_id = l.id
JOIN clients c ON l.client_id = c.id
LEFT JOIN teams t ON s.team_id = t.id;

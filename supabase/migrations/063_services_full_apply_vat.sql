-- Expõe apply_vat na view services_full — a ficha do cliente (Próximas
-- intervenções / Histórico recente / KPI Faturado) mostrava o valor SEM IVA
-- mesmo quando o serviço tinha apply_vat=true, divergindo do valor com IVA
-- mostrado no painel de detalhe do calendário para o MESMO serviço.
-- CREATE OR REPLACE VIEW só pode acrescentar colunas no fim, por isso repete
-- a definição completa da migration 056 (a mais recente) com apply_vat
-- adicionado no fim.
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

  -- Pagamento
  s.payment_status,

  -- IVA (novo)
  s.apply_vat

FROM services s
JOIN locations l ON s.location_id = l.id
JOIN clients c ON l.client_id = c.id
LEFT JOIN teams t ON s.team_id = t.id;

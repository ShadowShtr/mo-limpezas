-- 035_split_views.sql
-- Divide services_full em views de escopo reduzido para minimizar dados expostos
-- por ecrã. services_full mantém-se para a ficha completa do gestor.
-- Todas as views têm security_invoker=true — RLS das tabelas subjacentes é aplicado.

-- ── 1. Calendar summary (calendário — sem financeiros, sem contactos, sem códigos) ──
DROP VIEW IF EXISTS services_calendar_summary;
CREATE VIEW services_calendar_summary
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
  s.contract_id,
  s.is_exception,
  s.cancel_type,
  s.cancelled_at,

  l.id      AS location_id,
  l.name    AS location_name,
  l.address AS location_address,
  -- Indicadores booleanos: o gestor vê se tem chave/código, mas não o valor
  l.has_key AS location_has_key,
  (l.access_code IS NOT NULL AND l.access_code <> '') AS location_has_access_code,

  c.id   AS client_id,
  c.name AS client_name,

  t.id    AS team_id,
  t.name  AS team_name,
  t.color AS team_color

FROM services s
JOIN locations l ON s.location_id = l.id
JOIN clients  c ON l.client_id = c.id
LEFT JOIN teams t ON s.team_id = t.id;

-- ── 2. Collaborator mobile view (app da funcionária) ─────────────────────────
-- Inclui access_code/instructions pois a funcionária precisa para aceder ao local.
-- RLS de services+locations garante que só vê serviços que lhe dizem respeito.
DROP VIEW IF EXISTS services_mobile_collaborator;
CREATE VIEW services_mobile_collaborator
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

  l.id           AS location_id,
  l.name         AS location_name,
  l.address      AS location_address,
  l.lat          AS location_lat,
  l.lng          AS location_lng,
  l.access_code  AS location_access_code,
  l.instructions AS location_instructions,
  l.has_key      AS location_has_key,
  l.key_label    AS location_key_label,

  c.id   AS client_id,
  c.name AS client_name,

  t.id    AS team_id,
  t.name  AS team_name,
  t.color AS team_color

FROM services s
JOIN locations l ON s.location_id = l.id
JOIN clients  c ON l.client_id = c.id
LEFT JOIN teams t ON s.team_id = t.id;

-- ── 3. Financial private (ecrãs financeiros — só gestores, via RLS) ──────────
DROP VIEW IF EXISTS services_financial_private;
CREATE VIEW services_financial_private
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
  s.calculated_value,
  s.manual_value,
  COALESCE(s.manual_value, s.calculated_value) AS effective_value,

  l.id   AS location_id,
  l.name AS location_name,

  c.id   AS client_id,
  c.name AS client_name,
  c.nif  AS client_nif,

  t.id   AS team_id,
  t.name AS team_name

FROM services s
JOIN locations l ON s.location_id = l.id
JOIN clients  c ON l.client_id = c.id
LEFT JOIN teams t ON s.team_id = t.id;

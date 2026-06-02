-- ============================================================
-- MIGRATION 010: views úteis para queries frequentes
-- ============================================================

-- Vista de serviços com toda a informação para o calendário
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
  l.id          AS location_id,
  l.name        AS location_name,
  l.address     AS location_address,
  l.lat         AS location_lat,
  l.lng         AS location_lng,
  l.access_code AS location_access_code,
  l.instructions AS location_instructions,

  -- Client
  c.id          AS client_id,
  c.name        AS client_name,

  -- Team
  t.id          AS team_id,
  t.name        AS team_name,
  t.color       AS team_color

FROM services s
JOIN locations l ON s.location_id = l.id
JOIN clients c ON l.client_id = c.id
LEFT JOIN teams t ON s.team_id = t.id;

-- Vista de resumo mensal de horas por colaborador
CREATE OR REPLACE VIEW monthly_hours_summary AS
SELECT
  p.id                    AS collaborator_id,
  p.company_id,
  p.full_name,
  p.contracted_hours_month,
  DATE_TRUNC('month', ts.clock_in_at)  AS month,
  COUNT(ts.id)                          AS services_count,
  SUM(ts.duration_minutes) / 60.0       AS worked_hours,
  SUM(CASE WHEN ts.location_warning THEN 1 ELSE 0 END) AS location_warnings
FROM profiles p
LEFT JOIN timesheets ts ON ts.collaborator_id = p.id
  AND ts.clock_in_at IS NOT NULL
  AND ts.clock_out_at IS NOT NULL
WHERE p.role = 'colaborador'
GROUP BY p.id, p.company_id, p.full_name, p.contracted_hours_month,
         DATE_TRUNC('month', ts.clock_in_at);

-- Vista de equipa com membros activos
CREATE OR REPLACE VIEW teams_with_members AS
SELECT
  t.id,
  t.company_id,
  t.name,
  t.color,
  t.active,
  t.leader_id,
  COALESCE(
    json_agg(
      json_build_object(
        'id', p.id,
        'full_name', p.full_name,
        'avatar_url', p.avatar_url,
        'phone', p.phone
      )
    ) FILTER (WHERE p.id IS NOT NULL),
    '[]'
  ) AS members
FROM teams t
LEFT JOIN team_members tm ON tm.team_id = t.id AND tm.left_at IS NULL
LEFT JOIN profiles p ON p.id = tm.collaborator_id
GROUP BY t.id;

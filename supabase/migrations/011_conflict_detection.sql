-- ============================================================
-- MIGRATION 011: função detect_schedule_conflicts (usada pelo cron)
-- Retorna pares de serviços com horários sobrepostos para a mesma equipa
-- num dado período.
-- ============================================================

CREATE OR REPLACE FUNCTION detect_schedule_conflicts(
  p_start DATE,
  p_end   DATE
)
RETURNS TABLE (
  company_id   UUID,
  team_id      UUID,
  service1_id  UUID,
  service2_id  UUID,
  service1_start TIMESTAMPTZ,
  service1_end   TIMESTAMPTZ,
  service2_start TIMESTAMPTZ,
  service2_end   TIMESTAMPTZ
)
LANGUAGE sql
SECURITY DEFINER
AS $$
  SELECT
    s1.company_id,
    s1.team_id,
    s1.id                AS service1_id,
    s2.id                AS service2_id,
    s1.scheduled_start   AS service1_start,
    s1.scheduled_end     AS service1_end,
    s2.scheduled_start   AS service2_start,
    s2.scheduled_end     AS service2_end
  FROM services s1
  JOIN services s2 ON
    s1.company_id      = s2.company_id  AND
    s1.team_id         = s2.team_id     AND
    s1.team_id         IS NOT NULL      AND
    s1.id              < s2.id          AND
    s1.scheduled_start < s2.scheduled_end AND
    s1.scheduled_end   > s2.scheduled_start AND
    s1.status NOT IN ('cancelado', 'falta') AND
    s2.status NOT IN ('cancelado', 'falta')
  WHERE s1.scheduled_start::DATE >= p_start
    AND s1.scheduled_start::DATE <= p_end;
$$;

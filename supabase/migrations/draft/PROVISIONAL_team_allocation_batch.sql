-- PROVISIONAL: review and assign a final migration number before application.
-- This file is inert in the custom migration runner while it remains in draft/.

BEGIN;

-- A row with team_id NULL means that the collaborator is explicitly available
-- on that date. No row means that the permanent team_members assignment applies.
ALTER TABLE public.collaborator_ride_assignments
  ALTER COLUMN team_id DROP NOT NULL;

-- Preserve membership intervals instead of recycling/deleting the same row.
ALTER TABLE public.team_members
  DROP CONSTRAINT IF EXISTS team_members_team_id_collaborator_id_key;

DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM public.team_members
    WHERE left_at IS NULL
    GROUP BY collaborator_id HAVING count(*) > 1
  ) THEN
    RAISE EXCEPTION 'TEAM_MIGRATION_DUPLICATE_ACTIVE_MEMBERSHIP';
  END IF;
  IF EXISTS (
    SELECT 1 FROM public.vehicle_allocations
    GROUP BY company_id, team_id, date HAVING count(*) > 1
  ) THEN
    RAISE EXCEPTION 'TEAM_MIGRATION_DUPLICATE_TEAM_VEHICLE';
  END IF;
END;
$$;

CREATE UNIQUE INDEX IF NOT EXISTS team_members_one_active_team_per_collaborator
  ON public.team_members (collaborator_id)
  WHERE left_at IS NULL;

CREATE UNIQUE INDEX IF NOT EXISTS vehicle_allocations_one_team_per_date
  ON public.vehicle_allocations (company_id, team_id, date);

CREATE OR REPLACE FUNCTION public.save_team_day_allocations(
  p_company_id uuid,
  p_actor_id uuid,
  p_date date,
  p_expected_snapshot jsonb,
  p_member_assignments jsonb,
  p_vehicle_allocations jsonb
) RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_role text;
  v_current jsonb;
  v_result jsonb;
BEGIN
  IF jsonb_typeof(p_expected_snapshot) <> 'object'
     OR jsonb_typeof(p_member_assignments) <> 'array'
     OR jsonb_typeof(p_vehicle_allocations) <> 'array' THEN
    RAISE EXCEPTION 'TEAM_ALLOCATION_INVALID_PAYLOAD';
  END IF;

  SELECT role INTO v_role
  FROM public.profiles
  WHERE id = p_actor_id AND company_id = p_company_id;

  IF v_role IS NULL OR v_role NOT IN ('admin', 'gestor') THEN
    RAISE EXCEPTION 'TEAM_ALLOCATION_FORBIDDEN';
  END IF;

  PERFORM pg_advisory_xact_lock(hashtextextended(p_company_id::text || ':' || p_date::text, 0));

  SELECT jsonb_build_object(
    'member_assignments', COALESCE((
      SELECT jsonb_agg(
        jsonb_build_object('collaborator_id', collaborator_id, 'team_id', team_id)
        ORDER BY collaborator_id
      )
      FROM public.collaborator_ride_assignments
      WHERE company_id = p_company_id AND date = p_date
    ), '[]'::jsonb),
    'vehicle_allocations', COALESCE((
      SELECT jsonb_agg(
        jsonb_build_object('team_id', team_id, 'vehicle_id', vehicle_id, 'driver_id', driver_id)
        ORDER BY team_id, vehicle_id
      )
      FROM public.vehicle_allocations
      WHERE company_id = p_company_id AND date = p_date
    ), '[]'::jsonb)
  ) INTO v_current;

  IF v_current IS DISTINCT FROM p_expected_snapshot THEN
    RAISE EXCEPTION 'TEAM_ALLOCATION_CONFLICT';
  END IF;

  IF EXISTS (
    SELECT 1 FROM jsonb_to_recordset(p_member_assignments)
      AS x(collaborator_id uuid, team_id uuid)
    GROUP BY collaborator_id HAVING count(*) > 1
  ) OR EXISTS (
    SELECT 1 FROM jsonb_to_recordset(p_vehicle_allocations)
      AS x(team_id uuid, vehicle_id uuid, driver_id uuid)
    GROUP BY team_id HAVING count(*) > 1
  ) OR EXISTS (
    SELECT 1 FROM jsonb_to_recordset(p_vehicle_allocations)
      AS x(team_id uuid, vehicle_id uuid, driver_id uuid)
    GROUP BY vehicle_id HAVING count(*) > 1
  ) THEN
    RAISE EXCEPTION 'TEAM_ALLOCATION_DUPLICATE';
  END IF;

  IF EXISTS (
    SELECT 1
    FROM jsonb_to_recordset(p_member_assignments) AS x(collaborator_id uuid, team_id uuid)
    LEFT JOIN public.profiles p ON p.id = x.collaborator_id
    LEFT JOIN public.teams t ON t.id = x.team_id
    WHERE p.company_id IS DISTINCT FROM p_company_id
       OR p.role IS DISTINCT FROM 'colaborador'
       OR (x.team_id IS NOT NULL AND t.company_id IS DISTINCT FROM p_company_id)
  ) THEN
    RAISE EXCEPTION 'TEAM_ALLOCATION_INVALID_MEMBER';
  END IF;

  IF EXISTS (
    SELECT 1
    FROM jsonb_to_recordset(p_vehicle_allocations) AS x(team_id uuid, vehicle_id uuid, driver_id uuid)
    LEFT JOIN public.teams t ON t.id = x.team_id
    LEFT JOIN public.vehicles v ON v.id = x.vehicle_id
    LEFT JOIN public.profiles d ON d.id = x.driver_id
    WHERE t.company_id IS DISTINCT FROM p_company_id
       OR v.company_id IS DISTINCT FROM p_company_id
       OR (x.driver_id IS NOT NULL AND d.company_id IS DISTINCT FROM p_company_id)
  ) THEN
    RAISE EXCEPTION 'TEAM_ALLOCATION_INVALID_VEHICLE';
  END IF;

  IF EXISTS (
    SELECT 1
    FROM jsonb_to_recordset(p_vehicle_allocations) AS x(team_id uuid, vehicle_id uuid, driver_id uuid)
    LEFT JOIN LATERAL (
      SELECT desired.team_id
      FROM jsonb_to_recordset(p_member_assignments) AS desired(collaborator_id uuid, team_id uuid)
      WHERE desired.collaborator_id = x.driver_id
    ) override_row ON true
    LEFT JOIN LATERAL (
      SELECT tm.team_id
      FROM public.team_members tm
      WHERE tm.collaborator_id = x.driver_id AND tm.left_at IS NULL
      LIMIT 1
    ) home_row ON true
    WHERE x.driver_id IS NOT NULL
      AND CASE
        WHEN override_row.team_id IS NOT NULL
          OR EXISTS (
            SELECT 1 FROM jsonb_to_recordset(p_member_assignments)
              AS present(collaborator_id uuid, team_id uuid)
            WHERE present.collaborator_id = x.driver_id
          )
          THEN override_row.team_id
        ELSE home_row.team_id
      END IS DISTINCT FROM x.team_id
  ) THEN
    RAISE EXCEPTION 'TEAM_ALLOCATION_DRIVER_NOT_IN_TEAM';
  END IF;

  DELETE FROM public.collaborator_ride_assignments a
  WHERE a.company_id = p_company_id
    AND a.date = p_date
    AND NOT EXISTS (
      SELECT 1 FROM jsonb_to_recordset(p_member_assignments)
        AS x(collaborator_id uuid, team_id uuid)
      WHERE x.collaborator_id = a.collaborator_id
    );

  INSERT INTO public.collaborator_ride_assignments
    (company_id, collaborator_id, team_id, date, assigned_by)
  SELECT p_company_id, x.collaborator_id, x.team_id, p_date, p_actor_id
  FROM jsonb_to_recordset(p_member_assignments) AS x(collaborator_id uuid, team_id uuid)
  ON CONFLICT (collaborator_id, date) DO UPDATE
    SET team_id = EXCLUDED.team_id,
        assigned_by = EXCLUDED.assigned_by,
        updated_at = now();

  DELETE FROM public.vehicle_allocations a
  WHERE a.company_id = p_company_id
    AND a.date = p_date
    AND NOT EXISTS (
      SELECT 1 FROM jsonb_to_recordset(p_vehicle_allocations)
        AS x(team_id uuid, vehicle_id uuid, driver_id uuid)
      WHERE x.team_id = a.team_id AND x.vehicle_id = a.vehicle_id
    );

  INSERT INTO public.vehicle_allocations
    (company_id, team_id, vehicle_id, driver_id, date)
  SELECT p_company_id, x.team_id, x.vehicle_id, x.driver_id, p_date
  FROM jsonb_to_recordset(p_vehicle_allocations) AS x(team_id uuid, vehicle_id uuid, driver_id uuid)
  ON CONFLICT (vehicle_id, date) DO UPDATE
    SET team_id = EXCLUDED.team_id,
        driver_id = EXCLUDED.driver_id,
        updated_at = now();

  SELECT jsonb_build_object(
    'member_assignments', COALESCE((
      SELECT jsonb_agg(
        jsonb_build_object('collaborator_id', collaborator_id, 'team_id', team_id)
        ORDER BY collaborator_id
      )
      FROM public.collaborator_ride_assignments
      WHERE company_id = p_company_id AND date = p_date
    ), '[]'::jsonb),
    'vehicle_allocations', COALESCE((
      SELECT jsonb_agg(
        jsonb_build_object('team_id', team_id, 'vehicle_id', vehicle_id, 'driver_id', driver_id)
        ORDER BY team_id, vehicle_id
      )
      FROM public.vehicle_allocations
      WHERE company_id = p_company_id AND date = p_date
    ), '[]'::jsonb)
  ) INTO v_result;

  RETURN v_result;
END;
$$;

CREATE OR REPLACE FUNCTION public.save_team_with_members_v2(
  p_company_id uuid,
  p_actor_id uuid,
  p_team_id uuid,
  p_expected_updated_at timestamptz,
  p_expected_member_ids jsonb,
  p_name text,
  p_color text,
  p_active boolean,
  p_leader_id uuid,
  p_member_ids uuid[]
) RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_role text;
  v_team_id uuid;
  v_current_updated_at timestamptz;
  v_current_members jsonb;
BEGIN
  SELECT role INTO v_role FROM public.profiles
  WHERE id = p_actor_id AND company_id = p_company_id;
  IF v_role IS NULL OR v_role NOT IN ('admin', 'gestor') THEN
    RAISE EXCEPTION 'TEAM_SAVE_FORBIDDEN';
  END IF;
  IF btrim(p_name) = '' OR p_member_ids IS NULL THEN
    RAISE EXCEPTION 'TEAM_SAVE_INVALID_PAYLOAD';
  END IF;
  IF cardinality(p_member_ids) <> (
    SELECT count(DISTINCT requested.member_id)
    FROM unnest(p_member_ids) AS requested(member_id)
  ) THEN
    RAISE EXCEPTION 'TEAM_SAVE_DUPLICATE_MEMBER';
  END IF;
  IF p_leader_id IS NOT NULL AND NOT (p_leader_id = ANY(p_member_ids)) THEN
    RAISE EXCEPTION 'TEAM_SAVE_LEADER_NOT_MEMBER';
  END IF;
  IF EXISTS (
    SELECT 1 FROM unnest(p_member_ids) AS requested(member_id)
    LEFT JOIN public.profiles p ON p.id = requested.member_id
    WHERE p.company_id IS DISTINCT FROM p_company_id OR p.role IS DISTINCT FROM 'colaborador'
  ) THEN
    RAISE EXCEPTION 'TEAM_SAVE_INVALID_MEMBER';
  END IF;

  PERFORM pg_advisory_xact_lock(hashtextextended(p_company_id::text || ':memberships', 0));

  IF p_team_id IS NULL THEN
    INSERT INTO public.teams (company_id, name, color, active, leader_id)
    VALUES (p_company_id, btrim(p_name), p_color, p_active, p_leader_id)
    RETURNING id INTO v_team_id;
  ELSE
    SELECT updated_at INTO v_current_updated_at
    FROM public.teams WHERE id = p_team_id AND company_id = p_company_id FOR UPDATE;
    IF v_current_updated_at IS NULL THEN RAISE EXCEPTION 'TEAM_SAVE_NOT_FOUND'; END IF;

    SELECT COALESCE(jsonb_agg(collaborator_id ORDER BY collaborator_id), '[]'::jsonb)
    INTO v_current_members
    FROM public.team_members WHERE team_id = p_team_id AND left_at IS NULL;

    IF v_current_updated_at IS DISTINCT FROM p_expected_updated_at
       OR v_current_members IS DISTINCT FROM p_expected_member_ids THEN
      RAISE EXCEPTION 'TEAM_SAVE_CONFLICT';
    END IF;

    UPDATE public.teams SET
      name = btrim(p_name), color = p_color, active = p_active, leader_id = p_leader_id
    WHERE id = p_team_id AND company_id = p_company_id;
    v_team_id := p_team_id;
  END IF;

  IF EXISTS (
    SELECT 1 FROM public.team_members tm
    WHERE tm.collaborator_id = ANY(p_member_ids)
      AND tm.left_at IS NULL AND tm.team_id <> v_team_id
  ) THEN
    RAISE EXCEPTION 'TEAM_SAVE_MEMBER_IN_OTHER_TEAM';
  END IF;

  UPDATE public.team_members
  SET left_at = CURRENT_DATE
  WHERE team_id = v_team_id AND left_at IS NULL
    AND NOT (collaborator_id = ANY(p_member_ids));

  INSERT INTO public.team_members (team_id, collaborator_id, joined_at, left_at)
  SELECT v_team_id, requested.member_id, CURRENT_DATE, NULL
  FROM unnest(p_member_ids) AS requested(member_id)
  WHERE NOT EXISTS (
    SELECT 1 FROM public.team_members tm
    WHERE tm.team_id = v_team_id
      AND tm.collaborator_id = requested.member_id
      AND tm.left_at IS NULL
  );

  RETURN v_team_id;
END;
$$;

REVOKE ALL ON FUNCTION public.save_team_day_allocations(uuid, uuid, date, jsonb, jsonb, jsonb) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.save_team_with_members_v2(uuid, uuid, uuid, timestamptz, jsonb, text, text, boolean, uuid, uuid[]) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.save_team_day_allocations(uuid, uuid, date, jsonb, jsonb, jsonb) TO service_role;
GRANT EXECUTE ON FUNCTION public.save_team_with_members_v2(uuid, uuid, uuid, timestamptz, jsonb, text, text, boolean, uuid, uuid[]) TO service_role;

COMMIT;

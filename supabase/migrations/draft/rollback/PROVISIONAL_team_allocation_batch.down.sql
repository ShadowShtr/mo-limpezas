BEGIN;

DROP FUNCTION IF EXISTS public.save_team_day_allocations(uuid, uuid, date, jsonb, jsonb, jsonb);
DROP FUNCTION IF EXISTS public.save_team_with_members_v2(uuid, uuid, uuid, timestamptz, jsonb, text, text, boolean, uuid, uuid[]);
DROP INDEX IF EXISTS public.vehicle_allocations_one_team_per_date;
DROP INDEX IF EXISTS public.team_members_one_active_team_per_collaborator;

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM public.collaborator_ride_assignments WHERE team_id IS NULL) THEN
    RAISE EXCEPTION 'ROLLBACK_BLOCKED_NULL_DAY_TEAM';
  END IF;
  IF EXISTS (
    SELECT 1 FROM public.team_members
    GROUP BY team_id, collaborator_id HAVING count(*) > 1
  ) THEN
    RAISE EXCEPTION 'ROLLBACK_BLOCKED_MEMBERSHIP_HISTORY';
  END IF;
END;
$$;

ALTER TABLE public.collaborator_ride_assignments ALTER COLUMN team_id SET NOT NULL;
ALTER TABLE public.team_members
  ADD CONSTRAINT team_members_team_id_collaborator_id_key UNIQUE (team_id, collaborator_id);

COMMIT;

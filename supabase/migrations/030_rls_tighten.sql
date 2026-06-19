-- ============================================================
-- MIGRATION 030: Tighten RLS — remove permissive legacy policies
-- ============================================================
-- Migration 014 created correct role-split policies but used wrong names
-- in the DROP statements, leaving the original "FOR ALL" policies from
-- migrations 003/007 active alongside the new ones.
-- Postgres RLS is permissive (OR): one "FOR ALL for everyone" policy
-- silently grants collaborators INSERT/UPDATE/DELETE they should not have.
--
-- This migration:
--   1. Drops the leftover permissive policies on clients/locations/absences
--   2. Fixes vacation_requests (014 never touched it)
--   3. Recreates services_full WITH (security_invoker = true) so RLS on
--      clients/locations is enforced when joining through the view
-- ============================================================

-- ── 1. clients ────────────────────────────────────────────────────────────────
-- "company clients" (FOR ALL, everyone) was NOT dropped by 014 — drop it now.
DROP POLICY IF EXISTS "company clients" ON clients;
-- Correct policies already exist from 014: clients_select + clients_manage.

-- ── 2. locations ──────────────────────────────────────────────────────────────
DROP POLICY IF EXISTS "company locations" ON locations;
-- Correct policies already exist from 014: locations_select + locations_manage.

-- ── 3. absences ───────────────────────────────────────────────────────────────
-- Migration 007 created "company absences" (FOR ALL). Migration 014 tried to
-- drop "users see own company absences" (different name) — missed it.
DROP POLICY IF EXISTS "company absences" ON absences;
-- Correct policies already exist from 014: absences_select + absences_manage.

-- ── 4. vacation_requests ──────────────────────────────────────────────────────
-- Migration 014 never touched vacation_requests.
-- Only policy is the original "company vacation requests" (FOR ALL for everyone).
DROP POLICY IF EXISTS "company vacation requests" ON vacation_requests;

-- Collaborators: see/submit only their own requests.
-- Managers: full control within the company.
CREATE POLICY "vacation_requests_select" ON vacation_requests
  FOR SELECT USING (
    collaborator_id = auth.uid()
    OR (
      company_id = get_my_company_id()
      AND get_my_role() IN ('admin', 'gestor')
    )
  );

CREATE POLICY "vacation_requests_insert" ON vacation_requests
  FOR INSERT WITH CHECK (
    collaborator_id = auth.uid()
    AND company_id = get_my_company_id()
  );

CREATE POLICY "vacation_requests_manage" ON vacation_requests
  FOR ALL USING (
    company_id = get_my_company_id()
    AND get_my_role() IN ('admin', 'gestor')
  );

-- ── 5. services_full — enforce RLS on joined tables ───────────────────────────
-- Without security_invoker=true the view runs as the view owner (postgres),
-- bypassing RLS on clients/locations. Collaborators could see access codes,
-- client contacts, etc. of clients they are not assigned to.
-- Most recent definition is from migration 026 (adds has_key / key_label).
DROP VIEW IF EXISTS services_full;

CREATE VIEW services_full
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
  t.color        AS team_color

FROM services s
JOIN locations l ON s.location_id = l.id
JOIN clients c ON l.client_id = c.id
LEFT JOIN teams t ON s.team_id = t.id;

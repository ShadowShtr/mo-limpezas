-- ============================================================
-- MIGRATION 031: Unique constraint on (company_id, reference_number)
-- Prevents duplicate reference numbers caused by concurrent inserts
-- (the client was generating reference numbers from COUNT(*)+1, which
-- has an obvious race condition when two managers create services simultaneously).
-- The server action now generates the ref number server-side with a retry loop.
-- ============================================================

CREATE UNIQUE INDEX IF NOT EXISTS services_company_ref_unique
  ON services (company_id, reference_number);

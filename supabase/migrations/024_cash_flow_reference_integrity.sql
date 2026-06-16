-- Prevent duplicated automatic cash-flow entries for the same invoice/payroll record.
CREATE UNIQUE INDEX IF NOT EXISTS cash_flow_entries_reference_unique
  ON cash_flow_entries (company_id, reference_type, reference_id)
  WHERE reference_type IS NOT NULL AND reference_id IS NOT NULL;

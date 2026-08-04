import policy from "../../supabase/migration-policy.json";

export const ACTIVE_MIGRATIONS: string[] = policy.activeMigrations;
export const FROZEN_DRAFT_MIGRATIONS = policy.frozenDrafts.map((draft) => draft.ledgerName);
export const EXPECTED_APPLIED_MIGRATION_COUNT = ACTIVE_MIGRATIONS.length;
export const CURRENT_SCHEMA_BASELINE = policy.currentSchemaBaseline;

export function evaluateMigrationLedger(appliedNames: string[]) {
  const applied = new Set(appliedNames);
  const expected = new Set(ACTIVE_MIGRATIONS);
  const missing = ACTIVE_MIGRATIONS.filter((name) => !applied.has(name));
  const appliedFrozenDrafts = FROZEN_DRAFT_MIGRATIONS.filter((name) => applied.has(name));
  const unexpected = appliedNames.filter((name) => !expected.has(name) && !FROZEN_DRAFT_MIGRATIONS.includes(name));

  return {
    ok: missing.length === 0 && appliedFrozenDrafts.length === 0 && unexpected.length === 0,
    missing,
    appliedFrozenDrafts,
    unexpected,
  };
}

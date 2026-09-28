import { readFileSync, readdirSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { analyzeMigrationTransactionControl } from "./lib/migration-transaction-control.mjs";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const migrationsDir = join(root, "supabase", "migrations");
const outputArg = process.argv.indexOf("--output");
const output = outputArg >= 0 ? resolve(process.cwd(), process.argv[outputArg + 1] ?? "") : null;
if (outputArg >= 0 && !process.argv[outputArg + 1]) throw new Error("--output exige um caminho.");

const migrations = readdirSync(migrationsDir)
  .filter((name) => name.endsWith(".sql"))
  .sort()
  .map((name) => ({ name, ...analyzeMigrationTransactionControl(readFileSync(join(migrationsDir, name), "utf8")) }));

const report = {
  schemaVersion: 1,
  scope: "supabase/migrations/*.sql (somente ficheiros diretos; draft/ e rollback/ excluídos)",
  generatedFrom: "scripts/audit-migration-transaction-control.mjs",
  totals: {
    files: migrations.length,
    runnerOwned: migrations.filter((item) => item.classification === "runner-owned").length,
    legacyOuterWrapper: migrations.filter((item) => item.classification === "legacy-outer-wrapper").length,
    unsupportedControl: migrations.filter((item) => item.classification === "unsupported-control").length,
  },
  runnerOwned: migrations
    .filter((item) => item.classification === "runner-owned")
    .map((item) => item.name),
  legacyOuterWrappers: migrations
    .filter((item) => item.classification === "legacy-outer-wrapper")
    .map(({ name, statementCount, controls }) => ({ name, statementCount, controls })),
  unsupportedControls: migrations
    .filter((item) => item.classification === "unsupported-control")
    .map(({ name, statementCount, controls }) => ({ name, statementCount, controls })),
};

const json = `${JSON.stringify(report, null, 2)}\n`;
if (output) writeFileSync(output, json, "utf8");
else process.stdout.write(json);

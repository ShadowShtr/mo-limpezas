import { execFileSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { mkdirSync } from "node:fs";

const output = process.argv[2] ?? "reports/finance-legacy-references.json";
const patterns = [
  "/dashboard/financeiro/fluxo-caixa",
  "Fluxo de Caixa",
  "cashFlow",
  "getCashFlow",
  "createCashFlow",
  "/dashboard/financeiro/contas",
  "Contas",
  "getAccountsData",
];

const files = execFileSync("git", ["ls-files"], { encoding: "utf8" })
  .split(/\r?\n/)
  .filter(Boolean)
  .filter((file) => file !== output && !file.startsWith(".git/"));

function classification(file) {
  const normalized = file.replaceAll("\\", "/").toLowerCase();
  if (normalized.includes("concili") || normalized.includes("reconcil")) {
    return "RECONCILIATION_REQUIRED";
  }
  if (normalized.includes("report") || normalized.includes("relatorio")) {
    return "REPORT_REQUIRED";
  }
  if (
    normalized.startsWith("src/domain/") ||
    normalized.startsWith("src/lib/") ||
    normalized.startsWith("src/app/actions/")
  ) {
    return "DOMAIN_REQUIRED";
  }
  if (
    normalized.startsWith("src/app/") ||
    normalized.startsWith("src/components/") ||
    normalized.startsWith("src/release-notes/")
  ) {
    return "UI_ONLY";
  }
  return "OTHER";
}

const references = [];
for (const file of files) {
  let source;
  try {
    source = readFileSync(file, "utf8");
  } catch {
    continue;
  }
  source.split(/\r?\n/).forEach((line, index) => {
    const matchedPatterns = patterns.filter((pattern) => line.includes(pattern));
    if (matchedPatterns.length > 0) {
      references.push({
        file,
        line: index + 1,
        classification: classification(file),
        patterns: matchedPatterns,
      });
    }
  });
}

references.sort((a, b) => a.file.localeCompare(b.file) || a.line - b.line);
const counts = Object.fromEntries(
  ["UI_ONLY", "DOMAIN_REQUIRED", "REPORT_REQUIRED", "RECONCILIATION_REQUIRED", "OTHER"].map(
    (kind) => [kind, references.filter((item) => item.classification === kind).length],
  ),
);

mkdirSync(dirname(output), { recursive: true });
writeFileSync(
  output,
  `${JSON.stringify({ generatedFrom: "git ls-files", patterns, counts, references }, null, 2)}\n`,
);
console.log(`Classificadas ${references.length} referencias legacy em ${output}.`);

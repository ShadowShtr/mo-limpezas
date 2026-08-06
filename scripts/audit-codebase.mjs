#!/usr/bin/env node
/**
 * Auditor integral do código — Task T00 do PLANO MESTRE (docs/PLANO-MESTRE.md).
 *
 * Produz um inventário objetivo da árvore do repositório usando o compilador
 * TypeScript já instalado (sem dependências novas). NÃO remove nada: apenas
 * classifica e reporta, para que qualquer remoção posterior tenha prova.
 *
 * O relatório é **determinístico**: duas execuções sem alterações no
 * repositório produzem bytes idênticos. Nada de timestamps, caminhos absolutos
 * ou métricas que dependam do estado local (build, nome da diretoria).
 *
 * IMPORTANTE ao regenerar o relatório versionado: o inventário vem de
 * `git ls-files --cached`, ou seja, do **índice**. Ficheiros novos ainda por
 * adicionar não são contados. Fazer `git add` ANTES de regenerar, senão o
 * relatório fica desatualizado em relação ao commit que o acompanha:
 *
 *   git add -A && npm run audit:code:json && git add -A
 *
 * `src/__tests__/audit-codebase.test.ts` falha se isto for esquecido.
 *
 * Uso:
 *   node scripts/audit-codebase.mjs                       # imprime JSON
 *   node scripts/audit-codebase.mjs --output reports/code-audit.json
 *   node scripts/audit-codebase.mjs --fail-on-high-confidence   # sai 1 se houver risco
 *   node scripts/audit-codebase.mjs --include-timestamp   # junta generatedAt (quebra o determinismo)
 */

import { execFileSync } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import ts from "typescript";

const ROOT = process.cwd();
const args = process.argv.slice(2);

const FAIL_ON_HIGH_CONFIDENCE = args.includes("--fail-on-high-confidence");

// Fora por omissão: o relatório é versionado, e um timestamp faria cada
// execução produzir um diff mesmo sem nada ter mudado no repositório.
const INCLUDE_TIMESTAMP = args.includes("--include-timestamp");

function readArgument(flag) {
  const index = args.indexOf(flag);
  return index >= 0 ? args[index + 1] ?? null : null;
}

const OUTPUT = readArgument("--output");

const IGNORED_DIRECTORIES = new Set([
  ".git",
  ".next",
  ".vercel",
  "node_modules",
  "out",
  "build",
  "coverage",
]);

const TEXT_EXTENSIONS = new Set([
  ".ts",
  ".tsx",
  ".mts",
  ".cts",
  ".js",
  ".jsx",
  ".mjs",
  ".cjs",
  ".json",
  ".sql",
  ".md",
  ".css",
  ".scss",
  ".html",
  ".yml",
  ".yaml",
  ".sh",
  ".ps1",
]);

/**
 * Ficheiros que o Next.js carrega por convenção — nunca são "não usados".
 * Inclui as rotas do App Router e os ficheiros de metadata (manifest, sitemap,
 * robots, ícones e imagens sociais), que também são entradas por convenção.
 */
const NEXT_ENTRY_NAMES = new Set([
  "page.ts",
  "page.tsx",
  "layout.ts",
  "layout.tsx",
  "route.ts",
  "route.tsx",
  "loading.ts",
  "loading.tsx",
  "error.ts",
  "error.tsx",
  "global-error.ts",
  "global-error.tsx",
  "not-found.ts",
  "not-found.tsx",
  "template.ts",
  "template.tsx",
  "default.ts",
  "default.tsx",
  "manifest.ts",
  "sitemap.ts",
  "robots.ts",
  "icon.ts",
  "icon.tsx",
  "apple-icon.ts",
  "apple-icon.tsx",
  "opengraph-image.ts",
  "opengraph-image.tsx",
  "twitter-image.ts",
  "twitter-image.tsx",
]);

/**
 * Saída gerada pelo próprio auditor. Fica fora do inventário: sem isto o
 * relatório conta-se a si próprio, e como cada execução muda o tamanho do
 * ficheiro que a execução seguinte vai medir, `textLines` oscilava entre
 * corridas (95447 -> 95446 -> ...). Um inventário não pode ter a sua própria
 * saída como entrada.
 */
const GENERATED_OUTPUT_PREFIXES = ["reports/"];

/** Artefactos capazes de destruir ou popular uma base real (Task T03). */
const DANGEROUS_ARTIFACTS = [
  "supabase/APPLY_ALL.sql",
  "scripts/build-combined-sql.mjs",
  "CRIAR_PAGAMENTOS.sql",
  "src/app/api/seed-demo/route.ts",
];

function normalizePath(value) {
  return value.split(path.sep).join("/");
}

function relative(value) {
  return normalizePath(path.relative(ROOT, value));
}

function walk(directory, output = []) {
  for (const name of fs.readdirSync(directory)) {
    if (IGNORED_DIRECTORIES.has(name)) continue;

    const absolute = path.join(directory, name);
    const stat = fs.statSync(absolute);

    if (stat.isDirectory()) {
      walk(absolute, output);
    } else {
      output.push(absolute);
    }
  }

  return output;
}

/**
 * Inventário dos ficheiros do repositório.
 *
 * Usa `git ls-files` para que o inventário seja exatamente o conteúdo versionado
 * — ficheiros ignorados (`backups/`, `.env*`, dados locais) não são repositório e
 * distorceriam as contagens e as duplicações. Sem git, faz varredura da árvore.
 */
function isGeneratedOutput(absolute) {
  const rel = relative(absolute);
  return GENERATED_OUTPUT_PREFIXES.some((prefix) => rel.startsWith(prefix));
}

function inventoryFiles() {
  try {
    const output = execFileSync("git", ["ls-files", "-z", "--cached"], {
      cwd: ROOT,
      encoding: "utf8",
      maxBuffer: 64 * 1024 * 1024,
    });

    const files = output
      .split("\0")
      .filter(Boolean)
      .map((rel) => path.join(ROOT, rel))
      .filter((absolute) => fs.existsSync(absolute))
      .filter((absolute) => !isGeneratedOutput(absolute));

    if (files.length > 0) {
      return { files, source: "git ls-files" };
    }
  } catch {
    // Sem git disponível ou fora de um repositório: cai para a varredura.
  }

  return {
    files: walk(ROOT).filter((absolute) => !isGeneratedOutput(absolute)),
    source: "filesystem walk",
  };
}

function lineNumber(sourceFile, position) {
  return sourceFile.getLineAndCharacterOfPosition(position).line + 1;
}

function isInsideProject(fileName) {
  const root = normalizePath(ROOT) + "/";
  return normalizePath(fileName).startsWith(root);
}

function isTestFile(fileName) {
  const value = normalizePath(fileName);
  return (
    value.includes("/__tests__/") ||
    /\.(test|spec)\.[cm]?[jt]sx?$/.test(value)
  );
}

function isProductionEntry(fileName) {
  const rel = relative(fileName);
  const base = path.basename(fileName);

  if (
    rel === "src/proxy.ts" ||
    rel === "src/middleware.ts" ||
    rel === "src/instrumentation.ts" ||
    rel === "src/instrumentation-client.ts"
  ) {
    return true;
  }

  return rel.startsWith("src/app/") && NEXT_ENTRY_NAMES.has(base);
}

function sha256(content) {
  return crypto.createHash("sha256").update(content).digest("hex");
}

// ---------------------------------------------------------------------------
// 1. Inventário bruto da árvore
// ---------------------------------------------------------------------------

const { files: allFiles, source: inventorySource } = inventoryFiles();

const textFiles = allFiles.filter((file) =>
  TEXT_EXTENSIONS.has(path.extname(file).toLowerCase()),
);

// ---------------------------------------------------------------------------
// 2. Programa TypeScript (AST + diagnósticos)
// ---------------------------------------------------------------------------

const configPath = ts.findConfigFile(ROOT, ts.sys.fileExists, "tsconfig.json");

if (!configPath) {
  throw new Error("tsconfig.json não encontrado.");
}

const configRead = ts.readConfigFile(configPath, ts.sys.readFile);

if (configRead.error) {
  throw new Error(
    ts.flattenDiagnosticMessageText(configRead.error.messageText, "\n"),
  );
}

const parsedConfig = ts.parseJsonConfigFileContent(
  configRead.config,
  ts.sys,
  ROOT,
);

// `incremental` exige `tsBuildInfoFile` quando o programa é criado por API e
// produziria um diagnóstico TS5074 sobre a própria auditoria, não sobre o código.
const programOptions = { ...parsedConfig.options, incremental: false };
delete programOptions.tsBuildInfoFile;

const program = ts.createProgram({
  rootNames: parsedConfig.fileNames,
  options: programOptions,
});

// O `tsconfig` inclui `.next/types/**`, que só existe depois de um build. Sem
// este filtro, `sourceFiles` valia 298 numa máquina com build e 297 sem ele —
// uma métrica de inventário não pode depender do estado local.
const sourceFiles = program
  .getSourceFiles()
  .filter(
    (sourceFile) =>
      isInsideProject(sourceFile.fileName) &&
      !sourceFile.isDeclarationFile &&
      !relative(sourceFile.fileName).startsWith(".next/"),
  );

const diagnostics = ts
  .getPreEmitDiagnostics(program)
  // Mesma razão do filtro de `sourceFiles`: diagnósticos vindos de `.next/`
  // dependeriam de haver um build local.
  .filter(
    (diagnostic) =>
      !diagnostic.file ||
      !relative(diagnostic.file.fileName).startsWith(".next/"),
  )
  .map((diagnostic) => {
    const file = diagnostic.file;

    const location =
      file && diagnostic.start != null
        ? {
            file: relative(file.fileName),
            line: lineNumber(file, diagnostic.start),
          }
        : null;

    return {
      code: diagnostic.code,
      category: ts.DiagnosticCategory[diagnostic.category],
      message: ts.flattenDiagnosticMessageText(diagnostic.messageText, "\n"),
      location,
    };
  });

// ---------------------------------------------------------------------------
// 3. Grafo de imports (estáticos, dinâmicos e require)
// ---------------------------------------------------------------------------

const graph = new Map();

function resolveModule(sourceFile, moduleName) {
  const result = ts.resolveModuleName(
    moduleName,
    sourceFile.fileName,
    parsedConfig.options,
    ts.sys,
  );

  const resolved = result.resolvedModule?.resolvedFileName;

  if (
    !resolved ||
    !isInsideProject(resolved) ||
    resolved.includes("/node_modules/")
  ) {
    return null;
  }

  return normalizePath(resolved);
}

for (const sourceFile of sourceFiles) {
  const sourceKey = normalizePath(sourceFile.fileName);
  const dependencies = new Set();

  const visit = (node) => {
    let moduleName = null;

    if (
      (ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) &&
      node.moduleSpecifier &&
      ts.isStringLiteral(node.moduleSpecifier)
    ) {
      moduleName = node.moduleSpecifier.text;
    }

    if (
      ts.isCallExpression(node) &&
      node.arguments.length === 1 &&
      ts.isStringLiteral(node.arguments[0])
    ) {
      if (node.expression.kind === ts.SyntaxKind.ImportKeyword) {
        moduleName = node.arguments[0].text;
      }

      if (
        ts.isIdentifier(node.expression) &&
        node.expression.text === "require"
      ) {
        moduleName = node.arguments[0].text;
      }
    }

    if (moduleName) {
      const resolved = resolveModule(sourceFile, moduleName);
      if (resolved) dependencies.add(resolved);
    }

    ts.forEachChild(node, visit);
  };

  visit(sourceFile);

  graph.set(sourceKey, dependencies);
}

function collectReachable(entries) {
  const visited = new Set();
  const pending = [...entries];

  while (pending.length > 0) {
    const current = pending.pop();

    if (!current || visited.has(current)) continue;

    visited.add(current);

    for (const dependency of graph.get(current) ?? []) {
      if (!visited.has(dependency)) pending.push(dependency);
    }
  }

  return visited;
}

const productionEntries = sourceFiles
  .filter((file) => isProductionEntry(file.fileName))
  .map((file) => normalizePath(file.fileName));

const testEntries = sourceFiles
  .filter((file) => isTestFile(file.fileName))
  .map((file) => normalizePath(file.fileName));

const productionReachable = collectReachable(productionEntries);
const allReachable = collectReachable([...productionEntries, ...testEntries]);

/** Candidatos a código morto — exigem verificação manual antes de remover. */
const unreachableProductionModules = sourceFiles
  .filter((file) => {
    const normalized = normalizePath(file.fileName);

    return (
      relative(file.fileName).startsWith("src/") &&
      !isTestFile(file.fileName) &&
      !isProductionEntry(file.fileName) &&
      !productionReachable.has(normalized)
    );
  })
  .map((file) => relative(file.fileName))
  .sort();

/**
 * Módulos de produção que só são alcançados a partir de testes — os próprios
 * ficheiros de teste ficam de fora, senão a lista seria só a suite inteira.
 */
const testOnlyModules = sourceFiles
  .filter((file) => {
    const normalized = normalizePath(file.fileName);

    return (
      relative(file.fileName).startsWith("src/") &&
      !isTestFile(file.fileName) &&
      !productionReachable.has(normalized) &&
      allReachable.has(normalized)
    );
  })
  .map((file) => relative(file.fileName))
  .sort();

// ---------------------------------------------------------------------------
// 4. Duplicações exatas
// ---------------------------------------------------------------------------

const duplicateFilesByHash = new Map();

for (const file of textFiles) {
  const rel = relative(file);

  if (rel === "package-lock.json" || rel.endsWith(".map")) continue;

  const content = fs.readFileSync(file, "utf8");

  if (content.trim().length < 80) continue;

  const hash = sha256(content);
  const group = duplicateFilesByHash.get(hash) ?? [];

  group.push(rel);
  duplicateFilesByHash.set(hash, group);
}

const exactDuplicateFiles = [...duplicateFilesByHash.values()]
  .filter((group) => group.length > 1)
  .sort((a, b) => a[0].localeCompare(b[0]));

// ---------------------------------------------------------------------------
// 5. Padrões de risco
// ---------------------------------------------------------------------------

const directRevalidatePath = [];
const productionAdminClientInClientComponent = [];
const productionPublicSignupCalls = [];
const testSignupCalls = [];
const dateRiskCandidates = [];

for (const sourceFile of sourceFiles) {
  const rel = relative(sourceFile.fileName);
  const content = sourceFile.getFullText();
  const isTest = isTestFile(sourceFile.fileName);

  if (
    rel !== "src/lib/revalidate-business.ts" &&
    /\brevalidatePath\s*\(/.test(content)
  ) {
    directRevalidatePath.push(rel);
  }

  if (
    !isTest &&
    /^\s*["']use client["'];/m.test(content) &&
    /\bcreateAdminClient\b/.test(content)
  ) {
    productionAdminClientInClientComponent.push(rel);
  }

  // `signUp` num teste é quase sempre o oposto de um risco: é a suite a
  // verificar que o registo público está fechado. Só conta como risco de
  // confiança alta em código de produção — senão o gate `--fail-on-high-
  // confidence` ficaria permanentemente vermelho por causa de um teste bom.
  if (/\.auth\.signUp\s*\(/.test(content)) {
    (isTest ? testSignupCalls : productionPublicSignupCalls).push(rel);
  }

  if (
    rel !== "src/lib/lisbon-time.ts" &&
    (/\.toISOString\(\)\.slice\(0,\s*10\)/.test(content) ||
      /\.toISOString\(\)\.split\(["']T["']\)\[0\]/.test(content))
  ) {
    dateRiskCandidates.push(rel);
  }
}

const dangerousArtifacts = DANGEROUS_ARTIFACTS.filter((rel) =>
  fs.existsSync(path.join(ROOT, rel)),
);

const totalLines = textFiles.reduce(
  (sum, file) => sum + fs.readFileSync(file, "utf8").split(/\r?\n/).length,
  0,
);

// ---------------------------------------------------------------------------
// 6. Relatório
// ---------------------------------------------------------------------------

const report = {
  ...(INCLUDE_TIMESTAMP ? { generatedAt: new Date().toISOString() } : {}),
  inventorySource,
  summary: {
    repositoryFiles: allFiles.length,
    textFiles: textFiles.length,
    sourceFiles: sourceFiles.length,
    textLines: totalLines,
    typescriptDiagnostics: diagnostics.length,
    productionEntries: productionEntries.length,
    unreachableProductionModules: unreachableProductionModules.length,
    exactDuplicateFileGroups: exactDuplicateFiles.length,
  },
  highConfidence: {
    dangerousArtifacts,
    productionAdminClientInClientComponent,
    productionPublicSignupCalls,
  },
  reviewRequired: {
    unreachableProductionModules,
    testOnlyModules,
    testSignupCalls: [...new Set(testSignupCalls)].sort(),
    exactDuplicateFiles,
    directRevalidatePath: [...new Set(directRevalidatePath)].sort(),
    dateRiskCandidates: [...new Set(dateRiskCandidates)].sort(),
  },
  diagnostics,
};

const serialized = JSON.stringify(report, null, 2);

if (OUTPUT) {
  const absoluteOutput = path.resolve(ROOT, OUTPUT);

  fs.mkdirSync(path.dirname(absoluteOutput), { recursive: true });
  fs.writeFileSync(absoluteOutput, serialized + "\n", "utf8");

  console.log(`Relatório gravado em ${relative(absoluteOutput)}`);
} else {
  console.log(serialized);
}

const highConfidenceCount =
  dangerousArtifacts.length +
  productionAdminClientInClientComponent.length +
  productionPublicSignupCalls.length;

if (
  FAIL_ON_HIGH_CONFIDENCE &&
  (highConfidenceCount > 0 ||
    diagnostics.some((diagnostic) => diagnostic.category === "Error"))
) {
  process.exitCode = 1;
}

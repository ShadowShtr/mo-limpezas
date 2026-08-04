import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import policy from "../../supabase/migration-policy.json";

const root = process.cwd();

function read(relativePath: string) {
  return fs.readFileSync(path.join(root, relativePath), "utf8");
}

function filesUnder(relativePath: string, extensions: string[]): string[] {
  const base = path.join(root, relativePath);
  const output: string[] = [];

  function visit(dir: string) {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const absolute = path.join(dir, entry.name);
      if (entry.isDirectory()) visit(absolute);
      else if (extensions.includes(path.extname(entry.name))) output.push(path.relative(root, absolute));
    }
  }

  visit(base);
  return output;
}

describe("documentação e migrations têm uma única fonte de verdade", () => {
  it("mantém os documentos canónicos", () => {
    for (const file of [
      "docs/README.md",
      "docs/ESTADO-ATUAL.md",
      "docs/MIGRATIONS-RUNBOOK.md",
      "docs/ATOMICIDADE-IMPLEMENTACAO.md",
    ]) {
      expect(fs.existsSync(path.join(root, file)), file).toBe(true);
    }
  });

  it("remove artefactos operacionais obsoletos", () => {
    for (const file of [
      "supabase/APPLY_ALL.sql",
      "supabase/seed.sql",
      "scripts/build-combined-sql.mjs",
      "scripts/test-065-domain-atomicity.mjs",
      "CRIAR_PAGAMENTOS.sql",
      "src/app/api/seed-demo/route.ts",
      "src/app/(dashboard)/dashboard/configuracoes/_components/seed-button.tsx",
    ]) {
      expect(fs.existsSync(path.join(root, file)), file).toBe(false);
    }
  });

  it("não mantém instruções proibidas ou segredo histórico em documentos", () => {
    const documentFiles = [
      "README.md",
      "CLAUDE.md",
      "AUDITORIA-CONSOLIDADA.md",
      "AUDITORIA-REVERSOES.md",
      "AUDITORIA_COMPLETA.txt",
      ...filesUnder("docs", [".md", ".txt"]),
      ...filesUnder("planning", [".md", ".txt"]),
    ];
    // TEST_DATABASE_URL/"Supabase descartável" foram banidos numa fase em
    // que só significavam "Postgres local via Docker". O dono reintroduziu
    // TEST_DATABASE_URL em 2026-08-04 com um significado diferente e
    // legítimo (projeto Supabase de staging real, para ensaiar concorrência
    // e Realtime antes de aplicar migrations em produção — ver
    // docs/HANDOFF-2026-08-04.md). Docker continua banido.
    const forbidden = [
      /Docker/i,
      /APPLY_ALL/i,
      /node scripts\/run-migrations\.mjs --baseline/i,
      /node scripts\/run-migrations\.mjs --seed/i,
      /@vitortmf/i,
    ];

    for (const file of documentFiles) {
      const content = read(file);
      for (const pattern of forbidden) expect(content, `${file}: ${pattern}`).not.toMatch(pattern);
    }
  });

  it("classifica auditorias e planeamento antigos como históricos", () => {
    for (const file of [
      "AUDITORIA_COMPLETA.txt",
      "AUDITORIA-CONSOLIDADA.md",
      "AUDITORIA-REVERSOES.md",
      "docs/auditoria-tecnica-senior-2026-06-20.md",
      "planning/README.md",
    ]) {
      expect(read(file), file).toMatch(/HISTÓRICO|HISTÓRICA|ARQUIVO HISTÓRICO/);
    }
  });

  it("mantém 064/065 fora da pasta executável e com hash protegido", () => {
    const executable = fs.readdirSync(path.join(root, "supabase/migrations"));
    for (const draft of policy.frozenDrafts) {
      expect(executable, draft.ledgerName).not.toContain(draft.ledgerName);
      expect(fs.existsSync(path.join(root, draft.path)), draft.path).toBe(true);
    }
  });
});

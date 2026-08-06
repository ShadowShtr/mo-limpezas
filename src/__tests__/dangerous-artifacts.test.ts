// ============================================================================
// GUARDA — nenhum caminho acidental para destruir ou popular uma base real
// ============================================================================
// Origem: Task T03 do plano mestre (docs/PLANO-MESTRE.md, secção 24).
//
// Quatro ferramentas de bootstrap sobreviveram à evolução do sistema e
// continuavam no repositório muito depois de terem sido substituídas:
//
// - `supabase/APPLY_ALL.sql`        26 x `DROP ... CASCADE`, recriava o schema
//                                   antigo e as policies antigas por cima de
//                                   uma base real. Substituído por 71
//                                   migrations numeradas + runner seguro.
// - `scripts/build-combined-sql.mjs` Só existia para reconstruir o anterior.
// - `CRIAR_PAGAMENTOS.sql`          40 linhas de dados financeiros reais
//                                   (rendas, contabilista, garagens) com UUID
//                                   fixo da empresa. Substituído pela
//                                   migration 037, cuja policy é idêntica.
// - `src/app/api/seed-demo/route.ts` Criava utilizadores Auth, clientes,
//                                   faturas e salários com a service role.
//                                   Bloqueado em produção, mas totalmente
//                                   funcional em preview ou staging.
//
// Este teste falha se qualquer um voltar, ou se aparecer um caminho novo com
// a mesma capacidade. Não substitui revisão — torna a reincidência visível.
// ============================================================================

import { describe, it, expect } from "vitest";
import fs from "node:fs";
import path from "node:path";

const ROOT = path.join(__dirname, "..", "..");

const ARTEFACTOS_REMOVIDOS = [
  "supabase/APPLY_ALL.sql",
  "scripts/build-combined-sql.mjs",
  "CRIAR_PAGAMENTOS.sql",
  "src/app/api/seed-demo/route.ts",
  "src/app/(dashboard)/dashboard/configuracoes/_components/seed-button.tsx",
];

function walk(dir: string, out: string[] = []): string[] {
  for (const name of fs.readdirSync(dir)) {
    if (
      name === "node_modules" ||
      name === ".next" ||
      name === ".git" ||
      name === ".vercel" ||
      name === "backups"
    ) {
      continue;
    }

    const p = path.join(dir, name);

    if (fs.statSync(p).isDirectory()) walk(p, out);
    else out.push(p);
  }

  return out;
}

function relative(p: string): string {
  return path.relative(ROOT, p).split(path.sep).join("/");
}

describe("artefactos perigosos — Task T03", () => {
  it("nenhum dos artefactos removidos voltou ao repositório", () => {
    const voltaram = ARTEFACTOS_REMOVIDOS.filter((rel) =>
      fs.existsSync(path.join(ROOT, rel)),
    );

    expect(voltaram).toEqual([]);
  });

  it("não existe endpoint de seed com service role", () => {
    const rotas = walk(path.join(ROOT, "src", "app", "api")).filter((p) =>
      /route\.tsx?$/.test(p),
    );

    const suspeitas = rotas
      .map(relative)
      .filter((rel) => /seed|demo-data|popular/i.test(rel));

    expect(suspeitas).toEqual([]);
  });

  it("nenhum SQL versionado fora de migrations faz DROP ... CASCADE", () => {
    // As migrations podem legitimamente fazer DROP de um objeto que elas
    // próprias gerem; o problema é SQL solto, colável no SQL Editor, capaz de
    // derrubar o schema todo.
    const sqlSolto = walk(ROOT)
      .filter((p) => p.endsWith(".sql"))
      .map(relative)
      .filter((rel) => !rel.startsWith("supabase/migrations/"));

    const destrutivos = sqlSolto.filter((rel) => {
      const content = fs.readFileSync(path.join(ROOT, rel), "utf8");
      return /\bDROP\s+(TABLE|VIEW|SCHEMA)\b[\s\S]{0,80}\bCASCADE\b/i.test(
        content,
      );
    });

    expect(destrutivos).toEqual([]);
  });

  it("nenhum SQL versionado transporta dados financeiros operacionais", () => {
    // `CRIAR_PAGAMENTOS.sql` continha rendas, honorários e UUIDs reais da
    // empresa. Dados de negócio pertencem à base, não ao repositório.
    const sqlSolto = walk(ROOT)
      .filter((p) => p.endsWith(".sql"))
      .map(relative)
      .filter(
        (rel) =>
          !rel.startsWith("supabase/migrations/") && rel !== "supabase/seed.sql",
      );

    const comDados = sqlSolto.filter((rel) => {
      const content = fs.readFileSync(path.join(ROOT, rel), "utf8");
      return (
        /INSERT\s+INTO\s+fixed_variable_payments/i.test(content) ||
        /INSERT\s+INTO\s+(invoices|payroll_records|cash_flow_entries)\b/i.test(
          content,
        )
      );
    });

    expect(comDados).toEqual([]);
  });

  it("a página de configurações já não oferece geração de dados fictícios", () => {
    const page = fs.readFileSync(
      path.join(
        ROOT,
        "src",
        "app",
        "(dashboard)",
        "dashboard",
        "configuracoes",
        "page.tsx",
      ),
      "utf8",
    );

    expect(page).not.toMatch(/SeedButton/);
    expect(page).not.toMatch(/seed-demo/);
  });

  it("continua a existir caminho para um ambiente local descartável", () => {
    // A T03 remove atalhos perigosos, não a capacidade de desenvolver
    // localmente: as migrations e o runner seguro ficam.
    expect(fs.existsSync(path.join(ROOT, "scripts", "run-migrations.mjs"))).toBe(
      true,
    );

    const migrations = fs
      .readdirSync(path.join(ROOT, "supabase", "migrations"))
      .filter((name) => name.endsWith(".sql"));

    expect(migrations.length).toBeGreaterThan(60);
  });
});

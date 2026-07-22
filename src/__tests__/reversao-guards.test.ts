// ============================================================================
// GUARDAS ANTI-REVERSÃO
// ============================================================================
// Testes estáticos que fixam as invariantes descobertas na auditoria de
// "alterações que desaparecem/voltam atrás" (ver scripts/audit-reversoes.mjs).
// Se um destes falhar, alguém reintroduziu uma das causas-raiz.
// ============================================================================

import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync, statSync } from "fs";
import { join } from "path";
import { CLIENTE_SHEET_SELECT } from "@/lib/cliente-sheet-fields";
import { CONTRATO_SHEET_SELECT, CONTRACT_FINANCIAL_FIELDS } from "@/lib/contrato-sheet-fields";

const ROOT = join(__dirname, "..", "..");
const SRC = join(ROOT, "src");

function walk(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) walk(p, out);
    else if (/\.(ts|tsx)$/.test(name)) out.push(p);
  }
  return out;
}

// ── 1. Edição parcial: os formulários têm de carregar TODAS as colunas que
//       gravam, senão o update escreve null por cima (bug type/notes + avença).
describe("edição parcial (perda de campos ao gravar)", () => {
  it("CLIENTE_SHEET_SELECT inclui todas as colunas que updateCliente grava", () => {
    for (const col of ["name", "email", "phone", "nif", "type", "notes", "status", "vat_exempt"]) {
      expect(CLIENTE_SHEET_SELECT, `coluna em falta no select do ClienteSheet: ${col}`).toContain(col);
    }
  });

  it("CONTRATO_SHEET_SELECT inclui as colunas financeiras da avença", () => {
    for (const col of ["fixed_price", "fixed_monthly", "apply_vat"]) {
      expect(CONTRACT_FINANCIAL_FIELDS).toContain(col);
      expect(CONTRATO_SHEET_SELECT).toContain(col);
    }
  });

  it("nenhuma página que renderiza ClienteSheet volta a escrever a lista de colunas à mão", () => {
    const offenders: string[] = [];
    for (const file of walk(SRC)) {
      if (file.includes("cliente-sheet-fields")) continue;
      const src = readFileSync(file, "utf8");
      const usesSheet = /<ClienteSheet[\s>]/.test(src);
      const queriesClients = /from\(["']clients["']\)/.test(src);
      if (usesSheet && queriesClients && !src.includes("CLIENTE_SHEET_SELECT")) offenders.push(file);
    }
    expect(offenders, `Estas páginas alimentam o ClienteSheet sem usar CLIENTE_SHEET_SELECT (risco de apagar type/notes ao gravar): ${offenders.join(", ")}`).toEqual([]);
  });

  it("nenhuma página que renderiza ContratoSheet volta a escrever a lista de colunas à mão", () => {
    const offenders: string[] = [];
    for (const file of walk(SRC)) {
      if (file.includes("contrato-sheet-fields")) continue;
      const src = readFileSync(file, "utf8");
      const usesSheet = /<ContratoSheet[\s>]/.test(src);
      const queriesContracts = /from\(["']contracts["']\)/.test(src);
      if (usesSheet && queriesContracts && !src.includes("CONTRATO_SHEET_SELECT")) offenders.push(file);
    }
    expect(offenders, `Estas páginas alimentam o ContratoSheet sem usar CONTRATO_SHEET_SELECT (risco de apagar o valor da avença): ${offenders.join(", ")}`).toEqual([]);
  });
});

// ── 2. Pipeline de migração: nunca mais re-executar tudo nem semear produção.
describe("run-migrations.mjs seguro", () => {
  const src = readFileSync(join(ROOT, "scripts", "run-migrations.mjs"), "utf8");

  it("não tem credenciais hardcoded", () => {
    expect(/password:\s*["'][^"']+["']/.test(src)).toBe(false);
    expect(src).toContain("SUPABASE_DB_URL");
  });

  it("usa tabela de controlo _migrations (só aplica pendentes)", () => {
    expect(src).toContain("_migrations");
    expect(src).toContain("--baseline");
  });

  it("seed só com flag explícita e guarda contra base com dados", () => {
    expect(src).toContain("--seed");
    expect(src).toMatch(/dbHasData/);
  });

  it("não engole erros de migração (sem 'already exists' ignorado)", () => {
    expect(src).not.toContain("already exists");
  });
});

// ── 3. Service worker: HTML nunca pode vir da cache (senão deploys "não aparecem").
describe("service worker (public/sw.js)", () => {
  const sw = readFileSync(join(ROOT, "public", "sw.js"), "utf8");

  it("navegações/HTML são sempre rede (network-first), nunca cache-first", () => {
    // A única escrita em cache (c.put) tem de estar dentro do bloco de assets estáticos.
    const putCount = (sw.match(/\.put\(/g) ?? []).length;
    expect(putCount).toBe(1);
    const assetBlock = sw.slice(sw.indexOf("js|css|png"), sw.indexOf("Páginas HTML"));
    expect(assetBlock).toContain(".put(");
  });

  it("/api/ nunca é cacheado", () => {
    expect(sw).toContain('url.pathname.startsWith("/api/")');
  });

  it("a versão da cache é carimbada por deploy (prebuild)", () => {
    const pkg = JSON.parse(readFileSync(join(ROOT, "package.json"), "utf8"));
    expect(pkg.scripts.prebuild).toContain("stamp-sw");
  });
});

// ── 4. Rastreabilidade: /api/health tem de expor a versão em produção.
describe("versão do deploy rastreável", () => {
  it("/api/health devolve o commit (VERCEL_GIT_COMMIT_SHA)", () => {
    const src = readFileSync(join(SRC, "app", "api", "health", "route.ts"), "utf8");
    expect(src).toContain("VERCEL_GIT_COMMIT_SHA");
  });
});

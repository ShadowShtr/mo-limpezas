// ============================================================================
// T17-B1 — Guarda dos backlogs determinísticos
// ============================================================================
//
// 🚨 Estático e offline. Lê ficheiros versionados. Não liga ao Supabase, não lê
//    `.env`, não executa nenhum dos scripts que inventaria.
//
// ----------------------------------------------------------------------------
//
// Guarda dois relatórios que a T17-B1 produziu e que rondas seguintes vão
// consumir como plano de trabalho:
//
//   reports/ignored-query-errors.json  — os 268 erros de consulta ignorados
//   reports/auth-guard-inline.json     — os 20 guards inline duplicados
//
// O que testa: que continuam a existir, que são internamente coerentes, que
// respeitam os bloqueios em vigor, e — o mais importante — **que não contêm
// dados reais**. Um relatório de auditoria versionado é um sítio fácil de
// entornar PII sem ninguém dar por isso.
//
// O que NÃO testa: contagens exactas. O número de erros ignorados desce à
// medida que forem corrigidos, e uma guarda que falhasse a cada correcção
// seria desligada na primeira semana.

import { describe, it, expect } from "vitest";
import fs from "node:fs";
import path from "node:path";

const ROOT = process.cwd();

interface IgnoredError {
  path: string;
  line: number;
  fn: string | null;
  table: string | null;
  fallback: string[];
  severity: "CRITICAL" | "HIGH" | "MEDIUM" | "LOW";
  failMode: "fail-closed" | "unchecked";
  recommendedBatch: string;
  userImpact: string;
}

interface GuardEntry {
  path: string;
  verdict: string;
  notes: string;
  classified: boolean;
}

function load<T>(rel: string): T {
  return JSON.parse(fs.readFileSync(path.join(ROOT, "reports", rel), "utf8")) as T;
}

const ERRORS = load<{
  total: number;
  filesAffected: number;
  bySeverity: Record<string, number>;
  byBatch: Record<string, number>;
  findings: IgnoredError[];
}>("ignored-query-errors.json");

const GUARDS = load<{
  usingCentralGuard: number;
  inlineGuards: number;
  entries: GuardEntry[];
}>("auth-guard-inline.json");

// ─── Nenhum dado real nos relatórios ────────────────────────────────────────

describe("T17-B1 — os relatórios não vazam dados", () => {
  const RAW = ["ignored-query-errors.json", "auth-guard-inline.json"]
    .map((f) => fs.readFileSync(path.join(ROOT, "reports", f), "utf8"))
    .join("\n");

  it("não contêm credenciais nem chaves", () => {
    // JWT do Supabase, chaves novas, cadeias de ligação, service-role.
    const segredos = [
      /\beyJ[A-Za-z0-9_-]{20,}\.[A-Za-z0-9_-]{10,}/,   // JWT
      /\bsb_secret_[A-Za-z0-9]/,
      /postgres(?:ql)?:\/\/[^\s"]*:[^\s"@]+@/,          // cadeia com password
    ];
    for (const re of segredos) {
      expect(re.test(RAW), `padrão de segredo encontrado: ${re}`).toBe(false);
    }
  });

  it("não contêm dados pessoais nem mensagens vindas da base", () => {
    // Emails, telefones portugueses e NIF são o que apareceria se alguém
    // colasse output real num relatório.
    const pii = [
      /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/,
      /\+351\s?\d{9}\b/,
    ];
    for (const re of pii) {
      expect(re.test(RAW), `possível dado pessoal no relatório: ${re}`).toBe(false);
    }
  });
});

// ─── Erros de consulta ignorados ────────────────────────────────────────────

describe("T17-B1 — backlog dos erros de consulta ignorados", () => {
  it("o total bate com o número de ocorrências listadas", () => {
    expect(ERRORS.findings.length).toBe(ERRORS.total);
    expect(new Set(ERRORS.findings.map((f) => f.path)).size).toBe(ERRORS.filesAffected);
  });

  it("toda a ocorrência tem localização, severidade e lote", () => {
    const validas = ["CRITICAL", "HIGH", "MEDIUM", "LOW"];
    for (const f of ERRORS.findings) {
      expect(f.path.length, "sem caminho não há como agir").toBeGreaterThan(0);
      expect(f.line, `${f.path}: linha inválida`).toBeGreaterThan(0);
      expect(validas, `${f.path}:${f.line}: severidade fora da matriz`).toContain(f.severity);
      expect(f.recommendedBatch.length).toBeGreaterThan(0);
      expect(f.userImpact.length, "uma severidade sem impacto escrito é um palpite").toBeGreaterThan(20);
    }
  });

  it("payments.ts e invoices.ts continuam bloqueados pelo incidente financeiro", () => {
    // Tocam exactamente a zona da regressão ainda sem diagnóstico. Não podem
    // entrar em nenhum lote de correcção antes de haver um BEFORE real.
    const bloqueados = ERRORS.findings.filter((f) =>
      /src\/app\/actions\/(payments|invoices)\.ts$/.test(f.path));
    expect(bloqueados.length, "estes ficheiros têm erros ignorados conhecidos").toBeGreaterThan(0);
    for (const f of bloqueados) {
      expect(
        f.recommendedBatch,
        `${f.path}:${f.line}: não pode ser agendado para correcção`,
      ).toBe("BLOCKED_FINANCIAL_INCIDENT");
    }
  });

  it("fail-closed nunca é classificado CRITICAL", () => {
    // Uma falha que vira recusa perde a causa real, mas não confirma nada de
    // falso. Tratá-la como crítica inflacionaria a lista e afogaria os casos em
    // que o `null` segue para uma escrita.
    const erradas = ERRORS.findings.filter((f) => f.failMode === "fail-closed" && f.severity === "CRITICAL");
    expect(erradas.map((f) => `${f.path}:${f.line}`)).toEqual([]);
  });

  it("os CRITICAL são poucos e concentrados — uma lista accionável", () => {
    const criticos = ERRORS.findings.filter((f) => f.severity === "CRITICAL");
    expect(criticos.length, "se tudo é crítico, nada é").toBeLessThan(ERRORS.total / 4);
  });
});

// ─── Guards inline ──────────────────────────────────────────────────────────

describe("T17-B1 — backlog AUTH_GUARD_CENTRALIZATION", () => {
  it("as 35 actions continuam repartidas entre guard central e guard inline", () => {
    // O número que importa não é 15 nem 20: é que a soma cubra todas as actions
    // e que NENHUMA fique sem guard.
    expect(GUARDS.usingCentralGuard + GUARDS.inlineGuards).toBe(35);
    expect(GUARDS.inlineGuards).toBeGreaterThan(0);
  });

  it("todo o guard inline tem veredicto e justificação escrita", () => {
    const validos = ["SAFE_TO_CENTRALIZE", "SEMANTIC_DIFFERENCE", "NEEDS_TEST", "STANDBY"];
    for (const e of GUARDS.entries) {
      expect(e.classified, `${e.path}: guard inline sem classificação manual`).toBe(true);
      expect(validos, `${e.path}: veredicto fora da matriz`).toContain(e.verdict);
      expect(e.notes.length, `${e.path}: veredicto sem razão não é decisão`).toBeGreaterThan(30);
    }
  });

  it("as actions em standby no inventário não são propostas para centralizar", () => {
    // `whatsapp.ts` está STANDBY como ficheiro inteiro — mexer no guard de algo
    // cujo destino ainda não está decidido é trabalho que pode ser deitado fora.
    const whatsapp = GUARDS.entries.find((e) => e.path.endsWith("actions/whatsapp.ts"));
    expect(whatsapp, "whatsapp.ts tem guard inline").toBeDefined();
    expect(whatsapp!.verdict).toBe("STANDBY");
  });
});

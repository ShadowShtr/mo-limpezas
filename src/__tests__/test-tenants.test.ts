// ============================================================================
// GUARDAS — scripts/test-tenants/*
// ============================================================================
// Unitários para as funções puras de lib.mjs (sem rede) + guardas estáticas
// sobre provision.mjs/verify-isolation.mjs/cleanup.mjs (mesmo padrão de
// src/__tests__/reversao-guards.test.ts e atomicity-065-static.test.ts):
// nenhum destes scripts liga a uma base real durante os testes — só se
// confirma, por leitura de código, que as garantias de segurança pedidas
// (dry-run por padrão, confirmação exata, nunca fuzzy-match, nunca
// service_role a provar RLS, nunca imprimir credenciais) estão presentes.
// ============================================================================

import { describe, it, expect } from "vitest";
import fs from "node:fs";
import path from "node:path";
import {
  maskEmail,
  maskUuid,
  fingerprint,
  requireEnv,
  TestResults,
  safeErrorMessage,
  TEST_SLUGS,
  TENANT_A_SLUG,
  TENANT_B_SLUG,
  genRunId,
  syntheticName,
  SYNTHETIC_PREFIX,
} from "../../scripts/test-tenants/lib.mjs";

const ROOT = path.join(__dirname, "..", "..");
const readNormalized = (p: string) => fs.readFileSync(p, "utf8").replace(/\r\n/g, "\n");

const provisionSrc = readNormalized(path.join(ROOT, "scripts/test-tenants/provision.mjs"));
const verifySrc = readNormalized(path.join(ROOT, "scripts/test-tenants/verify-isolation.mjs"));
const cleanupSrc = readNormalized(path.join(ROOT, "scripts/test-tenants/cleanup.mjs"));

describe("lib.mjs — funções puras", () => {
  it("maskEmail nunca devolve o email completo", () => {
    const masked = maskEmail("joana.silva@example.com");
    expect(masked).not.toBe("joana.silva@example.com");
    expect(masked).toContain("*");
    expect(masked).toContain("@");
  });

  it("maskEmail lida com vazio/nulo sem lançar", () => {
    expect(maskEmail("")).toBe("(vazio)");
    expect(maskEmail(undefined as unknown as string)).toBe("(vazio)");
  });

  it("maskUuid trunca e nunca devolve o UUID completo", () => {
    const uuid = "11111111-2222-3333-4444-555555555555";
    const masked = maskUuid(uuid);
    expect(masked).not.toBe(uuid);
    expect(masked.length).toBeLessThan(uuid.length);
  });

  it("fingerprint é determinístico mas não reversível (hash, não o valor)", () => {
    const a = fingerprint("mo-limpezas-real-slug");
    const b = fingerprint("mo-limpezas-real-slug");
    expect(a).toBe(b);
    expect(a).not.toContain("mo-limpezas");
  });

  it("requireEnv lança com o nome da variável em falta, nunca aceita string vazia", () => {
    delete process.env.__TEST_TENANTS_FAKE_VAR__;
    expect(() => requireEnv(["__TEST_TENANTS_FAKE_VAR__"])).toThrow(/__TEST_TENANTS_FAKE_VAR__/);
    process.env.__TEST_TENANTS_FAKE_VAR__ = "";
    expect(() => requireEnv(["__TEST_TENANTS_FAKE_VAR__"])).toThrow();
    process.env.__TEST_TENANTS_FAKE_VAR__ = "valor";
    expect(() => requireEnv(["__TEST_TENANTS_FAKE_VAR__"])).not.toThrow();
    delete process.env.__TEST_TENANTS_FAKE_VAR__;
  });

  it("TestResults regista PASS/FAIL e reporta falhas corretamente", () => {
    const r = new TestResults();
    r.pass("ok");
    expect(r.hasFailures()).toBe(false);
    r.fail("não ok");
    expect(r.hasFailures()).toBe(true);
    expect(r.summary()).toEqual({ total: 2, passed: 1, failed: 1 });
  });

  it("TestResults.report() traduz uma condição em PASS/FAIL sem ternário-como-statement", () => {
    const r = new TestResults();
    r.report(true, "sucesso");
    r.report(false, "sucesso-esperado", "falha com mensagem própria");
    expect(r.summary()).toEqual({ total: 2, passed: 1, failed: 1 });
    expect(r.results[1].description).toBe("falha com mensagem própria");
  });

  it("safeErrorMessage nunca deixa passar algo com formato de JWT", () => {
    const fakeJwt = "eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.dQw4w9WgXcQ-fake-signature-part";
    const msg = safeErrorMessage({ message: `Erro: token ${fakeJwt} inválido` });
    expect(msg).not.toContain(fakeJwt);
    expect(msg).toContain("[jwt-redacted]");
  });

  it("slugs de teste são exatamente os dois reservados, sem mais nenhum", () => {
    expect(TEST_SLUGS).toEqual([TENANT_A_SLUG, TENANT_B_SLUG]);
    expect(TENANT_A_SLUG).toBe("mo-testes-atomicidade");
    expect(TENANT_B_SLUG).toBe("teste-isolamento-tenant");
  });

  it("genRunId gera valores diferentes a cada chamada", () => {
    expect(genRunId()).not.toBe(genRunId());
  });

  it("syntheticName usa sempre o prefixo reservado", () => {
    const name = syntheticName(genRunId(), "CLIENTE");
    expect(name.startsWith(SYNTHETIC_PREFIX)).toBe(true);
  });
});

describe("provision.mjs — guardas estáticas", () => {
  it("dry-run é o padrão: WRITE só fica true com --apply E --confirm juntos", () => {
    expect(provisionSrc).toMatch(/const APPLY = args\.includes\("--apply"\)/);
    expect(provisionSrc).toMatch(/const WRITE = APPLY && CONFIRMED/);
  });

  it("--apply sem confirmação falha com exit code != 0", () => {
    expect(provisionSrc).toMatch(/if \(APPLY && !CONFIRMED\)/);
    expect(provisionSrc).toContain("process.exit(1)");
  });

  it("confirmação exige o valor exato CREATE_ISOLATED_PRODUCTION_TEST_TENANTS", () => {
    expect(provisionSrc).toContain('confirmValue === "CREATE_ISOLATED_PRODUCTION_TEST_TENANTS"');
  });

  it("localiza empresas só por slug exato (.eq), nunca ilike/like", () => {
    expect(provisionSrc).toContain('.eq("slug", slug)');
    expect(provisionSrc).not.toMatch(/\.ilike\(|\.like\(/);
  });

  it("nunca imprime password nem email em claro (usa maskEmail)", () => {
    expect(provisionSrc).not.toMatch(/console\.log\([^)]*password/i);
    // toda a interpolação de email em console.log passa por maskEmail(...)
    const emailLogLines = provisionSrc.split("\n").filter((l) => l.includes("console.log") && l.includes("email"));
    for (const line of emailLogLines) expect(line).toContain("maskEmail(");
  });

  it("aborta sem mover automaticamente quando a conta já existe noutra empresa", () => {
    expect(provisionSrc).toMatch(/profile\.company_id !== company\.id/);
    expect(provisionSrc).toMatch(/abortando sem mover automaticamente/);
  });

  it("upsert de profile é sempre explícito (handle_new_user é neutra desde a 068)", () => {
    expect(provisionSrc).toMatch(/from\("profiles"\)\s*\n?\s*\.upsert\(/);
    expect(provisionSrc).toContain("onConflict: \"id\"");
  });
});

describe("verify-isolation.mjs — guardas estáticas", () => {
  it("não declara SUPABASE_SERVICE_ROLE_KEY como variável obrigatória", () => {
    const reqEnvBlock = verifySrc.slice(verifySrc.indexOf("REQUIRED_ENV = ["), verifySrc.indexOf("];"));
    expect(reqEnvBlock).not.toContain("SUPABASE_SERVICE_ROLE_KEY");
    expect(reqEnvBlock).toContain("SUPABASE_ANON_KEY");
  });

  it("as sessões das 4 contas usam signIn (anon), nunca makeAdminClient", () => {
    expect(verifySrc).toMatch(/const a1 = await signIn\(/);
    expect(verifySrc).toMatch(/const a2 = await signIn\(/);
    expect(verifySrc).toMatch(/const a3 = await signIn\(/);
    expect(verifySrc).toMatch(/const b1 = await signIn\(/);
  });

  it("makeAdminClient só aparece dentro do bloco de configuração de teste isolado, comentado como tal", () => {
    const occurrences = (verifySrc.match(/makeAdminClient\(\)/g) ?? []).length;
    expect(occurrences).toBeGreaterThan(0);
    expect(occurrences).toBeLessThanOrEqual(2);
    expect(verifySrc).toContain("Não prova nem depende de RLS");
  });

  it("qualquer FAIL produz exit code != 0", () => {
    expect(verifySrc).toMatch(/if \(results\.hasFailures\(\)\) process\.exit\(1\)/);
    expect(verifySrc).toMatch(/main\(\)\.catch[\s\S]*process\.exit\(1\)/);
  });

  it("nunca imprime dados de linha, só PASS/FAIL", () => {
    // não deve haver console.log de `data` bruto fora dos PASS/FAIL
    expect(verifySrc).not.toMatch(/console\.log\(data\)/);
    expect(verifySrc).not.toMatch(/console\.log\(JSON\.stringify\(data/);
  });

  it("só apaga dados sintéticos deste run_id no finally, nunca as empresas/contas de teste", () => {
    const finallyBlock = verifySrc.slice(verifySrc.indexOf("} finally {"));
    expect(finallyBlock).not.toMatch(/from\("companies"\)\.delete/);
    expect(finallyBlock).not.toMatch(/auth\.admin\.deleteUser/);
    expect(finallyBlock).toMatch(/from\("clients"\)\.delete/);
  });
});

describe("cleanup.mjs — guardas estáticas", () => {
  it("dry-run é o padrão", () => {
    expect(cleanupSrc).toMatch(/const WRITE = APPLY && CONFIRMED/);
  });

  it("--apply sem confirmação falha", () => {
    expect(cleanupSrc).toMatch(/if \(APPLY && !CONFIRMED\)/);
  });

  it("exige confirmação DIFERENTE da usada em provision.mjs (DELETE_ vs CREATE_)", () => {
    expect(cleanupSrc).toContain('confirmValue === "DELETE_ISOLATED_PRODUCTION_TEST_TENANTS"');
    expect(cleanupSrc).not.toContain("CREATE_ISOLATED_PRODUCTION_TEST_TENANTS");
  });

  it("localiza empresas só pelos slugs exatos, via .in(), nunca ilike/like", () => {
    expect(cleanupSrc).toContain('.in("slug", TEST_SLUGS)');
    expect(cleanupSrc).not.toMatch(/\.ilike\(|\.like\(/);
  });

  it("aborta ao encontrar profile fora do conjunto de emails esperados", () => {
    expect(cleanupSrc).toMatch(/unexpectedProfiles\.length > 0/);
    expect(cleanupSrc).toMatch(/abortando sem apagar nada/);
  });

  it("nunca apaga sem antes mostrar contagens agregadas", () => {
    const writeIdx = cleanupSrc.indexOf("if (!WRITE)");
    const countsIdx = cleanupSrc.indexOf("Será removido:");
    expect(countsIdx).toBeGreaterThan(0);
    expect(countsIdx).toBeLessThan(writeIdx);
  });

  it("ordem de remoção: dados filhos, profiles, Auth, company_settings, companies", () => {
    const order = [
      cleanupSrc.indexOf('await admin.from(t).delete()'),
      cleanupSrc.indexOf('await admin.from("profiles").delete()'),
      cleanupSrc.indexOf("auth.admin.deleteUser"),
      cleanupSrc.indexOf('await admin.from("company_settings").delete()'),
      cleanupSrc.indexOf('await admin.from("companies").delete()'),
    ];
    for (let i = 1; i < order.length; i++) {
      expect(order[i]).toBeGreaterThan(order[i - 1]);
    }
  });
});

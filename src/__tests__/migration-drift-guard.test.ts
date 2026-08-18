// ============================================================================
// DRIFT GUARD — ledger diz pendente, schema diz presente
// ============================================================================
//
// Origem (2026-08-17): verificação read-only contra a base real mostrou que
// 071/072/073 estão aplicadas em produção mas ausentes de `public._migrations`
// (foram aplicadas pelo SQL Editor, que não escreve no ledger). Para o runner
// isso lê-se como "pendente", e um `--apply` tentaria re-executá-las sobre
// dados financeiros reais.
//
// Nenhum teste aqui liga a uma base. Um cliente falso responde por catálogo
// (`to_regclass`, `information_schema.columns`, `pg_proc`) e grava tudo o que
// recebeu, para se poder afirmar — por captura, não por leitura do código —
// que a detecção é só de leitura.
//
// 🔴 O caso E existe por causa de um erro real cometido durante a verificação:
//    sondar as funções via PostgREST sem argumentos devolveu `PGRST202` e
//    parecia provar ausência. Funções que estavam mesmo aplicadas davam o
//    mesmo 404, porque o PostgREST resolve funções por assinatura. A detecção
//    passou a ser por catálogo; este teste fixa isso.
// ============================================================================

import { describe, it, expect } from "vitest";
import {
  detectarDrift,
  inspecionarSchema,
  formatarRelatorioDrift,
  functionExists,
  FINGERPRINTS,
  SEM_FINGERPRINT,
  CODIGO_DRIFT,
  CODIGO_PARCIAL,
} from "../../scripts/lib/migration-drift-guard.mjs";

const M071 = "071_finance_periods_and_expense_categories.sql";
const M072 = "072_invoice_atomic_creation.sql";
const M073 = "073_payment_to_cashflow.sql";
const M070 = "070_guard_profile_managed_fields.sql";

const MUTA = ["CREATE", "ALTER", "INSERT", "UPDATE", "DELETE", "DROP", "BEGIN", "COMMIT", "TRUNCATE", "GRANT"];

/**
 * Cliente falso: decide por conjuntos de nomes existentes. Nunca liga a nada.
 * `queries` guarda tudo para os testes de read-only.
 */
function fakeClient({
  tabelas = new Set<string>(),
  colunas = new Set<string>(),
  funcoes = new Set<string>(),
  triggers = new Map<string, { enabled: boolean; functionName: string }>(),
}: {
  tabelas?: Set<string>;
  colunas?: Set<string>;
  funcoes?: Set<string>;
  triggers?: Map<string, { enabled: boolean; functionName: string }>;
} = {}) {
  const queries: { sql: string; params: unknown }[] = [];
  return {
    queries,
    async query(sql: string, params: unknown[] = []) {
      queries.push({ sql, params });

      if (sql.includes("to_regclass")) {
        const alvo = String(params[0]);
        return { rows: [{ reg: tabelas.has(alvo) ? alvo : null }] };
      }
      if (sql.includes("information_schema.columns")) {
        const [schema, tabela, coluna] = params as string[];
        return { rows: colunas.has(`${schema}.${tabela}.${coluna}`) ? [{ "1": 1 }] : [] };
      }
      // pg_trigger antes de pg_proc: a query de triggers faz JOIN a pg_proc e
      // conteria ambas as strings.
      if (sql.includes("pg_trigger")) {
        const [schema, tabela, nome] = params as string[];
        const achado = triggers.get(`${schema}.${tabela}.${nome}`);
        if (!achado) return { rows: [] };
        return { rows: [{ tgenabled: achado.enabled ? "O" : "D", function_name: achado.functionName }] };
      }
      if (sql.includes("pg_proc")) {
        const [schema, nome] = params as string[];
        return { rows: funcoes.has(`${schema}.${nome}`) ? [{ "1": 1 }] : [] };
      }
      throw new Error(`Query inesperada no cliente falso: ${sql.slice(0, 80)}`);
    },
  };
}

/** Todos os objectos das três migrations verificadas — o estado real de produção. */
function schemaCompleto() {
  return fakeClient({
    tabelas: new Set(["public.expense_categories", "public.financial_periods"]),
    colunas: new Set([
      "public.cash_flow_entries.expense_category_id",
      "public.fixed_variable_payments.expense_category_id",
    ]),
    funcoes: new Set([
      "public.create_invoice_with_items",
      "public.mark_payment_paid",
      "public.unmark_payment_paid",
      "public.is_financial_period_open",
    ]),
  });
}

// ─── A) ledger ausente + schema ausente → pendente normal ────────────────────

describe("A) ledger missing + schema absent → pendente normal", () => {
  it("não bloqueia: é para isto que o runner existe", async () => {
    const r = await detectarDrift({ client: fakeClient(), pendentes: [M071, M072, M073] });
    expect(r.deveAbortar).toBe(false);
    expect(r.codigo).toBeNull();
    expect(r.achados.every((a) => a.schema === "ABSENT")).toBe(true);
  });

  it("uma migration nova sem fingerprint é ignorada, não bloqueada", async () => {
    const r = await detectarDrift({ client: fakeClient(), pendentes: ["099_coisa_nova.sql"] });
    expect(r.achados).toHaveLength(0);
    expect(r.deveAbortar).toBe(false);
  });
});

// ─── B) ledger ausente + schema presente → DRIFT ─────────────────────────────

describe("B) ledger missing + schema present → MIGRATION_LEDGER_SCHEMA_DRIFT", () => {
  it("bloqueia as três, com o código certo", async () => {
    const r = await detectarDrift({ client: schemaCompleto(), pendentes: [M071, M072, M073] });
    expect(r.deveAbortar).toBe(true);
    expect(r.codigo).toBe(CODIGO_DRIFT);
    expect(r.bloqueiam.map((a) => a.migration).sort()).toEqual([M071, M072, M073]);
  });

  it("cada uma isoladamente também bloqueia", async () => {
    for (const m of [M071, M072, M073]) {
      const r = await detectarDrift({ client: schemaCompleto(), pendentes: [m] });
      expect(r.deveAbortar, `${m} devia bloquear`).toBe(true);
      expect(r.achados[0].schema).toBe("PRESENT");
    }
  });

  it("reporta os objectos encontrados, para a mensagem ser accionável", async () => {
    const r = await detectarDrift({ client: schemaCompleto(), pendentes: [M073] });
    expect(r.achados[0].presentes).toEqual(
      expect.arrayContaining([
        "public.mark_payment_paid()",
        "public.unmark_payment_paid()",
        "public.is_financial_period_open()",
      ]),
    );
    expect(r.achados[0].ausentes).toHaveLength(0);
  });
});

// ─── C) ledger presente → nem entra na detecção ──────────────────────────────

describe("C) ledger present → applied, sem drift a reportar", () => {
  it("uma migration registada no ledger nunca chega ao detector", async () => {
    // O detector só recebe `pendentes`. Uma migration no ledger não está lá.
    const r = await detectarDrift({ client: schemaCompleto(), pendentes: [] });
    expect(r.achados).toHaveLength(0);
    expect(r.deveAbortar).toBe(false);
  });
});

// ─── D) 070 → ABSENT por catálogo, já não UNKNOWN ────────────────────────────
//
// 🔴 Bloco invertido a 2026-08-18. Antes fixava que a 070 era `UNKNOWN` por não
//    ter fingerprint, com o motivo de que provar a presença exigiria escrever em
//    `profiles` sob identidade não-admin. O R0 refutou isso: `pg_proc` +
//    `pg_trigger` respondem por leitura pura de catálogo, e no live run
//    responderam ABSENT. `UNKNOWN` era um estado da ferramenta, não da base.

const TRG070 = "public.profiles.trg_guard_profile_managed_fields";
const FN070 = "fn_guard_profile_managed_fields";

/** A 070 materializada e correcta: função + trigger activo a apontar para ela. */
function schema070Presente() {
  return fakeClient({
    funcoes: new Set([`public.${FN070}`]),
    triggers: new Map([[TRG070, { enabled: true, functionName: FN070 }]]),
  });
}

describe("D) 070 é verificável por catálogo", () => {
  it("tem fingerprint estrutural, e já não está em SEM_FINGERPRINT", () => {
    expect((FINGERPRINTS as Record<string, unknown>)[M070]).toBeDefined();
    expect((SEM_FINGERPRINT as Record<string, string>)[M070]).toBeUndefined();
  });

  // Teste 4 do contrato: sem função e sem trigger → ABSENT, não UNKNOWN.
  it("🔴 sem função e sem trigger → ABSENT (o estado real de produção)", async () => {
    const r = await inspecionarSchema(fakeClient(), M070);
    expect(r.estado).toBe("ABSENT");
    expect(r.estado).not.toBe("UNKNOWN");
  });

  // Teste 5: função + trigger correctos → PRESENT.
  it("com função e trigger activo a apontar para ela → PRESENT", async () => {
    const r = await inspecionarSchema(schema070Presente(), M070);
    expect(r.estado).toBe("PRESENT");
  });

  // Teste 6: trigger desactivado ou a apontar para outra função não é PRESENT.
  it("🔴 trigger desactivado → não conta como presente", async () => {
    const client = fakeClient({
      funcoes: new Set([`public.${FN070}`]),
      triggers: new Map([[TRG070, { enabled: false, functionName: FN070 }]]),
    });
    const r = await inspecionarSchema(client, M070);
    expect(r.estado).toBe("PARTIAL"); // função existe, trigger não conforme
    expect(r.estado).not.toBe("PRESENT");
  });

  it("🔴 trigger a apontar para outra função → não conta como presente", async () => {
    const client = fakeClient({
      funcoes: new Set([`public.${FN070}`]),
      triggers: new Map([[TRG070, { enabled: true, functionName: "outra_funcao_qualquer" }]]),
    });
    const r = await inspecionarSchema(client, M070);
    expect(r.estado).not.toBe("PRESENT");
  });

  // Teste 7: ABSENT + ledger ausente não é drift.
  it("🔴 070 ABSENT com ledger ausente NÃO produz drift", async () => {
    const r = await detectarDrift({ client: fakeClient(), pendentes: [M070] });
    expect(r.achados[0].schema).toBe("ABSENT");
    expect(r.deveAbortar).toBe(false);
    expect(r.codigo).toBeNull();
    expect(r.bloqueiam).toHaveLength(0);
  });

  it("aparece no relatório com o estado real", async () => {
    const r = await detectarDrift({ client: fakeClient(), pendentes: [M070] });
    const txt = formatarRelatorioDrift(r).join("\n");
    expect(txt).toContain(M070);
    expect(txt).toContain("ABSENT");
  });

  // Se algum dia a 070 for aplicada por fora, aí sim é drift — e tem de parar.
  it("070 materializada mas ausente do ledger → bloqueia", async () => {
    const r = await detectarDrift({ client: schema070Presente(), pendentes: [M070] });
    expect(r.achados[0].schema).toBe("PRESENT");
    expect(r.deveAbortar).toBe(true);
    expect(r.codigo).toBe(CODIGO_DRIFT);
  });
});

// ─── E) assinatura errada não vira ABSENT ────────────────────────────────────

describe("E) detecção por catálogo, não por HTTP status", () => {
  it("functionExists pergunta ao pg_proc, sem executar a função", async () => {
    const c = fakeClient({ funcoes: new Set(["public.mark_payment_paid"]) });
    expect(await functionExists(c, "public", "mark_payment_paid")).toBe(true);
    expect(await functionExists(c, "public", "nao_existe")).toBe(false);

    // Nenhuma query executa a função: só interroga o catálogo.
    expect(c.queries.every((q) => q.sql.includes("pg_proc"))).toBe(true);
    expect(c.queries.some((q) => /SELECT\s+(public\.)?mark_payment_paid\s*\(/i.test(q.sql))).toBe(false);
  });

  it("não usa códigos PGRST/HTTP em sítio nenhum", async () => {
    const c = schemaCompleto();
    await detectarDrift({ client: c, pendentes: [M071, M072, M073] });
    const todo = c.queries.map((q) => q.sql).join(" ");
    expect(todo).not.toMatch(/PGRST|404|42883/);
  });

  it("a função existe no catálogo independentemente da assinatura chamada", async () => {
    // O falso negativo original: sondar por RPC sem argumentos dava 404 numa
    // função que existia. O catálogo responde por nome, não por assinatura.
    const c = fakeClient({ funcoes: new Set(["public.is_financial_period_open"]) });
    const r = await inspecionarSchema(c, M073);
    expect(r.presentes).toContain("public.is_financial_period_open()");
    expect(r.estado).toBe("PARTIAL"); // as outras duas faltam
    expect(r.estado).not.toBe("ABSENT");
  });
});

// ─── F) 071 parcial → PARTIAL, abort ─────────────────────────────────────────

describe("F) materialização parcial → MIGRATION_PARTIALLY_MATERIALIZED", () => {
  it("expense_categories existe, financial_periods não → PARTIAL", async () => {
    const c = fakeClient({
      tabelas: new Set(["public.expense_categories"]),
      colunas: new Set(["public.cash_flow_entries.expense_category_id"]),
    });
    const r = await inspecionarSchema(c, M071);
    expect(r.estado).toBe("PARTIAL");
    expect(r.presentes).toContain("public.expense_categories");
    expect(r.ausentes).toContain("public.financial_periods");
  });

  it("PARTIAL aborta, e com o código próprio", async () => {
    const c = fakeClient({ tabelas: new Set(["public.expense_categories"]) });
    const r = await detectarDrift({ client: c, pendentes: [M071] });
    expect(r.deveAbortar).toBe(true);
    expect(r.codigo).toBe(CODIGO_PARCIAL);
  });

  it("PARTIAL tem precedência sobre DRIFT quando há ambos", async () => {
    const c = fakeClient({
      tabelas: new Set(["public.expense_categories"]), // 071 parcial
      funcoes: new Set([
        "public.mark_payment_paid",
        "public.unmark_payment_paid",
        "public.is_financial_period_open",
      ]), // 073 completa
    });
    const r = await detectarDrift({ client: c, pendentes: [M071, M073] });
    expect(r.codigo).toBe(CODIGO_PARCIAL);
  });

  it("o relatório diz que precisa de análise à mão", async () => {
    const c = fakeClient({ tabelas: new Set(["public.expense_categories"]) });
    const r = await detectarDrift({ client: c, pendentes: [M071] });
    const txt = formatarRelatorioDrift(r).join("\n");
    expect(txt).toContain("PARCIAL");
    expect(txt).toMatch(/à mão|analise|análise/i);
  });
});

// ─── Read-only ───────────────────────────────────────────────────────────────

describe("🔴 detecção é READ-ONLY", () => {
  it("zero queries mutáveis, em qualquer estado de schema", async () => {
    for (const c of [fakeClient(), schemaCompleto()]) {
      await detectarDrift({ client: c, pendentes: [M070, M071, M072, M073] });
      for (const { sql } of c.queries) {
        const inicio = sql.trim().toUpperCase();
        for (const p of MUTA) {
          expect(inicio.startsWith(p), `query mutável: ${sql.slice(0, 60)}`).toBe(false);
        }
      }
      expect(c.queries.length).toBeGreaterThan(0);
    }
  });

  it("nunca toca em public._migrations", async () => {
    const c = schemaCompleto();
    await detectarDrift({ client: c, pendentes: [M071, M072, M073] });
    expect(c.queries.some((q) => q.sql.includes("_migrations"))).toBe(false);
  });
});

// ─── Não auto-reconciliar ────────────────────────────────────────────────────

describe("🔴 nunca auto-reconcilia", () => {
  it("o módulo não contém INSERT INTO public._migrations", async () => {
    const fs = await import("node:fs");
    const path = await import("node:path");
    const fonte = fs.readFileSync(
      path.join(__dirname, "..", "..", "scripts", "lib", "migration-drift-guard.mjs"),
      "utf8",
    );
    expect(fonte).not.toMatch(/INSERT\s+INTO\s+public\._migrations/i);
    expect(fonte).not.toMatch(/UPDATE\s+public\._migrations/i);
  });

  it("mostra checksum esperado mas não o grava", async () => {
    const r = await detectarDrift({ client: schemaCompleto(), pendentes: [M071] });
    const txt = formatarRelatorioDrift(r, { checksumEsperado: { [M071]: "abc123" } }).join("\n");
    expect(txt).toContain("EXPECTED_FILE_CHECKSUM: abc123");
  });

  it("aponta para o documento de reconciliação, não resolve sozinho", async () => {
    const r = await detectarDrift({ client: schemaCompleto(), pendentes: [M072] });
    const txt = formatarRelatorioDrift(r).join("\n");
    expect(txt).toContain("LEDGER-RECONCILIATION-PENDING");
    expect(txt).toMatch(/não reconcilia por iniciativa própria/i);
  });
});

// ─── Output seguro ───────────────────────────────────────────────────────────

describe("output não vaza nada", () => {
  it("só nomes de objectos, estados e acção", async () => {
    const r = await detectarDrift({ client: schemaCompleto(), pendentes: [M071, M072, M073] });
    const txt = formatarRelatorioDrift(r, {
      checksumEsperado: { [M071]: "deadbeef" },
    }).join("\n");

    expect(txt).not.toMatch(/sb_secret_|sb_publishable_|sbp_|eyJ|postgres:\/\//);
    expect(txt).not.toMatch(/supabase\.co/);
    expect(txt).not.toMatch(/@|\+351|\d{4}-\d{3}/); // email/telefone/código postal
  });
});

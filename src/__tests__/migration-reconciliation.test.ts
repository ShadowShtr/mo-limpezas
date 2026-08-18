// ============================================================================
// R0 — manifesto de reconciliação do ledger
// ============================================================================
//
// Nenhum teste liga a uma base. Um cliente falso responde ao catálogo de forma
// determinística e **grava todo o SQL que recebeu** — é isso que permite provar
// por captura, e não por leitura do código, que a ferramenta só lê.
//
// Os casos que mais importam:
//
//   · 022 — ficheiro editado depois de aplicado. Prova que «o objecto existe»
//     e «o ficheiro actual é o que correu» são afirmações diferentes.
//   · SQL Editor — schema completo e ledger vazio dá `UNPROVABLE`, nunca
//     `PROVEN`, por muito que todos os objectos coincidam.
//   · Assinatura errada — função com o nome certo e argumentos diferentes não
//     é a função que a migration declara.
// ============================================================================

import { describe, it, expect } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import {
  CORRESPONDENCE,
  LEDGER,
  RECOMMENDATION,
  SCHEMA,
  avaliarCorrespondencia,
  avaliarChecksumLedger,
  LEDGER_CHECKSUM,
  avaliarLedger,
  construirManifesto,
  formatarManifesto,
  inspecionarSchema,
  recomendar,
} from "../../scripts/lib/migration-reconciliation.mjs";
import { checksumForNewMigration, normalizeToCRLF } from "../../scripts/lib/migration-checksum.mjs";

const M070 = "070_guard_profile_managed_fields.sql";
const M071 = "071_finance_periods_and_expense_categories.sql";
const M072 = "072_invoice_atomic_creation.sql";
const M073 = "073_payment_to_cashflow.sql";

const ESCRITA = ["INSERT", "UPDATE", "DELETE", "ALTER", "CREATE", "DROP", "TRUNCATE", "GRANT", "COMMIT"];

/**
 * Cliente falso de catálogo. Grava o SQL **executado** — o detector de escrita
 * analisa isto, nunca o que a base devolve (uma definição de função devolvida
 * por `pg_get_functiondef` contém `CREATE OR REPLACE`, e isso é um resultado).
 */
function fakeCatalog({
  tabelas = new Set<string>(),
  colunas = new Map<string, { type: string; nullable: boolean }>(),
  funcoes = [] as { schema: string; name: string; args: string; returns?: string }[],
  triggers = [] as {
    schema: string; table: string; name: string; enabled?: string;
    functionName: string; functionSchema?: string;
  }[],
  indices = new Set<string>(),
  falhar = null as string | null,
} = {}) {
  const sqlExecutado: string[] = [];
  return {
    sqlExecutado,
    async query(sql: string, params: unknown[] = []) {
      sqlExecutado.push(sql);
      if (falhar) throw new Error(falhar);

      if (sql.includes("information_schema.tables")) {
        const [s, t] = params as string[];
        return { rows: tabelas.has(`${s}.${t}`) ? [{ ok: 1 }] : [] };
      }
      if (sql.includes("information_schema.columns")) {
        const [s, t] = params as string[];
        const rows: { column_name: string; data_type: string; is_nullable: string }[] = [];
        for (const [chave, v] of colunas) {
          const [cs, ct, cc] = chave.split(".");
          if (cs === s && ct === t) {
            rows.push({ column_name: cc, data_type: v.type, is_nullable: v.nullable ? "YES" : "NO" });
          }
        }
        return { rows };
      }
      if (sql.includes("pg_get_function_identity_arguments")) {
        const [s, n] = params as string[];
        return {
          rows: funcoes
            .filter((f) => f.schema === s && f.name === n)
            .map((f) => ({ proname: f.name, args: f.args, returns: f.returns ?? "void" })),
        };
      }
      if (sql.includes("pg_trigger")) {
        const [s, t] = params as string[];
        return {
          rows: triggers
            .filter((g) => g.schema === s && g.table === t)
            .map((g) => ({
              tgname: g.name,
              tgenabled: g.enabled ?? "O",
              function_name: g.functionName,
              function_schema: g.functionSchema ?? "public",
            })),
        };
      }
      if (sql.includes("pg_index")) {
        const [s, t] = params as string[];
        return {
          rows: [...indices]
            .filter((i) => i.startsWith(`${s}.${t}.`))
            .map((i) => ({ index_name: i.split(".").slice(2).join(".") })),
        };
      }
      return { rows: [] };
    },
  };
}

/** Base com 071/072/073 completas — o estado real de produção. */
function producaoCompleta() {
  return fakeCatalog({
    tabelas: new Set(["public.expense_categories", "public.financial_periods"]),
    colunas: new Map([
      ["public.expense_categories.id", { type: "uuid", nullable: false }],
      ["public.expense_categories.company_id", { type: "uuid", nullable: false }],
      ["public.expense_categories.name", { type: "text", nullable: false }],
      ["public.expense_categories.normalized_name", { type: "text", nullable: false }],
      ["public.expense_categories.color_token", { type: "text", nullable: true }],
      ["public.expense_categories.icon", { type: "text", nullable: true }],
      ["public.expense_categories.active", { type: "boolean", nullable: false }],
      ["public.expense_categories.sort_order", { type: "integer", nullable: false }],
      ["public.financial_periods.id", { type: "uuid", nullable: false }],
      ["public.financial_periods.company_id", { type: "uuid", nullable: false }],
      ["public.financial_periods.year", { type: "smallint", nullable: false }],
      ["public.financial_periods.month", { type: "smallint", nullable: false }],
      ["public.financial_periods.status", { type: "text", nullable: false }],
      ["public.financial_periods.closed_at", { type: "timestamp with time zone", nullable: true }],
      ["public.financial_periods.closed_by", { type: "uuid", nullable: true }],
      ["public.financial_periods.reopened_at", { type: "timestamp with time zone", nullable: true }],
      ["public.financial_periods.reopened_by", { type: "uuid", nullable: true }],
      ["public.financial_periods.reopen_reason", { type: "text", nullable: true }],
      ["public.cash_flow_entries.expense_category_id", { type: "uuid", nullable: true }],
      ["public.fixed_variable_payments.expense_category_id", { type: "uuid", nullable: true }],
    ]),
    funcoes: [
      {
        schema: "public", name: "create_invoice_with_items",
        args: "p_company_id uuid, p_client_id uuid, p_prefix text, p_year integer, p_invoice_date date, p_due_date date, p_period_start date, p_period_end date, p_subtotal numeric, p_vat_rate numeric, p_vat_amount numeric, p_total numeric, p_items jsonb",
      },
      { schema: "public", name: "is_financial_period_open", args: "p_company_id uuid, p_year integer, p_month integer" },
      { schema: "public", name: "mark_payment_paid", args: "p_company_id uuid, p_payment_id uuid, p_paid_on date" },
      { schema: "public", name: "unmark_payment_paid", args: "p_company_id uuid, p_payment_id uuid" },
    ],
    indices: new Set([
      "public.invoices.uq_invoices_number_per_company",
      "public.invoices.uq_invoices_draft_per_client_period",
    ]),
  });
}

// ─── §35: 071 ────────────────────────────────────────────────────────────────

describe("§35 — 071", () => {
  it("ledger ausente + schema completo → CANDIDATE_WITH_ASSUMPTION", async () => {
    const r = await inspecionarSchema(producaoCompleta(), M071);
    expect(r.estado).toBe(SCHEMA.PRESENT);
    expect(
      recomendar({
        ledgerEstado: LEDGER.ABSENT,
        schemaEstado: r.estado,
        correspondencia: CORRESPONDENCE.UNPROVABLE,
      }),
    ).toBe(RECOMMENDATION.CANDIDATE_WITH_ASSUMPTION);
  });

  it("🔴 ledger ausente + UMA coluna em falta → PARTIAL → BLOCKED", async () => {
    // O SQL Editor não é transaccional: uma execução interrompida deixa
    // exactamente isto — tabelas criadas, última coluna por criar.
    const r = await inspecionarSchema(
      fakeCatalog({
        tabelas: new Set(["public.expense_categories", "public.financial_periods"]),
        colunas: new Map([
          ["public.expense_categories.id", { type: "uuid", nullable: false }],
          ["public.cash_flow_entries.expense_category_id", { type: "uuid", nullable: true }],
          // `fixed_variable_payments.expense_category_id` ausente
        ]),
      }),
      M071,
    );
    expect(r.estado).toBe(SCHEMA.PARTIAL);
    expect(
      recomendar({
        ledgerEstado: LEDGER.ABSENT,
        schemaEstado: r.estado,
        correspondencia: CORRESPONDENCE.UNPROVABLE,
      }),
    ).toBe(RECOMMENDATION.BLOCKED);
  });

  it("o diff diz QUAL coluna falta — um PARTIAL sem detalhe não é accionável", async () => {
    const r = await inspecionarSchema(
      fakeCatalog({
        tabelas: new Set(["public.expense_categories", "public.financial_periods"]),
        colunas: new Map([["public.expense_categories.id", { type: "uuid", nullable: false }]]),
      }),
      M071,
    );
    const ausentes = r.objectos.filter((o: { estado: string }) => o.estado === "ABSENT");
    expect(ausentes.some((o: { alvo: string }) => o.alvo.includes("fixed_variable_payments.expense_category_id"))).toBe(true);
  });

  it("ledger presente com checksum a bater → ALREADY_RECONCILED", () => {
    const conteudo = "-- 071\n";
    const l = avaliarLedger({ checksum: checksumForNewMigration(conteudo) }, conteudo);
    expect(l.estado).toBe(LEDGER.PRESENT);
    expect(
      recomendar({
        ledgerEstado: l.estado,
        schemaEstado: SCHEMA.PRESENT,
        correspondencia: CORRESPONDENCE.PROVEN,
      }),
    ).toBe(RECOMMENDATION.ALREADY_RECONCILED);
  });

  it("🔴 ledger presente com checksum diferente → BLOCKED", () => {
    const l = avaliarLedger({ checksum: "0".repeat(64) }, "-- 071\n");
    expect(l.estado).toBe(LEDGER.CHECKSUM_MISMATCH);
    expect(
      recomendar({
        ledgerEstado: l.estado,
        schemaEstado: SCHEMA.PRESENT,
        correspondencia: CORRESPONDENCE.CONTRADICTED,
      }),
    ).toBe(RECOMMENDATION.BLOCKED);
  });
});

// ─── §36: 070 sem escrever em profiles ───────────────────────────────────────

describe("§36 — 070 verificada por catálogo, sem tocar em profiles", () => {
  it("sem catálogo acessível → ABSENT (nada encontrado), nunca PRESENT", async () => {
    const r = await inspecionarSchema(fakeCatalog(), M070);
    expect(r.estado).toBe(SCHEMA.ABSENT);
    expect(r.estado).not.toBe(SCHEMA.PRESENT);
  });

  it("só a função → PARTIAL", async () => {
    const r = await inspecionarSchema(
      fakeCatalog({ funcoes: [{ schema: "public", name: "fn_guard_profile_managed_fields", args: "" }] }),
      M070,
    );
    expect(r.estado).toBe(SCHEMA.PARTIAL);
  });

  it("só o trigger → PARTIAL", async () => {
    const r = await inspecionarSchema(
      fakeCatalog({
        triggers: [{
          schema: "public", table: "profiles",
          name: "trg_guard_profile_managed_fields",
          functionName: "fn_guard_profile_managed_fields",
        }],
      }),
      M070,
    );
    expect(r.estado).toBe(SCHEMA.PARTIAL);
  });

  it("🔴 função + trigger correctos → PRESENT, sem nenhuma escrita", async () => {
    const c = fakeCatalog({
      funcoes: [{ schema: "public", name: "fn_guard_profile_managed_fields", args: "" }],
      triggers: [{
        schema: "public", table: "profiles",
        name: "trg_guard_profile_managed_fields",
        functionName: "fn_guard_profile_managed_fields",
      }],
    });
    const r = await inspecionarSchema(c, M070);
    expect(r.estado).toBe(SCHEMA.PRESENT);

    // O ponto todo: prova-se a 070 sem escrever uma linha em `profiles`.
    for (const sql of c.sqlExecutado) {
      expect(sql.trim().toUpperCase().startsWith("SELECT")).toBe(true);
    }
  });

  it("🔴 trigger a apontar para outra função → CONTRADICTED, e nunca PRESENT", async () => {
    const r = await inspecionarSchema(
      fakeCatalog({
        funcoes: [{ schema: "public", name: "fn_guard_profile_managed_fields", args: "" }],
        triggers: [{
          schema: "public", table: "profiles",
          name: "trg_guard_profile_managed_fields",
          functionName: "outra_funcao_qualquer",
        }],
      }),
      M070,
    );
    expect(r.estado).toBe(SCHEMA.PARTIAL);
    expect(r.objectos.some((o: { estado: string }) => o.estado === "CONTRADICTED")).toBe(true);
  });

  it("trigger desactivado existe mas não corre — e isso aparece", async () => {
    const r = await inspecionarSchema(
      fakeCatalog({
        funcoes: [{ schema: "public", name: "fn_guard_profile_managed_fields", args: "" }],
        triggers: [{
          schema: "public", table: "profiles",
          name: "trg_guard_profile_managed_fields",
          functionName: "fn_guard_profile_managed_fields",
          enabled: "D",
        }],
      }),
      M070,
    );
    expect(r.estado).toBe(SCHEMA.PARTIAL);
    expect(r.objectos.some((o: { detalhe: string | null }) => o.detalhe?.includes("desactivado"))).toBe(true);
  });
});

// ─── §37: assinatura ─────────────────────────────────────────────────────────

describe("§37 — nome igual, assinatura diferente NÃO é PRESENT", () => {
  it("073 com assinatura errada → MISMATCH", async () => {
    const r = await inspecionarSchema(
      fakeCatalog({
        funcoes: [
          { schema: "public", name: "is_financial_period_open", args: "p_company_id uuid, p_date date" }, // errada
          { schema: "public", name: "mark_payment_paid", args: "p_company_id uuid, p_payment_id uuid, p_paid_on date" },
          { schema: "public", name: "unmark_payment_paid", args: "p_company_id uuid, p_payment_id uuid" },
        ],
      }),
      M073,
    );
    expect(r.estado).toBe(SCHEMA.PARTIAL);
    const mau = r.objectos.find(
      (o: { alvo: string }) => o.alvo.includes("is_financial_period_open"),
    ) as { estado: string } | undefined;
    expect(mau).toBeDefined();
    expect(mau?.estado).toBe("MISMATCH");
  });

  it("072 com a assinatura certa → PRESENT", async () => {
    const r = await inspecionarSchema(producaoCompleta(), M072);
    expect(r.estado).toBe(SCHEMA.PRESENT);
  });

  it("072 sem o índice único → PARTIAL", async () => {
    // A função existe mas `uq_invoices_number_per_company` não: a numeração
    // única por empresa é metade do que a 072 garante.
    const r = await inspecionarSchema(
      fakeCatalog({
        funcoes: [{
          schema: "public", name: "create_invoice_with_items",
          args: "p_company_id uuid, p_client_id uuid, p_prefix text, p_year integer, p_invoice_date date, p_due_date date, p_period_start date, p_period_end date, p_subtotal numeric, p_vat_rate numeric, p_vat_amount numeric, p_total numeric, p_items jsonb",
        }],
        indices: new Set<string>(),
      }),
      M072,
    );
    expect(r.estado).toBe(SCHEMA.PARTIAL);
  });
});

// ─── §38: SQL Editor ─────────────────────────────────────────────────────────

describe("§38 — schema completo + ledger ausente → UNPROVABLE, nunca PROVEN", () => {
  it("objectos todos presentes não provam o SQL executado", () => {
    const c = avaliarCorrespondencia({ ledgerEstado: LEDGER.ABSENT, schemaEstado: SCHEMA.PRESENT });
    expect(c).toBe(CORRESPONDENCE.UNPROVABLE);
    expect(c).not.toBe(CORRESPONDENCE.PROVEN);
  });

  // 🔴 Regra invertida a 2026-08-18, depois do R1. Antes esperava-se `PROVEN`
  //    aqui, porque só o runner escrevia no ledger. O R1 escreveu três linhas
  //    administrativamente, à mão, sem executar nada — a implicação
  //    "linha no ledger ⇒ o runner aplicou isto" deixou de valer.
  it("🔴 ledger com checksum a bater NÃO dá PROVEN — só LEDGER_CHECKSUM_MATCH", () => {
    const c = avaliarCorrespondencia({ ledgerEstado: LEDGER.PRESENT, schemaEstado: SCHEMA.PRESENT });
    expect(c).toBe(CORRESPONDENCE.UNPROVABLE);
    expect(c).not.toBe(CORRESPONDENCE.PROVEN);

    // O facto sobre o checksum continua a ser afirmado — noutra dimensão.
    expect(avaliarChecksumLedger({ ledgerEstado: LEDGER.PRESENT }))
      .toBe(LEDGER_CHECKSUM.PROVEN);
  });

  it("checksum divergente continua a dar CONTRADICTED e MISMATCH", () => {
    expect(avaliarCorrespondencia({ ledgerEstado: LEDGER.CHECKSUM_MISMATCH, schemaEstado: SCHEMA.PRESENT }))
      .toBe(CORRESPONDENCE.CONTRADICTED);
    expect(avaliarChecksumLedger({ ledgerEstado: LEDGER.CHECKSUM_MISMATCH }))
      .toBe(LEDGER_CHECKSUM.MISMATCH);
  });

  it("ledger ausente → LEDGER_CHECKSUM_MATCH = UNKNOWN", () => {
    expect(avaliarChecksumLedger({ ledgerEstado: LEDGER.ABSENT }))
      .toBe(LEDGER_CHECKSUM.UNKNOWN);
  });

  it("linha no ledger sem checksum guardado → UNKNOWN, não PROVEN", () => {
    expect(avaliarChecksumLedger({ ledgerEstado: LEDGER.PRESENT, semChecksum: true }))
      .toBe(LEDGER_CHECKSUM.UNKNOWN);
  });

  it("o manifesto carrega a assunção por escrito", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "r0-"));
    fs.writeFileSync(path.join(dir, M073), "-- 073\n", "utf8");
    const m = await construirManifesto({
      client: producaoCompleta(),
      migrationsDir: dir,
      migrations: [M073],
      lerLedger: async () => new Map(),
    });
    const e = m.entries[0];
    expect(e.correspondence.CORRESPONDENCE_TO_EXECUTED_SQL).toBe(CORRESPONDENCE.UNPROVABLE);
    expect(e.correspondence.assumption).toContain("NÃO é estabelecida pelo checksum");
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it("🔴 o campo chama-se CURRENT_FILE_CHECKSUM, nunca APPLIED_CHECKSUM", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "r0-"));
    fs.writeFileSync(path.join(dir, M072), "-- 072\n", "utf8");
    const m = await construirManifesto({
      client: producaoCompleta(),
      migrationsDir: dir,
      migrations: [M072],
      lerLedger: async () => new Map(),
    });
    expect(m.entries[0].currentFile).toHaveProperty("CURRENT_FILE_CHECKSUM");
    expect(JSON.stringify(m.entries[0])).not.toContain("APPLIED_CHECKSUM");
    fs.rmSync(dir, { recursive: true, force: true });
  });
});

// ─── §39: 022 como regressão ─────────────────────────────────────────────────

describe("§39 — 022: ficheiro editado depois de aplicado", () => {
  it("🔴 checksum do ledger ≠ ficheiro actual → CHECKSUM_MISMATCH → BLOCKED", () => {
    const l = avaliarLedger({ checksum: "a".repeat(64) }, "-- conteudo actual, diferente do aplicado\n");
    expect(l.estado).toBe(LEDGER.CHECKSUM_MISMATCH);
    expect(avaliarCorrespondencia({ ledgerEstado: l.estado, schemaEstado: SCHEMA.PRESENT }))
      .toBe(CORRESPONDENCE.CONTRADICTED);
    expect(
      recomendar({
        ledgerEstado: l.estado,
        schemaEstado: SCHEMA.PRESENT,
        correspondencia: CORRESPONDENCE.CONTRADICTED,
      }),
    ).toBe(RECOMMENDATION.BLOCKED);
  });

  it("nunca sugere reconciliação automática nesse caso", () => {
    const r = recomendar({
      ledgerEstado: LEDGER.CHECKSUM_MISMATCH,
      schemaEstado: SCHEMA.PRESENT,
      correspondencia: CORRESPONDENCE.CONTRADICTED,
    });
    expect(r).not.toBe(RECOMMENDATION.CANDIDATE_WITH_ASSUMPTION);
    expect(r).not.toBe(RECOMMENDATION.ALREADY_RECONCILED);
  });
});

// ─── §27: CRLF ───────────────────────────────────────────────────────────────

describe("§27 — CRLF não é divergência", () => {
  it("um checkout com CRLF continua a bater com o checksum canónico", () => {
    const lf = "-- migration\nSELECT 1;\n";
    const canonico = checksumForNewMigration(lf);
    // O mesmo ficheiro materializado com CRLF pelo git no Windows.
    const crlf = normalizeToCRLF(lf);
    expect(avaliarLedger({ checksum: canonico }, crlf).estado).toBe(LEDGER.PRESENT);
  });

  it("usa o algoritmo do runner, não uma normalização nova", () => {
    const conteudo = "-- x\r\nSELECT 1;\r\n";
    // `checksumForNewMigration` normaliza sempre para LF — é o que o runner
    // gravaria. Reimplementar isto aqui era a forma de divergir em silêncio.
    expect(avaliarLedger({ checksum: checksumForNewMigration(conteudo) }, conteudo).estado)
      .toBe(LEDGER.PRESENT);
  });
});

// ─── §40: zero escrita ───────────────────────────────────────────────────────

describe("§40 — READ_ONLY_SQL_ONLY", () => {
  it("🔴 todo o SQL executado é SELECT", async () => {
    const c = producaoCompleta();
    for (const m of [M070, M071, M072, M073]) await inspecionarSchema(c, m);

    expect(c.sqlExecutado.length).toBeGreaterThan(0);
    for (const sql of c.sqlExecutado) {
      const inicio = sql.trim().toUpperCase();
      expect(inicio.startsWith("SELECT"), `não é SELECT: ${sql.slice(0, 60)}`).toBe(true);
      for (const verbo of ESCRITA) {
        expect(inicio.startsWith(verbo), `verbo de escrita: ${sql.slice(0, 60)}`).toBe(false);
      }
    }
  });

  it("o módulo não contém escrita ao ledger nem DDL", () => {
    const fonte = fs.readFileSync(
      path.join(__dirname, "..", "..", "scripts", "lib", "migration-reconciliation.mjs"),
      "utf8",
    );
    expect(fonte).not.toMatch(/INSERT\s+INTO/i);
    expect(fonte).not.toMatch(/UPDATE\s+public\./i);
    expect(fonte).not.toMatch(/DELETE\s+FROM/i);
    expect(fonte).not.toMatch(/\bDROP\s+(TABLE|FUNCTION|INDEX)/i);
  });

  it("a CLI recusa --apply com RECONCILIATION_WRITE_NOT_ENABLED", () => {
    const fonte = fs.readFileSync(
      path.join(__dirname, "..", "..", "scripts", "reconcile-migrations.mjs"),
      "utf8",
    );
    expect(fonte).toContain("RECONCILIATION_WRITE_NOT_ENABLED");
    // Não existe caminho de escrita: nem sequer desligado.
    expect(fonte).not.toMatch(/INSERT\s+INTO\s+public\._migrations/i);
    // A sessão é aberta em leitura no servidor.
    expect(fonte).toContain("BEGIN READ ONLY");
  });
});

// ─── Revisão pré-live: overloads, ordem, erro ≠ ausente ──────────────────────

describe("revisão pré-live", () => {
  it("🔴 overload extra não esconde a assinatura certa", async () => {
    // Duas funções com o mesmo nome e assinaturas diferentes. A query não
    // filtra por assinatura — devolve as duas — e a comparação procura a certa
    // entre elas. Um overload legítimo não pode virar MISMATCH.
    const r = await inspecionarSchema(
      fakeCatalog({
        funcoes: [
          { schema: "public", name: "unmark_payment_paid", args: "p_company_id uuid" }, // overload antigo
          { schema: "public", name: "unmark_payment_paid", args: "p_company_id uuid, p_payment_id uuid" }, // a certa
          { schema: "public", name: "mark_payment_paid", args: "p_company_id uuid, p_payment_id uuid, p_paid_on date" },
          { schema: "public", name: "is_financial_period_open", args: "p_company_id uuid, p_year integer, p_month integer" },
        ],
      }),
      M073,
    );
    expect(r.estado).toBe(SCHEMA.PRESENT);
  });

  it("🔴 só overloads errados → MISMATCH, e o detalhe lista os que existem", async () => {
    const r = await inspecionarSchema(
      fakeCatalog({
        funcoes: [
          { schema: "public", name: "unmark_payment_paid", args: "p_company_id uuid" },
          { schema: "public", name: "unmark_payment_paid", args: "p_id uuid, p_outro text" },
          { schema: "public", name: "mark_payment_paid", args: "p_company_id uuid, p_payment_id uuid, p_paid_on date" },
          { schema: "public", name: "is_financial_period_open", args: "p_company_id uuid, p_year integer, p_month integer" },
        ],
      }),
      M073,
    );
    expect(r.estado).toBe(SCHEMA.PARTIAL);
    const mau = r.objectos.find(
      (o: { alvo: string }) => o.alvo.includes("unmark_payment_paid"),
    ) as { estado: string; detalhe: string | null } | undefined;
    expect(mau?.estado).toBe("MISMATCH");
    // O detalhe tem de mostrar o que lá está, para a revisão humana decidir.
    expect(mau?.detalhe).toContain("p_id uuid");
  });

  it("🔴 falha a meio da introspecção → ERROR, nunca ABSENT", async () => {
    // O caso perigoso: algumas leituras passam, uma falha. Se isto devolvesse
    // ABSENT, um timeout no meio da verificação lia-se como «a migration não
    // está aplicada» — e uma reaplicação sobre dados reais parecia justificada.
    let n = 0;
    const client = {
      async query(sql: string, params: unknown[] = []) {
        n += 1;
        if (n > 2) throw new Error("connection reset");
        if (sql.includes("information_schema.tables")) {
          const [s, t] = params as string[];
          return { rows: `${s}.${t}` === "public.expense_categories" ? [{ ok: 1 }] : [] };
        }
        return { rows: [] };
      },
    };
    const r = await inspecionarSchema(client, M071);
    expect(r.estado).toBe(SCHEMA.ERROR);
    expect(r.estado).not.toBe(SCHEMA.ABSENT);
    expect(r.estado).not.toBe(SCHEMA.PARTIAL);
  });

  it("ERROR de schema → BLOCKED, e correspondência UNPROVABLE", () => {
    expect(
      recomendar({
        ledgerEstado: LEDGER.ABSENT,
        schemaEstado: SCHEMA.ERROR,
        correspondencia: CORRESPONDENCE.UNPROVABLE,
      }),
    ).toBe(RECOMMENDATION.BLOCKED);
    expect(avaliarCorrespondencia({ ledgerEstado: LEDGER.ABSENT, schemaEstado: SCHEMA.ERROR }))
      .toBe(CORRESPONDENCE.UNPROVABLE);
  });

  it("🔴 ABSENT só quando a base respondeu e não tinha nada", async () => {
    // Distinção que importa: aqui a base respondeu a tudo, e respondeu «não
    // existe». Isso é ABSENT legítimo — diferente de não ter conseguido ler.
    const r = await inspecionarSchema(fakeCatalog(), M071);
    expect(r.estado).toBe(SCHEMA.ABSENT);
    expect(
      recomendar({
        ledgerEstado: LEDGER.ABSENT,
        schemaEstado: r.estado,
        correspondencia: CORRESPONDENCE.UNPROVABLE,
      }),
    ).toBe(RECOMMENDATION.NOT_CANDIDATE);
  });
});

// ─── Manifesto completo ──────────────────────────────────────────────────────

describe("manifesto", () => {
  function dirComMigrations() {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "r0-manifest-"));
    for (const m of [M070, M071, M072, M073]) {
      fs.writeFileSync(path.join(dir, m), `-- ${m}\n`, "utf8");
    }
    return dir;
  }

  it("estado real esperado: 071/072/073 candidatas, 070 conforme catálogo", async () => {
    const dir = dirComMigrations();
    const m = await construirManifesto({
      client: producaoCompleta(),
      migrationsDir: dir,
      lerLedger: async () => new Map(), // ledger parado na 069
    });

    type Entrada = {
      migration: string;
      recommendation: string;
      correspondence: { CORRESPONDENCE_TO_EXECUTED_SQL: string };
    };
    const por: Record<string, Entrada> = Object.fromEntries(
      (m.entries as Entrada[]).map((e) => [e.migration, e]),
    );
    for (const mig of [M071, M072, M073]) {
      expect(por[mig].recommendation, mig).toBe(RECOMMENDATION.CANDIDATE_WITH_ASSUMPTION);
      expect(por[mig].correspondence.CORRESPONDENCE_TO_EXECUTED_SQL).toBe(CORRESPONDENCE.UNPROVABLE);
    }
    // A 070 não tem os objectos nesta fixture → não é candidata.
    expect(por[M070].recommendation).toBe(RECOMMENDATION.NOT_CANDIDATE);

    fs.rmSync(dir, { recursive: true, force: true });
  });

  it("§18 — a 072 carrega o estado da concorrência", async () => {
    const dir = dirComMigrations();
    const m = await construirManifesto({
      client: producaoCompleta(),
      migrationsDir: dir,
      migrations: [M072],
      lerLedger: async () => new Map(),
    });
    const notas = m.entries[0].evidence.notes.join(" ");
    expect(notas).toContain("ATOMIC_EFFECT = PROVEN");
    expect(notas).toContain("CONCURRENT_SERIALIZATION = NOT_PROVEN");
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it("determinístico: duas execuções dão exactamente o mesmo", async () => {
    const dir = dirComMigrations();
    const opts = {
      client: producaoCompleta(),
      migrationsDir: dir,
      lerLedger: async () => new Map(),
    };
    const a = await construirManifesto(opts);
    const b = await construirManifesto({ ...opts, client: producaoCompleta() });
    expect(JSON.stringify(a)).toBe(JSON.stringify(b));
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it("falha ao ler o ledger não vira 'ausente'", async () => {
    const dir = dirComMigrations();
    const m = await construirManifesto({
      client: producaoCompleta(),
      migrationsDir: dir,
      migrations: [M071],
      lerLedger: async () => {
        throw new Error("connection reset");
      },
    });
    expect(m.entries[0].ledger.state).toBe(LEDGER.ERROR);
    expect(m.entries[0].recommendation).toBe(RECOMMENDATION.BLOCKED);
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it("o relatório não vaza credenciais nem dados", async () => {
    const dir = dirComMigrations();
    const m = await construirManifesto({
      client: producaoCompleta(),
      migrationsDir: dir,
      lerLedger: async () => new Map(),
    });
    const txt = formatarManifesto(m).join("\n");
    expect(txt).not.toMatch(/sb_secret_|sb_publishable_|sbp_|eyJ|postgres:\/\//);
    expect(txt).toContain("Nenhuma escrita foi feita");
    fs.rmSync(dir, { recursive: true, force: true });
  });
});

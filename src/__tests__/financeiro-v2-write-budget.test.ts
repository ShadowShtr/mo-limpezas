// ============================================================================
// Financeiro V2 — cliquet do orçamento de escrita
// ============================================================================
//
// 🚨 Offline e **sem git**. Não usa `git diff`, nome de ramo, `origin/*`,
//    `merge-base` nem profundidade de checkout. Corre igual na máquina local,
//    num clone com só o HEAD, e no GitHub Actions.
//
// ---------------------------------------------------------------------------
// Porque foi reescrito
// ---------------------------------------------------------------------------
// A versão anterior comparava head com base por `git diff --name-only <ramo>`.
// Passava localmente e **falhava no CI** — o checkout é do SHA da PR, com
// profundidade 1, e o ramo base não existe:
//
//     fatal: ambiguous argument 'fix/t17b3-action-query-errors'
//
// O invariante mais importante da ronda nunca chegou a correr onde interessa.
//
// ---------------------------------------------------------------------------
// Três invariantes, separados de propósito
// ---------------------------------------------------------------------------
//
//   1. DIRECT_DB_MUTATION      a UI nunca escreve directamente na base
//   2. WRITE_ACTION_CAPABILITY que actions de escrita cada vista consegue
//                              disparar — inventário versionado, nos dois
//                              sentidos
//   3. AUTO_WRITE_ON_RENDER    o que corre só por abrir a página
//
// Misturá-los daria um número único que não se sabe interpretar. "Capacidade
// inalterada" e "deixou de escrever ao abrir" são afirmações diferentes.
//
// 🔴 Quando o mecanismo não consegue provar, **falha**. Nunca `skip`. Num
//    invariante financeiro, "não consegui verificar" tende para falha.
// ============================================================================

import { describe, it, expect } from "vitest";
import fs from "node:fs";
import path from "node:path";

import {
  compareToCeiling,
  countDirectDbMutations,
  stripComments,
  writeActionsUsedBy,
  writeCapableExports,
} from "@/lib/finance-write-surface";

const ROOT = process.cwd();
const ler = (rel: string) => fs.readFileSync(path.join(ROOT, rel), "utf8");

// ─── A superfície de UI financeira ──────────────────────────────────────────

const UI_DIRS = [
  "src/app/(dashboard)/dashboard/financeiro",
  "src/app/(dashboard)/dashboard/cobrancas",
  "src/app/(dashboard)/dashboard/folha-pagamento",
  "src/components/financeiro",
];

function walk(dir: string, acc: string[] = []): string[] {
  for (const e of fs.readdirSync(path.join(ROOT, dir), { withFileTypes: true })) {
    const rel = `${dir}/${e.name}`;
    if (e.isDirectory()) walk(rel, acc);
    else if (/\.tsx?$/.test(e.name)) acc.push(rel);
  }
  return acc;
}

const UI_FILES = UI_DIRS.flatMap((d) => walk(d)).sort();

/** Os ficheiros que são renderizados no servidor — o que corre ao abrir. */
const isServerPage = (rel: string) =>
  /\/page\.tsx$/.test(rel) && !/["']use client["']/.test(ler(rel));

// ─── Actions de escrita, derivadas do código ────────────────────────────────

function actionSources(): string[] {
  const out: string[] = [];
  const roots = ["src/app/actions"];
  for (const r of roots) {
    for (const e of fs.readdirSync(path.join(ROOT, r), { withFileTypes: true })) {
      if (e.isFile() && e.name.endsWith(".ts")) out.push(`${r}/${e.name}`);
    }
  }
  for (const d of ["src/app/(dashboard)/dashboard/calendario/_actions"]) {
    if (!fs.existsSync(path.join(ROOT, d))) continue;
    for (const e of fs.readdirSync(path.join(ROOT, d), { withFileTypes: true })) {
      if (e.isFile() && e.name.endsWith(".ts")) out.push(`${d}/${e.name}`);
    }
  }
  return out;
}

const WRITE_ACTIONS: string[] = [
  ...new Set(actionSources().flatMap((f) => writeCapableExports(ler(f)))),
].sort();

// ═══════════════════════════════════════════════════════════════════════════
// INVENTÁRIO VERSIONADO
// ═══════════════════════════════════════════════════════════════════════════
//
// Por ficheiro, as actions de escrita que ele pode disparar. Levantado do
// código no HEAD desta PR, não copiado de exemplo nenhum.
//
// Acrescentar uma entrada é uma decisão que se lê no diff. É esse o objectivo.

const CAPABILITY_CEILING: Record<string, string[]> = {
  // ── Pagamentos ────────────────────────────────────────────────────────────
  "src/app/(dashboard)/dashboard/financeiro/pagamentos/_components/payments-client.tsx": [
    "createPayment", "deletePayment", "deletePaymentAttachment", "getPayments",
    "setPaymentStatus", "updatePayment", "uploadPaymentAttachment",
  ],
  // 🔴 `getPayments` NÃO é leitura. Chama `ensureMonth`, que faz
  //    `.insert(rows)` para clonar os pagamentos fixos do mês anterior.
  //    Está aqui porque é a verdade — ver a secção AUTO_WRITE_ON_RENDER.
  "src/app/(dashboard)/dashboard/financeiro/pagamentos/page.tsx": [
    "getPayments",
  ],

  // ── Contas e Fluxo de Caixa (mesma fonte, mesmas actions) ─────────────────
  "src/app/(dashboard)/dashboard/financeiro/contas/_components/contas-client.tsx": [
    "createCashFlowEntry", "deleteCashFlowEntry", "updateCashFlowEntry",
  ],
  "src/app/(dashboard)/dashboard/financeiro/fluxo-caixa/_components/cash-flow-client.tsx": [
    "createCashFlowEntry", "deleteCashFlowEntry", "updateCashFlowEntry",
  ],

  // ── Cobranças ─────────────────────────────────────────────────────────────
  "src/app/(dashboard)/dashboard/cobrancas/_components/invoices-client.tsx": [
    "deleteInvoice", "generateInvoices", "updateInvoiceStatus",
  ],
  "src/app/(dashboard)/dashboard/cobrancas/_components/daily-billing-client.tsx": [
    "setServicePayment",
  ],

  // ── Folha ─────────────────────────────────────────────────────────────────
  "src/app/(dashboard)/dashboard/folha-pagamento/_components/payroll-client.tsx": [
    "approvePayrollRecords", "calculateAndSavePayroll", "markPayrollPaid",
  ],
  "src/app/(dashboard)/dashboard/folha-pagamento/_components/payroll-edit-sheet.tsx": [
    "adjustPayrollRecord",
  ],

  // ── Conciliação ───────────────────────────────────────────────────────────
  "src/app/(dashboard)/dashboard/financeiro/conciliacao/_components/reconciliation-client.tsx": [
    "confirmMatch", "createEntryFromTransaction", "deleteImport",
    "ignoreTransaction", "manualMatch", "rejectMatch",
  ],
};

/**
 * Páginas de servidor autorizadas a chamar uma action que escreve durante o
 * render.
 *
 * 🔴 **Uma só, e é uma dívida, não um padrão.**
 *
 * `pagamentos/page.tsx` chama `getPayments`, que chama `ensureMonth`, que
 * insere: abrir a página **gera** os pagamentos fixos do mês pedido, clonados
 * do mês anterior mais recente.
 *
 * Não foi corrigido nesta PR porque a correcção vive em `payments.ts`, que está
 * `BLOQUEADO_INCIDENTE_FINANCEIRO` — é exactamente o ficheiro sob diagnóstico.
 * Mexer-lhe antes da evidência seria escrever por cima do que se está a medir.
 *
 * A Folha tinha o mesmo defeito e **foi** corrigida nesta PR
 * (`ensurePayrollCalculated` saiu do render), porque aí a correcção era só
 * retirar o gatilho, sem tocar no motor.
 */
const AUTO_WRITE_ON_RENDER_ALLOWED: Record<string, string[]> = {
  "src/app/(dashboard)/dashboard/financeiro/pagamentos/page.tsx": ["getPayments"],
};

// ═══════════════════════════════════════════════════════════════════════════

describe("Financeiro V2 — o mecanismo do cliquet", () => {
  it("não depende de git, ramos nem profundidade de checkout", () => {
    // Verificar a CAPACIDADE, não as palavras.
    //
    // Uma primeira versão procurava as cadeias "git diff", "merge-base" e
    // "execFileSync" no código dos dois ficheiros — e encontrava-as na própria
    // lista de termos proibidos, aqui dentro. É a armadilha "mencionar ≠ usar"
    // que este projecto já apanhou sete vezes; procurar por texto é sempre
    // convidá-la a voltar.
    //
    // O que torna um teste dependente de git é **poder executar git**. Sem
    // importar `node:child_process` não há como.
    for (const f of [
      "src/__tests__/financeiro-v2-write-budget.test.ts",
      "src/lib/finance-write-surface.ts",
    ]) {
      const code = stripComments(ler(f));
      expect(code, `${f}: não pode importar child_process`)
        .not.toMatch(/from\s+["']node:child_process["']|require\(\s*["']node:child_process["']/);
      expect(code, `${f}: não pode invocar git`)
        .not.toMatch(/["'`]git["'`]\s*,/);
    }
  });

  it("distingue mutação na base de método de colecção", () => {
    // `next.delete(id)` sobre um Set não é escrita na base. Contá-lo faria o
    // cliquet medir a coisa errada — foi o primeiro erro desta ferramenta.
    expect(countDirectDbMutations(`const next = new Set(); next.delete(id);`)).toBe(0);
    expect(countDirectDbMutations(`map.set(k, v); arr.filter(Boolean);`)).toBe(0);
    expect(countDirectDbMutations(`await admin.from("services").delete().eq("id", x);`)).toBe(1);
    expect(countDirectDbMutations(`await admin.from("t").insert(rows);`)).toBe(1);
    expect(countDirectDbMutations(`await supabase.rpc("detect_conflicts", {});`)).toBe(1);
  });

  it("ignora o que está em comentário", () => {
    expect(countDirectDbMutations(`// await admin.from("t").insert(x)`)).toBe(0);
    expect(countDirectDbMutations(`/* .from("t").update({}) */`)).toBe(0);
  });

  it("segue a delegação: uma action que só chama outra também escreve", () => {
    const src = `
      async function inner() { await admin.from("t").insert(rows); }
      export async function outer() { return inner(); }
      export async function puro() { return 1; }
    `;
    expect(writeCapableExports(src)).toEqual(["outer"]);
  });

  it("apanha o caso real: uma função com nome de leitura que escreve", () => {
    // É o `getPayments`: chama `ensureMonth`, que insere.
    const src = `
      async function ensureMonth() { await admin.from("p").insert(rows); }
      export async function getThings(y: number) { await ensureMonth(); return read(); }
    `;
    expect(writeCapableExports(src)).toContain("getThings");
  });

  it("não entra em ciclo com funções recursivas", () => {
    const src = `
      export async function a() { return b(); }
      async function b() { return a(); }
    `;
    expect(() => writeCapableExports(src)).not.toThrow();
    expect(writeCapableExports(src)).toEqual([]);
  });

  it("o corpo da função não é confundido com a assinatura", () => {
    const src = `export async function f(input: { kind: string }): Promise<{ ok: true }> {
      await admin.from("t").insert(input);
    }`;
    expect(writeCapableExports(src)).toEqual(["f"]);
  });

  it("capacidade nova → FALHA", () => {
    const v = compareToCeiling(["createPayment", "deletePayment"], ["createPayment"]);
    expect(v.added).toEqual(["deletePayment"]);
    expect(v.removed).toEqual([]);
  });

  it("capacidade removida → exige baixar o tecto", () => {
    const v = compareToCeiling(["createPayment"], ["createPayment", "deletePayment"]);
    expect(v.added).toEqual([]);
    expect(v.removed).toEqual(["deletePayment"]);
  });

  it("igual ao tecto → passa", () => {
    expect(compareToCeiling(["a", "b"], ["b", "a"])).toEqual({ added: [], removed: [] });
  });
});

describe("Financeiro V2 — a lista de actions de escrita é real", () => {
  it("foi derivada do código e não está vazia", () => {
    // Se o detector partir, esta lista esvazia — e todos os outros testes
    // passariam por vacuidade. É a falha que o teste tem de apanhar primeiro.
    expect(WRITE_ACTIONS.length).toBeGreaterThan(30);
  });

  it("inclui as que escrevem por delegação, não só as óbvias", () => {
    for (const a of [
      "createPayment", "deletePayment", "generateInvoices", "markPayrollPaid",
      "calculateAndSavePayroll",   // → runPayrollCalculation → upsert
      "getPayments",               // → ensureMonth → insert
    ]) {
      expect(WRITE_ACTIONS, `${a} devia ser reconhecida como escrita`).toContain(a);
    }
  });

  it("não classifica leituras puras como escrita", () => {
    for (const a of ["getInvoices", "getPayrollRecords", "getCashFlowEntries"]) {
      expect(WRITE_ACTIONS, `${a} é leitura`).not.toContain(a);
    }
  });
});

describe("Financeiro V2 — invariante 1: a UI não escreve directamente", () => {
  it("nenhum ficheiro da UI financeira faz mutação na base", () => {
    // Toda a escrita passa por server actions. Uma mutação directa aqui seria
    // o padrão que a auditoria já apanhou noutras áreas (equipas, saldo de
    // férias): o browser a escrever com RLS a decidir em silêncio.
    const infractores = UI_FILES
      .map((f) => [f, countDirectDbMutations(ler(f))] as const)
      .filter(([, n]) => n > 0)
      .map(([f, n]) => `${f}: ${n}`);
    expect(infractores).toEqual([]);
  });
});

describe("Financeiro V2 — invariante 2: capacidade inventariada", () => {
  const observado = new Map<string, string[]>();
  for (const f of UI_FILES) {
    const usadas = writeActionsUsedBy(ler(f), WRITE_ACTIONS);
    if (usadas.length > 0) observado.set(f, usadas);
  }

  it("nenhum ficheiro financeiro com capacidade de escrita fica fora do inventário", () => {
    // Fail-closed: um ficheiro novo que ligue uma action de escrita tem de ser
    // declarado. Não há allowlist genérica.
    const naoInventariados = [...observado.keys()].filter((f) => !(f in CAPABILITY_CEILING));
    expect(
      naoInventariados,
      "acrescentar ao CAPABILITY_CEILING, com as actions que o ficheiro dispara",
    ).toEqual([]);
  });

  it("o inventário não tem entradas mortas", () => {
    const fantasmas = Object.keys(CAPABILITY_CEILING).filter((f) => !observado.has(f));
    expect(fantasmas, "estas entradas já não correspondem a nada — remover").toEqual([]);
  });

  it("🔴 nenhuma capacidade de escrita nova", () => {
    const novas: string[] = [];
    for (const [f, actual] of observado) {
      const { added } = compareToCeiling(actual, CAPABILITY_CEILING[f] ?? []);
      for (const a of added) novas.push(`${f} → ${a}`);
    }
    expect(novas, "capacidade de escrita nova numa vista financeira").toEqual([]);
  });

  it("capacidade removida obriga a baixar o tecto", () => {
    const aDescer: string[] = [];
    for (const [f, ceiling] of Object.entries(CAPABILITY_CEILING)) {
      const { removed } = compareToCeiling(observado.get(f) ?? [], ceiling);
      for (const r of removed) aDescer.push(`${f}: retirar "${r}" do tecto`);
    }
    expect(
      aDescer,
      "o Financeiro V2 avançou — baixar o tecto para que o cliquet continue a ser prova",
    ).toEqual([]);
  });
});

describe("Financeiro V2 — invariante 3: o render não escreve", () => {
  const paginas = UI_FILES.filter(isServerPage);

  it("as sete vistas foram encontradas", () => {
    // Se a descoberta partir, os testes seguintes passariam sem verificar nada.
    expect(paginas.length).toBeGreaterThanOrEqual(7);
  });

  it("🔴 abrir uma página só pode escrever onde está declarado", () => {
    const infractores: string[] = [];
    for (const p of paginas) {
      const usadas = writeActionsUsedBy(ler(p), WRITE_ACTIONS);
      const permitidas = AUTO_WRITE_ON_RENDER_ALLOWED[p] ?? [];
      for (const a of usadas) {
        if (!permitidas.includes(a)) infractores.push(`${p} → ${a}`);
      }
    }
    expect(
      infractores,
      "navegar, mudar de aba ou mudar de mês não pode escrever",
    ).toEqual([]);
  });

  it("a lista de excepções não cresce em silêncio", () => {
    // Hoje é uma: `getPayments` em pagamentos/page.tsx, bloqueada pelo
    // incidente. Se aparecer outra, tem de se ver no diff.
    expect(Object.keys(AUTO_WRITE_ON_RENDER_ALLOWED)).toEqual([
      "src/app/(dashboard)/dashboard/financeiro/pagamentos/page.tsx",
    ]);
  });

  it("a Folha saiu da lista de excepções — foi corrigida nesta PR", () => {
    const folha = "src/app/(dashboard)/dashboard/folha-pagamento/page.tsx";
    expect(AUTO_WRITE_ON_RENDER_ALLOWED[folha]).toBeUndefined();
    expect(writeActionsUsedBy(ler(folha), WRITE_ACTIONS)).toEqual([]);
  });
});

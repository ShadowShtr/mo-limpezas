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
  collectServerRenderGraph,
  compareToCeiling,
  countDirectDbMutations,
  isClientComponent,
  resolveImport,
  stripComments,
  writeActionsUsedBy,
  writeCapableExports,
  createWriteCapabilityResolver,
} from "@/lib/finance-write-surface";

const ROOT = process.cwd();
const ler = (rel: string) => fs.readFileSync(path.join(ROOT, rel), "utf8");
const lerOuNull = (rel: string): string | null => {
  try { return ler(rel); } catch { return null; }
};

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

// Nota: havia aqui um `isServerPage` que filtrava por `page.tsx`. Foi essa a
// regra que deixou passar o `PaymentsReminderBanner` — o banner não é uma
// página. O invariante 3 passou a percorrer o grafo de render a partir das
// raízes; ver `collectServerRenderGraph`.

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

// O resolvedor segue a delegação **através de ficheiros**. Um teste de mutação
// mostrou que a versão por-ficheiro era cega a isto: mover a materialização de
// mês para outro módulo e importá-la de volta fazia `getPayments` voltar a
// escrever sem nenhuma guarda acusar. Um `insert` a um import de distância era
// invisível — e reconhecer só o caminho conhecido dá um "seguro" falso.
const resolvedor = createWriteCapabilityResolver(lerOuNull);

const WRITE_ACTIONS: string[] = [
  ...new Set(actionSources().flatMap((f) => resolvedor.exportsThatWrite(f))),
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
  // `getPayments` saiu desta lista nesta PR: deixou de chamar `ensureMonth` e
  // passou a ser mesmo leitura. O tecto desce com ele — se voltasse a escrever,
  // `compareToCeiling` acusaria capacidade nova e este teste falharia.
  "src/app/(dashboard)/dashboard/financeiro/pagamentos/_components/payments-client.tsx": [
    "createPayment", "deletePayment", "deletePaymentAttachment",
    "setPaymentStatus", "updatePayment", "uploadPaymentAttachment",
  ],
  // `pagamentos/page.tsx` desapareceu deste inventário por não lhe restar
  // nenhuma capacidade de escrita — só chama `getPayments`.

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
  // `recalcSuggestions` entrou aqui quando o detector passou a seguir imports.
  // Não é capacidade nova — sempre escreveu, via
  // `generateSuggestions` (`src/lib/bank-import/reconcile-db.ts`) → `.upsert`.
  // Era invisível porque a mutação vive noutro ficheiro. É CLICK_TRIGGER: o
  // componente é de cliente, e o grafo de render não lhe chega.
  "src/app/(dashboard)/dashboard/financeiro/conciliacao/_components/reconciliation-client.tsx": [
    "confirmMatch", "createEntryFromTransaction", "deleteImport",
    "ignoreTransaction", "manualMatch", "recalcSuggestions", "rejectMatch",
  ],
};

/**
 * Páginas de servidor autorizadas a chamar uma action que escreve durante o
 * render.
 *
 * ✅ **Vazio.** Renderizar não escreve, em lado nenhum do Financeiro.
 *
 * Teve uma entrada — `pagamentos/page.tsx → getPayments → ensureMonth →
 * insert`. Abrir a página gerava os pagamentos fixos do mês, clonados do mês
 * anterior. Foi assim que os 15 fixos de Agosto/2026 nasceram todos no mesmo
 * segundo, e que quatro vencimentos trimestrais foram esmagados numa só data.
 *
 * A PR C retirou-a. Este objecto ficar vazio é o invariante: uma entrada nova
 * é uma decisão que se lê no diff, e tem de ser defendida.
 */
const AUTO_WRITE_ON_RENDER_ALLOWED: Record<string, string[]> = {};

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


// ═══════════════════════════════════════════════════════════════════════════
// INVARIANTE 3 — o grafo de renderização
// ═══════════════════════════════════════════════════════════════════════════
//
// A versão anterior olhava só para `page.tsx` dentro das pastas financeiras. E
// falhou-lhe exactamente este caminho:
//
//     finance-shell.tsx → PaymentsReminderBanner → getPaymentsReminder
//                       → ensureMonth → insert
//
// O banner não é uma página e nem sequer vive numa pasta financeira. Uma regra
// baseada em nomes de ficheiro e pastas nunca lá chegaria.
//
// Agora parte-se das raízes e percorre-se o grafo, parando nos componentes de
// cliente — onde o código deixa de correr no render do servidor.

/** As sete vistas. É daqui que o render começa. */
const FINANCE_RENDER_ROOTS = [
  "src/app/(dashboard)/dashboard/financeiro/page.tsx",
  "src/app/(dashboard)/dashboard/financeiro/pagamentos/page.tsx",
  "src/app/(dashboard)/dashboard/financeiro/contas/page.tsx",
  "src/app/(dashboard)/dashboard/financeiro/fluxo-caixa/page.tsx",
  "src/app/(dashboard)/dashboard/financeiro/conciliacao/page.tsx",
  "src/app/(dashboard)/dashboard/cobrancas/page.tsx",
  "src/app/(dashboard)/dashboard/folha-pagamento/page.tsx",
];

describe("Financeiro V2 — o grafo de render é percorrido a sério", () => {
  it("resolve imports relativos e de alias", () => {
    const existe = (r: string) => ["src/components/x.tsx", "src/a/b/c.ts"].includes(r);
    expect(resolveImport("src/app/p/page.tsx", "@/components/x", existe)).toBe("src/components/x.tsx");
    expect(resolveImport("src/a/b/d.ts", "./c", existe)).toBe("src/a/b/c.ts");
    expect(resolveImport("src/a/b/d.ts", "../b/c", existe)).toBe("src/a/b/c.ts");
    expect(resolveImport("src/a/b/d.ts", "react", existe)).toBeNull();
  });

  it("reconhece um componente de cliente", () => {
    expect(isClientComponent('"use client";\nexport function X() {}')).toBe(true);
    expect(isClientComponent("export function X() {}")).toBe(false);
  });

  it("B: shell → componente de servidor com escrita → é alcançado", () => {
    const fake: Record<string, string> = {
      "src/p/page.tsx": 'import { Shell } from "@/c/shell";',
      "src/c/shell.tsx": 'import { Banner } from "@/c/banner";',
      "src/c/banner.tsx": 'import { getReminder } from "@/app/actions/x";\nawait getReminder();',
    };
    const grafo = collectServerRenderGraph(["src/p/page.tsx"], (r) => fake[r] ?? null);
    expect(grafo).toContain("src/c/banner.tsx");
    expect(writeActionsUsedBy(fake["src/c/banner.tsx"], ["getReminder"])).toEqual(["getReminder"]);
  });

  it("C: página → intermédio → servidor → helper de escrita → é alcançado", () => {
    const fake: Record<string, string> = {
      "src/p/page.tsx": 'import { A } from "./a";',
      "src/p/a.tsx": 'import { B } from "./b";',
      "src/p/b.tsx": 'import { escrever } from "@/app/actions/y";\nawait escrever();',
    };
    const grafo = collectServerRenderGraph(["src/p/page.tsx"], (r) => fake[r] ?? null);
    expect(grafo).toEqual(["src/p/a.tsx", "src/p/b.tsx", "src/p/page.tsx"]);
  });

  it("🔴 D: um componente de cliente com a action num onClick NÃO é auto-write", () => {
    // A distinção que impede a guarda de encher de falsos positivos:
    // CAPABILITY não é RENDER_TRIGGER.
    const fake: Record<string, string> = {
      "src/p/page.tsx": 'import { C } from "./c";',
      "src/p/c.tsx": '"use client";\nimport { deletePayment } from "@/app/actions/payments";\nonClick={() => deletePayment(1)}',
    };
    const grafo = collectServerRenderGraph(["src/p/page.tsx"], (r) => fake[r] ?? null);
    expect(grafo, "a travessia pára no componente de cliente").toEqual(["src/p/page.tsx"]);
    expect(grafo).not.toContain("src/p/c.tsx");
  });

  it("E: componente de servidor novo com mutação directa é alcançado", () => {
    const fake: Record<string, string> = {
      "src/p/page.tsx": 'import { S } from "./s";',
      "src/p/s.tsx": 'await admin.from("t").insert({});',
    };
    const grafo = collectServerRenderGraph(["src/p/page.tsx"], (r) => fake[r] ?? null);
    expect(grafo).toContain("src/p/s.tsx");
    expect(countDirectDbMutations(fake["src/p/s.tsx"])).toBe(1);
  });

  it("F: um componente fora da pasta da página continua a ser analisado", () => {
    // Foi isto que falhou: o banner vive em `dashboard/_components/`.
    const fake: Record<string, string> = {
      "src/app/x/page.tsx": 'import { Longe } from "@/outra/pasta/longe";',
      "src/outra/pasta/longe.tsx": "export async function Longe() { return null; }",
    };
    const grafo = collectServerRenderGraph(["src/app/x/page.tsx"], (r) => fake[r] ?? null);
    expect(grafo).toContain("src/outra/pasta/longe.tsx");
  });
});

describe("Financeiro V2 — invariante 3: o grafo de render não escreve", () => {
  const grafo = collectServerRenderGraph(FINANCE_RENDER_ROOTS, lerOuNull);

  it("o grafo foi mesmo percorrido", () => {
    // Se a travessia partir, tudo o resto passaria por vacuidade.
    expect(grafo.length).toBeGreaterThanOrEqual(FINANCE_RENDER_ROOTS.length);
    for (const r of FINANCE_RENDER_ROOTS) expect(grafo).toContain(r);
    expect(grafo, "a casca é partilhada pelas sete vistas")
      .toContain("src/components/financeiro/finance-shell.tsx");
  });

  it("🔴 nada no grafo de render chama uma action que escreve, salvo o declarado", () => {
    const infractores: string[] = [];
    for (const f of grafo) {
      const usadas = writeActionsUsedBy(lerOuNull(f) ?? "", WRITE_ACTIONS);
      const permitidas = AUTO_WRITE_ON_RENDER_ALLOWED[f] ?? [];
      for (const a of usadas) if (!permitidas.includes(a)) infractores.push(`${f} → ${a}`);
    }
    expect(
      infractores,
      "abrir uma vista financeira não pode escrever — ver o grafo de render",
    ).toEqual([]);
  });

  it("nada no grafo de render faz mutação directa", () => {
    const infractores = grafo
      .map((f) => [f, countDirectDbMutations(lerOuNull(f) ?? "")] as const)
      .filter(([, n]) => n > 0)
      .map(([f]) => f);
    expect(infractores).toEqual([]);
  });

  it("A: a casca não monta o PaymentsReminderBanner", () => {
    // Montá-lo levava `ensureMonth` das duas superfícies que já o tinham para
    // as sete vistas — a casca estaria a ampliar o auto-write.
    const shell = stripComments(lerOuNull("src/components/financeiro/finance-shell.tsx") ?? "");
    expect(shell).not.toMatch(/PaymentsReminderBanner/);
    expect(grafo).not.toContain("src/app/(dashboard)/dashboard/_components/payments-reminder-banner.tsx");
  });

  it("G: FINANCE_SHELL_SHARED_AUTO_WRITE = 0", () => {
    // O que a casca acrescenta, partilhado pelas sete vistas.
    const partilhados = grafo.filter((f) => f.startsWith("src/components/financeiro/"));
    expect(partilhados.length).toBeGreaterThan(0);
    const comEscrita = partilhados.filter((f) =>
      writeActionsUsedBy(lerOuNull(f) ?? "", WRITE_ACTIONS).length > 0
      || countDirectDbMutations(lerOuNull(f) ?? "") > 0);
    expect(comEscrita, "a casca não pode ter efeito financeiro partilhado").toEqual([]);
  });

  it("🔴 H: PAYMENTS_PAGE_PREEXISTING_AUTO_WRITE = 0", () => {
    // Era 1: `getPayments` → `ensureMonth` → `insert`.
    const pag = "src/app/(dashboard)/dashboard/financeiro/pagamentos/page.tsx";
    expect(AUTO_WRITE_ON_RENDER_ALLOWED[pag]).toBeUndefined();
    expect(
      writeActionsUsedBy(lerOuNull(pag) ?? "", WRITE_ACTIONS),
      "abrir Pagamentos não pode gerar pagamentos",
    ).toEqual([]);
  });

  it("I: não há excepções nenhumas, e a lista não cresce em silêncio", () => {
    expect(Object.keys(AUTO_WRITE_ON_RENDER_ALLOWED)).toEqual([]);
  });

  it("a Folha saiu da lista — foi corrigida na PR A", () => {
    const folha = "src/app/(dashboard)/dashboard/folha-pagamento/page.tsx";
    expect(AUTO_WRITE_ON_RENDER_ALLOWED[folha]).toBeUndefined();
    expect(writeActionsUsedBy(lerOuNull(folha) ?? "", WRITE_ACTIONS)).toEqual([]);
  });

  it("🔴 DASHBOARD_PREEXISTING_AUTO_WRITE = 0", () => {
    // O banner continua montado no Dashboard — e pode continuar, porque
    // `getPaymentsReminder` deixou de materializar o mês corrente. O que se
    // corrigiu não foi o sítio onde o banner está: foi o que ele fazia.
    const dash = stripComments(lerOuNull("src/app/(dashboard)/dashboard/page.tsx") ?? "");
    expect(dash).toMatch(/PaymentsReminderBanner/);

    const banner = "src/app/(dashboard)/dashboard/_components/payments-reminder-banner.tsx";
    expect(lerOuNull(banner), "o banner tem de existir para isto provar algo").not.toBeNull();
    expect(
      writeActionsUsedBy(lerOuNull(banner) ?? "", WRITE_ACTIONS),
      "entrar no Dashboard não pode criar pagamentos",
    ).toEqual([]);
  });
});

// ============================================================================
// O período governa todas as abas financeiras
// ============================================================================
//
// O seletor diz «Agosto 2026». Se uma aba responder sobre outro horizonte, a
// interface está a afirmar uma coisa que o motor não sustenta — e o utilizador
// não tem como perceber qual das duas está certa.
//
// Já se encontraram três casos:
//
//   getFinancialDashboard   ignorava o período por completo    → corrigido
//   getAccountsData         devolvia toda a história           → corrigido
//   getBankReconciliationData  últimos 500 movimentos de sempre → corrigido
//
// Estes testes existem para o quarto não passar despercebido.
// ============================================================================

import { describe, it, expect } from "vitest";
import fs from "node:fs";
import path from "node:path";

import { stripComments } from "@/lib/finance-write-surface";
import { calcularKpis, type FactoFatura, type FactoFolha, type Fonte } from "@/domain/finance-v2/aggregate";
import type { FinanceReadContext } from "@/domain/finance-v2/types";

const ROOT = process.cwd();
const ler = (rel: string) => fs.readFileSync(path.join(ROOT, rel), "utf8");
const codigo = (rel: string) => stripComments(ler(rel));

const ctx = (year: number, month: number): FinanceReadContext => ({
  companyId: "A", year, month,
  periodStart: `${year}-${String(month).padStart(2, "0")}-01`,
  periodEnd: `${year}-${String(month).padStart(2, "0")}-${new Date(Date.UTC(year, month, 0)).getUTCDate()}`,
  todayLisbon: "2026-08-12",
});

// ─── 1. As sete páginas resolvem o período ───────────────────────────────────

const PAGINAS = [
  "src/app/(dashboard)/dashboard/financeiro/page.tsx",
  "src/app/(dashboard)/dashboard/financeiro/pagamentos/page.tsx",
  "src/app/(dashboard)/dashboard/financeiro/contas/page.tsx",
  "src/app/(dashboard)/dashboard/financeiro/fluxo-caixa/page.tsx",
  "src/app/(dashboard)/dashboard/financeiro/conciliacao/page.tsx",
  "src/app/(dashboard)/dashboard/cobrancas/page.tsx",
  "src/app/(dashboard)/dashboard/folha-pagamento/page.tsx",
];

describe("todas as vistas leem o mesmo `?mes=`", () => {
  it("cada página resolve o período da rota", () => {
    for (const p of PAGINAS) {
      expect(codigo(p), `${p} não lê o período`).toMatch(/parseFinancePeriod\(params\.mes\)/);
    }
  });

  it("🔴 nenhuma página decide o mês pelo relógio", () => {
    // `new Date()` numa página de servidor decide o mês em UTC, e discorda do
    // seletor durante a primeira hora do dia em hora de verão.
    for (const p of PAGINAS) {
      expect(codigo(p), `${p} usa o relógio`).not.toMatch(/new Date\(\)\.getMonth|new Date\(\)\.getFullYear/);
    }
  });
});

// ─── 2. Os carregadores aceitam o período ────────────────────────────────────

describe("os carregadores recebem o período, e usam-no", () => {
  it("🔴 getAccountsData filtra os três blocos", () => {
    const src = codigo("src/app/actions/cash-flow.ts");
    const i = src.indexOf("export async function getAccountsData");
    const corpo = src.slice(i, i + 2600);

    expect(corpo, "assinatura sem período").toMatch(/input\?:\s*\{\s*year:\s*number;\s*month:\s*number\s*\}/);
    // Faturas por vencimento, salários por período contabilístico, despesas
    // pela data do movimento — cada bloco pelo que faz sentido para si.
    expect(corpo).toMatch(/invoicesQ\.gte\("due_date"/);
    expect(corpo).toMatch(/payrollQ\.eq\("period_year"/);
    expect(corpo).toMatch(/expensesQ\.gte\("date"/);
  });

  it("🔴 getBankReconciliationData filtra os movimentos", () => {
    const src = codigo("src/app/actions/bank-reconciliation.ts");
    expect(src).toMatch(/period\?:\s*\{\s*year:\s*number;\s*month:\s*number\s*\}/);
    expect(src).toMatch(/txQuery\.gte\("transaction_date"/);
  });

  it("as páginas passam mesmo o período aos carregadores", () => {
    expect(codigo("src/app/(dashboard)/dashboard/financeiro/contas/page.tsx"))
      .toMatch(/getAccountsData\(\s*\{\s*year:\s*period\.year,\s*month:\s*period\.month\s*\}\s*\)/);
    expect(codigo("src/app/(dashboard)/dashboard/financeiro/conciliacao/page.tsx"))
      .toMatch(/period:\s*\{\s*year:\s*period\.year,\s*month:\s*period\.month\s*\}/);
  });

  it("o Resumo usa o motor novo, não o legado, para os números", () => {
    const src = codigo("src/app/(dashboard)/dashboard/financeiro/page.tsx");
    expect(src).toMatch(/getFinanceDashboardV2\(\s*\{\s*year:\s*period\.year,\s*month:\s*period\.month\s*\}\s*\)/);
  });
});

// ─── 3. Julho 100 / Agosto 200 ───────────────────────────────────────────────

describe("🔴 Julho 100, Agosto 200", () => {
  const ok = <T,>(f: T[]): Fonte<T> => ({ ok: true, factos: f });
  const semFolha: Fonte<FactoFolha> = ok([]);
  const fatura = (o: Partial<FactoFatura>): FactoFatura => ({
    id: "f", status: "emitida", total: 0, dueDate: null, paidAt: null,
    periodStart: null, clientId: null, clientName: null, ...o,
  });

  const faturas = ok([
    fatura({ id: "jul", total: 100, periodStart: "2026-07-01", dueDate: "2026-07-31" }),
    fatura({ id: "ago", total: 200, periodStart: "2026-08-01", dueDate: "2026-08-31" }),
  ]);

  it("Faturado muda com o mês", () => {
    expect(calcularKpis(faturas, ok([]), semFolha, ctx(2026, 7)).faturado.valor).toBe(100);
    expect(calcularKpis(faturas, ok([]), semFolha, ctx(2026, 8)).faturado.valor).toBe(200);
  });

  it("🔴 Em aberto também — e não a carteira toda", () => {
    // Era o defeito que restava: «Em aberto» somava faturas de todos os
    // períodos, e não mudava ao trocar de mês.
    const jul = calcularKpis(faturas, ok([]), semFolha, ctx(2026, 7)).emAberto.valor;
    const ago = calcularKpis(faturas, ok([]), semFolha, ctx(2026, 8)).emAberto.valor;
    expect(jul).toBe(100);
    expect(ago).toBe(200);
    expect(jul).not.toBe(ago);
  });

  it("Custos e Recebido seguem as datas dos movimentos", () => {
    const caixa = ok([
      { date: "2026-07-05", tipo: "entrada" as const, status: "confirmado", amount: 100, categoria: null },
      { date: "2026-08-05", tipo: "entrada" as const, status: "confirmado", amount: 200, categoria: null },
      { date: "2026-07-06", tipo: "saida" as const, status: "confirmado", amount: 10, categoria: "fornecedor" },
      { date: "2026-08-06", tipo: "saida" as const, status: "confirmado", amount: 20, categoria: "fornecedor" },
    ]);
    expect(calcularKpis(ok([]), caixa, semFolha, ctx(2026, 7)).recebido.valor).toBe(100);
    expect(calcularKpis(ok([]), caixa, semFolha, ctx(2026, 8)).recebido.valor).toBe(200);
    expect(calcularKpis(ok([]), caixa, semFolha, ctx(2026, 7)).custos.valor).toBe(10);
    expect(calcularKpis(ok([]), caixa, semFolha, ctx(2026, 8)).custos.valor).toBe(20);
  });

  it("🔴 uma falha continua a não virar zero, em qualquer mês", () => {
    for (const m of [7, 8]) {
      const k = calcularKpis({ ok: false, erro: "timeout" }, ok([]), semFolha, ctx(2026, m));
      expect(k.faturado.estado).toBe("ERROR");
      expect(k.faturado.valor).toBeNull();
    }
  });
});

// ─── 4. Aging: global, e assumido como tal ───────────────────────────────────

describe("aging — global por decisão explícita", () => {
  it("é a carteira vencida inteira, e isso está escrito", () => {
    // Uma decisão que fica assumida em vez de silenciosa: o aging responde
    // «que dívida antiga existe hoje», não «que dívida nasceu em Agosto».
    // Filtrá-lo pelo mês esvaziaria os baldes de +30 dias precisamente quando
    // são mais úteis.
    const src = ler("src/domain/finance-v2/aggregate.ts");
    const i = src.indexOf("export function calcularAging");
    const corpo = src.slice(Math.max(i - 900, 0), i + 400);
    expect(corpo, "a decisão tem de estar documentada").toMatch(/carteira|global|idade/i);
  });
});

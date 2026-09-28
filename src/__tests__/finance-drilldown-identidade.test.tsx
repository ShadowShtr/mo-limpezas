// @vitest-environment jsdom
// ============================================================================
// Resumo → Fluxo de Caixa: o drilldown fala da MESMA categoria que a fatia
// ============================================================================
//
// Percurso completo, com o código real em cada passo e só a base fingida:
//
//   getFinanceDashboardV2          (agrupa — identidade canónica)
//   → FinancialDashboardClient     (o link que o utilizador clica)
//   → fluxo-caixa/page.tsx         (lê `categoriaKey` da URL)
//   → getCashFlowEntries           (calcula `effective_expense_category_key`)
//   → CashFlowClient               (filtra e mostra as linhas)
//
// A. estruturada «Fornecedor» ≠ legado «fornecedor»: duas fatias, dois links,
//    duas listas — nenhuma devolve a linha da outra.
// B. movimento de pagamento com texto legado «despesa» e pagamento em
//    «Combustível»: fica no UUID do Combustível e o drilldown encontra-o.
// C. movimento de pagamento SEM categoria: `uncategorized`, nunca
//    `legacy:despesa` por acidente.
// ============================================================================

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, type ReactElement } from "react";
import { createRoot, type Root } from "react-dom/client";

const EMPRESA = "11111111-1111-4111-8111-111111111111";
type Linha = Record<string, unknown>;
const db = vi.hoisted(() => ({ tabelas: {} as Record<string, Linha[]> }));

vi.mock("@/lib/auth-guard", () => ({
  requireProfile: async () => ({
    ok: true,
    profile: { id: "p", company_id: "11111111-1111-4111-8111-111111111111", role: "admin" },
    admin: fakeAdmin(),
  }),
}));
vi.mock("@/lib/supabase/admin", () => ({ createAdminClient: () => fakeAdmin() }));
vi.mock("@/lib/supabase/server", () => ({
  createClient: async () => ({ auth: { getUser: async () => ({ data: { user: { id: "p" } } }) } }),
}));
vi.mock("@/lib/supabase/client", () => ({
  createClient: () => ({
    channel: () => { const c = { on: () => c, subscribe: () => c }; return c; },
    removeChannel: () => {},
  }),
}));
vi.mock("next/navigation", () => ({
  redirect: (u: string) => { throw new Error(`redirect ${u}`); },
  useRouter: () => ({ refresh: () => {}, push: () => {}, replace: () => {} }),
  usePathname: () => "/dashboard/financeiro",
  useSearchParams: () => new URLSearchParams(),
}));
vi.mock("@/app/actions/invoices", () => ({ getUnbilledServices: async () => ({ ok: true, services: [] }) }));
vi.mock("@/app/actions/expense-categories", () => ({
  getExpenseCategoryCatalog: async () => ({
    ok: true, catalog: { available: true, categories: [], suggestions: [], missingSuggestions: [] },
  }),
}));
vi.mock("@/components/attachments/attachments-field", () => ({ AttachmentsField: () => null }));

function fakeAdmin() {
  return {
    from(tabela: string) {
      const preds: Array<(r: Linha) => boolean> = [];
      const res = () => (db.tabelas[tabela] ?? []).filter((r) => preds.every((p) => p(r)));
      const self: Record<string, unknown> = {
        select: () => self,
        order: () => self,
        eq: (c: string, v: unknown) => { preds.push((r) => r[c] === v); return self; },
        gte: (c: string, v: string) => { preds.push((r) => String(r[c]) >= v); return self; },
        lte: (c: string, v: string) => { preds.push((r) => String(r[c]) <= v); return self; },
        in: (c: string, vs: unknown[]) => { preds.push((r) => vs.includes(r[c])); return self; },
        single: async () => ({ data: res()[0] ?? null, error: null }),
        maybeSingle: async () => ({ data: res()[0] ?? null, error: null }),
        then: (resolve: (v: unknown) => void) => Promise.resolve({ data: res(), error: null }).then(resolve),
      };
      return self;
    },
  };
}

import { getFinanceDashboardV2 } from "@/app/actions/finance-dashboard-v2";
import { FinancialDashboardClient } from "@/app/(dashboard)/dashboard/financeiro/_components/financial-dashboard-client";
import FluxoCaixaPage from "@/app/(dashboard)/dashboard/financeiro/fluxo-caixa/page";

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const COMB = { id: "c0mb0000-0000-4000-8000-000000000001", name: "Combustível" };
const FORN = { id: "f0f00000-0000-4000-8000-000000000002", name: "Fornecedor" };
const rel = (c: { name: string } | null) => (c ? { name: c.name, color_token: null } : null);

const pagamento = (id: string, c: typeof COMB | null): Linha => ({
  id, company_id: EMPRESA, expense_category_id: c?.id ?? null, expense_categories: rel(c),
});

const caixa = (id: string, descricao: string, o: {
  amount: number; legada?: string | null; c?: typeof COMB | null; ref?: string | null;
}): Linha => ({
  id, company_id: EMPRESA, type: "saida", amount: o.amount, description: descricao,
  category: o.legada ?? null, date: "2026-09-10",
  reference_type: o.ref ? "fixed_variable_payment" : null, reference_id: o.ref ?? null,
  status: "confirmado", notes: null, created_at: "2026-09-10T10:00:00Z",
  expense_category_id: o.c?.id ?? null, expense_categories: rel(o.c ?? null),
});

let host: HTMLDivElement;
let root: Root;

beforeEach(() => {
  db.tabelas = {
    profiles: [{ id: "p", company_id: EMPRESA }],
    fixed_variable_payments: [pagamento("pg-comb", COMB), pagamento("pg-sem", null)],
    cash_flow_entries: [
      caixa("cf-forn-estr", "COMPRA ESTRUTURADA", { amount: 30, c: FORN }),
      caixa("cf-forn-leg", "COMPRA LEGADA", { amount: 80, legada: "fornecedor" }),
      caixa("cf-gasoleo", "GASOLEO DO PAGAMENTO", { amount: 100, legada: "despesa", ref: "pg-comb" }),
      caixa("cf-sem", "PAGAMENTO SEM CATEGORIA", { amount: 25, legada: "despesa", ref: "pg-sem" }),
      caixa("cf-desp", "DESPESA MANUAL", { amount: 12, legada: "despesa" }),
    ],
  };
  host = document.createElement("div");
  document.body.appendChild(host);
  root = createRoot(host);
});

afterEach(() => {
  act(() => root.unmount());
  host.remove();
});

const silencio = () => vi.spyOn(console, "error").mockImplementation(() => {});

/** Os links do donut do Resumo, tal como o utilizador os vê: nome → href. */
async function linksDoResumo(): Promise<Map<string, string>> {
  const s = silencio();
  const r = await getFinanceDashboardV2({ year: 2026, month: 9 });
  if (!r.ok) throw new Error(r.error);
  await act(async () => {
    root.render(
      <FinancialDashboardClient
        data={null} error={null} companyId={EMPRESA} initialSummary={null}
        unbilled={null} snapshot={r.snapshot} snapshotError={null}
      />,
    );
  });
  s.mockRestore();
  const links = new Map<string, string>();
  for (const a of host.querySelectorAll<HTMLAnchorElement>('a[href*="fluxo-caixa"]')) {
    links.set((a.textContent ?? "").replace(/\s+/g, " ").trim(), a.getAttribute("href")!);
  }
  return links;
}

/** Segue um href: página real → action real → CashFlowClient real. Devolve as descrições visíveis. */
async function seguir(href: string): Promise<string[]> {
  const url = new URL(href, "http://x");
  const params = Object.fromEntries(url.searchParams.entries());
  const s = silencio();
  const pagina = (await FluxoCaixaPage({ searchParams: Promise.resolve(params) })) as ReactElement<{ children: ReactElement }>;
  await act(async () => { root.render(pagina.props.children); });
  s.mockRestore();
  const alvo = ["COMPRA ESTRUTURADA", "COMPRA LEGADA", "GASOLEO DO PAGAMENTO", "PAGAMENTO SEM CATEGORIA", "DESPESA MANUAL"];
  return alvo.filter((d) => (host.textContent ?? "").includes(d));
}

/** O link cujo rótulo é EXACTAMENTE `nome` (seguido do valor) — «Fornecedor» não apanha «Fornecedores». */
const linkQueComeca = (links: Map<string, string>, nome: string) =>
  [...links].find(([texto]) => texto.startsWith(nome) && !/^[\p{L}]/u.test(texto.slice(nome.length)))?.[1] ?? null;

describe("A. estruturada «Fornecedor» ≠ legado «fornecedor»", () => {
  it("🔴 duas fatias, duas identidades, dois drilldowns diferentes", async () => {
    const links = await linksDoResumo();
    const estr = linkQueComeca(links, "Fornecedor");
    const leg = linkQueComeca(links, "Fornecedores"); // rótulo humano do legado
    expect(estr).not.toBeNull();
    expect(leg).not.toBeNull();
    expect(estr).toContain(`categoriaKey=${encodeURIComponent(FORN.id)}`);
    expect(leg).toContain(`categoriaKey=${encodeURIComponent("legacy:fornecedor")}`);
    expect(estr).not.toBe(leg);
    // Nenhum link novo usa o NOME como filtro.
    for (const href of links.values()) expect(href).not.toMatch(/[?&]categoria=/);
  });

  it("🔴 o filtro estruturado NÃO devolve a legada", async () => {
    const links = await linksDoResumo();
    expect(await seguir(linkQueComeca(links, "Fornecedor")!)).toEqual(["COMPRA ESTRUTURADA"]);
  });

  it("🔴 o filtro legado NÃO devolve a estruturada", async () => {
    const links = await linksDoResumo();
    expect(await seguir(linkQueComeca(links, "Fornecedores")!)).toEqual(["COMPRA LEGADA"]);
  });
});

describe("B. movimento de pagamento classificado pelo pagamento", () => {
  it("🔴 fica no UUID do Combustível, e o drilldown encontra-o sem depender de «despesa»", async () => {
    const links = await linksDoResumo();
    const comb = linkQueComeca(links, "Combustível");
    expect(comb).toContain(`categoriaKey=${encodeURIComponent(COMB.id)}`);
    expect(await seguir(comb!)).toEqual(["GASOLEO DO PAGAMENTO"]);
  });

  it("o legado «despesa» não arrasta o movimento do pagamento", async () => {
    const links = await linksDoResumo();
    const desp = linkQueComeca(links, "Despesas gerais");
    expect(desp).toContain(`categoriaKey=${encodeURIComponent("legacy:despesa")}`);
    expect(await seguir(desp!)).toEqual(["DESPESA MANUAL"]);
  });
});

describe("C. sem categoria efectiva", () => {
  it("🔴 identidade `uncategorized` — não cai em legacy:despesa", async () => {
    const s = silencio();
    const r = await getFinanceDashboardV2({ year: 2026, month: 9 });
    s.mockRestore();
    if (!r.ok) throw new Error(r.error);
    const porId = Object.fromEntries(r.snapshot.expensesByCategory.fatias.map((f) => [f.identidade, f.valor]));
    expect(porId.uncategorized).toBe(25);
    expect(porId["legacy:despesa"]).toBe(12);
  });

  it("🔴 o drilldown por `uncategorized` mostra só esse movimento", async () => {
    expect(await seguir("/dashboard/financeiro/fluxo-caixa?mes=2026-09&categoriaKey=uncategorized"))
      .toEqual(["PAGAMENTO SEM CATEGORIA"]);
  });
});

describe("«Outros» não é categoria", () => {
  it("não gera drilldown", async () => {
    const links = await linksDoResumo();
    for (const href of links.values()) expect(href).not.toContain("__outros__");
  });
});

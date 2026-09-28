// ============================================================================
// Resumo ↔ Pagamentos — a mesma seleção dá o mesmo valor por categoria
// ============================================================================
//
// Prova numérica, pelas duas ACTIONS reais (`getFinanceDashboardV2` e
// `getFinanceLedger`) sobre a MESMA base falsa — não pelas funções puras em
// separado. Assim fica provado também que os dois adaptadores lêem as mesmas
// colunas e resolvem a categoria da mesma maneira.
//
// Seleção: Setembro de 2026, modo «Caixa» em Pagamentos (o Resumo só tem esse
// eixo). Por categoria canónica — `id` estruturado, `legacy:texto`,
// `uncategorized` — os dois ecrãs têm de dar o mesmo número, ao cêntimo.
//
// O conjunto foi escolhido para exercitar as duas divergências medidas antes
// desta PR:
//
//   · uma despesa PENDENTE (Resumo contava, Pagamentos não);
//   · a estruturada «Fornecedor» e o texto legado «fornecedor» (o Resumo
//     somava-os numa fatia, Pagamentos separava-os).
//
// E os casos de fronteira que já estavam certos e não podem voltar atrás: a
// categoria de um movimento nascido de pagamento é a do PAGAMENTO; um
// pagamento sem categoria dá «sem categoria» e não o texto legado do
// movimento; um vínculo partido usa o que o próprio movimento diz; entradas e
// outros meses não entram.
// ============================================================================

import { beforeEach, describe, expect, it, vi } from "vitest";

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
vi.mock("@/app/actions/invoices", () => ({ getUnbilledServices: async () => ({ ok: true, services: [] }) }));

function fakeAdmin() {
  return {
    from(tabela: string) {
      const preds: Array<(r: Linha) => boolean> = [];
      const self: Record<string, unknown> = {
        select: () => self,
        order: () => self,
        or: () => { preds.push(() => false); return self; }, // pendentes anteriores: nenhum no cenário
        eq: (c: string, v: unknown) => { preds.push((r) => r[c] === v); return self; },
        neq: (c: string, v: unknown) => { preds.push((r) => r[c] !== v); return self; },
        gte: (c: string, v: string) => { preds.push((r) => String(r[c]) >= v); return self; },
        lte: (c: string, v: string) => { preds.push((r) => String(r[c]) <= v); return self; },
        lt: (c: string, v: string) => { preds.push((r) => String(r[c]) < v); return self; },
        in: (c: string, vs: unknown[]) => { preds.push((r) => vs.includes(r[c])); return self; },
        then: (resolve: (v: unknown) => void) =>
          Promise.resolve({ data: (db.tabelas[tabela] ?? []).filter((r) => preds.every((p) => p(r))), error: null })
            .then(resolve),
      };
      return self;
    },
  };
}

import { getFinanceDashboardV2 } from "@/app/actions/finance-dashboard-v2";
import { getFinanceLedger } from "@/app/actions/finance-ledger";
import { categorySlices } from "@/domain/finance/ledger-presentation";

const COMB = { id: "c0mb0000-0000-4000-8000-000000000001", name: "Combustível", color_token: null };
const FORN = { id: "f0f00000-0000-4000-8000-000000000002", name: "Fornecedor", color_token: null };
const cat = (c: typeof COMB | null) => (c ? { name: c.name, color_token: c.color_token } : null);

function pagamento(id: string, mes: number, c: typeof COMB | null, amount: number): Linha {
  return {
    id, company_id: EMPRESA, kind: "variavel", description: id, amount, due_date: `2026-${String(mes).padStart(2, "0")}-10`,
    status: "pago", period_year: 2026, period_month: mes, paid_at: "2026-09-05T10:00:00Z", direct_debit: false,
    notes: null, sort_order: 0, expense_category_id: c?.id ?? null, created_at: "2026-09-01T10:00:00Z",
    updated_at: "2026-09-01T10:00:00Z", expense_categories: cat(c),
  };
}

function caixa(id: string, o: {
  data?: string; tipo?: string; status?: string; amount: number;
  legada?: string | null; c?: typeof COMB | null; ref?: string | null;
}): Linha {
  return {
    id, company_id: EMPRESA, type: o.tipo ?? "saida", amount: o.amount, description: id, category: o.legada ?? null,
    date: o.data ?? "2026-09-10", reference_type: o.ref ? "fixed_variable_payment" : null, reference_id: o.ref ?? null,
    status: o.status ?? "confirmado", notes: null, expense_category_id: o.c?.id ?? null,
    created_at: "2026-09-01T10:00:00Z", expense_categories: cat(o.c ?? null),
  };
}

beforeEach(() => {
  db.tabelas = {
    fixed_variable_payments: [
      pagamento("p1", 9, COMB, 100),   // Setembro, Combustível
      pagamento("p2", 10, FORN, 40),   // competência Outubro, pago em Setembro
      pagamento("p3", 9, null, 25),    // sem categoria
    ],
    cash_flow_entries: [
      caixa("cf1", { amount: 100, legada: "despesa", ref: "p1" }),       // → Combustível (do pagamento)
      caixa("cf2", { amount: 40, legada: "despesa", ref: "p2", data: "2026-09-20" }), // → Fornecedor
      caixa("cf3", { amount: 25, legada: "despesa", ref: "p3" }),        // → sem categoria, NÃO «despesa»
      caixa("cf4", { amount: 80, legada: "fornecedor" }),                // legado, separado de FORN
      caixa("cf5", { amount: 30, c: FORN, status: "pendente" }),         // pendente conta
      caixa("cf6", { amount: 12.34, legada: "despesa", status: "pendente" }),
      caixa("cf7", { amount: 500, tipo: "entrada", legada: "faturacao" }), // entrada: fora
      caixa("cf8", { amount: 99, legada: "despesa", data: "2026-08-31" }), // outro mês: fora
      caixa("cf9", { amount: 7 }),                                       // sem categoria
      caixa("cf10", { amount: 15, c: COMB }),
      caixa("cf11", { amount: 9, legada: "combustivel", ref: "p-que-nao-existe" }), // vínculo partido
    ],
  };
});

const ESPERADO: Record<string, number> = {
  [COMB.id]: 115,          // 100 (p1) + 15 (cf10)
  [FORN.id]: 70,           // 40 (p2) + 30 (cf5 pendente)
  uncategorized: 32,       // 25 (p3) + 7 (cf9)
  "legacy:fornecedor": 80,
  "legacy:despesa": 12.34,
  "legacy:combustivel": 9,
};

async function resumo() {
  const spy = vi.spyOn(console, "error").mockImplementation(() => {});
  const r = await getFinanceDashboardV2({ year: 2026, month: 9 });
  spy.mockRestore();
  if (!r.ok) throw new Error(r.error);
  expect(r.snapshot.expensesByCategory.estado).toBe("AVAILABLE");
  return r.snapshot.expensesByCategory;
}

async function pagamentosCaixa() {
  const r = await getFinanceLedger(2026, 9);
  if (!r.ok) throw new Error(r.error);
  return categorySlices(r.rows, { year: 2026, month: 9 }, "caixa");
}

describe("Resumo ↔ Pagamentos (Caixa) — paridade por categoria", () => {
  it("🔴 Resumo: o valor esperado em cada categoria canónica", async () => {
    const b = await resumo();
    const porId = Object.fromEntries(b.fatias.map((f) => [f.identidade, f.valor]));
    expect(porId).toEqual(ESPERADO);
    expect(b.total).toBe(318.34);
    expect(b.pendentes).toEqual({ total: 42.34, contagem: 2 });
  });

  it("🔴 Pagamentos › Caixa: o MESMO valor em cada categoria canónica", async () => {
    const fatias = await pagamentosCaixa();
    const porId = Object.fromEntries(fatias.map((f) => [f.category_key, f.amount_cents / 100]));
    expect(porId).toEqual(ESPERADO);
  });

  it("🔴 PARIDADE: categoria a categoria, ao cêntimo, e no total", async () => {
    const [b, fatias] = await Promise.all([resumo(), pagamentosCaixa()]);
    const r = new Map(b.fatias.map((f) => [f.identidade, Math.round(f.valor * 100)]));
    const p = new Map(fatias.map((f) => [f.category_key, f.amount_cents]));
    expect([...r.keys()].sort()).toEqual([...p.keys()].sort());
    for (const [k, v] of p) expect(r.get(k), k).toBe(v);
    expect(Math.round(b.total * 100)).toBe(fatias.reduce((s, f) => s + f.amount_cents, 0));
  });

  it("a estruturada «Fornecedor» e o legado «fornecedor» ficam separados nos DOIS", async () => {
    const [b, fatias] = await Promise.all([resumo(), pagamentosCaixa()]);
    expect(b.fatias.filter((f) => f.identidade === FORN.id || f.identidade === "legacy:fornecedor")).toHaveLength(2);
    expect(fatias.filter((f) => f.category_key === FORN.id || f.category_key === "legacy:fornecedor")).toHaveLength(2);
  });

  it("mudar a seleção para outro mês muda os dois da mesma maneira", async () => {
    const r = await getFinanceDashboardV2({ year: 2026, month: 8 });
    const l = await getFinanceLedger(2026, 8);
    if (!r.ok || !l.ok) throw new Error("leitura falhou");
    const pSlices = categorySlices(l.rows, { year: 2026, month: 8 }, "caixa");
    expect(r.snapshot.expensesByCategory.fatias.map((f) => [f.identidade, f.valor]))
      .toEqual(pSlices.map((f) => [f.category_key, f.amount_cents / 100]));
    expect(pSlices).toEqual([{ category_key: "legacy:despesa", category_id: null, name: "despesa", amount_cents: 9900 }]);
  });
});

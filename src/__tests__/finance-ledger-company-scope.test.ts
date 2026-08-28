// ============================================================================
// Âmbito por empresa em `getFinanceLedger` — o RLS não conta aqui
// ============================================================================
//
// 🔴 `requireProfile()` devolve `createAdminClient()`, ou seja, a identidade
//    `service_role`. Essa identidade tem `BYPASSRLS`: as políticas de
//    row-level security **não se aplicam** a estas consultas.
//
//    Isto corrige uma afirmação minha anterior — «o isolamento é da consulta e
//    do RLS». A segunda metade era falsa, e falsa de um modo perigoso: deixava
//    a impressão de haver uma segunda linha de defesa que não existe. Se um
//    `.eq("company_id", …)` cair, não há RLS a apanhar o erro. Uma empresa
//    veria os pagamentos e os movimentos de outra.
//
//    O isolamento desta action é, e só é:
//
//      guarda de autenticação  →  profile.company_id  →  filtros explícitos
//
//    O `company_id` nunca vem do cliente: `getFinanceLedger(year, month)` não
//    o aceita, e é o servidor que o resolve a partir da sessão.
//
// Estes ensaios exercitam o adaptador real com um cliente falso que regista as
// chamadas ao construtor de consultas. Não precisam de PostgreSQL: o que se
// mede é qual o filtro que a action aplica, não o que a base faria com ele.
// ============================================================================

import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import path from "node:path";

const EMPRESA = "11111111-1111-4111-8111-111111111111";
const OUTRA = "99999999-9999-4999-8999-999999999999";
const PERFIL = "22222222-2222-4222-8222-222222222222";

const guarda = vi.hoisted(() => ({ resultado: null as unknown }));
const registo = vi.hoisted(() => ({ chamadas: [] as Array<Record<string, unknown>> }));

vi.mock("@/lib/auth-guard", () => ({
  requireProfile: async (opts: unknown) => {
    registo.chamadas.push({ tipo: "requireProfile", opts });
    return guarda.resultado;
  },
}));

/** Cliente falso: regista tabela e filtros, devolve sempre vazio. */
function clienteFalso() {
  return {
    from(tabela: string) {
      const filtros: Record<string, unknown> = {};
      const q = {
        select: () => q,
        eq: (col: string, val: unknown) => { filtros[col] = val; return q; },
        in: (col: string, val: unknown) => { filtros[col] = val; return q; },
        gte: (col: string, val: unknown) => { filtros[`gte:${col}`] = val; return q; },
        lte: (col: string, val: unknown) => { filtros[`lte:${col}`] = val; return q; },
        then: (resolve: (v: unknown) => void) => {
          registo.chamadas.push({ tipo: "query", tabela, filtros });
          return Promise.resolve({ data: [], error: null }).then(resolve);
        },
      };
      return q;
    },
  };
}

import { getFinanceLedger } from "@/app/actions/finance-ledger";

beforeEach(() => {
  registo.chamadas = [];
  guarda.resultado = {
    ok: true,
    admin: clienteFalso(),
    profile: { id: PERFIL, company_id: EMPRESA, role: "admin" },
  };
});
afterEach(() => vi.restoreAllMocks());

const consultas = () => registo.chamadas.filter((c) => c.tipo === "query");

// ═══════════════════════════════════════════════════════════════════════════

describe("getFinanceLedger — o âmbito da empresa não depende do RLS", () => {
  it("🔴 a assinatura não aceita company_id — não há como o cliente o escolher", () => {
    // Uma Server Action é um endpoint. Se o `company_id` fosse parâmetro,
    // bastava alguém enviá-lo. Aqui só entram o ano e o mês.
    expect(getFinanceLedger.length).toBe(2);
    const src = fs.readFileSync(
      path.join(process.cwd(), "src", "app", "actions", "finance-ledger.ts"), "utf8");
    const assinatura = src.slice(
      src.indexOf("export async function getFinanceLedger"),
      src.indexOf("): Promise<FinanceLedgerResult>"));
    expect(assinatura).not.toMatch(/company/i);
  });

  it("o company_id usado é o do perfil resolvido no servidor", async () => {
    await getFinanceLedger(2026, 8);
    expect(consultas().length).toBeGreaterThan(0);
    for (const c of consultas()) {
      expect((c.filtros as Record<string, unknown>).company_id).toBe(EMPRESA);
    }
  });

  it("mudar o perfil muda o âmbito — nada está fixo no código", async () => {
    guarda.resultado = {
      ok: true, admin: clienteFalso(),
      profile: { id: PERFIL, company_id: OUTRA, role: "gestor" },
    };
    await getFinanceLedger(2026, 8);
    for (const c of consultas()) {
      expect((c.filtros as Record<string, unknown>).company_id).toBe(OUTRA);
    }
  });

  it("🔴 as duas consultas do período filtram por empresa", async () => {
    await getFinanceLedger(2026, 8);
    const pagamentos = consultas().find((c) => c.tabela === "fixed_variable_payments");
    const caixa = consultas().find((c) => c.tabela === "cash_flow_entries");
    expect(pagamentos, "paymentsByCompetence não correu").toBeDefined();
    expect(caixa, "cashflowsByCashPeriod não correu").toBeDefined();
    expect((pagamentos!.filtros as Record<string, unknown>).company_id).toBe(EMPRESA);
    expect((caixa!.filtros as Record<string, unknown>).company_id).toBe(EMPRESA);
  });

  it("🔴 as duas consultas de resolução cruzada também filtram por empresa", async () => {
    // `paymentsByIds` e `cashflowsByPaymentIds` só correm quando há ids a
    // resolver fora do mês. São as mais fáceis de esquecer — e as mais
    // perigosas, porque recebem ids que vieram da outra consulta.
    const admin = clienteFalso();
    const original = admin.from.bind(admin);
    let volta = 0;
    (admin as { from: unknown }).from = (tabela: string) => {
      const q = original(tabela);
      const then = q.then.bind(q);
      q.then = (resolve: (v: unknown) => void) => {
        volta += 1;
        if (volta === 1) {
          registo.chamadas.push({ tipo: "query", tabela, filtros: { company_id: EMPRESA } });
          return Promise.resolve({
            data: [{
              id: "pay-fora", kind: "variavel", description: "x", amount: 10,
              due_date: null, status: "pendente", period_year: 2026, period_month: 8,
              paid_at: null, expense_category_id: null, created_at: "2026-08-01T00:00:00Z",
              updated_at: "2026-08-01T00:00:00Z",
            }],
            error: null,
          }).then(resolve);
        }
        if (volta === 2) {
          registo.chamadas.push({ tipo: "query", tabela, filtros: { company_id: EMPRESA } });
          return Promise.resolve({
            data: [{
              id: "cf-fora", type: "saida", amount: 10, description: "x", category: null,
              date: "2026-08-10", reference_type: "fixed_variable_payment",
              reference_id: "pay-de-outro-mes", status: "pendente",
              expense_category_id: null, created_at: "2026-08-10T00:00:00Z",
            }],
            error: null,
          }).then(resolve);
        }
        return then(resolve);
      };
      return q;
    };
    guarda.resultado = {
      ok: true, admin, profile: { id: PERFIL, company_id: EMPRESA, role: "admin" },
    };

    await getFinanceLedger(2026, 8);
    // A terceira e/ou quarta consulta são as de resolução; todas filtram.
    expect(consultas().length).toBeGreaterThanOrEqual(3);
    for (const c of consultas()) {
      expect((c.filtros as Record<string, unknown>).company_id).toBe(EMPRESA);
    }
  });

  it("o papel exigido continua a ser admin ou gestor", async () => {
    await getFinanceLedger(2026, 8);
    const g = registo.chamadas.find((c) => c.tipo === "requireProfile")!;
    expect((g.opts as { roles: string[] }).roles.sort()).toEqual(["admin", "gestor"]);
  });

  it("🔴 falha de autenticação não consulta dados financeiros", async () => {
    guarda.resultado = { ok: false, code: "FORBIDDEN", error: "Sem permissão." };
    const r = await getFinanceLedger(2026, 8);
    expect(r).toEqual({ ok: false, error: "Sem permissão." });
    expect(consultas()).toHaveLength(0);
  });

  it("um período inválido nem chega à guarda", async () => {
    const r = await getFinanceLedger(2026, 13);
    expect(r.ok).toBe(false);
    expect(registo.chamadas).toHaveLength(0);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// A guarda que apanha a remoção de um filtro
// ═══════════════════════════════════════════════════════════════════════════

describe("os quatro filtros de empresa estão todos escritos", () => {
  const src = fs.readFileSync(
    path.join(process.cwd(), "src", "app", "actions", "finance-ledger.ts"), "utf8");

  it("🔴 as quatro consultas têm .eq(\"company_id\", companyId)", () => {
    // Sem RLS por trás, cada filtro em falta é uma fuga entre empresas. O
    // ensaio de comportamento acima apanha as consultas que correm; esta
    // guarda apanha também a que só corre num ramo raro.
    const codigo = src.split("\n").filter((l) => !l.trimStart().startsWith("//")).join("\n");
    const ocorrencias = codigo.match(/\.eq\("company_id", companyId\)/g) ?? [];
    expect(ocorrencias).toHaveLength(4);

    for (const fn of ["paymentsByCompetence", "cashflowsByCashPeriod",
                      "paymentsByIds", "cashflowsByPaymentIds"]) {
      const i = codigo.indexOf(`async ${fn}(`);
      expect(i, `${fn} não encontrada`).toBeGreaterThan(-1);
      const corpo = codigo.slice(i, codigo.indexOf("return error", i));
      expect(corpo, `${fn} sem filtro de empresa`).toContain('.eq("company_id", companyId)');
    }
  });

  it("o companyId vem do perfil, não de um argumento", () => {
    const codigo = src.split("\n").filter((l) => !l.trimStart().startsWith("//")).join("\n");
    expect(codigo).toContain("const companyId = profile.company_id;");
  });
});

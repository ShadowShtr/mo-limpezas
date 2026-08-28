// ============================================================================
// As acções usam mesmo as RPC atómicas
// ============================================================================
//
// 🔴 Os ensaios de concorrência provam que as **funções** serializam. Não
//    provam que a aplicação as chama. São perguntas diferentes, e a segunda é
//    a que decide se o utilizador fica protegido: uma migration impecável com
//    um `update` directo por cima não corrige nada.
//
// Aqui as Server Actions correm a sério, com o cliente Supabase isolado, e
// verifica-se o que elas mandam para a base: que RPC, com que argumentos, e —
// tão importante — que **não** sobrou nenhuma escrita directa na tabela.
//
// O `company_id` é sempre confrontado: vem de `profile.company_id` e nunca de
// um argumento do cliente. `requireProfile` devolve `service_role`, que passa
// por cima do RLS, portanto este predicado é a única barreira que resta.
// ============================================================================

import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import path from "node:path";

const EMPRESA = "11111111-1111-4111-8111-111111111111";
const PERFIL = "22222222-2222-4222-8222-222222222222";
const ALVO = "33333333-3333-4333-8333-333333333333";

const guarda = vi.hoisted(() => ({ resultado: null as unknown }));
const reg = vi.hoisted(() => ({ chamadas: [] as Array<Record<string, unknown>> }));

vi.mock("@/lib/auth-guard", () => ({
  requireProfile: async () => guarda.resultado,
}));
vi.mock("next/cache", () => ({ revalidatePath: () => {} }));
vi.mock("@/lib/audit", () => ({ auditLog: async () => {} }));
// 🔴 As acções de caixa não passam por `requireProfile`: constroem o cliente
//    administrativo e leem o perfil elas próprias. Isolar só o guard não
//    chegava — e foi assim que este ensaio falhou com «supabaseUrl is
//    required», que é o cliente real a tentar nascer.
vi.mock("@/lib/supabase/server", () => ({
  createClient: async () => ({
    auth: { getUser: async () => ({ data: { user: { id: PERFIL } } }) },
  }),
}));
vi.mock("@/lib/supabase/admin", () => ({
  createAdminClient: () => (guarda.resultado as { admin: unknown }).admin,
}));
vi.mock("@/lib/finance-period-guard", async (orig) => {
  const real = await orig<typeof import("@/lib/finance-period-guard")>();
  return {
    ...real,
    assertFinancialPeriodOpen: async () => ({ ok: true, periodo: { year: 2026, month: 8 } }),
    assertPeriodosAbertosParaMudancaDeData: async () => ({ ok: true, periodo: { year: 2026, month: 8 } }),
    lerEstadoPeriodo: async () => ({ ok: true, estado: { status: "open" } }),
  };
});

const PERFIL_ROW = { id: PERFIL, company_id: EMPRESA, role: "admin" };

/** Cliente falso: regista RPC e escritas directas, devolve vazio. */
function cliente(linha: Record<string, unknown> | null = null) {
  const api = {
    rpc: (nome: string, args: Record<string, unknown>) => {
      reg.chamadas.push({ tipo: "rpc", nome, args });
      return Promise.resolve({ data: null, error: null });
    },
    from(tabela: string) {
      const q: Record<string, unknown> = {};
      const self: Record<string, unknown> = {
        select: () => self,
        eq: () => self,
        is: () => self,
        in: () => self,
        neq: () => self,
        gte: () => self,
        lte: () => self,
        order: () => self,
        limit: () => self,
        update: (patch: unknown) => { reg.chamadas.push({ tipo: "update", tabela, patch }); return self; },
        delete: () => { reg.chamadas.push({ tipo: "delete", tabela }); return self; },
        insert: (v: unknown) => { reg.chamadas.push({ tipo: "insert", tabela, v }); return self; },
        // Consciente da tabela: `profiles` devolve um perfil, o resto devolve
        // a linha do cenário. Sem isto, a guarda própria das acções de caixa
        // recusava por «sem permissão» e a RPC nunca chegava a ser chamada.
        maybeSingle: async () => ({ data: tabela === "profiles" ? PERFIL_ROW : linha, error: null }),
        single: async () => ({ data: tabela === "profiles" ? PERFIL_ROW : linha, error: null }),
        then: (resolve: (v: unknown) => void) => Promise.resolve({ data: [], error: null }).then(resolve),
      };
      void q;
      return self;
    },
  };
  return api;
}

import { updatePayment, deletePayment } from "@/app/actions/payments";
import { updateCashFlowEntry, deleteCashFlowEntry } from "@/app/actions/cash-flow";
import { confirmMatch } from "@/app/actions/bank-reconciliation";

beforeEach(() => {
  reg.chamadas = [];
  guarda.resultado = {
    ok: true,
    admin: cliente({ id: ALVO, date: "2026-08-10", reference_type: null,
                     bank_transaction_id: "tx-1", cash_flow_entry_id: "cf-1" }),
    profile: { id: PERFIL, company_id: EMPRESA, role: "admin" },
  };
});
afterEach(() => vi.restoreAllMocks());

const rpcs = () => reg.chamadas.filter((c) => c.tipo === "rpc");
const escritas = (tabela: string, tipo: string) =>
  reg.chamadas.filter((c) => c.tipo === tipo && c.tabela === tabela);

// ═══════════════════════════════════════════════════════════════════════════

describe("pagamentos — o valor e a eliminação passam pela RPC", () => {
  it("PAYMENT_ACTION_RPC_ROUTING: alterar o valor chama update_payment_amount_atomic", async () => {
    await updatePayment(ALVO, { amount: 250 });
    const r = rpcs().find((c) => c.nome === "update_payment_amount_atomic");
    expect(r, "a RPC do valor não foi chamada").toBeDefined();
    expect(r!.args).toEqual({ p_company_id: EMPRESA, p_payment_id: ALVO, p_amount: 250 });
  });

  it("🔴 e o valor NÃO é escrito outra vez por fora", async () => {
    // Uma segunda escrita directa passaria por fora do lock e desfaria a
    // decisão que a RPC acabou de tomar.
    await updatePayment(ALVO, { amount: 250, description: "Nova descrição" });
    for (const u of escritas("fixed_variable_payments", "update")) {
      expect(Object.keys(u.patch as object)).not.toContain("amount");
    }
  });

  it("os outros campos continuam a ser gravados", async () => {
    await updatePayment(ALVO, { amount: 250, description: "Nova descrição" });
    const u = escritas("fixed_variable_payments", "update")[0];
    expect(u, "os campos restantes não foram gravados").toBeDefined();
    expect((u.patch as Record<string, unknown>).description).toBe("Nova descrição");
  });

  it("sem `amount` no patch, a RPC do valor não é chamada", async () => {
    await updatePayment(ALVO, { description: "Só o texto" });
    expect(rpcs().find((c) => c.nome === "update_payment_amount_atomic")).toBeUndefined();
  });

  it("NULL_AMOUNT_COMPATIBILITY: pôr o valor a null é legítimo e vai pela RPC", async () => {
    await updatePayment(ALVO, { amount: null });
    const r = rpcs().find((c) => c.nome === "update_payment_amount_atomic")!;
    expect((r.args as Record<string, unknown>).p_amount).toBeNull();
  });

  it("DELETE_PAYMENT_RPC_ROUTING: apagar chama delete_payment_atomic", async () => {
    await deletePayment(ALVO);
    const r = rpcs().find((c) => c.nome === "delete_payment_atomic");
    expect(r).toBeDefined();
    expect(r!.args).toEqual({ p_company_id: EMPRESA, p_payment_id: ALVO });
  });

  it("🔴 e não sobra nenhum delete directo na tabela de pagamentos", async () => {
    await deletePayment(ALVO);
    expect(escritas("fixed_variable_payments", "delete")).toHaveLength(0);
  });
});

describe("fluxo de caixa — alterar e apagar passam pela RPC", () => {
  it("CASHFLOW_ACTION_RPC_ROUTING: alterar chama update_cashflow_entry_atomic", async () => {
    await updateCashFlowEntry(ALVO, { description: "Revisto" });
    const r = rpcs().find((c) => c.nome === "update_cashflow_entry_atomic");
    expect(r).toBeDefined();
    const args = r!.args as Record<string, unknown>;
    expect(args.p_company_id).toBe(EMPRESA);
    expect(args.p_entry_id).toBe(ALVO);
    expect((args.p_patch as Record<string, unknown>).description).toBe("Revisto");
  });

  it("🔴 e não sobra update directo em cash_flow_entries", async () => {
    await updateCashFlowEntry(ALVO, { description: "Revisto" });
    expect(escritas("cash_flow_entries", "update")).toHaveLength(0);
  });

  it("apagar chama delete_cashflow_entry_atomic", async () => {
    await deleteCashFlowEntry(ALVO);
    const r = rpcs().find((c) => c.nome === "delete_cashflow_entry_atomic");
    expect(r).toBeDefined();
    expect(r!.args).toEqual({ p_company_id: EMPRESA, p_entry_id: ALVO });
  });

  it("🔴 e não sobra delete directo em cash_flow_entries", async () => {
    await deleteCashFlowEntry(ALVO);
    expect(escritas("cash_flow_entries", "delete")).toHaveLength(0);
  });
});

describe("conciliação — a confirmação é uma só chamada", () => {
  it("RECONCILIATION_ACTION_RPC_ROUTING: chama confirm_bank_match_atomic", async () => {
    await confirmMatch(ALVO);
    const r = rpcs().find((c) => c.nome === "confirm_bank_match_atomic");
    expect(r).toBeDefined();
    expect(r!.args).toEqual({ p_company_id: EMPRESA, p_match_id: ALVO, p_actor_id: PERFIL });
  });

  it("🔴 CONFIRM_MATCH_ALL_DB_WRITES_ATOMIC: sem escritas de seguimento", async () => {
    // Rejeitar as outras sugestões e marcar a transacção bancária como
    // reconciliada passaram para dentro da RPC. Feitas cá fora, corriam depois
    // da confirmação já gravada e podiam falhar sozinhas.
    await confirmMatch(ALVO);
    expect(escritas("bank_reconciliation_matches", "update")).toHaveLength(0);
    expect(escritas("bank_transactions", "update")).toHaveLength(0);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// A guarda que apanha o regresso do caminho antigo
// ═══════════════════════════════════════════════════════════════════════════

describe("APP_ROUTING_MUTATION_PROOF — o caminho directo não volta", () => {
  const ler = (f: string) => fs.readFileSync(path.join(process.cwd(), f), "utf8")
    .split("\n").filter((l) => !l.trimStart().startsWith("//")).join("\n");

  const corpo = (src: string, nome: string) => {
    const i = src.indexOf(`export async function ${nome}`);
    const fim = src.indexOf("\nexport ", i + 1);
    return src.slice(i, fim === -1 ? undefined : fim);
  };

  it("updatePayment não escreve `amount` directamente", () => {
    const c = corpo(ler("src/app/actions/payments.ts"), "updatePayment");
    expect(c).toContain("update_payment_amount_atomic");
    expect(c).not.toMatch(/\.update\(\s*\{[^}]*\bamount\b/);
  });

  it("deletePayment não tem `.delete()`", () => {
    const c = corpo(ler("src/app/actions/payments.ts"), "deletePayment");
    expect(c).toContain("delete_payment_atomic");
    expect(c).not.toContain(".delete()");
  });

  it("updateCashFlowEntry não tem `.update(` sobre a tabela", () => {
    const c = corpo(ler("src/app/actions/cash-flow.ts"), "updateCashFlowEntry");
    expect(c).toContain("update_cashflow_entry_atomic");
    expect(c).not.toMatch(/from\("cash_flow_entries"\)[\s\S]{0,200}\.update\(/);
  });

  it("deleteCashFlowEntry não tem `.delete()`", () => {
    const c = corpo(ler("src/app/actions/cash-flow.ts"), "deleteCashFlowEntry");
    expect(c).toContain("delete_cashflow_entry_atomic");
    expect(c).not.toContain(".delete()");
  });

  it("confirmMatch não escreve em matches nem em bank_transactions", () => {
    const c = corpo(ler("src/app/actions/bank-reconciliation.ts"), "confirmMatch");
    expect(c).toContain("confirm_bank_match_atomic");
    expect(c).not.toMatch(/from\("bank_transactions"\)[\s\S]{0,200}\.update\(/);
    expect(c).not.toMatch(/\.update\(\{ status: "rejected" \}\)/);
  });

  it("🔴 nenhuma RPC recebe um company_id vindo de fora", () => {
    // O `company_id` resolve-se no servidor. Se alguma vez viesse por
    // argumento, uma empresa podia operar sobre outra — e sem RLS a apanhar.
    for (const f of ["src/app/actions/payments.ts", "src/app/actions/cash-flow.ts",
                     "src/app/actions/bank-reconciliation.ts"]) {
      const src = ler(f);
      const chamadas = src.match(/p_company_id:\s*[^,\n]+/g) ?? [];
      expect(chamadas.length, `${f} sem chamadas RPC`).toBeGreaterThan(0);
      for (const ch of chamadas) {
        expect(ch, `${f}: ${ch}`).toMatch(/p_company_id:\s*(profile\.company_id|companyId)/);
      }
    }
  });
});

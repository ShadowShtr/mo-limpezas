// ============================================================================
// Cobranças avulsas — actions e read model da união
// ============================================================================
//
// O que se prova aqui, sem base de dados (a base real está em
// `cobrancas-current-master.pg.test.ts`):
//
//   · cada writer chama a SUA RPC da 091 e não escreve em tabela nenhuma;
//   · criar não toca em `services`, `invoices`, `invoice_items` nem caixa;
//   · as recusas da base chegam ao ecrã traduzidas — nunca cruas;
//   · uma resposta da RPC com forma inesperada não é sucesso;
//   · `getDailyBilling` devolve serviço E cobrança avulsa, no dia e nos
//     pendentes, com a avulsa anulada filtrada na leitura;
//   · a pagamento de serviço mantém-se na 097.
// ============================================================================

import { beforeEach, describe, expect, it, vi } from "vitest";

const EMPRESA = "11111111-1111-4111-8111-111111111111";
const PERFIL = "22222222-2222-4222-8222-222222222222";
const CLIENTE = "44444444-4444-4444-8444-444444444444";
const COBRANCA = "55555555-5555-4555-8555-555555555555";
const SERVICO = "66666666-6666-4666-8666-666666666666";
const LOCAL = "77777777-7777-4777-8777-777777777777";

type Chamada = { tipo: string; tabela?: string; nome?: string; args?: unknown; filtros?: unknown[] };

const estado = vi.hoisted(() => ({
  chamadas: [] as Chamada[],
  rpc: (() => ({ data: null, error: null })) as (nome: string, args: Record<string, unknown>) => { data: unknown; error: { message: string; code?: string } | null },
  dados: (() => []) as (tabela: string, filtros: unknown[][]) => unknown[],
}));

vi.mock("next/cache", () => ({ revalidatePath: () => {} }));
vi.mock("@/lib/audit", () => ({ auditLog: async () => {} }));
vi.mock("@/lib/auth-guard", () => ({
  requireProfile: async () => ({ ok: true, profile: { id: PERFIL, company_id: EMPRESA, role: "admin" }, admin: fakeAdmin() }),
}));

function fakeAdmin() {
  return {
    rpc: (nome: string, args: Record<string, unknown>) => {
      estado.chamadas.push({ tipo: "rpc", nome, args });
      return Promise.resolve(estado.rpc(nome, args));
    },
    from(tabela: string) {
      const filtros: unknown[][] = [];
      const self: Record<string, unknown> = {};
      for (const m of ["select", "eq", "is", "in", "neq", "gte", "lt", "lte", "or", "order", "limit"]) {
        self[m] = (...a: unknown[]) => { filtros.push([m, ...a]); return self; };
      }
      for (const m of ["insert", "update", "delete", "upsert"]) {
        self[m] = (v: unknown) => { estado.chamadas.push({ tipo: m, tabela, args: v }); return self; };
      }
      self.maybeSingle = async () => ({ data: estado.dados(tabela, filtros)[0] ?? null, error: null });
      self.single = self.maybeSingle;
      self.then = (resolve: (v: unknown) => void) =>
        Promise.resolve({ data: estado.dados(tabela, filtros), error: null }).then(resolve);
      return self;
    },
  };
}

import {
  createManualCharge,
  setManualChargePayment,
  updateManualCharge,
  voidManualCharge,
} from "@/app/actions/manual-charges";
import { getDailyBilling, setServicePayment } from "@/app/actions/daily-billing";

const escritasDirectas = () => estado.chamadas.filter((c) => c.tipo !== "rpc");
const rpcs = () => estado.chamadas.filter((c) => c.tipo === "rpc").map((c) => c.nome);

beforeEach(() => {
  estado.chamadas = [];
  estado.rpc = () => ({ data: null, error: null });
  estado.dados = () => [];
});

describe("createManualCharge", () => {
  const input = { clientId: CLIENTE, chargeDate: "2026-09-12", description: "Vidros", amount: 80, applyVat: true };

  it("🔴 cria pela RPC da 091 — sem serviço, fatura, linha de fatura nem caixa", async () => {
    estado.rpc = () => ({ data: [{ charge_id: COBRANCA }], error: null });
    const r = await createManualCharge(input);
    expect(r).toEqual({ ok: true, id: COBRANCA });
    expect(rpcs()).toEqual(["create_manual_charge_atomic"]);
    expect(escritasDirectas()).toEqual([]);
    const args = estado.chamadas[0].args as Record<string, unknown>;
    expect(args).toMatchObject({
      p_company_id: EMPRESA, p_client_id: CLIENTE, p_charge_date: "2026-09-12",
      p_description: "Vidros", p_amount: 80, p_apply_vat: true, p_actor: PERFIL,
    });
  });

  it.each([
    ["sem cliente", { ...input, clientId: "" }],
    ["data impossível", { ...input, chargeDate: "2026-02-30" }],
    ["descrição vazia", { ...input, description: "   " }],
    ["valor zero", { ...input, amount: 0 }],
    ["valor negativo", { ...input, amount: -5 }],
    ["três casas decimais", { ...input, amount: 1.005 }],
  ])("recusa %s antes de chegar à base", async (_c, entrada) => {
    const r = await createManualCharge(entrada);
    expect(r.ok).toBe(false);
    expect(estado.chamadas).toEqual([]);
  });

  it("🔴 mês fechado: a frase é a do período, não a do Postgres", async () => {
    estado.rpc = () => ({ data: null, error: { message: "FINANCIAL_PERIOD_CLOSED: 2026-09" } });
    const r = await createManualCharge(input);
    expect(r.ok).toBe(false);
    expect(!r.ok && r.error).toMatch(/mês está fechado/);
    expect(!r.ok && r.error).not.toMatch(/FINANCIAL_PERIOD/);
  });

  it("🔴 erro desconhecido não chega cru ao ecrã", async () => {
    estado.rpc = () => ({ data: null, error: { message: 'relation "public.manual_charges" does not exist', code: "42P01" } });
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    const r = await createManualCharge(input);
    spy.mockRestore();
    expect(!r.ok && r.error).not.toMatch(/relation|manual_charges/);
  });

  it("🔴 resposta com forma inesperada não é sucesso", async () => {
    estado.rpc = () => ({ data: [], error: null });
    expect((await createManualCharge(input)).ok).toBe(false);
  });
});

describe("updateManualCharge", () => {
  it("edita pela RPC da 091, só com as chaves pedidas", async () => {
    estado.rpc = () => ({ data: [{ charge_id: COBRANCA }], error: null });
    const r = await updateManualCharge(COBRANCA, { description: "  Vidros  ", amount: 90 });
    expect(r.ok).toBe(true);
    expect(rpcs()).toEqual(["update_manual_charge_atomic"]);
    expect((estado.chamadas[0].args as { p_patch: unknown }).p_patch).toEqual({ description: "Vidros", amount: 90 });
    expect(escritasDirectas()).toEqual([]);
  });

  it("🔴 com recebimento, a recusa de valor chega traduzida", async () => {
    estado.rpc = () => ({ data: null, error: { message: "MANUAL_CHARGE_PAID_AMOUNT_LOCKED" } });
    const r = await updateManualCharge(COBRANCA, { amount: 1 });
    expect(!r.ok && r.error).toMatch(/Remova-o antes de alterar o valor/);
  });

  it("uma resposta sobre OUTRA cobrança não confirma esta", async () => {
    estado.rpc = () => ({ data: [{ charge_id: SERVICO }], error: null });
    expect((await updateManualCharge(COBRANCA, { description: "x" })).ok).toBe(false);
  });
});

describe("setManualChargePayment — os quatro gestos", () => {
  it.each([
    ["retirar", "nao_informado", null],
    ["50%", "sinal_50", null],
    ["100%", "pago_total", null],
    ["valor livre", "sinal_50", 40],
  ] as const)("%s → set_manual_charge_payment_atomic, sem escrita directa", async (_g, status, valor) => {
    estado.rpc = () => ({ data: [{ charge_id: COBRANCA, cash_amount: "40.00" }], error: null });
    const r = await setManualChargePayment(COBRANCA, status, valor);
    expect(r.ok).toBe(true);
    expect(rpcs()).toEqual(["set_manual_charge_payment_atomic"]);
    expect(estado.chamadas[0].args).toMatchObject({ p_status: status, p_paid_amount: valor });
    expect(escritasDirectas()).toEqual([]);
  });

  it("🔴 mês fechado: recusa traduzida, nada escrito do lado da aplicação", async () => {
    estado.rpc = () => ({ data: null, error: { message: "FINANCIAL_PERIOD_CLOSED: 2026-09" } });
    const r = await setManualChargePayment(COBRANCA, "pago_total");
    expect(!r.ok && r.error).toMatch(/mês está fechado/);
    expect(escritasDirectas()).toEqual([]);
  });
});

describe("voidManualCharge", () => {
  it("excluir = anular pela RPC, nunca DELETE", async () => {
    estado.rpc = () => ({ data: [{ charge_id: COBRANCA }], error: null });
    expect((await voidManualCharge(COBRANCA)).ok).toBe(true);
    expect(rpcs()).toEqual(["void_manual_charge_atomic"]);
    expect(escritasDirectas()).toEqual([]);
  });

  it("🔴 com recebimento: FAIL_CLOSED, com a frase certa", async () => {
    estado.rpc = () => ({ data: null, error: { message: "MANUAL_CHARGE_HAS_PAYMENT" } });
    const r = await voidManualCharge(COBRANCA);
    expect(!r.ok && r.error).toMatch(/Remova o recebimento antes de a excluir/);
  });
});

describe("setServicePayment — continua na 097", () => {
  it("🔴 período fechado: a frase é a do período, não a mensagem crua", async () => {
    estado.dados = (t) => (t === "services" ? [{ payment_status: "nao_informado" }] : []);
    estado.rpc = () => ({ data: null, error: { message: "FINANCIAL_PERIOD_CLOSED: 2026-09" } });
    const r = await setServicePayment(SERVICO, "pago_total");
    expect(rpcs()).toEqual(["set_service_payment_atomic"]);
    expect(!r.ok && r.error).toMatch(/mês está fechado/);
  });
});

describe("getDailyBilling — união serviço / cobrança avulsa", () => {
  const filtro = (filtros: unknown[][], m: string, col?: string) =>
    filtros.some((f) => f[0] === m && (col === undefined || f[1] === col));

  function cenario() {
    estado.dados = (tabela, filtros) => {
      if (tabela === "company_settings") return [{ vat_rate: 23 }];
      if (tabela === "services" && filtro(filtros, "or")) {
        return [{
          id: "s-antigo", reference_number: "R2", scheduled_start: "2026-09-10T09:00:00+01:00", status: "concluido",
          location_id: LOCAL, contract_id: null, calculated_value: 50, manual_value: null, apply_vat: false,
          payment_status: null, paid_amount: null, paid_at: null, notes: null,
        }];
      }
      if (tabela === "services") {
        return [{
          id: SERVICO, reference_number: "R1", scheduled_start: "2026-09-12T09:00:00+01:00", status: "agendado",
          location_id: LOCAL, contract_id: null, calculated_value: 100, manual_value: null, apply_vat: true,
          payment_status: "nao_informado", paid_amount: null, paid_at: null, notes: null,
        }];
      }
      if (tabela === "manual_charges" && filtro(filtros, "eq", "charge_date")) {
        return [{
          id: COBRANCA, client_id: CLIENTE, charge_date: "2026-09-12", description: "Vidros", amount: "80.00",
          apply_vat: true, payment_status: "sinal_50", paid_amount: null, paid_at: null, notes: null,
        }];
      }
      if (tabela === "manual_charges") {
        return [{
          id: "m-antiga", client_id: CLIENTE, charge_date: "2026-09-01", description: "Extra", amount: "20.00",
          apply_vat: false, payment_status: "nao_informado", paid_amount: null, paid_at: null, notes: null,
        }];
      }
      if (tabela === "locations") return [{ id: LOCAL, name: "Escritório", client_id: CLIENTE }];
      if (tabela === "clients") return [{ id: CLIENTE, name: "Cliente A" }];
      return [];
    };
  }

  it("🔴 o dia traz o serviço E a cobrança avulsa, cada um com o seu tipo", async () => {
    cenario();
    const r = await getDailyBilling("2026-09-12");
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.data.day.map((d) => `${d.type}:${d.id}`).sort()).toEqual([`manual_charge:${COBRANCA}`, `service:${SERVICO}`].sort());
    const avulsa = r.data.day.find((d) => d.type === "manual_charge");
    // Não inventa local nem serviço: esses campos nem existem no ramo avulso.
    expect(avulsa).not.toHaveProperty("location_name");
    expect(avulsa).not.toHaveProperty("scheduled_start");
    expect(avulsa).toMatchObject({ client_name: "Cliente A", description: "Vidros", value: 80 });
  });

  it("🔴 a cobrança avulsa antiga por receber entra nos pendentes, ao lado do serviço", async () => {
    cenario();
    const r = await getDailyBilling("2026-09-12");
    if (!r.ok) throw new Error(r.error);
    expect(r.data.pending.map((p) => `${p.type}:${p.id}`)).toEqual(["service:s-antigo", "manual_charge:m-antiga"]);
  });

  it("🔴 a leitura das avulsas filtra as anuladas e as pagas a 100% nos pendentes", async () => {
    const vistos: unknown[][][] = [];
    estado.dados = (tabela, filtros) => {
      if (tabela === "manual_charges") vistos.push(filtros);
      return tabela === "company_settings" ? [{ vat_rate: 23 }] : [];
    };
    await getDailyBilling("2026-09-12");
    expect(vistos).toHaveLength(2);
    for (const f of vistos) {
      expect(filtro(f, "eq", "company_id")).toBe(true);
      expect(f.some((x) => x[0] === "is" && x[1] === "voided_at" && x[2] === null)).toBe(true);
    }
    expect(vistos.some((f) => f.some((x) => x[0] === "neq" && x[1] === "payment_status" && x[2] === "pago_total"))).toBe(true);
  });

  it("🔴 serviço antigo sem estado gravado (NULL) continua a contar como por cobrar", async () => {
    let orServicos: unknown = null;
    estado.dados = (tabela, filtros) => {
      if (tabela === "services") {
        const or = filtros.find((f) => f[0] === "or");
        if (or) orServicos = or[1];
      }
      return tabela === "company_settings" ? [{ vat_rate: 23 }] : [];
    };
    await getDailyBilling("2026-09-12");
    expect(orServicos).toBe("payment_status.is.null,payment_status.neq.pago_total");
  });

  it("data inválida não chega à base", async () => {
    const r = await getDailyBilling("2026-13-40");
    expect(r.ok).toBe(false);
  });
});

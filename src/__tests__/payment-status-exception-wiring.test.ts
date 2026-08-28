/**
 * 🔴 Prova de WIRING: a excepção não prevista percorre o caminho REAL da action.
 *
 * O ficheiro está separado de `payment-status-trace.test.ts` porque precisa de
 * `vi.mock` no topo do módulo — a action importa `requireProfile`,
 * `createAdminClient` e `next/cache`, e nenhum deles existe num teste de node.
 *
 * O que este teste NÃO aceita como prova: chamar `tracePaymentStatus`
 * directamente. Isso prova que a função escreve uma linha, não que a action a
 * chama quando rebenta. A diferença é exactamente o defeito que este ficheiro
 * corrige — o estágio `PAYMENT_STATUS_UNEXPECTED_EXCEPTION` existia no tipo, no
 * logger e no teste, e a action nunca o emitia.
 */
import { describe, it, expect, vi, afterEach } from "vitest";

const PERFIL = { id: "u-1", company_id: "11111111-1111-4111-8111-111111111111", role: "admin" };
const PAGAMENTO = "22222222-2222-4222-8222-222222222222";

/** Trocado por cada teste, antes de invocar a action. */
let requireProfileImpl: () => Promise<unknown> = async () => ({
  ok: true, profile: PERFIL, admin: {},
});

vi.mock("@/lib/auth-guard", () => ({
  requireProfile: () => requireProfileImpl(),
  AUTH_GUARD_CODES: { UNAUTHENTICATED: "UNAUTHENTICATED", PROFILE_NOT_FOUND: "PROFILE_NOT_FOUND", FORBIDDEN: "FORBIDDEN" },
}));
vi.mock("@/lib/supabase/admin", () => ({ createAdminClient: () => ({}) }));
vi.mock("next/cache", () => ({ revalidatePath: () => {} }));

/** A guarda de período é o primeiro passo depois do guard no caminho "pago". */
let periodoImpl: () => Promise<unknown> = async () => ({ ok: true });
vi.mock("@/lib/finance-period-guard", () => ({
  assertFinancialPeriodOpen: () => periodoImpl(),
  lerEstadoPeriodo: async () => ({ ok: true, estado: { status: "open" } }),
}));

import { setPaymentStatus } from "@/app/actions/payments";

function capturar() {
  const linhas: string[] = [];
  const guardar = (v: unknown) => linhas.push(String(v));
  const spies = [
    vi.spyOn(console, "log").mockImplementation(guardar),
    vi.spyOn(console, "warn").mockImplementation(guardar),
    vi.spyOn(console, "error").mockImplementation(guardar),
  ];
  return { linhas, restaurar: () => spies.forEach((s) => s.mockRestore()) };
}

afterEach(() => {
  vi.restoreAllMocks();
  requireProfileImpl = async () => ({ ok: true, profile: PERFIL, admin: {} });
  periodoImpl = async () => ({ ok: true });
});

describe("🔴 excepção não prevista — caminho real da action", () => {
  it("uma excepção a meio do fluxo é registada E re-lançada", async () => {
    const rebenta = new Error("boom: driver caiu com segredo=abc");
    periodoImpl = async () => { throw rebenta; };

    const { linhas, restaurar } = capturar();
    // 🔴 RETHROW_REQUIRED: a action tem de PROPAGAR, não devolver { ok:false }.
    await expect(setPaymentStatus(PAGAMENTO, "pago")).rejects.toThrow(rebenta);
    restaurar();

    const excecao = linhas.map((l) => JSON.parse(l))
      .filter((l) => l.stage === "PAYMENT_STATUS_UNEXPECTED_EXCEPTION");
    expect(excecao).toHaveLength(1);
    expect(excecao[0].code).toBe("UNEXPECTED_EXCEPTION");
    expect(excecao[0].ok).toBe(false);

    // A mensagem da excepção não entra na linha, nem em parte.
    for (const l of linhas) {
      expect(l).not.toContain("boom");
      expect(l).not.toContain("segredo");
      expect(l).not.toContain("driver");
    }
  });

  it("a excepção do próprio guard de autenticação também é registada e propagada", async () => {
    const rebenta = new Error("sessão indisponível");
    requireProfileImpl = async () => { throw rebenta; };

    const { linhas, restaurar } = capturar();
    await expect(setPaymentStatus(PAGAMENTO, "pendente")).rejects.toThrow(rebenta);
    restaurar();

    const stages = linhas.map((l) => JSON.parse(l).stage);
    expect(stages).toContain("PAYMENT_STATUS_UNEXPECTED_EXCEPTION");
    for (const l of linhas) expect(l).not.toContain("sessão indisponível");
  });

  it("uma recusa normal continua a ser { ok:false } — nada foi convertido em excepção", async () => {
    requireProfileImpl = async () => ({ ok: false, code: "FORBIDDEN", error: "Sem permissão." });

    const { linhas, restaurar } = capturar();
    const r = await setPaymentStatus(PAGAMENTO, "pago");
    restaurar();

    expect(r).toEqual({ ok: false, error: "Sem permissão." });
    const linha = linhas.map((l) => JSON.parse(l)).find((l) => l.stage === "PAYMENT_STATUS_AUTH_GUARD");
    expect(linha?.code).toBe("FORBIDDEN");
    // 🔴 AUTH_GUARD não regista o paymentId: nesta etapa ainda vem do cliente.
    expect(linha?.payment).toBeNull();
  });

  it("🔴 AUTH_GUARD não escreve no log um paymentId hostil vindo do cliente", async () => {
    requireProfileImpl = async () => ({ ok: false, code: "UNAUTHENTICATED", error: "Sessão inválida." });

    const { linhas, restaurar } = capturar();
    await setPaymentStatus("password=segredo&Authorization=Bearer abc", "pago");
    restaurar();

    for (const l of linhas) {
      expect(l).not.toContain("password");
      expect(l).not.toContain("segredo");
      expect(l).not.toContain("Bearer");
      expect(l).not.toContain("Authorization");
    }
    expect(JSON.parse(linhas[0]).payment).toBeNull();
  });
});

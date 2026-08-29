/**
 * Rasto de `setPaymentStatus` — em **runtime**, não por leitura do ficheiro.
 *
 * O ensaio irmão (`payment-status-trace.test.ts`) prova o contrato do tracer e
 * lê a action como texto. Isso apanha o que lá está escrito, mas não prova que
 * o caminho é percorrido: um `stage` pode existir no tipo, aparecer numa
 * chamada e mesmo assim nunca ser emitido — foi exactamente o que aconteceu
 * com `PAYMENT_STATUS_UNEXPECTED_EXCEPTION`, declarado e inalcançável.
 *
 * Aqui a action corre a sério, com as dependências isoladas, e verifica-se a
 * linha que sai para a consola. Um `stage` só conta como observável se este
 * ficheiro o vir.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

// ─── Dependências isoladas ──────────────────────────────────────────────────

const guardaAuth = vi.hoisted(() => ({ resultado: null as unknown }));
const rpc = vi.hoisted(() => ({
  marcar: vi.fn(),
  desmarcar: vi.fn(),
}));
const periodo = vi.hoisted(() => ({
  assert: vi.fn(),
  lerEstado: vi.fn(),
}));
const supabase = vi.hoisted(() => ({ pagamento: null as unknown, erro: null as unknown }));

vi.mock("@/lib/auth-guard", () => ({
  requireProfile: async () => guardaAuth.resultado,
}));

vi.mock("@/lib/finance-rpc/payment-cashflow", () => ({
  marcarPagamentoPago: (...a: unknown[]) => rpc.marcar(...a),
  desmarcarPagamentoPago: (...a: unknown[]) => rpc.desmarcar(...a),
}));

vi.mock("@/lib/finance-period-guard", async (original) => {
  const real = await original<typeof import("@/lib/finance-period-guard")>();
  return {
    ...real,
    assertFinancialPeriodOpen: (...a: unknown[]) => periodo.assert(...a),
    lerEstadoPeriodo: (...a: unknown[]) => periodo.lerEstado(...a),
  };
});

vi.mock("next/cache", () => ({ revalidatePath: () => {} }));
vi.mock("@/lib/supabase/admin", () => ({ createAdminClient: () => admin() }));

/** Cliente mínimo: só o que `bloquearSePagamentoEmPeriodoFechado` percorre. */
function admin() {
  const encadeado = {
    select: () => encadeado,
    eq: () => encadeado,
    update: () => encadeado,
    maybeSingle: async () => ({ data: supabase.pagamento, error: supabase.erro }),
  };
  return { from: () => encadeado };
}

import { setPaymentStatus } from "@/app/actions/payments";

const EMPRESA = "11111111-1111-4111-8111-111111111111";
const PERFIL = "22222222-2222-4222-8222-222222222222";
const PAGAMENTO = "33333333-3333-4333-8333-333333333333";

let linhas: string[] = [];

beforeEach(() => {
  linhas = [];
  const guardar = (v: unknown) => linhas.push(String(v));
  vi.spyOn(console, "log").mockImplementation(guardar);
  vi.spyOn(console, "warn").mockImplementation(guardar);
  vi.spyOn(console, "error").mockImplementation(guardar);

  guardaAuth.resultado = {
    ok: true,
    admin: admin(),
    profile: { id: PERFIL, company_id: EMPRESA, role: "admin" },
  };
  supabase.pagamento = { period_year: 2026, period_month: 8 };
  supabase.erro = null;
  periodo.assert.mockResolvedValue({ ok: true, periodo: { year: 2026, month: 8 } });
  periodo.lerEstado.mockResolvedValue({ ok: true, estado: { status: "open" } });
  rpc.marcar.mockResolvedValue({ ok: true, movimentoId: "m1", jaEstavaPago: false });
  rpc.desmarcar.mockResolvedValue({ ok: true });
});

afterEach(() => vi.restoreAllMocks());

/** A última linha estruturada emitida. */
function linha() {
  expect(linhas.length, "nenhuma linha de rasto foi emitida").toBeGreaterThan(0);
  return JSON.parse(linhas[linhas.length - 1]) as Record<string, unknown>;
}

// ═══════════════════════════════════════════════════════════════════════════
// As etapas, percorridas a sério
// ═══════════════════════════════════════════════════════════════════════════

describe("etapas observáveis em runtime", () => {
  it("1. guarda de autenticação → AUTH_GUARD com o código do guard", async () => {
    guardaAuth.resultado = { ok: false, code: "FORBIDDEN", error: "Sem permissão." };
    const r = await setPaymentStatus(PAGAMENTO, "pago");
    expect(r).toEqual({ ok: false, error: "Sem permissão." });
    expect(linha()).toMatchObject({ stage: "PAYMENT_STATUS_AUTH_GUARD", code: "FORBIDDEN", ok: false });
  });

  it("2. período fechado → PERIOD_GUARD + FINANCIAL_PERIOD_CLOSED", async () => {
    periodo.assert.mockResolvedValue({
      ok: false, code: "FINANCIAL_PERIOD_CLOSED", error: "Agosto está fechado.",
    });
    await setPaymentStatus(PAGAMENTO, "pago");
    expect(linha()).toMatchObject({
      stage: "PAYMENT_STATUS_PERIOD_GUARD", code: "FINANCIAL_PERIOD_CLOSED",
    });
  });

  it("3. 🔴 falha a ler o período → STATE_UNKNOWN, não CLOSED", async () => {
    // Era aqui que o rasto mentia: uma falha de infraestrutura ficava
    // registada como «o mês está fechado», e mandava quem investiga procurar
    // uma regra de negócio que não existia.
    periodo.assert.mockResolvedValue({
      ok: false, code: "FINANCIAL_PERIOD_STATE_UNKNOWN", error: "Não foi possível confirmar.",
    });
    await setPaymentStatus(PAGAMENTO, "pago");
    expect(linha()).toMatchObject({
      stage: "PAYMENT_STATUS_PERIOD_GUARD", code: "FINANCIAL_PERIOD_STATE_UNKNOWN",
    });
  });

  it("4. data inválida → INVALID_DATE", async () => {
    periodo.assert.mockResolvedValue({ ok: false, code: "INVALID_DATE", error: "Data inválida." });
    await setPaymentStatus(PAGAMENTO, "pago");
    expect(linha()).toMatchObject({ code: "INVALID_DATE" });
  });

  it("5. recusa da RPC de marcar → MARK_RPC com o motivo canónico", async () => {
    // 🔴 Este mock devolvia `motivo: "CASHFLOW_LINK_AMOUNT_MISMATCH"`, e isso
    //    era impossível em produção.
    //
    //    `CASHFLOW_LINK_AMOUNT_MISMATCH` é o nome de uma excepção levantada
    //    pela 079 dentro do Postgres. Chega ao TypeScript na `message` do erro,
    //    e `interpretarErro` classifica-a como `recusadoPelaBase` — é esse o
    //    valor que o `motivo` toma, e `MotivoFalha` só tem cinco. O mock
    //    fabricava um sexto, e o teste dava por observado um valor que a
    //    aplicação nunca emite. A classificação real está provada em
    //    `payment-cashflow-rpc.test.ts`.
    //
    //    Enquanto o sanitizador filtrava por FORMA, a diferença não aparecia:
    //    qualquer MAIÚSCULA_COM_UNDERSCORES passava. Com a allowlist de VALOR,
    //    um motivo inventado dá `UNCLASSIFIED_CODE` — que é o comportamento
    //    certo, e foi o que expôs o mock irrealista.
    rpc.marcar.mockResolvedValue({
      ok: false, motivo: "recusadoPelaBase", error: "Valores divergentes.",
    });
    await setPaymentStatus(PAGAMENTO, "pago");
    expect(linha()).toMatchObject({
      stage: "PAYMENT_STATUS_MARK_RPC", code: "recusadoPelaBase",
    });
  });

  it("5b. 🔴 um motivo fora de MotivoFalha não é registado tal e qual", async () => {
    // O reverso do que está acima: se algum dia a RPC devolver algo que não
    // pertence à união — porque alguém alargou o tipo sem alargar a allowlist,
    // ou porque a resposta veio deformada — o valor não entra no log.
    rpc.marcar.mockResolvedValue({
      ok: false, motivo: "CASHFLOW_LINK_AMOUNT_MISMATCH", error: "Valores divergentes.",
    });
    await setPaymentStatus(PAGAMENTO, "pago");
    expect(linha().code).toBe("UNCLASSIFIED_CODE");
    expect(linhas.join("\n")).not.toContain("CASHFLOW_LINK_AMOUNT_MISMATCH");
  });

  it("6. desmarcar pagamento inexistente → UNMARK_GUARD + PAYMENT_NOT_FOUND", async () => {
    supabase.pagamento = null;
    const r = await setPaymentStatus(PAGAMENTO, "pendente");
    expect(r).toEqual({ ok: false, error: "Pagamento não encontrado." });
    expect(linha()).toMatchObject({
      stage: "PAYMENT_STATUS_UNMARK_GUARD", code: "PAYMENT_NOT_FOUND",
    });
  });

  it("7. desmarcar com leitura de estado falhada → STATE_UNKNOWN", async () => {
    periodo.lerEstado.mockResolvedValue({ ok: false, error: "rede" });
    await setPaymentStatus(PAGAMENTO, "pendente");
    expect(linha()).toMatchObject({
      stage: "PAYMENT_STATUS_UNMARK_GUARD", code: "FINANCIAL_PERIOD_STATE_UNKNOWN",
    });
  });

  it("8. desmarcar com período fechado → CLOSED", async () => {
    periodo.lerEstado.mockResolvedValue({ ok: true, estado: { status: "closed" } });
    await setPaymentStatus(PAGAMENTO, "pendente");
    expect(linha()).toMatchObject({
      stage: "PAYMENT_STATUS_UNMARK_GUARD", code: "FINANCIAL_PERIOD_CLOSED",
    });
  });

  it("9. excepção inesperada → UNEXPECTED_EXCEPTION", async () => {
    rpc.marcar.mockRejectedValue(new Error("o cliente rebentou"));
    await expect(setPaymentStatus(PAGAMENTO, "pago")).rejects.toThrow();
    expect(linha()).toMatchObject({
      stage: "PAYMENT_STATUS_UNEXPECTED_EXCEPTION", code: "UNEXPECTED_EXCEPTION", ok: false,
    });
  });

  it("10. 🔴 e a excepção é RE-LANÇADA, com a mesma identidade", async () => {
    // Observar não é tratar. Se o `catch` engolisse, a UI receberia sucesso
    // para uma operação que não gravou nada — o pior desfecho possível.
    const original = new Error("falha real");
    rpc.marcar.mockRejectedValue(original);
    await expect(setPaymentStatus(PAGAMENTO, "pago")).rejects.toBe(original);
  });

  it("a excepção não entra na linha de log", async () => {
    rpc.marcar.mockRejectedValue(new Error("Fornecedor Silva, NIF 123456789"));
    await expect(setPaymentStatus(PAGAMENTO, "pago")).rejects.toThrow();
    expect(linhas.join("\n")).not.toMatch(/Silva|123456789/);
  });

  it("o caminho feliz emite OK, e uma só vez", async () => {
    const r = await setPaymentStatus(PAGAMENTO, "pago");
    expect(r).toEqual({ ok: true });
    const etapas = linhas.map((l) => JSON.parse(l).stage);
    expect(etapas).toEqual(["PAYMENT_STATUS_OK"]);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// Nada de arbitrário chega ao log
// ═══════════════════════════════════════════════════════════════════════════

describe("um caller forjado não escreve o que quer nos logs", () => {
  it("11. 🔴 id forjado com texto/PII no AUTH_GUARD não é registado de todo", async () => {
    // O TypeScript desaparece na compilação: quem chama a Server Action envia
    // o que quiser. A defesa tem de estar no tracer.
    //
    // 🔴 A expectativa endureceu: era `INVALID_UUID`, passa a ser `null`.
    //
    //    No AUTH_GUARD o `requireProfile` ainda não passou — não há sessão, e
    //    o id é entrada não autenticada. `INVALID_UUID` já não deixava passar
    //    o texto, mas continuava a afirmar «veio cá um id, e era mau» sobre uma
    //    tentativa que nem sequer está autenticada. Nesta etapa não se olha
    //    para ids, e a ausência é a informação certa.
    const forjado = "Maria Silva maria@exemplo.pt 912345678" as string;
    guardaAuth.resultado = { ok: false, code: "FORBIDDEN", error: "x" };
    await setPaymentStatus(forjado, "pago");
    expect(linha().payment).toBeNull();
    expect(linhas.join("\n")).not.toMatch(/Maria|exemplo\.pt|912345678/);
  });

  it("11b. 🔴 e um UUID válido mas forjado também não, no AUTH_GUARD", async () => {
    // O caso que `INVALID_UUID` nunca cobriu: um id com a forma certa passava
    // intacto para o log de uma tentativa não autenticada. A forma nunca disse
    // nada sobre a origem.
    guardaAuth.resultado = { ok: false, code: "UNAUTHENTICATED", error: "x" };
    await setPaymentStatus("0f8fad5b-d9cb-469f-a165-70867728950e", "pago");
    expect(linha().payment).toBeNull();
    expect(linhas.join("\n")).not.toContain("0f8fad5b");
  });

  it("12. estado alvo forjado não aparece — vira invalid", async () => {
    guardaAuth.resultado = { ok: false, code: "FORBIDDEN", error: "x" };
    await setPaymentStatus(PAGAMENTO, "'; DROP TABLE payments--" as never);
    expect(linha().target).toBe("invalid");
    expect(linhas.join("\n")).not.toMatch(/DROP TABLE/);
  });

  it("13. código com espaços e dados vira UNCLASSIFIED_CODE", async () => {
    guardaAuth.resultado = {
      ok: false,
      code: "erro ao gravar pagamento de Silva no valor de 1234,56 EUR",
      error: "x",
    };
    await setPaymentStatus(PAGAMENTO, "pago");
    expect(linha().code).toBe("UNCLASSIFIED_CODE");
    expect(linhas.join("\n")).not.toMatch(/Silva|1234/);
  });

  it("um id válido passa intacto depois da autenticação — a peneira não estraga o caso normal", async () => {
    // 🔴 A supressão é cirúrgica, e tem de se provar dos dois lados. Se apagasse
    //    o `payment` em todas as etapas, o rasto deixava de servir para aquilo
    //    que foi feito: dizer QUAL pagamento parou ONDE. Por isso o caso normal
    //    mede-se agora numa etapa já autenticada.
    periodo.assert.mockResolvedValue({
      ok: false, code: "FINANCIAL_PERIOD_CLOSED", error: "Agosto está fechado.",
    });
    await setPaymentStatus(PAGAMENTO, "pago");
    expect(linha().stage).toBe("PAYMENT_STATUS_PERIOD_GUARD");
    expect(linha().payment).toBe(PAGAMENTO);
    expect(linha().target).toBe("pago");
  });

  it("14. nenhum segredo entra na linha, em nenhuma etapa", async () => {
    const proibido = /cookie|authorization|bearer|service_role|postgres:\/\/|password|eyJ/i;
    for (const alvo of ["pago", "pendente"] as const) {
      guardaAuth.resultado = { ok: false, code: "FORBIDDEN", error: "x" };
      await setPaymentStatus(PAGAMENTO, alvo);
    }
    expect(linhas.join("\n")).not.toMatch(proibido);
  });
});

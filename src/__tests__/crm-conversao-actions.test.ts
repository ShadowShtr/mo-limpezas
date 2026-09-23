// ============================================================================
// A conversão — comportamento da Server Action, não leitura de strings
// ============================================================================
//
// Corre `convertAcceptedQuote` a sério, com o guard e o cliente de base
// substituídos por duplos que registam o que foi chamado. É o que permite
// provar o que nenhum ensaio estático prova:
//
//   · um `quoteId` malformado não chega sequer à base — query 0, RPC 0;
//   · um orçamento nascido de cliente NÃO chama a RPC;
//   · a RPC é chamada exactamente UMA vez, com os quatro argumentos certos,
//     e o `p_lead_id` vem do SERVIDOR (`source_lead_id`), não do browser;
//   · a auditoria distingue conversão real de repetição idempotente.
// ============================================================================

import { describe, it, expect, vi, beforeEach } from "vitest";

const auditLog = vi.fn();
const invalidateBusinessState = vi.fn();
const requireProfile = vi.fn();

vi.mock("@/lib/audit", () => ({ auditLog: (...a: unknown[]) => auditLog(...a) }));
vi.mock("@/lib/revalidate-business", () => ({
  invalidateBusinessState: (...a: unknown[]) => invalidateBusinessState(...a),
}));
vi.mock("@/lib/auth-guard", () => ({
  AUTH_GUARD_CODES: {
    UNAUTHENTICATED: "UNAUTHENTICATED",
    PROFILE_NOT_FOUND: "PROFILE_NOT_FOUND",
    FORBIDDEN: "FORBIDDEN",
  },
  requireProfile: (...a: unknown[]) => requireProfile(...a),
}));

const { convertAcceptedQuote } = await import("@/app/actions/crm-conversao");

const EMPRESA = "11111111-1111-4111-8111-111111111111";
const ACTOR = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const LEAD = "22222222-2222-4222-8222-222222222222";
const QUOTE = "33333333-3333-4333-8333-333333333333";
const CLIENTE = "44444444-4444-4444-8444-444444444444";
const LOCAL = "55555555-5555-4555-8555-555555555555";

interface Chamadas {
  rpc: { nome: string; args: Record<string, unknown> }[];
  selects: { tabela: string; cols: string }[];
}

interface Respostas {
  quote?: Record<string, unknown> | null;
  quoteErro?: { message: string } | null;
  rpc?: () => { data: unknown; error: { message: string } | null };
}

function duplo(r: Respostas = {}) {
  const chamadas: Chamadas = { rpc: [], selects: [] };

  const builder = (tabela: string) => {
    const api = {
      select: (cols: string) => { chamadas.selects.push({ tabela, cols }); return api; },
      eq: () => api,
      maybeSingle: async () => ({
        data: r.quote === undefined ? { source_lead_id: LEAD } : r.quote,
        error: r.quoteErro ?? null,
      }),
    };
    return api;
  };

  const admin = {
    from: builder,
    rpc: async (nome: string, args: Record<string, unknown>) => {
      chamadas.rpc.push({ nome, args });
      return r.rpc
        ? r.rpc()
        : { data: [{ client_id: CLIENTE, location_id: LOCAL, ja_convertida: false }], error: null };
    },
  };

  requireProfile.mockResolvedValue({
    ok: true, admin, profile: { id: ACTOR, company_id: EMPRESA },
  });

  return chamadas;
}

/** Quantas vezes a auditoria da CONVERSÃO foi gravada. */
const auditoriasDeConversao = () =>
  auditLog.mock.calls.filter((c) => (c[0] as { action?: string })?.action === "crm_lead_converted").length;

beforeEach(() => { vi.clearAllMocks(); });

// ───────────────────────────────────────────────────────────────────────────
describe("entrada pública — só o quoteId, e validado primeiro", () => {
  for (const mau of ["", "nao-e-uuid", "12345", "3333-4333-8333"]) {
    it(`🔴 «${mau}»: VALIDATION, sem tocar na base nem na RPC`, async () => {
      const chamadas = duplo();
      const res = await convertAcceptedQuote(mau);

      expect(res.ok).toBe(false);
      if (!res.ok) expect(res.error.code).toBe("VALIDATION");
      // 🔴 Nem query nem RPC: a recusa acontece antes de qualquer ligação.
      expect(chamadas.selects).toHaveLength(0);
      expect(chamadas.rpc).toHaveLength(0);
    });
  }

  it("a assinatura aceita um argumento só", () => {
    expect(convertAcceptedQuote.length).toBe(1);
  });
});

describe("autenticação e papel", () => {
  it("não autenticado", async () => {
    requireProfile.mockResolvedValue({ ok: false, code: "UNAUTHENTICATED" });
    const res = await convertAcceptedQuote(QUOTE);
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error.code).toBe("UNAUTHENTICATED");
  });

  it("papel sem permissão", async () => {
    requireProfile.mockResolvedValue({ ok: false, code: "FORBIDDEN" });
    const res = await convertAcceptedQuote(QUOTE);
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error.code).toBe("FORBIDDEN");
  });

  it("🔴 admin E gestor podem converter", async () => {
    duplo();
    await convertAcceptedQuote(QUOTE);
    expect(requireProfile).toHaveBeenCalledWith({ roles: ["admin", "gestor"] });
  });
});

// ───────────────────────────────────────────────────────────────────────────
describe("a proveniência vem do SERVIDOR", () => {
  it("🔴 lê só `source_lead_id`, e nada mais", async () => {
    // Trazer `status`/`superseded_by_id` «para validar antes» seria começar a
    // duplicar as regras da RPC — e uma leitura sem lock nem sequer é verdade
    // no instante da escrita.
    const chamadas = duplo();
    await convertAcceptedQuote(QUOTE);

    const leitura = chamadas.selects.find((s) => s.tabela === "crm_quotes");
    expect(leitura).toBeDefined();
    expect(leitura!.cols.trim()).toBe("source_lead_id");
  });

  it("🔴 `p_lead_id` é o source_lead_id lido, não nada vindo de fora", async () => {
    const chamadas = duplo({ quote: { source_lead_id: LEAD } });
    await convertAcceptedQuote(QUOTE);

    expect(chamadas.rpc).toHaveLength(1);
    expect(chamadas.rpc[0].args.p_lead_id).toBe(LEAD);
  });

  it("orçamento inexistente ou de outra empresa: NOT_FOUND, RPC 0", async () => {
    const chamadas = duplo({ quote: null });
    const res = await convertAcceptedQuote(QUOTE);

    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error.code).toBe("NOT_FOUND");
    expect(chamadas.rpc).toHaveLength(0);
  });

  it("🔴 orçamento nascido de CLIENTE: BUSINESS_RULE e RPC 0", async () => {
    const chamadas = duplo({ quote: { source_lead_id: null } });
    const res = await convertAcceptedQuote(QUOTE);

    expect(res.ok).toBe(false);
    if (!res.ok) {
      expect(res.error.code).toBe("BUSINESS_RULE");
      expect(res.error.message).toContain("diretamente para um cliente");
    }
    expect(chamadas.rpc).toHaveLength(0);
  });

  it("falha a ler o orçamento não chama a RPC", async () => {
    const chamadas = duplo({ quote: null, quoteErro: { message: "timeout" } });
    const res = await convertAcceptedQuote(QUOTE);
    expect(res.ok).toBe(false);
    expect(chamadas.rpc).toHaveLength(0);
  });
});

// ───────────────────────────────────────────────────────────────────────────
describe("a RPC é a autoridade — uma chamada, quatro argumentos", () => {
  it("🔴 exactamente uma chamada, com os quatro args exactos", async () => {
    const chamadas = duplo();
    await convertAcceptedQuote(QUOTE);

    expect(chamadas.rpc).toHaveLength(1);
    expect(chamadas.rpc[0].nome).toBe("convert_crm_lead_atomic");
    expect(chamadas.rpc[0].args).toEqual({
      p_company_id: EMPRESA,
      p_lead_id: LEAD,
      p_actor: ACTOR,
      p_quote_id: QUOTE,
    });
  });

  it("sucesso normal devolve os ids e alreadyConverted=false", async () => {
    duplo();
    const res = await convertAcceptedQuote(QUOTE);

    expect(res.ok).toBe(true);
    if (res.ok) {
      expect(res.data).toEqual({ clientId: CLIENTE, locationId: LOCAL, alreadyConverted: false });
    }
  });

  it("🔴 sucesso idempotente também é sucesso", async () => {
    duplo({
      rpc: () => ({ data: [{ client_id: CLIENTE, location_id: LOCAL, ja_convertida: true }], error: null }),
    });
    const res = await convertAcceptedQuote(QUOTE);

    expect(res.ok).toBe(true);
    if (res.ok) {
      expect(res.data.alreadyConverted).toBe(true);
      expect(res.data.clientId).toBe(CLIENTE);
    }
  });

  it("🔴 sem client_id/location_id: PERSISTENCE, e não se inventam ids", async () => {
    duplo({ rpc: () => ({ data: [{ ja_convertida: false }], error: null }) });
    const res = await convertAcceptedQuote(QUOTE);
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error.code).toBe("PERSISTENCE");
  });
});

// ───────────────────────────────────────────────────────────────────────────
describe("🔴 o contrato da resposta falha FECHADO", () => {
  /**
   * 🔴 Porque é que `ja_convertida` malformado é o caso perigoso.
   *
   *    `linha.ja_convertida === true` lê bem e falha aberto: com `undefined`,
   *    `null` ou uma string, dá `false` em silêncio — e `false` é justamente
   *    o ramo que AUDITA a conversão como real. Uma resposta que não se
   *    percebe passaria a valer como «conversão confirmada» e ficava
   *    registada como tal.
   */
  const FORA_DO_CONTRATO: Array<[string, Record<string, unknown>]> = [
    ["A. client_id ausente", { location_id: LOCAL, ja_convertida: false }],
    ["B. location_id ausente", { client_id: CLIENTE, ja_convertida: false }],
    ["C. ja_convertida ausente", { client_id: CLIENTE, location_id: LOCAL }],
    ["D. ja_convertida null", { client_id: CLIENTE, location_id: LOCAL, ja_convertida: null }],
    ["E. ja_convertida «false» (string)",
      { client_id: CLIENTE, location_id: LOCAL, ja_convertida: "false" }],
    ["F. ja_convertida 0", { client_id: CLIENTE, location_id: LOCAL, ja_convertida: 0 }],
    ["G. client_id não é uuid",
      { client_id: "nao-e-uuid", location_id: LOCAL, ja_convertida: false }],
    ["H. resposta vazia", {}],
  ];

  for (const [nome, linha] of FORA_DO_CONTRATO) {
    it(`${nome} → PERSISTENCE, sem auditoria nem invalidação`, async () => {
      duplo({ rpc: () => ({ data: [linha], error: null }) });

      const res = await convertAcceptedQuote(QUOTE);

      expect(res.ok, "não pode haver sucesso").toBe(false);
      if (!res.ok) expect(res.error.code).toBe("PERSISTENCE");

      // 🔴 Nenhum efeito: nem auditoria de uma conversão que ninguém
      //    confirmou, nem invalidação de caches por causa dela.
      expect(auditoriasDeConversao()).toBe(0);
      expect(invalidateBusinessState).not.toHaveBeenCalled();
    });
  }

  it("resposta nula da RPC → PERSISTENCE", async () => {
    duplo({ rpc: () => ({ data: null, error: null }) });
    const res = await convertAcceptedQuote(QUOTE);
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error.code).toBe("PERSISTENCE");
    expect(auditoriasDeConversao()).toBe(0);
  });

  it("🔴 o contrato CUMPRIDO continua a passar — false audita", async () => {
    duplo({
      rpc: () => ({ data: [{ client_id: CLIENTE, location_id: LOCAL, ja_convertida: false }], error: null }),
    });
    const res = await convertAcceptedQuote(QUOTE);

    expect(res.ok).toBe(true);
    if (res.ok) expect(res.data.alreadyConverted).toBe(false);
    expect(auditoriasDeConversao()).toBe(1);
    expect(invalidateBusinessState).toHaveBeenCalledTimes(1);
  });

  it("🔴 o contrato CUMPRIDO continua a passar — true não audita", async () => {
    duplo({
      rpc: () => ({ data: [{ client_id: CLIENTE, location_id: LOCAL, ja_convertida: true }], error: null }),
    });
    const res = await convertAcceptedQuote(QUOTE);

    expect(res.ok).toBe(true);
    if (res.ok) expect(res.data.alreadyConverted).toBe(true);
    expect(auditoriasDeConversao()).toBe(0);
    expect(invalidateBusinessState).toHaveBeenCalledTimes(1);
  });

  it("a mensagem de erro não expõe o interior da resposta", async () => {
    duplo({ rpc: () => ({ data: [{ client_id: CLIENTE }], error: null }) });
    const res = await convertAcceptedQuote(QUOTE);
    expect(res.ok).toBe(false);
    if (!res.ok) {
      expect(res.error.message).not.toContain("ja_convertida");
      expect(res.error.message).not.toContain("client_id");
    }
  });
});

// ───────────────────────────────────────────────────────────────────────────
describe("sentinelas — mensagem que se entende, nunca SQL cru", () => {
  const casos: Array<[string, string, RegExp]> = [
    ["LEAD_NOT_FOUND", "NOT_FOUND", /Lead não encontrada/],
    ["QUOTE_NOT_FOUND", "NOT_FOUND", /Orçamento não encontrado/],
    ["QUOTE_NOT_ACCEPTED: estado enviado", "BUSINESS_RULE", /ainda não está aceite/],
    ["QUOTE_ALREADY_SUPERSEDED: substituído por x", "CONFLICT", /revisão mais recente/],
    ["QUOTE_LEAD_MISMATCH: não nasceu", "CONFLICT", /estado deste orçamento mudou/],
    ["QUOTE_RECIPIENT_MISMATCH: já não", "CONFLICT", /estado deste orçamento mudou/],
    ["CONVERSION_VISIT_MISMATCH: a visita x", "CONFLICT", /visita ligada ao orçamento/],
    ["CONVERSION_ADDRESS_REQUIRED", "BUSINESS_RULE", /morada válida/],
    ["CONVERSION_STATE_DIVERGED: o local", "CONFLICT", /inconsistente/],
    ["ACTOR_NOT_IN_COMPANY", "FORBIDDEN", /Sem permissão/],
  ];

  for (const [sentinela, code, frase] of casos) {
    it(`${sentinela.split(":")[0]} → ${code}`, async () => {
      duplo({ rpc: () => ({ data: null, error: { message: sentinela } }) });
      const res = await convertAcceptedQuote(QUOTE);

      expect(res.ok).toBe(false);
      if (!res.ok) {
        expect(res.error.code).toBe(code);
        expect(res.error.message).toMatch(frase);
        // 🔴 A sentinela crua nunca chega ao ecrã.
        expect(res.error.message).not.toContain(sentinela.split(":")[0]);
      }
    });
  }

  it("🔴 CONVERSION_QUOTE_REQUIRED não culpa o utilizador", async () => {
    // A RPC levanta-a com `p_quote_id` NULL, e esta action só chama com um
    // UUID já validado. Numa chamada válida é impossível: se aparecer, é
    // defeito nosso, não dele. Dizer «faltou indicar o orçamento» seria
    // culpá-lo por um erro que não cometeu e não sabe corrigir.
    duplo({ rpc: () => ({ data: null, error: { message: "CONVERSION_QUOTE_REQUIRED" } }) });
    const res = await convertAcceptedQuote(QUOTE);

    expect(res.ok).toBe(false);
    if (!res.ok) {
      expect(res.error.code).toBe("PERSISTENCE");
      expect(res.error.message).not.toMatch(/orçamento.*falt|falt.*orçamento/i);
    }
  });

  it("🔴 erro desconhecido não vaza SQL", async () => {
    duplo({
      rpc: () => ({
        data: null,
        error: { message: 'relation "public.crm_leads" violates constraint "x_fkey"' },
      }),
    });
    const res = await convertAcceptedQuote(QUOTE);

    expect(res.ok).toBe(false);
    if (!res.ok) {
      expect(res.error.message).not.toContain("crm_leads");
      expect(res.error.message).not.toContain("constraint");
      expect(res.error.message).not.toContain("relation");
    }
  });
});

// ───────────────────────────────────────────────────────────────────────────
describe("auditoria — a conversão real conta uma vez", () => {
  it("🔴 primeira conversão: 1 registo", async () => {
    duplo();
    await convertAcceptedQuote(QUOTE);

    expect(auditoriasDeConversao()).toBe(1);
    const p = auditLog.mock.calls[0][0] as Record<string, unknown>;
    expect(p.entityType).toBe("crm_lead");
    expect(p.entityId).toBe(LEAD);
    expect(p.after).toEqual({ quote_id: QUOTE, client_id: CLIENTE, location_id: LOCAL });
  });

  it("🔴 sucesso IDEMPOTENTE: 0 registos", async () => {
    // Um duplo clique ou um retry não é uma segunda conversão — é a mesma,
    // vista outra vez. Auditá-la encheria a auditoria de eventos que nunca
    // aconteceram, e quem contasse conversões contaria cliques.
    duplo({
      rpc: () => ({ data: [{ client_id: CLIENTE, location_id: LOCAL, ja_convertida: true }], error: null }),
    });
    await convertAcceptedQuote(QUOTE);

    expect(auditoriasDeConversao()).toBe(0);
  });

  it("falha: 0 registos", async () => {
    duplo({ rpc: () => ({ data: null, error: { message: "QUOTE_NOT_ACCEPTED" } }) });
    await convertAcceptedQuote(QUOTE);
    expect(auditoriasDeConversao()).toBe(0);
  });

  it("orçamento de cliente: 0 registos", async () => {
    duplo({ quote: { source_lead_id: null } });
    await convertAcceptedQuote(QUOTE);
    expect(auditoriasDeConversao()).toBe(0);
  });
});

// ───────────────────────────────────────────────────────────────────────────
describe("invalidação", () => {
  it("🔴 três domínios e o clientId, uma vez", async () => {
    duplo();
    await convertAcceptedQuote(QUOTE);

    expect(invalidateBusinessState).toHaveBeenCalledTimes(1);
    expect(invalidateBusinessState).toHaveBeenCalledWith({
      domains: ["leads", "clients", "locations"],
      clientId: CLIENTE,
    });
  });

  it("🔴 também no sucesso idempotente", async () => {
    // Quem repetiu pode estar a ver uma lista desactualizada noutro separador.
    duplo({
      rpc: () => ({ data: [{ client_id: CLIENTE, location_id: LOCAL, ja_convertida: true }], error: null }),
    });
    await convertAcceptedQuote(QUOTE);

    expect(invalidateBusinessState).toHaveBeenCalledTimes(1);
  });

  it("falha não invalida", async () => {
    duplo({ rpc: () => ({ data: null, error: { message: "QUOTE_NOT_ACCEPTED" } }) });
    await convertAcceptedQuote(QUOTE);
    expect(invalidateBusinessState).not.toHaveBeenCalled();
  });
});

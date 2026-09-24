// ============================================================================
// Editar um rascunho — comportamento da Server Action, não leitura de strings
// ============================================================================
//
// Corre `editDraftQuote` a sério, com o guard e o cliente de base substituídos
// por duplos que registam o que foi chamado. É o que permite provar o que
// nenhum ensaio estático prova:
//
//   · o TOKEN de concorrência chega à RPC exactamente como veio da base —
//     microssegundos incluídos. É a prova central desta suite;
//   · a taxa de IVA usada é a PERSISTIDA no rascunho, nunca a do browser nem a
//     das definições de hoje;
//   · a empresa e o actor vêm do servidor, e o destinatário não vem de lado
//     nenhum;
//   · a RPC é chamada exactamente UMA vez, com os 16 argumentos certos;
//   · a auditoria só acontece no sucesso, e a invalidação também.
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

const { editDraftQuote } = await import("@/app/actions/crm-orcamentos");

const EMPRESA = "11111111-1111-4111-8111-111111111111";
const ACTOR = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const QUOTE = "33333333-3333-4333-8333-333333333333";
const VISITA = "66666666-6666-4666-8666-666666666666";

/**
 * 🔴 O token, com MICROSSEGUNDOS.
 *
 *    É esta string que tem de chegar à RPC. `new Date(...)` sobre ela devolve
 *    `2026-09-24T13:05:54.123Z` — perde os `456` e o offset explícito, e a RPC
 *    recusaria com `QUOTE_DRAFT_STALE`.
 */
const TOKEN = "2026-09-24T13:05:54.123456+00:00";

const ANO = 2026;
const IVA_GRAVADO = 23;

interface Chamadas {
  rpc: { nome: string; args: Record<string, unknown> }[];
  selects: { tabela: string; cols: string }[];
}

interface Respostas {
  base?: Record<string, unknown> | null;
  baseErro?: { message: string } | null;
  rpc?: () => { data: unknown; error: { message: string } | null };
}

function duplo(r: Respostas = {}) {
  const chamadas: Chamadas = { rpc: [], selects: [] };

  const builder = (tabela: string) => {
    const api = {
      select: (cols: string) => { chamadas.selects.push({ tabela, cols }); return api; },
      eq: () => api,
      maybeSingle: async () => ({
        data: r.base === undefined ? { quote_year: ANO, vat_rate: IVA_GRAVADO } : r.base,
        error: r.baseErro ?? null,
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
        : {
            data: [{
              quote_id: QUOTE,
              quote_number: "ORC2026/007",
              updated_at: "2026-09-24T14:00:00.987654+00:00",
            }],
            error: null,
          };
    },
  };

  requireProfile.mockResolvedValue({
    ok: true, admin, profile: { id: ACTOR, company_id: EMPRESA },
  });

  return chamadas;
}

/** Uma entrada válida; cada campo pode ser substituído. */
function entrada(over: Record<string, unknown> = {}) {
  return {
    expectedUpdatedAt: TOKEN,
    visitId: null,
    issueDate: `${ANO}-03-01`,
    validUntil: `${ANO}-04-01`,
    pricingKind: "pontual" as const,
    discountPct: 0,
    applyVat: true,
    proposedFrequency: null,
    paymentTerms: null,
    notes: null,
    internalNotes: null,
    items: [{ description: "Limpeza", quantity: 2, unit: "hora" as const, unitPrice: 50 }],
    ...over,
  };
}

const auditoriasDeEdicao = () =>
  auditLog.mock.calls.filter(
    (c) => (c[0] as { action?: string })?.action === "crm_quote_draft_edited",
  ).length;

beforeEach(() => { vi.clearAllMocks(); });

// ───────────────────────────────────────────────────────────────────────────
describe("🔴 o token de concorrência", () => {
  it("🔴 chega à RPC EXACTAMENTE como veio da base, com microssegundos", async () => {
    // 🔴 A prova central. Se alguém puser `new Date(token).toISOString()` no
    //    caminho, o valor passa a `2026-09-24T13:05:54.123Z` e este ensaio
    //    fica vermelho — que é precisamente o que se quer, porque a RPC
    //    compara ao microssegundo e recusaria a edição como STALE.
    const chamadas = duplo();
    await editDraftQuote(QUOTE, entrada());

    expect(chamadas.rpc).toHaveLength(1);
    expect(chamadas.rpc[0].args.p_expected_updated_at).toBe(TOKEN);
    expect(String(chamadas.rpc[0].args.p_expected_updated_at)).toContain(".123456");
    expect(String(chamadas.rpc[0].args.p_expected_updated_at)).not.toBe(
      new Date(TOKEN).toISOString(),
    );
  });

  it("🔴 um token ausente é recusado, e a RPC não é chamada", async () => {
    const chamadas = duplo();
    const res = await editDraftQuote(
      QUOTE,
      entrada({ expectedUpdatedAt: undefined }) as never,
    );

    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error.code).toBe("VALIDATION");
    expect(chamadas.rpc).toHaveLength(0);
  });

  for (const mau of ["", "ontem", "2026-13-45T99:99:99", "1758718000"]) {
    it(`🔴 token «${mau}»: VALIDATION, sem RPC`, async () => {
      const chamadas = duplo();
      const res = await editDraftQuote(QUOTE, entrada({ expectedUpdatedAt: mau }));

      expect(res.ok).toBe(false);
      if (!res.ok) expect(res.error.code).toBe("VALIDATION");
      expect(chamadas.rpc).toHaveLength(0);
    });
  }

  for (const bom of [
    "2026-09-24T13:05:54.123456+00:00",
    "2026-09-24T13:05:54.123Z",
    "2026-09-24 13:05:54.123456+01",
    "2026-09-24T13:05:54+00:00",
  ]) {
    it(`aceita a forma «${bom}» e não a reescreve`, async () => {
      const chamadas = duplo();
      await editDraftQuote(QUOTE, entrada({ expectedUpdatedAt: bom }));
      expect(chamadas.rpc[0].args.p_expected_updated_at).toBe(bom);
    });
  }
});

// ───────────────────────────────────────────────────────────────────────────
describe("entrada pública — o que não entra", () => {
  for (const mau of ["", "nao-e-uuid", "12345"]) {
    it(`🔴 quoteId «${mau}»: recusa sem tocar na base nem na RPC`, async () => {
      const chamadas = duplo();
      const res = await editDraftQuote(mau, entrada());

      expect(res.ok).toBe(false);
      expect(chamadas.selects).toHaveLength(0);
      expect(chamadas.rpc).toHaveLength(0);
    });
  }

  it("🔴 empresa, actor e destinatário vindos do input são IGNORADOS", async () => {
    const chamadas = duplo();
    await editDraftQuote(QUOTE, entrada({
      companyId: "99999999-9999-4999-8999-999999999999",
      actorId: "88888888-8888-4888-8888-888888888888",
      leadId: "77777777-7777-4777-8777-777777777777",
      clientId: "66666666-6666-4666-8666-666666666666",
      sourceLeadId: "55555555-5555-4555-8555-555555555555",
      quoteNumber: "ORC2026/999",
      revision: 9,
      vatRate: 1,
    }) as never);

    const args = chamadas.rpc[0].args;
    expect(args.p_company_id).toBe(EMPRESA);
    expect(args.p_actor).toBe(ACTOR);
    // 🔴 A RPC nem sequer TEM parâmetros de destinatário ou identidade.
    for (const k of [
      "p_lead_id", "p_client_id", "p_source_lead_id",
      "p_quote_number", "p_revision", "p_root_quote_id", "p_status",
    ]) {
      expect(Object.keys(args), `a RPC recebeu ${k}`).not.toContain(k);
    }
    // E o IVA continua a ser o gravado, não o `1` que o input trouxe.
    expect(args.p_vat_rate).toBe(IVA_GRAVADO);
  });

  it("a assinatura pública é (quoteId, input)", () => {
    expect(editDraftQuote.length).toBe(2);
  });
});

// ───────────────────────────────────────────────────────────────────────────
describe("autenticação, papel e isolamento", () => {
  it("não autenticado", async () => {
    requireProfile.mockResolvedValue({ ok: false, code: "UNAUTHENTICATED" });
    const res = await editDraftQuote(QUOTE, entrada());
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error.code).toBe("UNAUTHENTICATED");
  });

  it("papel sem permissão", async () => {
    requireProfile.mockResolvedValue({ ok: false, code: "FORBIDDEN" });
    const res = await editDraftQuote(QUOTE, entrada());
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error.code).toBe("FORBIDDEN");
  });

  it("🔴 a leitura é company-scoped e MÍNIMA", async () => {
    const chamadas = duplo();
    await editDraftQuote(QUOTE, entrada());

    expect(chamadas.selects).toEqual([{ tabela: "crm_quotes", cols: "quote_year, vat_rate" }]);
    // 🔴 Nada de `status`, `superseded_by_id` nem `updated_at`: essas decisões
    //    pertencem à RPC, debaixo do lock. Lê-las aqui seria validar um passado.
    const cols = chamadas.selects[0].cols;
    for (const proibida of ["status", "superseded", "updated_at", "sent_at"]) {
      expect(cols, `a leitura traz ${proibida}`).not.toContain(proibida);
    }
  });

  it("🔴 orçamento de outra empresa: NOT_FOUND, e zero RPC", async () => {
    const chamadas = duplo({ base: null });
    const res = await editDraftQuote(QUOTE, entrada());

    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error.code).toBe("NOT_FOUND");
    expect(chamadas.rpc).toHaveLength(0);
  });

  it("erro a ler a base: PERSISTENCE, e zero RPC", async () => {
    const chamadas = duplo({ baseErro: { message: "ligação caiu" } });
    const res = await editDraftQuote(QUOTE, entrada());

    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error.code).toBe("PERSISTENCE");
    expect(chamadas.rpc).toHaveLength(0);
  });
});

// ───────────────────────────────────────────────────────────────────────────
describe("🔴 o IVA é o do rascunho", () => {
  it("🔴 usa a taxa PERSISTIDA, e não a do browser", async () => {
    const chamadas = duplo({ base: { quote_year: ANO, vat_rate: 6 } });
    await editDraftQuote(QUOTE, entrada({ vatRate: 23 }) as never);

    expect(chamadas.rpc[0].args.p_vat_rate).toBe(6);
  });

  it("🔴 NÃO lê company_settings", async () => {
    // Uma correcção de gralha não pode mudar o IVA de um orçamento por a
    // empresa ter alterado a taxa entretanto.
    const chamadas = duplo();
    await editDraftQuote(QUOTE, entrada());

    expect(chamadas.selects.map((s) => s.tabela)).not.toContain("company_settings");
  });

  it("o precheck de montante corre com a taxa gravada, antes da RPC", async () => {
    // 🔴 Cada campo dentro do seu domínio — 100 000 e 1 000 000 são ambos
    //    aceites — e o PRODUTO não cabe em numeric(10,2). É exactamente o caso
    //    que a validação campo a campo não apanha e o precheck apanha.
    const chamadas = duplo({ base: { quote_year: ANO, vat_rate: 6 } });
    const res = await editDraftQuote(QUOTE, entrada({
      items: [{ description: "X", quantity: 100_000, unit: "servico", unitPrice: 1_000_000 }],
    }));

    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error.code).toBe("BUSINESS_RULE");
    expect(chamadas.rpc, "overflow não pode chegar à RPC").toHaveLength(0);
  });
});

// ───────────────────────────────────────────────────────────────────────────
describe("🔴 o ano do número é do servidor", () => {
  it("🔴 emissão noutro ano: BUSINESS_RULE, e a RPC não é chamada", async () => {
    const chamadas = duplo({ base: { quote_year: 2026, vat_rate: IVA_GRAVADO } });
    const res = await editDraftQuote(QUOTE, entrada({
      issueDate: "2027-01-02", validUntil: "2027-02-02",
    }));

    expect(res.ok).toBe(false);
    if (!res.ok) {
      expect(res.error.code).toBe("BUSINESS_RULE");
      expect(res.error.message).toContain("2026");
    }
    expect(chamadas.rpc).toHaveLength(0);
  });

  it("a validade PODE cair no ano seguinte", async () => {
    const chamadas = duplo({ base: { quote_year: 2026, vat_rate: IVA_GRAVADO } });
    const res = await editDraftQuote(QUOTE, entrada({
      issueDate: "2026-12-31", validUntil: "2027-01-30",
    }));

    expect(res.ok).toBe(true);
    expect(chamadas.rpc).toHaveLength(1);
  });

  it("validade anterior à emissão: VALIDATION, sem RPC", async () => {
    const chamadas = duplo();
    const res = await editDraftQuote(QUOTE, entrada({
      issueDate: `${ANO}-03-10`, validUntil: `${ANO}-03-09`,
    }));

    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error.code).toBe("VALIDATION");
    expect(chamadas.rpc).toHaveLength(0);
  });
});

// ───────────────────────────────────────────────────────────────────────────
describe("🔴 o domínio é fechado no servidor", () => {
  const MAUS: Array<[string, Record<string, unknown>]> = [
    ["quantidade com 3 casas", { items: [{ description: "X", quantity: 1.555, unit: "hora", unitPrice: 1 }] }],
    ["preço com 3 casas", { items: [{ description: "X", quantity: 1, unit: "hora", unitPrice: 9.999 }] }],
    ["quantidade zero", { items: [{ description: "X", quantity: 0, unit: "hora", unitPrice: 1 }] }],
    ["preço negativo", { items: [{ description: "X", quantity: 1, unit: "hora", unitPrice: -1 }] }],
    ["descrição vazia", { items: [{ description: "   ", quantity: 1, unit: "hora", unitPrice: 1 }] }],
    ["unidade fora do domínio", { items: [{ description: "X", quantity: 1, unit: "litro", unitPrice: 1 }] }],
    ["zero linhas", { items: [] }],
    ["desconto com 3 casas", { discountPct: 3.141 }],
    ["desconto acima de 100", { discountPct: 101 }],
    ["tipo de preço inválido", { pricingKind: "semanal" }],
  ];

  for (const [nome, over] of MAUS) {
    it(`🔴 ${nome}: VALIDATION, e a RPC não chega a ser chamada`, async () => {
      const chamadas = duplo();
      const res = await editDraftQuote(QUOTE, entrada(over) as never);

      expect(res.ok).toBe(false);
      if (!res.ok) expect(res.error.code).toBe("VALIDATION");
      expect(chamadas.rpc).toHaveLength(0);
      expect(chamadas.selects, "nem sequer lê a base").toHaveLength(0);
    });
  }

  it("101 linhas é recusado", async () => {
    const chamadas = duplo();
    const res = await editDraftQuote(QUOTE, entrada({
      items: Array.from({ length: 101 }, (_, i) => ({
        description: `L${i}`, quantity: 1, unit: "servico", unitPrice: 1,
      })),
    }));
    expect(res.ok).toBe(false);
    expect(chamadas.rpc).toHaveLength(0);
  });
});

// ───────────────────────────────────────────────────────────────────────────
describe("a chamada da RPC", () => {
  it("🔴 UMA vez, com o nome e os 16 argumentos certos", async () => {
    const chamadas = duplo();
    await editDraftQuote(QUOTE, entrada({
      visitId: VISITA,
      pricingKind: "mensal",
      discountPct: 10,
      applyVat: false,
      proposedFrequency: "3× por semana",
      paymentTerms: "30 dias",
      notes: "para o cliente",
      internalNotes: "margem apertada",
    }));

    expect(chamadas.rpc).toHaveLength(1);
    expect(chamadas.rpc[0].nome).toBe("edit_crm_quote_draft");

    const args = chamadas.rpc[0].args;
    expect(Object.keys(args).sort()).toEqual([
      "p_actor", "p_apply_vat", "p_company_id", "p_discount_pct",
      "p_expected_updated_at", "p_internal_notes", "p_issue_date", "p_items",
      "p_notes", "p_payment_terms", "p_pricing_kind", "p_proposed_frequency",
      "p_quote_id", "p_valid_until", "p_vat_rate", "p_visit_id",
    ]);
    expect(args.p_quote_id).toBe(QUOTE);
    expect(args.p_visit_id).toBe(VISITA);
    expect(args.p_pricing_kind).toBe("mensal");
    expect(args.p_discount_pct).toBe(10);
    expect(args.p_apply_vat).toBe(false);
    expect(args.p_proposed_frequency).toBe("3× por semana");
    expect(args.p_payment_terms).toBe("30 dias");
    expect(args.p_notes).toBe("para o cliente");
    expect(args.p_internal_notes).toBe("margem apertada");
    expect(args.p_items).toEqual([
      { description: "Limpeza", quantity: 2, unit: "hora", unit_price: 50 },
    ]);
  });

  it("🔴 NÃO envia proposed_weekdays — a 105 não toca nesse campo", async () => {
    const chamadas = duplo();
    await editDraftQuote(QUOTE, entrada({ proposedWeekdays: [1, 2, 3] }) as never);
    expect(Object.keys(chamadas.rpc[0].args)).not.toContain("p_proposed_weekdays");
  });

  it("a visita ausente vai como null", async () => {
    const chamadas = duplo();
    await editDraftQuote(QUOTE, entrada({ visitId: null }));
    expect(chamadas.rpc[0].args.p_visit_id).toBeNull();
  });
});

// ───────────────────────────────────────────────────────────────────────────
describe("🔴 as sentinelas da 105 chegam traduzidas", () => {
  const CASOS: Array<[string, string, RegExp]> = [
    ["QUOTE_DRAFT_STALE: mudou", "CONFLICT", /alterado entretanto|[Rr]ecarregue/],
    ["QUOTE_NOT_DRAFT: estado enviado", "CONFLICT", /já não está em rascunho/],
    ["QUOTE_ALREADY_SUPERSEDED: x", "CONFLICT", /revisão mais recente/],
    ["QUOTE_DRAFT_STATE_DIVERGED: x", "CONFLICT", /inconsistente/],
    ["QUOTE_DRAFT_YEAR_IMMUTABLE: x", "BUSINESS_RULE", /ano do número/],
    ["QUOTE_VISIT_MISMATCH: x", "BUSINESS_RULE", /visita/i],
    ["QUOTE_AMOUNT_OVERFLOW: x", "BUSINESS_RULE", /./],
    ["QUOTE_ITEM_QUANTITY_INVALID: x", "BUSINESS_RULE", /quantidade/i],
    ["QUOTE_VAT_RATE_INVALID: x", "BUSINESS_RULE", /IVA/],
  ];

  for (const [mensagem, code, frase] of CASOS) {
    it(`${mensagem.split(":")[0]} → ${code}`, async () => {
      duplo({ rpc: () => ({ data: null, error: { message: mensagem } }) });
      const res = await editDraftQuote(QUOTE, entrada());

      expect(res.ok).toBe(false);
      if (!res.ok) {
        expect(res.error.code).toBe(code);
        expect(res.error.message).toMatch(frase);
        // 🔴 Nunca a sentinela crua nem SQL no ecrã.
        expect(res.error.message).not.toContain("QUOTE_");
        expect(res.error.message).not.toMatch(/SELECT|UPDATE|INSERT|pg_|relation/);
      }
      expect(auditoriasDeEdicao()).toBe(0);
      expect(invalidateBusinessState).not.toHaveBeenCalled();
    });
  }

  it("🔴 um erro desconhecido não expõe o texto cru", async () => {
    duplo({
      rpc: () => ({
        data: null,
        error: { message: 'ERROR: relation "crm_quotes" violates constraint xyz' },
      }),
    });
    const res = await editDraftQuote(QUOTE, entrada());

    expect(res.ok).toBe(false);
    if (!res.ok) {
      expect(res.error.code).toBe("PERSISTENCE");
      expect(res.error.message).not.toContain("crm_quotes");
      expect(res.error.message).not.toContain("constraint");
    }
  });

  it("🔴 EXPECTED_UPDATED_AT_REQUIRED cai no genérico, sem culpar o utilizador", async () => {
    // A UI nunca chega aqui: o Zod já exigiu o token. Se aparecer, é defeito
    // do nosso lado — dizer «faltou o updated_at» seria culpar quem não errou.
    duplo({
      rpc: () => ({
        data: null,
        error: { message: "QUOTE_DRAFT_EXPECTED_UPDATED_AT_REQUIRED: x" },
      }),
    });
    const res = await editDraftQuote(QUOTE, entrada());

    expect(res.ok).toBe(false);
    if (!res.ok) {
      expect(res.error.code).toBe("PERSISTENCE");
      expect(res.error.message).not.toContain("updated_at");
    }
  });
});

// ───────────────────────────────────────────────────────────────────────────
describe("🔴 a resposta da RPC é validada por inteiro", () => {
  const INCOMPLETAS: Array<[string, unknown]> = [
    ["sem quote_id", [{ quote_number: "ORC2026/007", updated_at: "2026-09-24T14:00:00Z" }]],
    ["sem quote_number", [{ quote_id: QUOTE, updated_at: "2026-09-24T14:00:00Z" }]],
    ["sem updated_at", [{ quote_id: QUOTE, quote_number: "ORC2026/007" }]],
    ["quote_id que não é uuid", [{ quote_id: "x", quote_number: "N", updated_at: "t" }]],
    ["array vazio", []],
    ["null", null],
  ];

  for (const [nome, data] of INCOMPLETAS) {
    it(`🔴 ${nome}: PERSISTENCE, sem auditar nem invalidar`, async () => {
      duplo({ rpc: () => ({ data, error: null }) });
      const res = await editDraftQuote(QUOTE, entrada());

      expect(res.ok).toBe(false);
      if (!res.ok) expect(res.error.code).toBe("PERSISTENCE");
      expect(auditoriasDeEdicao()).toBe(0);
      expect(invalidateBusinessState).not.toHaveBeenCalled();
    });
  }
});

// ───────────────────────────────────────────────────────────────────────────
describe("o sucesso", () => {
  it("🔴 devolve id, número e o updated_at NOVO", async () => {
    duplo();
    const res = await editDraftQuote(QUOTE, entrada());

    expect(res.ok).toBe(true);
    if (res.ok) {
      expect(res.data.id).toBe(QUOTE);
      expect(res.data.quoteNumber).toBe("ORC2026/007");
      // 🔴 O token NOVO, para quem quiser continuar a editar sem recarregar.
      expect(res.data.updatedAt).toBe("2026-09-24T14:00:00.987654+00:00");
      expect(res.data.updatedAt).not.toBe(TOKEN);
    }
  });

  it("🔴 audita UMA vez, no mesmo documento", async () => {
    duplo();
    await editDraftQuote(QUOTE, entrada());

    expect(auditoriasDeEdicao()).toBe(1);
    const evento = auditLog.mock.calls[0][0] as Record<string, unknown>;
    expect(evento.action).toBe("crm_quote_draft_edited");
    expect(evento.entityType).toBe("crm_quote");
    // 🔴 O MESMO id: a edição não cria documento novo.
    expect(evento.entityId).toBe(QUOTE);
    expect(evento.companyId).toBe(EMPRESA);
    expect(evento.actorId).toBe(ACTOR);
  });

  it("🔴 a auditoria não leva o payload inteiro", async () => {
    duplo();
    await editDraftQuote(QUOTE, entrada({ internalNotes: "MARGEM SECRETA" }));

    const evento = auditLog.mock.calls[0][0] as { after?: Record<string, unknown> };
    expect(JSON.stringify(evento.after)).not.toContain("MARGEM SECRETA");
    expect(evento.after).toEqual({ quote_number: "ORC2026/007", itens: 1 });
  });

  it("invalida o estado de negócio", async () => {
    duplo();
    await editDraftQuote(QUOTE, entrada());
    expect(invalidateBusinessState).toHaveBeenCalledTimes(1);
  });

  it("🔴 NÃO escreve na timeline da lead", async () => {
    // Corrigir um rascunho é autoria de um documento que ainda não saiu, não é
    // um evento comercial. Uma linha por cada gralha afogava o que importa.
    const chamadas = duplo();
    await editDraftQuote(QUOTE, entrada());

    expect(chamadas.selects.map((s) => s.tabela)).not.toContain("crm_lead_interactions");
    for (const c of auditLog.mock.calls) {
      expect((c[0] as { entityType?: string }).entityType).not.toBe("crm_lead");
    }
  });
});

// ============================================================================
// As Server Actions de orçamentos — comportamento, não leitura de strings
// ============================================================================
//
// Corre as actions a sério, com o guard e o cliente de base substituídos por
// duplos que registam o que foi chamado. É o que permite provar duas coisas
// que nenhum ensaio estático prova:
//
//   1. um valor fora do domínio decimal NÃO CHEGA À RPC. Um guard textual
//      mostraria que o `refine` está escrito; só a execução mostra que ele
//      dispara antes da chamada;
//
//   2. a timeline da lead é escrita a partir de `source_lead_id` LIDO DA
//      LINHA, e que uma falha a escrevê-la não transforma uma RPC bem
//      sucedida em erro.
//
// 🔴 Os valores de 0,000000051 e 0,000001051 não são inventados: são os casos
//    em que `round()` do Postgres e a aritmética do runtime divergem, porque a
//    sétima casa desaparece na escala 1e-6.
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

const { createQuote, reviseQuote, setQuoteStatus } = await import("@/app/actions/crm-orcamentos");

const EMPRESA = "11111111-1111-4111-8111-111111111111";
const ACTOR = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const LEAD = "22222222-2222-4222-8222-222222222222";
const QUOTE = "33333333-3333-4333-8333-333333333333";
const NOVA = "44444444-4444-4444-8444-444444444444";

interface Chamadas {
  rpc: { nome: string; args: Record<string, unknown> }[];
  inserts: { tabela: string; linha: Record<string, unknown> }[];
  selects: { tabela: string; cols: string }[];
}

/** O que cada leitura devolve. Ajustado por ensaio. */
interface Respostas {
  settings?: Record<string, unknown> | null;
  lead?: Record<string, unknown> | null;
  quote?: Record<string, unknown> | null;
  quoteErro?: { message: string } | null;
  rpc?: (nome: string) => { data: unknown; error: { message: string } | null };
  insertErro?: { message: string } | null;
  insertLanca?: boolean;
}

function duplo(r: Respostas) {
  const chamadas: Chamadas = { rpc: [], inserts: [], selects: [] };

  const builder = (tabela: string) => {
    const api = {
      select: (cols: string) => {
        chamadas.selects.push({ tabela, cols });
        return api;
      },
      eq: () => api,
      in: () => api,
      is: () => api,
      order: () => api,
      maybeSingle: async () => {
        if (tabela === "company_settings") return { data: r.settings ?? null, error: null };
        if (tabela === "crm_leads" || tabela === "clients") return { data: r.lead ?? { id: LEAD }, error: null };
        if (tabela === "crm_quotes") {
          return { data: r.quote ?? null, error: r.quoteErro ?? null };
        }
        return { data: null, error: null };
      },
      insert: async (linha: Record<string, unknown>) => {
        chamadas.inserts.push({ tabela, linha });
        if (r.insertLanca) throw new Error("rede em baixo");
        return { error: r.insertErro ?? null };
      },
    };
    return api;
  };

  const admin = {
    from: builder,
    rpc: async (nome: string, args: Record<string, unknown>) => {
      chamadas.rpc.push({ nome, args });
      return r.rpc
        ? r.rpc(nome)
        : { data: [{ quote_id: NOVA, quote_number: "ORC2026/001-R1", status: "enviado" }], error: null };
    },
  };

  requireProfile.mockResolvedValue({
    ok: true,
    admin,
    profile: { id: ACTOR, company_id: EMPRESA },
  });

  return chamadas;
}

const ITEM_OK = { description: "Limpeza", quantity: 1, unit: "servico" as const, unitPrice: 100 };

const CRIAR_BASE = {
  leadId: LEAD,
  clientId: null,
  visitId: null,
  issueDate: "2026-09-22",
  validUntil: "2026-10-22",
  pricingKind: "pontual" as const,
  items: [ITEM_OK],
};

const REVER_BASE = {
  issueDate: "2026-09-22",
  validUntil: "2026-10-22",
  items: [ITEM_OK],
};

beforeEach(() => {
  vi.clearAllMocks();
});

// ───────────────────────────────────────────────────────────────────────────
describe("🔴 domínio decimal — o valor fora do domínio não chega à RPC", () => {
  const FORA = [0.000000051, 0.000001051, 1.1234567, 0.0000001];
  const DENTRO = [1, 1.2, 1.123456, 0.000001];

  for (const preco of FORA) {
    it(`preço ${preco}: recusado, e a RPC nunca é chamada`, async () => {
      const chamadas = duplo({ settings: { vat_rate: 23, quote_prefix: "ORC" } });

      const res = await createQuote({
        ...CRIAR_BASE,
        items: [{ ...ITEM_OK, quantity: 100_000, unitPrice: preco }],
      });

      expect(res.ok).toBe(false);
      expect(chamadas.rpc).toHaveLength(0);
      if (!res.ok) expect(res.error.code).toBe("VALIDATION");
    });
  }

  for (const qtd of FORA) {
    it(`quantidade ${qtd}: recusada, e a RPC nunca é chamada`, async () => {
      const chamadas = duplo({ settings: { vat_rate: 23, quote_prefix: "ORC" } });

      const res = await createQuote({
        ...CRIAR_BASE,
        items: [{ ...ITEM_OK, quantity: qtd }],
      });

      expect(res.ok).toBe(false);
      expect(chamadas.rpc).toHaveLength(0);
    });
  }

  it("desconto com sete casas: recusado", async () => {
    const chamadas = duplo({ settings: { vat_rate: 23, quote_prefix: "ORC" } });
    const res = await createQuote({ ...CRIAR_BASE, discountPct: 1.1234567 });
    expect(res.ok).toBe(false);
    expect(chamadas.rpc).toHaveLength(0);
  });

  it("🔴 a revisão tem o mesmo domínio — não é porta de trás", async () => {
    const chamadas = duplo({ settings: { vat_rate: 23 } });

    const res = await reviseQuote(QUOTE, {
      ...REVER_BASE,
      items: [{ ...ITEM_OK, quantity: 100_000, unitPrice: 0.000000051 }],
    });

    expect(res.ok).toBe(false);
    expect(chamadas.rpc).toHaveLength(0);
  });

  it("desconto da revisão com sete casas: recusado", async () => {
    const chamadas = duplo({ settings: { vat_rate: 23 } });
    const res = await reviseQuote(QUOTE, { ...REVER_BASE, discountPct: 0.0000001 });
    expect(res.ok).toBe(false);
    expect(chamadas.rpc).toHaveLength(0);
  });

  for (const preco of DENTRO) {
    it(`preço ${preco}: aceite, e chega à RPC`, async () => {
      const chamadas = duplo({
        settings: { vat_rate: 23, quote_prefix: "ORC" },
        rpc: () => ({ data: [{ quote_id: NOVA, quote_number: "ORC2026/001" }], error: null }),
      });

      const res = await createQuote({
        ...CRIAR_BASE,
        items: [{ ...ITEM_OK, quantity: 100_000, unitPrice: preco }],
      });

      expect(res.ok).toBe(true);
      expect(chamadas.rpc).toHaveLength(1);
      expect(chamadas.rpc[0].nome).toBe("create_crm_quote_with_items");
      const itens = chamadas.rpc[0].args.p_items as { unit_price: number }[];
      expect(itens[0].unit_price).toBe(preco);
    });
  }

  it("a mensagem diz quantas casas são", async () => {
    duplo({ settings: { vat_rate: 23, quote_prefix: "ORC" } });
    const res = await createQuote({
      ...CRIAR_BASE,
      items: [{ ...ITEM_OK, unitPrice: 0.0000001 }],
    });
    expect(res.ok).toBe(false);
    if (!res.ok) {
      const texto = JSON.stringify(res.error);
      expect(texto).toContain("6 casas decimais");
    }
  });
});

// ───────────────────────────────────────────────────────────────────────────
describe("🔴 timeline da lead — pela proveniência, e best-effort", () => {
  const QUOTE_LIDO = { source_lead_id: LEAD, quote_number: "ORC2026/001-R1" };

  it("CREATE regista na lead de origem", async () => {
    const chamadas = duplo({
      settings: { vat_rate: 23, quote_prefix: "ORC" },
      rpc: () => ({ data: [{ quote_id: NOVA, quote_number: "ORC2026/001" }], error: null }),
    });

    const res = await createQuote(CRIAR_BASE);

    expect(res.ok).toBe(true);
    const linha = chamadas.inserts.find((i) => i.tabela === "crm_lead_interactions");
    expect(linha).toBeDefined();
    expect(linha!.linha.lead_id).toBe(LEAD);
    expect(String(linha!.linha.summary)).toContain("ORC2026/001");
  });

  it("🔴 REVISE regista, e lê a proveniência da linha NOVA", async () => {
    const chamadas = duplo({
      settings: { vat_rate: 23 },
      quote: QUOTE_LIDO,
      rpc: () => ({ data: [{ quote_id: NOVA, quote_number: "ORC2026/001-R1" }], error: null }),
    });

    const res = await reviseQuote(QUOTE, REVER_BASE);

    expect(res.ok).toBe(true);
    // Leu `crm_quotes` para descobrir a lead — e leu a coluna certa.
    const leitura = chamadas.selects.find((s) => s.tabela === "crm_quotes");
    expect(leitura).toBeDefined();
    expect(leitura!.cols).toContain("source_lead_id");
    // 🔴 `lead_id` como COLUNA, e não como sufixo de `source_lead_id` — um
    //    `not.toContain("lead_id")` seria sempre falso e o ensaio nunca
    //    apanharia a regressão que existe para apanhar.
    expect(leitura!.cols).not.toMatch(/(^|[\s,])lead_id(\s|,|$)/);

    const linha = chamadas.inserts.find((i) => i.tabela === "crm_lead_interactions");
    expect(linha).toBeDefined();
    expect(linha!.linha.lead_id).toBe(LEAD);
    expect(String(linha!.linha.summary)).toContain("ORC2026/001-R1");
    expect(String(linha!.linha.summary)).toContain("revisão");
  });

  it("🔴 STATUS regista, com o estado por extenso", async () => {
    const chamadas = duplo({
      quote: { source_lead_id: LEAD, quote_number: "ORC2026/001" },
      rpc: () => ({ data: [{ quote_id: QUOTE, status: "aceite" }], error: null }),
    });

    const res = await setQuoteStatus(QUOTE, { status: "aceite" });

    expect(res.ok).toBe(true);
    const linha = chamadas.inserts.find((i) => i.tabela === "crm_lead_interactions");
    expect(linha).toBeDefined();
    expect(String(linha!.linha.summary)).toBe("Orçamento ORC2026/001: aceite.");
  });

  for (const estado of ["enviado", "recusado", "expirado", "anulado"] as const) {
    it(`STATUS ${estado} também entra na timeline`, async () => {
      const chamadas = duplo({
        quote: { source_lead_id: LEAD, quote_number: "ORC2026/001" },
        rpc: () => ({ data: [{ quote_id: QUOTE, status: estado }], error: null }),
      });

      await setQuoteStatus(QUOTE, { status: estado });

      const linha = chamadas.inserts.find((i) => i.tabela === "crm_lead_interactions");
      expect(linha, `${estado} não foi registado`).toBeDefined();
      expect(String(linha!.linha.summary)).toContain(estado);
    });
  }

  it("🔴 orçamento sem lead de origem: não inventa uma", async () => {
    // Nasceu de um cliente que já existia. Não há lead nenhuma a quem contar
    // a história, e inventar uma seria pior do que o silêncio.
    const chamadas = duplo({
      quote: { source_lead_id: null, quote_number: "ORC2026/002" },
      rpc: () => ({ data: [{ quote_id: QUOTE, status: "enviado" }], error: null }),
    });

    const res = await setQuoteStatus(QUOTE, { status: "enviado" });

    expect(res.ok).toBe(true);
    expect(chamadas.inserts.filter((i) => i.tabela === "crm_lead_interactions")).toHaveLength(0);
  });

  it("🔴 falhar a escrever a timeline NÃO desfaz a operação", async () => {
    // `crm_lead_interactions` é projecção derivada. A fonte autoritativa é
    // `crm_quotes`, e a RPC já correu: devolver erro aqui faria a interface
    // dizer que nada aconteceu, quando o estado mudou mesmo.
    const chamadas = duplo({
      quote: QUOTE_LIDO,
      insertErro: { message: "permission denied" },
      rpc: () => ({ data: [{ quote_id: QUOTE, status: "enviado" }], error: null }),
    });

    const res = await setQuoteStatus(QUOTE, { status: "enviado" });

    expect(res.ok).toBe(true);
    if (res.ok) expect(res.data.status).toBe("enviado");
    expect(chamadas.inserts).toHaveLength(1);
  });

  it("🔴 uma excepção a escrever a timeline também não desfaz", async () => {
    duplo({
      quote: QUOTE_LIDO,
      insertLanca: true,
      rpc: () => ({ data: [{ quote_id: QUOTE, status: "enviado" }], error: null }),
    });

    const res = await setQuoteStatus(QUOTE, { status: "enviado" });
    expect(res.ok).toBe(true);
  });

  it("🔴 falhar a LER a proveniência também não desfaz", async () => {
    const chamadas = duplo({
      quoteErro: { message: "timeout" },
      rpc: () => ({ data: [{ quote_id: QUOTE, status: "enviado" }], error: null }),
    });

    const res = await setQuoteStatus(QUOTE, { status: "enviado" });

    expect(res.ok).toBe(true);
    expect(chamadas.inserts.filter((i) => i.tabela === "crm_lead_interactions")).toHaveLength(0);
  });

  it("a RPC falhada não escreve timeline nenhuma", async () => {
    const chamadas = duplo({
      quote: QUOTE_LIDO,
      rpc: () => ({ data: null, error: { message: "QUOTE_TRANSITION_NOT_ALLOWED: enviado -> aceite" } }),
    });

    const res = await setQuoteStatus(QUOTE, { status: "aceite" });

    expect(res.ok).toBe(false);
    expect(chamadas.inserts.filter((i) => i.tabela === "crm_lead_interactions")).toHaveLength(0);
  });
});

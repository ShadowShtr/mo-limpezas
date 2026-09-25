// @vitest-environment jsdom
// ============================================================================
// Editar um rascunho — o formulário e o botão, montados a sério
// ============================================================================
//
// Monta `QuoteSheet` em `mode="edit-draft"` e `QuoteDetailSheet` com react-dom.
// O que se prova aqui não se prova lendo strings:
//
//   🔴 o TOKEN chega à action exactamente como veio da base. Trocar
//      `base.quote.updated_at` por `new Date(...).toISOString()` deixa o
//      ensaio central vermelho — medido por mutação;
//
//   · o formulário abre com o documento PERSISTIDO, campo a campo;
//   · a pré-visualização usa o IVA do rascunho, não o das definições;
//   · o destinatário vê-se e não se troca;
//   · um `QUOTE_DRAFT_STALE` NÃO fecha o formulário — o trabalho da pessoa
//     fica à frente dela;
//   · editar chama `editDraftQuote`; rever continua a chamar `reviseQuote`.
// ============================================================================

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";

const createQuote = vi.fn();
const reviseQuote = vi.fn();
const editDraftQuote = vi.fn();
const getQuote = vi.fn();
const setQuoteStatus = vi.fn();
const convertAcceptedQuote = vi.fn();
const toast = vi.fn();

vi.mock("@/app/actions/crm-orcamentos", () => ({
  createQuote: (...a: unknown[]) => createQuote(...a),
  reviseQuote: (...a: unknown[]) => reviseQuote(...a),
  editDraftQuote: (...a: unknown[]) => editDraftQuote(...a),
  getQuote: (...a: unknown[]) => getQuote(...a),
  setQuoteStatus: (...a: unknown[]) => setQuoteStatus(...a),
}));
vi.mock("@/app/actions/crm-conversao", () => ({
  convertAcceptedQuote: (...a: unknown[]) => convertAcceptedQuote(...a),
}));
vi.mock("@/components/ui/toast", () => ({ useToast: () => ({ toast }) }));
vi.mock("next/navigation", () => ({ useRouter: () => ({ push: vi.fn() }) }));

const { QuoteSheet } = await import(
  "@/app/(dashboard)/dashboard/crm/orcamentos/_components/quote-sheet"
);
const { QuoteDetailSheet } = await import(
  "@/app/(dashboard)/dashboard/crm/orcamentos/_components/quote-detail-sheet"
);

const QUOTE = "11111111-1111-4111-8111-111111111111";
const LEAD = "22222222-2222-4222-8222-222222222222";
const VISITA = "33333333-3333-4333-8333-333333333333";

/**
 * 🔴 O token com MICROSSEGUNDOS e offset explícito, como o PostgREST entrega.
 *
 *    `new Date(TOKEN).toISOString()` dá `2026-09-24T13:05:54.123Z` — perde os
 *    `456`. É essa diferença que os ensaios abaixo medem.
 */
const TOKEN = "2026-09-24T13:05:54.123456+00:00";

/** Um rascunho vivo, com tudo preenchido, para se ver o que é pré-carregado. */
function rascunho(over: Record<string, unknown> = {}) {
  return {
    quote: {
      id: QUOTE,
      quote_number: "ORC2026/007",
      quote_year: 2026,
      quote_seq: 7,
      revision: 0,
      root_quote_id: QUOTE,
      superseded_by_id: null,
      lead_id: LEAD,
      client_id: null,
      source_lead_id: LEAD,
      visit_id: VISITA,
      target_name: "Condomínio Alfa",
      issue_date: "2026-03-10",
      valid_until: "2026-04-09",
      status: "rascunho",
      sent_at: null,
      accepted_at: null,
      rejected_at: null,
      rejection_reason: null,
      pricing_kind: "mensal",
      subtotal: 300,
      discount_pct: 12.5,
      apply_vat: true,
      // 🔴 6%, e NÃO os 23% que a página passa como taxa das definições.
      vat_rate: 6,
      vat_amount: 15.75,
      total: 278.25,
      proposed_frequency: "3× por semana",
      payment_terms: "30 dias",
      proposed_weekdays: null,
      notes: "Inclui produtos.",
      internal_notes: "margem apertada",
      created_at: "2026-03-10T09:00:00.000Z",
      updated_at: TOKEN,
      ...over,
    },
    items: [
      {
        id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
        position: 0,
        description: "Limpeza de escadas",
        quantity: 3,
        unit: "hora",
        unit_price: 100,
        line_total: 300,
      },
    ],
  };
}

const VISITAS = [
  { id: VISITA, lead_id: LEAD, client_id: null, scheduled_start: "2026-03-01T09:00:00.000Z",
    status: "realizada", area_sqm: 120 },
];

let container: HTMLDivElement;
let root: Root;

beforeEach(() => {
  vi.clearAllMocks();
  editDraftQuote.mockResolvedValue({
    ok: true,
    data: { id: QUOTE, quoteNumber: "ORC2026/007", updatedAt: "2026-09-24T14:00:00.987654+00:00" },
  });
  reviseQuote.mockResolvedValue({ ok: true, data: { id: "novo", quoteNumber: "ORC2026/007-R1" } });
  getQuote.mockResolvedValue({ ok: true, data: rascunho() });
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
});

/* eslint-disable @typescript-eslint/no-explicit-any */
function montarEdicao(over: Record<string, unknown> = {}) {
  const base = rascunho(over);
  act(() => {
    root.render(
      <QuoteSheet
        leads={[{ id: LEAD, name: "Condomínio Alfa" }] as any}
        clientes={[]}
        visitas={VISITAS as any}
        // 🔴 23% aqui de propósito: é a taxa das DEFINIÇÕES, e a edição não a
        //    pode usar. O rascunho tem 6%.
        vatRate={23}
        mode="edit-draft"
        base={base as any}
        onClose={() => {}}
        onDone={() => {}}
      />,
    );
  });
  return base;
}

function montarDetalhe(over: Record<string, unknown> = {}, onEditDraft = vi.fn()) {
  const base = rascunho(over);
  getQuote.mockResolvedValue({ ok: true, data: base });
  act(() => {
    root.render(
      <QuoteDetailSheet
        orcamento={base.quote as any}
        empresaNome="Mo Limpezas"
        onClose={() => {}}
        onChanged={() => {}}
        onRevise={() => {}}
        onEditDraft={onEditDraft}
      />,
    );
  });
  return onEditDraft;
}
/* eslint-enable @typescript-eslint/no-explicit-any */

const valorDe = (rotulo: RegExp): string => {
  const campo = [...document.querySelectorAll("label")]
    .find((l) => rotulo.test(l.textContent ?? ""))
    ?.querySelector("input, select, textarea") as HTMLInputElement | undefined;
  return campo?.value ?? "";
};

const botao = (texto: string) =>
  [...document.querySelectorAll("button")].find((b) => b.textContent?.includes(texto));

async function guardar() {
  const b = botao("Guardar alterações")!;
  await act(async () => { b.click(); });
}

// ───────────────────────────────────────────────────────────────────────────
describe("🔴 o token de concorrência", () => {
  it("🔴 chega à action EXACTAMENTE como veio da base", async () => {
    // 🔴 O ensaio que a ordem manda fixar. Substituir
    //    `expectedUpdatedAt: base!.quote.updated_at` por
    //    `new Date(base!.quote.updated_at).toISOString()` fá-lo ficar vermelho.
    montarEdicao();
    await guardar();

    expect(editDraftQuote).toHaveBeenCalledTimes(1);
    const [id, input] = editDraftQuote.mock.calls[0] as [string, Record<string, unknown>];
    expect(id).toBe(QUOTE);
    expect(input.expectedUpdatedAt).toBe(TOKEN);
    expect(String(input.expectedUpdatedAt)).toContain(".123456");
    expect(input.expectedUpdatedAt).not.toBe(new Date(TOKEN).toISOString());
  });

  it("🔴 um token truncado ao milissegundo seria OUTRO valor", () => {
    // Não é um ensaio do componente: é a prova de que a diferença existe e que
    // o ensaio acima mede alguma coisa. Sem isto, alguém poderia pensar que
    // `new Date(...)` é inofensivo aqui.
    expect(new Date(TOKEN).toISOString()).not.toBe(TOKEN);
    expect(new Date(TOKEN).toISOString()).toBe("2026-09-24T13:05:54.123Z");
  });
});

// ───────────────────────────────────────────────────────────────────────────
describe("🔴 o formulário abre com o documento persistido", () => {
  it("datas, tipo, desconto, frequência, condições e notas", () => {
    montarEdicao();

    expect(valorDe(/Data de emissão|Emissão/)).toBe("2026-03-10");
    expect(valorDe(/Válido até|Validade/)).toBe("2026-04-09");
    expect(valorDe(/^\s*Tipo/)).toBe("mensal");
    expect(valorDe(/Desconto/)).toBe("12.5");
    expect(valorDe(/Frequência/)).toBe("3× por semana");
    expect(valorDe(/Condições/)).toBe("30 dias");
    expect(document.body.textContent).toContain("Inclui produtos.");
    expect(document.body.textContent).toContain("margem apertada");
  });

  it("a visita vem pré-seleccionada", () => {
    montarEdicao();
    expect(valorDe(/Visita/)).toBe(VISITA);
  });

  it("as linhas vêm pré-carregadas", () => {
    montarEdicao();
    expect(document.body.innerHTML).toContain("Limpeza de escadas");
    const quantidades = [...document.querySelectorAll("input")].map((i) => i.value);
    expect(quantidades).toContain("3");
    expect(quantidades).toContain("100");
  });

  it("🔴 as datas NÃO são as de hoje — é o mesmo documento", () => {
    montarEdicao();
    const hoje = new Date().toISOString().slice(0, 10);
    expect(valorDe(/Data de emissão|Emissão/)).not.toBe(hoje);
  });

  it("o título diz que é uma edição, não uma revisão", () => {
    montarEdicao();
    expect(document.body.textContent).toContain("Editar ORC2026/007");
    expect(document.body.textContent).not.toContain("Revisão de");
  });
});

// ───────────────────────────────────────────────────────────────────────────
describe("🔴 o destinatário vê-se, mas não se troca", () => {
  it("aparece o nome, e não há selector de lead nem de cliente", () => {
    montarEdicao();

    expect(document.body.textContent).toContain("Condomínio Alfa");
    const selects = [...document.querySelectorAll("select")];
    const opcoes = selects.flatMap((s) => [...s.options].map((o) => o.textContent ?? ""));
    expect(opcoes.some((o) => o.includes("Escolha a lead"))).toBe(false);
    expect(opcoes.some((o) => o.includes("Escolha o cliente"))).toBe(false);
    expect(document.querySelector('input[name="alvo-orcamento"]')).toBeNull();
  });

  it("o input enviado não leva destinatário nenhum", async () => {
    montarEdicao();
    await guardar();

    const input = editDraftQuote.mock.calls[0][1] as Record<string, unknown>;
    for (const k of ["leadId", "clientId", "sourceLeadId", "quoteNumber", "revision", "vatRate"]) {
      expect(Object.keys(input), `o formulário enviou ${k}`).not.toContain(k);
    }
  });
});

// ───────────────────────────────────────────────────────────────────────────
describe("🔴 a pré-visualização usa o IVA do rascunho", () => {
  it("🔴 6% do documento, e não os 23% das definições", () => {
    montarEdicao();

    // 3 × 100 = 300 ; desconto 12,5 % → 262,50 ; IVA 6 % = 15,75 ; total 278,25
    const texto = document.body.textContent ?? "";
    expect(texto).toContain("278,25");
    // Com 23% o total seria 322,88 — se aparecer, a previsão usou a taxa errada.
    expect(texto).not.toContain("322,88");
  });
});

// ───────────────────────────────────────────────────────────────────────────
describe("🔴 STALE não fecha o formulário", () => {
  it("🔴 o erro aparece e o trabalho fica à frente da pessoa", async () => {
    const onDone = vi.fn();
    editDraftQuote.mockResolvedValue({
      ok: false,
      error: {
        code: "CONFLICT",
        message: "Este rascunho foi alterado entretanto. Recarregue-o antes de guardar as suas alterações.",
      },
    });

    const base = rascunho();
    /* eslint-disable @typescript-eslint/no-explicit-any */
    act(() => {
      root.render(
        <QuoteSheet
          leads={[{ id: LEAD, name: "Condomínio Alfa" }] as any}
          clientes={[]}
          visitas={VISITAS as any}
          vatRate={23}
          mode="edit-draft"
          base={base as any}
          onClose={() => {}}
          onDone={onDone}
        />,
      );
    });
    /* eslint-enable @typescript-eslint/no-explicit-any */

    await guardar();

    expect(toast).toHaveBeenCalledWith(
      expect.stringContaining("alterado entretanto"), "error");
    // 🔴 `onDone` é o que fecha o formulário em quem o monta. Não foi chamado.
    expect(onDone).not.toHaveBeenCalled();
    // E o formulário continua montado, com o documento lá dentro.
    expect(document.body.textContent).toContain("Editar ORC2026/007");
    expect(document.body.innerHTML).toContain("Limpeza de escadas");
  });

  it("🔴 NÃO há retry automático com um token novo", async () => {
    editDraftQuote.mockResolvedValue({
      ok: false, error: { code: "CONFLICT", message: "Este rascunho foi alterado entretanto." },
    });
    montarEdicao();
    await guardar();

    // Um retry automático transformaria a concorrência optimista outra vez em
    // last-write-wins — que é exactamente o defeito que a 105 fechou.
    expect(editDraftQuote).toHaveBeenCalledTimes(1);
  });

  it("no sucesso, o onDone é chamado com o número", async () => {
    const onDone = vi.fn();
    const base = rascunho();
    /* eslint-disable @typescript-eslint/no-explicit-any */
    act(() => {
      root.render(
        <QuoteSheet
          leads={[] as any}
          clientes={[]}
          visitas={VISITAS as any}
          vatRate={23}
          mode="edit-draft"
          base={base as any}
          onClose={() => {}}
          onDone={onDone}
        />,
      );
    });
    /* eslint-enable @typescript-eslint/no-explicit-any */

    await guardar();
    expect(onDone).toHaveBeenCalledWith("ORC2026/007");
  });
});

// ───────────────────────────────────────────────────────────────────────────
describe("🔴 cada modo chama a sua action", () => {
  it("editar chama editDraftQuote, e não reviseQuote nem createQuote", async () => {
    montarEdicao();
    await guardar();

    expect(editDraftQuote).toHaveBeenCalledTimes(1);
    expect(reviseQuote).not.toHaveBeenCalled();
    expect(createQuote).not.toHaveBeenCalled();
  });
});

// ───────────────────────────────────────────────────────────────────────────
describe("🔴 o botão no detalhe", () => {
  it("🔴 aparece num rascunho vivo", () => {
    montarDetalhe();
    expect(botao("Editar rascunho")).toBeDefined();
  });

  for (const status of ["enviado", "aceite", "recusado", "expirado", "anulado"]) {
    it(`🔴 NÃO aparece em ${status}`, () => {
      montarDetalhe({ status, sent_at: "2026-03-11T09:00:00.000Z" });
      expect(botao("Editar rascunho")).toBeUndefined();
    });
  }

  it("🔴 NÃO aparece num rascunho SUBSTITUÍDO", () => {
    montarDetalhe({ superseded_by_id: "99999999-9999-4999-8999-999999999999" });
    expect(botao("Editar rascunho")).toBeUndefined();
  });

  it("🔴 num rascunho não se oferece «Criar revisão»", () => {
    // Rever e editar são operações distintas; um rascunho não se revê.
    montarDetalhe();
    expect(botao("Criar revisão")).toBeUndefined();
  });

  it("🔴 entrega o documento da leitura FRESCA, com o token", async () => {
    const onEditDraft = vi.fn();
    montarDetalhe({}, onEditDraft);
    // O detalhe carrega com `getQuote`; só depois o botão fica activo.
    await act(async () => { await Promise.resolve(); });

    const b = botao("Editar rascunho")!;
    expect(b.disabled).toBe(false);
    await act(async () => { b.click(); });

    expect(onEditDraft).toHaveBeenCalledTimes(1);
    const entregue = onEditDraft.mock.calls[0][0] as { quote: { updated_at: string } };
    expect(entregue.quote.updated_at).toBe(TOKEN);
  });
});

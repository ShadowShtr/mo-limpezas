// @vitest-environment jsdom
// ============================================================================
// O botão de converter — comportamento real, não leitura de strings
// ============================================================================
//
// Monta o detalhe do orçamento com react-dom + jsdom.
//
// 🔴 O ensaio central é o último: `ConfirmDialog` faz `await onConfirm()` e
//    fecha-se a seguir. Se a conversão fosse lançada com `startTransition`
//    (que devolve `void`), o `await` resolvia de imediato e o diálogo fechava
//    ANTES de a Action terminar — dando a impressão de que já estava feita.
//    Aqui a Action é segurada de propósito, e prova-se que a UI continua
//    ocupada enquanto ela não resolve.
// ============================================================================

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";

const convertAcceptedQuote = vi.fn();
const getQuote = vi.fn();
const setQuoteStatus = vi.fn();
const push = vi.fn();
const toast = vi.fn();

vi.mock("@/app/actions/crm-conversao", () => ({
  convertAcceptedQuote: (...a: unknown[]) => convertAcceptedQuote(...a),
}));
vi.mock("@/app/actions/crm-orcamentos", () => ({
  getQuote: (...a: unknown[]) => getQuote(...a),
  setQuoteStatus: (...a: unknown[]) => setQuoteStatus(...a),
}));
vi.mock("next/navigation", () => ({ useRouter: () => ({ push }) }));
vi.mock("@/components/ui/toast", () => ({ useToast: () => ({ toast }) }));

const { QuoteDetailSheet } = await import(
  "@/app/(dashboard)/dashboard/crm/orcamentos/_components/quote-detail-sheet"
);

const QUOTE = "33333333-3333-4333-8333-333333333333";
const LEAD = "22222222-2222-4222-8222-222222222222";
const CLIENTE = "44444444-4444-4444-8444-444444444444";
const LOCAL = "55555555-5555-4555-8555-555555555555";

/** Um orçamento aceite, vivo, ainda endereçado à lead. */
function orcamento(over: Record<string, unknown> = {}) {
  return {
    id: QUOTE,
    quote_number: "ORC2026/001",
    quote_year: 2026, quote_seq: 1, revision: 0,
    root_quote_id: QUOTE,
    superseded_by_id: null,
    lead_id: LEAD,
    client_id: null,
    source_lead_id: LEAD,
    visit_id: null,
    target_name: "Condominio Alfa",
    issue_date: "2026-09-01", valid_until: "2026-10-01",
    status: "aceite",
    sent_at: "2026-09-01T10:00:00.000Z",
    accepted_at: "2026-09-05T10:00:00.000Z",
    rejected_at: null, rejection_reason: null,
    pricing_kind: "pontual",
    subtotal: 100, discount_pct: 0, apply_vat: true, vat_rate: 23,
    vat_amount: 23, total: 123,
    proposed_frequency: null, proposed_weekdays: null,
    payment_terms: null, notes: null, internal_notes: null,
    created_at: "2026-09-01T10:00:00.000Z",
    ...over,
  };
}

let container: HTMLDivElement;
let root: Root;

beforeEach(() => {
  vi.clearAllMocks();
  getQuote.mockResolvedValue({ ok: true, data: { quote: orcamento(), items: [] } });
  convertAcceptedQuote.mockResolvedValue({
    ok: true, data: { clientId: CLIENTE, locationId: LOCAL, alreadyConverted: false },
  });
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
});

/* eslint-disable @typescript-eslint/no-explicit-any */
function montar(q: Record<string, unknown> = {}) {
  getQuote.mockResolvedValue({ ok: true, data: { quote: orcamento(q), items: [] } });
  act(() => {
    root.render(
      <QuoteDetailSheet
        orcamento={orcamento(q) as any}
        empresaNome="Mo Limpezas"
        onClose={() => {}}
        onChanged={() => {}}
        onRevise={() => {}}
        onEditDraft={() => {}}
      />,
    );
  });
}
/* eslint-enable @typescript-eslint/no-explicit-any */

const textos = () =>
  [...document.querySelectorAll("button, a")].map((b) => b.textContent?.trim() ?? "");

const acharBotao = (texto: string) =>
  [...document.querySelectorAll("button")].find((b) => b.textContent?.includes(texto));

// ───────────────────────────────────────────────────────────────────────────
describe("🔴 matriz de visibilidade", () => {
  it("aceite, vivo, de lead → mostra «Converter em cliente»", () => {
    montar();
    expect(textos().some((t) => t.includes("Converter em cliente"))).toBe(true);
    expect(textos().some((t) => t.includes("Abrir cliente"))).toBe(false);
  });

  for (const status of ["rascunho", "enviado", "recusado", "expirado", "anulado"]) {
    it(`${status} → não mostra converter`, () => {
      montar({ status });
      expect(textos().some((t) => t.includes("Converter em cliente"))).toBe(false);
    });
  }

  it("🔴 substituído → não mostra converter", () => {
    // Uma revisão histórica não converte ninguém.
    montar({ superseded_by_id: "outro-id" });
    expect(textos().some((t) => t.includes("Converter em cliente"))).toBe(false);
  });

  it("🔴 nascido de cliente (sem source_lead_id) → não mostra converter", () => {
    montar({ source_lead_id: null, lead_id: null, client_id: CLIENTE });
    expect(textos().some((t) => t.includes("Converter em cliente"))).toBe(false);
  });

  it("🔴 já convertido → «Abrir cliente», e NÃO converter", () => {
    montar({ lead_id: null, client_id: CLIENTE });
    expect(textos().some((t) => t.includes("Converter em cliente"))).toBe(false);

    const link = [...document.querySelectorAll("a")].find((a) => a.textContent?.includes("Abrir cliente"));
    expect(link).toBeDefined();
    expect(link!.getAttribute("href")).toBe(`/dashboard/clientes/${CLIENTE}`);
  });
});

// ───────────────────────────────────────────────────────────────────────────
describe("confirmação", () => {
  it("clicar no botão abre o diálogo e NÃO chama a Action", () => {
    montar();
    act(() => { acharBotao("Converter em cliente")!.click(); });

    expect(document.body.textContent).toContain("Converter esta lead em cliente?");
    expect(document.body.textContent).toContain("Não cria contrato nem agenda serviços");
    expect(convertAcceptedQuote).not.toHaveBeenCalled();
  });

  it("🔴 cancelar → zero chamadas", () => {
    montar();
    act(() => { acharBotao("Converter em cliente")!.click(); });
    act(() => { acharBotao("Cancelar")!.click(); });

    expect(convertAcceptedQuote).not.toHaveBeenCalled();
  });

  it("🔴 confirmar → a Action recebe SÓ o quoteId", async () => {
    montar();
    act(() => { acharBotao("Converter em cliente")!.click(); });
    // O botão de confirmação do diálogo tem o mesmo texto; é o último no DOM.
    const confirmar = [...document.querySelectorAll("button")]
      .filter((b) => b.textContent?.includes("Converter em cliente")).pop()!;
    await act(async () => { confirmar.click(); });

    expect(convertAcceptedQuote).toHaveBeenCalledTimes(1);
    expect(convertAcceptedQuote).toHaveBeenCalledWith(QUOTE);
    expect(convertAcceptedQuote.mock.calls[0]).toHaveLength(1);
  });
});

// ───────────────────────────────────────────────────────────────────────────
describe("depois da Action", () => {
  async function confirmar() {
    act(() => { acharBotao("Converter em cliente")!.click(); });
    const btn = [...document.querySelectorAll("button")]
      .filter((b) => b.textContent?.includes("Converter em cliente")).pop()!;
    await act(async () => { btn.click(); });
  }

  it("sucesso → toast e navegação para o cliente", async () => {
    montar();
    await confirmar();

    expect(toast).toHaveBeenCalledWith("Lead convertida em cliente.", "success");
    expect(push).toHaveBeenCalledWith(`/dashboard/clientes/${CLIENTE}`);
  });

  it("🔴 sucesso idempotente → toast próprio e MESMA navegação", async () => {
    convertAcceptedQuote.mockResolvedValue({
      ok: true, data: { clientId: CLIENTE, locationId: LOCAL, alreadyConverted: true },
    });
    montar();
    await confirmar();

    expect(toast).toHaveBeenCalledWith(
      "A lead já estava convertida. A abrir o cliente existente.", "success");
    expect(push).toHaveBeenCalledWith(`/dashboard/clientes/${CLIENTE}`);
  });

  it("🔴 erro → toast e NENHUMA navegação", async () => {
    convertAcceptedQuote.mockResolvedValue({
      ok: false, error: { code: "CONFLICT", message: "Recarregue antes de converter." },
    });
    montar();
    await confirmar();

    expect(toast).toHaveBeenCalledWith("Recarregue antes de converter.", "error");
    expect(push).not.toHaveBeenCalled();
  });

  it("não abre contrato nem cria intervenção", async () => {
    montar();
    await confirmar();
    for (const destino of push.mock.calls.map((c) => String(c[0]))) {
      expect(destino).not.toContain("contrato");
      expect(destino).not.toContain("intervencao");
    }
  });
});

// ───────────────────────────────────────────────────────────────────────────
describe("🔴 semântica assíncrona — a UI espera a Action", () => {
  it("🔴 fica ocupada enquanto a Action não resolve", async () => {
    // O ensaio que apanha o uso de `startTransition`: com ele, o `await` do
    // ConfirmDialog resolveria de imediato e nada ficaria ocupado.
    let resolver: (v: unknown) => void = () => {};
    convertAcceptedQuote.mockReturnValue(new Promise((r) => { resolver = r; }));

    montar();
    act(() => { acharBotao("Converter em cliente")!.click(); });
    const btn = [...document.querySelectorAll("button")]
      .filter((b) => b.textContent?.includes("Converter em cliente")).pop()!;

    // 🔴 `await act(async …)`, e não `act(…)` síncrono: o `await onConfirm()`
    //    do ConfirmDialog resolve numa microtask, e um `act` síncrono não a
    //    deixa correr. Sem este await, o diálogo ainda estaria no DOM em
    //    qualquer dos desenhos e a asserção abaixo passaria sempre — medido.
    await act(async () => { btn.click(); });

    // A Action ainda não resolveu.
    expect(convertAcceptedQuote).toHaveBeenCalledTimes(1);
    expect(push).not.toHaveBeenCalled();

    // 🔴 ESTA é a asserção que distingue os dois desenhos.
    //
    //    `ConfirmDialog` fecha-se no `finally` do seu `await onConfirm()`.
    //    Com uma Promise verdadeira, continua ABERTO enquanto a Action não
    //    resolve. Com `startTransition` — que devolve `void` — o await
    //    resolveria já e o diálogo teria desaparecido aqui, dizendo ao
    //    utilizador que a conversão terminou quando ainda vai a meio.
    //
    //    Verificado por mutação: repondo `startTransition`, este ensaio fica
    //    vermelho. Só o `disabled` do botão de fechar NÃO chegava — o
    //    `pending` do `useTransition` também o bloqueia, e a mutação passava.
    expect(document.body.textContent).toContain("Converter esta lead em cliente?");

    // E o painel não pode fechar-se a meio.
    const fechar = document.querySelector('button[aria-label="Fechar"]') as HTMLButtonElement;
    expect(fechar.disabled).toBe(true);

    await act(async () => {
      resolver({ ok: true, data: { clientId: CLIENTE, locationId: LOCAL, alreadyConverted: false } });
    });

    expect(push).toHaveBeenCalledWith(`/dashboard/clientes/${CLIENTE}`);
  });

  it("depois de resolver, o painel volta a poder fechar-se", async () => {
    montar();
    act(() => { acharBotao("Converter em cliente")!.click(); });
    const btn = [...document.querySelectorAll("button")]
      .filter((b) => b.textContent?.includes("Converter em cliente")).pop()!;
    await act(async () => { btn.click(); });

    const fechar = document.querySelector('button[aria-label="Fechar"]') as HTMLButtonElement;
    expect(fechar.disabled).toBe(false);
  });
});

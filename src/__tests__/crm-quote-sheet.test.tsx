// @vitest-environment jsdom
// ============================================================================
// O formulário de orçamento — comportamento real, não leitura de strings
// ============================================================================
//
// Monta o componente com react-dom + jsdom. Estes dois invariantes não se
// provam lendo o ficheiro: são sobre o que o formulário ENVIA, e ambos
// nasceram de defeitos que este código teve.
//
//   1. uma revisão é um documento de HOJE. A primeira versão herdava
//      `issue_date` da versão anterior, e com ela a validade: uma R0 de há
//      três meses gerava uma R1 já expirada, que só rebentava muito mais
//      tarde com `QUOTE_EXPIRED_CANNOT_ACCEPT`;
//
//   2. esvaziar as observações numa revisão TEM de as apagar. `revise_crm_quote`
//      grava `COALESCE(p_notes, v_antiga.notes)`, por isso enviar `null` repunha
//      exactamente o texto que a pessoa acabara de apagar.
// ============================================================================

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";

import { addDaysToDateString, todayInLisbon } from "@/lib/lisbon-time";
import { QUOTE_DEFAULT_VALIDITY_DAYS } from "@/lib/crm/quotes";

const createQuote = vi.fn();
const reviseQuote = vi.fn();

vi.mock("@/app/actions/crm-orcamentos", () => ({
  createQuote: (...a: unknown[]) => createQuote(...a),
  reviseQuote: (...a: unknown[]) => reviseQuote(...a),
}));

vi.mock("@/components/ui/toast", () => ({
  useToast: () => ({ toast: vi.fn() }),
}));

const { QuoteSheet } = await import(
  "@/app/(dashboard)/dashboard/crm/orcamentos/_components/quote-sheet"
);

/** Uma R0 enviada há muito tempo, com validade já no passado. */
const BASE = {
  quote: {
    id: "11111111-1111-4111-8111-111111111111",
    quote_number: "ORC2026/003",
    quote_year: 2026,
    quote_seq: 3,
    revision: 0,
    root_quote_id: "11111111-1111-4111-8111-111111111111",
    superseded_by_id: null,
    lead_id: "22222222-2222-4222-8222-222222222222",
    client_id: null,
    source_lead_id: "22222222-2222-4222-8222-222222222222",
    visit_id: null,
    target_name: "Condominio Alfa",
    // 🔴 Meses antes de hoje, e a validade já passou. É o caso que partia.
    issue_date: "2026-06-01",
    valid_until: "2026-07-01",
    status: "enviado",
    sent_at: "2026-06-01T09:00:00.000Z",
    accepted_at: null,
    rejected_at: null,
    rejection_reason: null,
    pricing_kind: "pontual",
    subtotal: 100,
    discount_pct: 0,
    apply_vat: true,
    vat_rate: 23,
    vat_amount: 23,
    total: 123,
    proposed_frequency: null,
    proposed_weekdays: null,
    payment_terms: null,
    notes: "Inclui produtos.",
    internal_notes: "margem apertada",
    created_at: "2026-06-01T09:00:00.000Z",
  },
  items: [
    {
      id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
      position: 0,
      description: "Limpeza de escadas",
      quantity: 1,
      unit: "servico",
      unit_price: 100,
      line_total: 100,
    },
  ],
};

let container: HTMLDivElement;
let root: Root;

beforeEach(() => {
  vi.clearAllMocks();
  reviseQuote.mockResolvedValue({ ok: true, data: { id: "novo", quoteNumber: "ORC2026/003-R1" } });
  createQuote.mockResolvedValue({ ok: true, data: { id: "novo", quoteNumber: "ORC2026/004" } });
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
});

/* eslint-disable @typescript-eslint/no-explicit-any */
function montarRevisao() {
  act(() => {
    root.render(
      <QuoteSheet
        leads={[] as any}
        clientes={[]}
        visitas={[] as any}
        vatRate={23}
        mode="revise"
        base={BASE as any}
        onClose={() => {}}
        onDone={() => {}}
      />,
    );
  });
}
/* eslint-enable @typescript-eslint/no-explicit-any */

const input = (label: string): HTMLInputElement | HTMLTextAreaElement => {
  const campos = [...document.querySelectorAll("label")];
  const alvo = campos.find((l) => l.textContent?.trim().startsWith(label));
  const el = alvo?.querySelector("input, textarea");
  if (!el) throw new Error(`campo «${label}» não encontrado`);
  return el as HTMLInputElement | HTMLTextAreaElement;
};

/** Escreve num campo controlado por React. */
function escrever(el: HTMLInputElement | HTMLTextAreaElement, valor: string) {
  const proto = el instanceof HTMLTextAreaElement
    ? window.HTMLTextAreaElement.prototype
    : window.HTMLInputElement.prototype;
  Object.getOwnPropertyDescriptor(proto, "value")!.set!.call(el, valor);
  act(() => {
    el.dispatchEvent(new Event("input", { bubbles: true }));
  });
}

function submeter() {
  const form = container.querySelector("form") ?? document.querySelector("form");
  act(() => {
    form!.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
  });
}

describe("🔴 uma revisão é um documento de HOJE", () => {
  it("as datas abrem em hoje, e não nas da versão anterior", () => {
    montarRevisao();

    const hoje = todayInLisbon();
    expect(input("Data de emissão").value).toBe(hoje);
    expect(input("Válido até").value).toBe(
      addDaysToDateString(hoje, QUOTE_DEFAULT_VALIDITY_DAYS),
    );
  });

  it("🔴 não herda a validade expirada da R0", () => {
    montarRevisao();
    // Se herdasse, a R1 nascia já fora de prazo e só falhava ao ser aceite.
    expect(input("Válido até").value).not.toBe(BASE.quote.valid_until);
    expect(input("Data de emissão").value).not.toBe(BASE.quote.issue_date);
    expect(input("Válido até").value > todayInLisbon()).toBe(true);
  });

  it("o que descreve o NEGÓCIO herda-se na mesma", async () => {
    montarRevisao();
    submeter();
    await act(async () => { /* deixa a transição correr */ });

    expect(reviseQuote).toHaveBeenCalledTimes(1);
    const [, payload] = reviseQuote.mock.calls[0];
    expect(payload.items).toEqual([
      { description: "Limpeza de escadas", quantity: 1, unit: "servico", unitPrice: 100 },
    ]);
    expect(payload.applyVat).toBe(true);
    expect(payload.discountPct).toBe(0);
  });
});

describe("🔴 esvaziar as observações numa revisão apaga-as mesmo", () => {
  it("o campo abre com as notas da versão anterior", () => {
    montarRevisao();
    expect(input("Observações para o cliente").value).toBe("Inclui produtos.");
  });

  it("🔴 apagado, envia string vazia — nunca null", async () => {
    // `revise_crm_quote` grava `COALESCE(p_notes, v_antiga.notes)`: com `null`
    // a base repunha o texto que a pessoa acabara de apagar, e não havia forma
    // nenhuma de remover as observações numa revisão.
    montarRevisao();
    escrever(input("Observações para o cliente"), "");
    submeter();
    await act(async () => { /* deixa a transição correr */ });

    const [, payload] = reviseQuote.mock.calls[0];
    expect(payload.notes).toBe("");
    expect(payload.notes).not.toBeNull();
  });

  it("alterado, envia o texto novo", async () => {
    montarRevisao();
    escrever(input("Observações para o cliente"), "Sem produtos.");
    submeter();
    await act(async () => { /* deixa a transição correr */ });

    expect(reviseQuote.mock.calls[0][1].notes).toBe("Sem produtos.");
  });

  it("🔴 a revisão não oferece campos que a RPC herda e ignora", () => {
    // Notas internas, condições de pagamento e destinatário são copiados da
    // versão anterior pela RPC. Um campo editável cujo conteúdo é descartado
    // em silêncio é pior do que a ausência do campo.
    const etiquetas = [...document.querySelectorAll("label")].map((l) => l.textContent ?? "");
    expect(etiquetas.some((t) => t.includes("Notas internas"))).toBe(false);
    expect(etiquetas.some((t) => t.includes("Condições de pagamento"))).toBe(false);
    expect(etiquetas.some((t) => t.startsWith("Lead"))).toBe(false);
  });
});

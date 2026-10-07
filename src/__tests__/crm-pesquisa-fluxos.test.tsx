// @vitest-environment jsdom
// ============================================================================
// Pesquisa de cliente/lead — o que chega às actions
// ============================================================================
//
// A caixa de pesquisa substituiu os <select> de destinatário. O risco real não
// é visual: é uma visita ou um orçamento gravado com a lead E o cliente, com
// nenhum, ou com o do destinatário anterior depois de «Trocar». E, na lead
// nova, criar uma lead para quem já é cliente — a conversão faria dele um
// cliente duplicado.
//
// Aqui monta-se cada formulário a sério e verifica-se o payload exacto que
// segue para a action.
// ============================================================================

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";

const scheduleVisit = vi.fn();
const createQuote = vi.fn();
const reviseQuote = vi.fn();
const createLead = vi.fn();
const updateLead = vi.fn();
const push = vi.fn();
const refresh = vi.fn();

vi.mock("@/app/actions/crm-visitas", () => ({
  scheduleVisit: (...a: unknown[]) => scheduleVisit(...a),
}));
vi.mock("@/app/actions/crm-orcamentos", () => ({
  createQuote: (...a: unknown[]) => createQuote(...a),
  reviseQuote: (...a: unknown[]) => reviseQuote(...a),
}));
vi.mock("@/app/actions/crm-leads", () => ({
  createLead: (...a: unknown[]) => createLead(...a),
  updateLead: (...a: unknown[]) => updateLead(...a),
}));
vi.mock("@/components/ui/toast", () => ({ useToast: () => ({ toast: vi.fn() }) }));
vi.mock("next/navigation", () => ({ useRouter: () => ({ push, refresh }) }));

const { VisitSheet } = await import(
  "@/app/(dashboard)/dashboard/crm/visitas/_components/visit-sheet"
);
const { QuoteSheet } = await import(
  "@/app/(dashboard)/dashboard/crm/orcamentos/_components/quote-sheet"
);
const { LeadSheet } = await import("@/app/(dashboard)/dashboard/crm/_components/lead-sheet");

const LEAD = "22222222-2222-4222-8222-222222222222";
const LEAD_CONVERTIDA = "33333333-3333-4333-8333-333333333333";
const CLIENTE = "44444444-4444-4444-8444-444444444444";

const LEADS = [
  { id: LEAD, name: "Condomínio Beta", address: "Rua B", converted_client_id: null },
  // Já é cliente: só deve aparecer como cliente, nunca como lead.
  { id: LEAD_CONVERTIDA, name: "Condomínio Alfa", address: null, converted_client_id: CLIENTE },
];
const CLIENTES = [{ id: CLIENTE, name: "Condomínio Alfa", phone: "912345678" }];

let container: HTMLDivElement;
let root: Root;

beforeEach(() => {
  vi.clearAllMocks();
  scheduleVisit.mockResolvedValue({ ok: true, data: { id: "v" } });
  createQuote.mockResolvedValue({ ok: true, data: { id: "q", quoteNumber: "ORC2026/010" } });
  createLead.mockResolvedValue({ ok: true, data: { id: "nova" } });
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
});

function render(el: React.ReactElement) {
  act(() => root.render(el));
}

function escrever(el: HTMLInputElement, valor: string) {
  Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(el, valor);
  act(() => {
    el.dispatchEvent(new Event("input", { bubbles: true }));
  });
}

const caixa = () => document.querySelector('input[role="combobox"]') as HTMLInputElement;
const opcoes = () => [...document.querySelectorAll<HTMLElement>('[role="option"]')];

function pesquisarEEscolher(texto: string, etiqueta: string) {
  escrever(caixa(), texto);
  const o = opcoes().find((x) => x.textContent === etiqueta);
  if (!o) throw new Error(`opção «${etiqueta}» não encontrada: ${opcoes().map((x) => x.textContent)}`);
  act(() => o.click());
}

function clicar(texto: string) {
  const b = [...document.querySelectorAll<HTMLButtonElement>("button")].find((x) =>
    x.textContent?.trim().startsWith(texto),
  );
  if (!b) throw new Error(`botão «${texto}» não encontrado`);
  act(() => b.click());
}

async function submeter() {
  const form = document.querySelector("form")!;
  await act(async () => {
    form.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
  });
}

/* eslint-disable @typescript-eslint/no-explicit-any */

describe("Marcar visita", () => {
  const montar = (extra: Record<string, unknown> = {}) =>
    render(
      <VisitSheet
        leads={LEADS as any}
        clientes={CLIENTES}
        membros={[]}
        onClose={() => {}}
        onDone={() => {}}
        {...extra}
      />,
    );

  it("uma lead convertida não aparece como lead — só o cliente", () => {
    montar();
    escrever(caixa(), "alfa");
    const resultados = opcoes()
      .map((o) => o.textContent)
      .filter((t) => !t?.startsWith("Criar nova lead"));
    expect(resultados).toEqual(["ClienteCondomínio Alfa"]);
  });

  it("escolher um cliente envia só o clientId", async () => {
    montar();
    pesquisarEEscolher("alfa", "ClienteCondomínio Alfa");
    await submeter();
    expect(scheduleVisit).toHaveBeenCalledTimes(1);
    expect(scheduleVisit.mock.calls[0][0]).toMatchObject({ leadId: null, clientId: CLIENTE });
  });

  it("🔴 lead escolhida e depois trocada por cliente: a lead não vai junto", async () => {
    montar();
    pesquisarEEscolher("beta", "LeadCondomínio Beta");
    clicar("Trocar");
    pesquisarEEscolher("alfa", "ClienteCondomínio Alfa");
    await submeter();
    expect(scheduleVisit.mock.calls[0][0]).toMatchObject({ leadId: null, clientId: CLIENTE });
  });

  it("escolher uma lead envia só o leadId, e traz a morada dela", async () => {
    montar();
    pesquisarEEscolher("beta", "LeadCondomínio Beta");
    await submeter();
    expect(scheduleVisit.mock.calls[0][0]).toMatchObject({
      leadId: LEAD,
      clientId: null,
      address: "Rua B",
    });
  });

  it("vindo de ?cliente=, o cliente já vem escolhido", async () => {
    montar({ clienteInicial: CLIENTE });
    expect(document.body.textContent).toContain("Condomínio Alfa");
    await submeter();
    expect(scheduleVisit.mock.calls[0][0]).toMatchObject({ leadId: null, clientId: CLIENTE });
  });

  it("🔴 um ?cliente= que não existe é ignorado — nada é enviado", async () => {
    montar({ clienteInicial: "99999999-9999-4999-8999-999999999999" });
    expect(caixa()).not.toBeNull();
    const botao = [...document.querySelectorAll<HTMLButtonElement>('button[type="submit"]')][0];
    expect(botao.disabled).toBe(true);
  });

  it("com a lead fixa (ficha da lead), não se pode trocar", () => {
    montar({ leadFixa: LEADS[0] });
    expect(document.body.textContent).toContain("Condomínio Beta");
    expect(document.querySelector('button[aria-label^="Trocar"]')).toBeNull();
  });
});

describe("Novo orçamento", () => {
  const montar = (extra: Record<string, unknown> = {}) =>
    render(
      <QuoteSheet
        leads={LEADS as any}
        clientes={CLIENTES}
        visitas={[]}
        vatRate={23}
        mode="create"
        onClose={() => {}}
        onDone={() => {}}
        {...extra}
      />,
    );

  it("vindo de ?cliente=, envia só o clientId", async () => {
    montar({ clienteInicial: CLIENTE });
    await submeter();
    expect(createQuote).toHaveBeenCalledTimes(1);
    expect(createQuote.mock.calls[0][0]).toMatchObject({ leadId: null, clientId: CLIENTE });
  });

  it("🔴 cliente trocado por lead: o cliente não vai junto", async () => {
    montar({ clienteInicial: CLIENTE });
    clicar("Trocar");
    pesquisarEEscolher("beta", "LeadCondomínio Beta");
    await submeter();
    expect(createQuote.mock.calls[0][0]).toMatchObject({ leadId: LEAD, clientId: null });
  });

  it("«Criar nova lead» não grava orçamento nenhum — leva ao funil com o nome", () => {
    montar();
    escrever(caixa(), "Zé Novo");
    act(() => opcoes().at(-1)!.click());
    expect(createQuote).not.toHaveBeenCalled();
    expect(push).toHaveBeenCalledWith(`/dashboard/crm?nova=${encodeURIComponent("Zé Novo")}`);
  });
});

describe("Nova lead", () => {
  const montar = (extra: Record<string, unknown> = {}) =>
    render(
      <LeadSheet
        lead={null}
        membros={[]}
        leads={LEADS.filter((l) => !l.converted_client_id)}
        clientes={CLIENTES}
        onClose={() => {}}
        {...extra}
      />,
    );

  it("🔴 quem já é cliente não vira lead: não há botão de criar, e nada é gravado", () => {
    montar();
    pesquisarEEscolher("912 345", "ClienteCondomínio Alfa");
    expect(document.body.textContent).toContain("já é cliente");
    expect(document.querySelector('button[type="submit"]')).toBeNull();
    clicar("Marcar visita");
    expect(push).toHaveBeenCalledWith(`/dashboard/crm/visitas?cliente=${CLIENTE}`);
    expect(createLead).not.toHaveBeenCalled();
  });

  it("uma lead que já existe abre a ficha, sem criar outra", () => {
    montar();
    pesquisarEEscolher("beta", "LeadCondomínio Beta");
    expect(push).toHaveBeenCalledWith(`/dashboard/crm/${LEAD}`);
    expect(createLead).not.toHaveBeenCalled();
  });

  it("«Criar nova lead» abre o formulário com o nome e grava-o", async () => {
    montar();
    escrever(caixa(), "Zé Novo");
    act(() => opcoes().at(-1)!.click());
    const nome = [...document.querySelectorAll("label")]
      .find((l) => l.textContent?.startsWith("Empresa / Nome"))!
      .querySelector("input") as HTMLInputElement;
    expect(nome.value).toBe("Zé Novo");
    await submeter();
    expect(createLead).toHaveBeenCalledTimes(1);
    expect(createLead.mock.calls[0][0]).toMatchObject({ name: "Zé Novo" });
  });

  it("vindo de ?nova=, salta a pesquisa", () => {
    montar({ nomeInicial: "Zé Novo" });
    expect(caixa()).toBeNull();
    expect(document.querySelector('button[type="submit"]')).not.toBeNull();
  });

  it("editar uma lead nunca mostra a pesquisa", () => {
    montar({ lead: { ...LEADS[0], lead_type: "empresa", estimated_value_kind: "mensal" } });
    expect(caixa()).toBeNull();
  });
});

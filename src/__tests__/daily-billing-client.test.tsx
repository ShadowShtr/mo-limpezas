// @vitest-environment jsdom

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/app/actions/daily-billing", () => ({
  getDailyBilling: vi.fn(),
  setServicePayment: vi.fn(),
}));
vi.mock("@/lib/supabase/client", () => ({
  createClient: () => ({
    channel: () => {
      const channel = { on: () => channel, subscribe: () => channel };
      return channel;
    },
    removeChannel: vi.fn(),
  }),
}));
vi.mock("@/app/(dashboard)/dashboard/calendario/_components/service-create-sheet", () => ({
  ServiceCreateSheet: () => null,
}));

import { getDailyBilling, setServicePayment } from "@/app/actions/daily-billing";
import { DailyBillingClient } from "@/app/(dashboard)/dashboard/cobrancas/_components/daily-billing-client";

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

type Deferred<T> = { promise: Promise<T>; resolve: (value: T) => void; reject: (reason: unknown) => void };

function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((ok, fail) => { resolve = ok; reject = fail; });
  return { promise, resolve, reject };
}

function row(id: string, clientName: string) {
  return {
    id,
    reference_number: null,
    scheduled_start: "2026-09-12T09:00:00Z",
    status: "agendado",
    client_id: id,
    client_name: clientName,
    location_name: "Local",
    value: 100,
    apply_vat: false,
    is_avenca: false,
    payment_status: "nao_informado",
    paid_amount: null,
    paid_at: null,
  };
}

function data(rows: ReturnType<typeof row>[]) {
  return { day: rows, pending: [], vatRate: 23 };
}

describe("DailyBillingClient — identidade de pedidos e comandos", () => {
  let host: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    vi.resetAllMocks();
    host = document.createElement("div");
    document.body.appendChild(host);
    root = createRoot(host);
  });

  afterEach(() => {
    act(() => root.unmount());
    host.remove();
  });

  async function mount() {
    await act(async () => {
      root.render(
        <DailyBillingClient
          initialDate="2026-09-12"
          initialData={data([row("a", "Cliente A"), row("b", "Cliente B")])}
          initialError={null}
          companyId="company"
          clients={[]}
          locations={[]}
          teams={[]}
        />,
      );
    });
  }

  async function click(button: HTMLButtonElement) {
    await act(async () => button.click());
  }

  function paymentRow(clientName: string): HTMLElement {
    const candidates = Array.from(host.querySelectorAll<HTMLElement>("div.px-4.py-3"));
    const found = candidates.find((element) => element.textContent?.includes(clientName));
    if (!found) throw new Error(`Linha de ${clientName} não encontrada.`);
    return found;
  }

  function rowButton(clientName: string, label?: string): HTMLButtonElement {
    const buttons = Array.from(paymentRow(clientName).querySelectorAll<HTMLButtonElement>("button"));
    const found = label ? buttons.find((button) => button.textContent?.trim() === label) : buttons[0];
    if (!found) throw new Error(`Botão ${label ?? ""} de ${clientName} não encontrado.`);
    return found;
  }

  it("mantém a resposta mais recente quando duas recargas do mesmo dia terminam fora de ordem", async () => {
    const antiga = deferred<Awaited<ReturnType<typeof getDailyBilling>>>();
    const recente = deferred<Awaited<ReturnType<typeof getDailyBilling>>>();
    vi.mocked(getDailyBilling).mockReturnValueOnce(antiga.promise).mockReturnValueOnce(recente.promise);
    await mount();

    await act(async () => {
      window.dispatchEvent(new Event("focus"));
      window.dispatchEvent(new Event("focus"));
    });
    await act(async () => recente.resolve({ ok: true, data: data([row("a", "Nome recente")]) }));
    await act(async () => antiga.resolve({ ok: true, data: data([row("a", "Nome antigo")]) }));

    expect(host.textContent).toContain("Nome recente");
    expect(host.textContent).not.toContain("Nome antigo");
  });

  it("não apresenta linhas do dia anterior como acionáveis durante a mudança de dia", async () => {
    vi.mocked(getDailyBilling).mockReturnValue(new Promise(() => undefined));
    await mount();

    await click(host.querySelector<HTMLButtonElement>('button[aria-label="Dia seguinte"]')!);

    expect(host.querySelector<HTMLInputElement>('input[type="date"]')?.value).toBe("2026-09-13");
    expect(host.textContent).not.toContain("Cliente A");
    expect(host.textContent).toContain("A carregar cobranças");
  });

  it("mantém todas as linhas com gravação pendente protegidas", async () => {
    const gravaA = deferred<Awaited<ReturnType<typeof setServicePayment>>>();
    const gravaB = deferred<Awaited<ReturnType<typeof setServicePayment>>>();
    vi.mocked(setServicePayment).mockReturnValueOnce(gravaA.promise).mockReturnValueOnce(gravaB.promise);
    await mount();

    await click(rowButton("Cliente A", "100%"));
    await click(rowButton("Cliente B", "100%"));

    expect(paymentRow("Cliente A").querySelector("button")).toBeNull();
    expect(paymentRow("Cliente B").querySelector("button")).toBeNull();
  });

  it("a conclusão de uma linha não fecha o editor aberto noutra linha", async () => {
    const gravaA = deferred<Awaited<ReturnType<typeof setServicePayment>>>();
    vi.mocked(setServicePayment).mockReturnValue(gravaA.promise);
    vi.mocked(getDailyBilling).mockReturnValue(new Promise(() => undefined));
    await mount();

    await click(rowButton("Cliente A", "100%"));
    await click(paymentRow("Cliente B").querySelector<HTMLButtonElement>('button[title="Registar valor recebido (€)"]')!);
    await act(async () => gravaA.resolve({ ok: true }));

    expect(paymentRow("Cliente B").querySelector('input[type="number"]')).not.toBeNull();
  });

  it("liberta somente a linha cuja gravação falhou e permite tentar novamente", async () => {
    const primeira = deferred<Awaited<ReturnType<typeof setServicePayment>>>();
    vi.mocked(setServicePayment)
      .mockReturnValueOnce(primeira.promise)
      .mockResolvedValueOnce({ ok: true });
    await mount();

    await click(rowButton("Cliente A", "100%"));
    await act(async () => primeira.reject(new Error("falha de rede")));

    expect(rowButton("Cliente A", "100%").disabled).toBe(false);
    await click(rowButton("Cliente A", "100%"));
    expect(setServicePayment).toHaveBeenCalledTimes(2);
  });
});

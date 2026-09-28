// @vitest-environment jsdom
// ============================================================================
// Cobranças › Diário — a interface da união, e as corridas
// ============================================================================
//
// Reconstruído a partir dos testes da PR #178 sobre o master actual, e
// alargado à cobrança avulsa:
//
//   · a linha mostra Editar / Excluir e NÃO tem botões de pagamento;
//   · «Adicionar cobrança» pergunta primeiro: serviço ou cobrança avulsa;
//   · o editor recebe pela RPC certa conforme o tipo — 097 para serviço, 091
//     para avulsa — nos quatro gestos;
//   · excluir com recebimento não é oferecido;
//   · o Realtime ouve `services` e `manual_charges`, filtrados pela empresa;
//   · resposta de dia antigo não sobrescreve o dia novo; recarga antiga não
//     sobrescreve a nova; gravação antiga não escreve estado.
// ============================================================================

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const rt = vi.hoisted(() => ({ subs: [] as Array<{ table: string; filter: string; cb: () => void }> }));

vi.mock("@/app/actions/daily-billing", () => ({
  getDailyBilling: vi.fn(),
  setServicePayment: vi.fn(),
}));
vi.mock("@/app/actions/manual-charges", () => ({
  createManualCharge: vi.fn(),
  updateManualCharge: vi.fn(),
  setManualChargePayment: vi.fn(),
  voidManualCharge: vi.fn(),
}));
vi.mock("@/app/actions/cancellations", () => ({ deleteCalendarService: vi.fn() }));
vi.mock("next/link", () => ({
  default: ({ href, children, ...p }: { href: string; children: React.ReactNode }) => <a href={href} {...p}>{children}</a>,
}));
vi.mock("@/lib/supabase/client", () => ({
  createClient: () => ({
    channel: () => {
      const channel = {
        on: (_e: string, opts: { table: string; filter: string }, cb: () => void) => {
          rt.subs.push({ table: opts.table, filter: opts.filter, cb });
          return channel;
        },
        subscribe: () => channel,
      };
      return channel;
    },
    removeChannel: vi.fn(),
  }),
}));
vi.mock("@/app/(dashboard)/dashboard/calendario/_components/service-create-sheet", () => ({
  ServiceCreateSheet: ({ open }: { open: boolean }) => (open ? <div data-testid="service-sheet" /> : null),
}));

import { getDailyBilling, setServicePayment } from "@/app/actions/daily-billing";
import {
  createManualCharge,
  setManualChargePayment,
  voidManualCharge,
} from "@/app/actions/manual-charges";
import { deleteCalendarService } from "@/app/actions/cancellations";
import { DailyBillingClient } from "@/app/(dashboard)/dashboard/cobrancas/_components/daily-billing-client";
import type { DailyBillingData } from "@/app/actions/daily-billing";

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const EMPRESA = "11111111-1111-4111-8111-111111111111";

type Deferred<T> = { promise: Promise<T>; resolve: (v: T) => void; reject: (e: unknown) => void };
function deferred<T>(): Deferred<T> {
  let resolve!: (v: T) => void;
  let reject!: (e: unknown) => void;
  const promise = new Promise<T>((ok, fail) => { resolve = ok; reject = fail; });
  return { promise, resolve, reject };
}

const svc = (id: string, client: string, over: Record<string, unknown> = {}) => ({
  type: "service" as const, id, reference_number: null, scheduled_start: "2026-09-12T09:00:00Z", status: "agendado",
  client_id: "c", client_name: client, location_name: "Local", value: 100, apply_vat: false, is_avenca: false,
  payment_status: "nao_informado" as const, paid_amount: null, paid_at: null, notes: null, ...over,
});
const man = (id: string, client: string, over: Record<string, unknown> = {}) => ({
  type: "manual_charge" as const, id, charge_date: "2026-09-12", description: "Vidros", client_id: "c",
  client_name: client, value: 50, apply_vat: false, payment_status: "nao_informado" as const,
  paid_amount: null, paid_at: null, notes: null, ...over,
});
const data = (day: unknown[], pending: unknown[] = []) => ({ day, pending, vatRate: 23 }) as DailyBillingData;

let host: HTMLDivElement;
let root: Root;

beforeEach(() => {
  vi.resetAllMocks();
  rt.subs = [];
  vi.mocked(getDailyBilling).mockReturnValue(new Promise(() => undefined));
  host = document.createElement("div");
  document.body.appendChild(host);
  root = createRoot(host);
});

afterEach(() => {
  act(() => root.unmount());
  host.remove();
});

async function mount(initial = data([svc("s1", "Cliente Serviço"), man("m1", "Cliente Avulsa")])) {
  await act(async () => {
    root.render(
      <DailyBillingClient
        initialDate="2026-09-12"
        initialData={initial}
        initialError={null}
        companyId={EMPRESA}
        clients={[{ id: "c", name: "C" }] as never}
        locations={[]}
        teams={[]}
      />,
    );
  });
}

const click = async (el: Element | null | undefined) => {
  if (!el) throw new Error("elemento não encontrado");
  await act(async () => { (el as HTMLElement).click(); });
};
const button = (scope: ParentNode, label: string) =>
  [...scope.querySelectorAll("button")].find((b) => (b.textContent ?? "").trim() === label) ?? null;
const rowOf = (key: string) => host.querySelector(`[data-billing-row="${key}"]`) as HTMLElement;
const dialog = () => host.querySelector('[role="dialog"]') as HTMLElement;

describe("a linha", () => {
  it("🔴 serviço e avulsa aparecem juntos, com Editar e Excluir", async () => {
    await mount();
    for (const k of ["service:s1", "manual_charge:m1"]) {
      expect(button(rowOf(k), "Editar")).not.toBeNull();
      expect(button(rowOf(k), "Excluir")).not.toBeNull();
    }
    expect(rowOf("manual_charge:m1").textContent).toContain("Cobrança avulsa");
  });

  it("🔴 sem botões de pagamento na linha", async () => {
    await mount();
    for (const k of ["service:s1", "manual_charge:m1"]) {
      const labels = [...rowOf(k).querySelectorAll("button")].map((b) => (b.textContent ?? "").trim());
      expect(labels).not.toContain("Por pagar");
      expect(labels).not.toContain("50%");
      expect(labels).not.toContain("100%");
      expect(rowOf(k).querySelector('button[title="Registar valor recebido (€)"]')).toBeNull();
    }
  });

  it("os KPIs somam os dois tipos", async () => {
    await mount();
    // 100 € (serviço sem IVA) + 50 € (avulsa sem IVA)
    expect(host.textContent).toContain("150,00 €");
    expect(host.textContent).toMatch(/1 serviço · 1 avulsa/);
  });
});

describe("«Adicionar cobrança»", () => {
  it("🔴 abre a escolha com as duas opções", async () => {
    await mount();
    await click(button(host, "Adicionar cobrança"));
    const texto = dialog().textContent ?? "";
    expect(texto).toContain("Novo serviço");
    expect(texto).toContain("Cobrança avulsa / Nota de cobrança");
  });

  it("«Novo serviço» abre o sheet canónico do calendário", async () => {
    await mount();
    await click(button(host, "Adicionar cobrança"));
    await click([...dialog().querySelectorAll("button")].find((b) => b.textContent?.includes("Novo serviço")));
    expect(host.querySelector("[data-testid=service-sheet]")).not.toBeNull();
  });

  it("🔴 «Cobrança avulsa» cria pela action própria, com o dia em vista", async () => {
    vi.mocked(createManualCharge).mockResolvedValue({ ok: true, id: "novo" });
    await mount();
    await click(button(host, "Adicionar cobrança"));
    await click([...dialog().querySelectorAll("button")].find((b) => b.textContent?.includes("Cobrança avulsa")));
    const sheet = dialog();
    const set = async (el: HTMLInputElement | HTMLSelectElement, v: string) => {
      const proto = el instanceof HTMLSelectElement ? HTMLSelectElement.prototype : HTMLInputElement.prototype;
      Object.getOwnPropertyDescriptor(proto, "value")!.set!.call(el, v);
      await act(async () => { el.dispatchEvent(new Event(el instanceof HTMLSelectElement ? "change" : "input", { bubbles: true })); });
    };
    await set(sheet.querySelector("select")!, "c");
    const [descricao, valor] = [...sheet.querySelectorAll('input[type="text"]')] as HTMLInputElement[];
    await set(descricao, "Limpeza extra");
    await set(valor, "35,5");
    await click(button(sheet, "Criar cobrança"));
    expect(createManualCharge).toHaveBeenCalledWith(expect.objectContaining({
      clientId: "c", chargeDate: "2026-09-12", description: "Limpeza extra", amount: 35.5, applyVat: true,
    }));
  });
});

describe("o editor — recebimento pela RPC do tipo certo", () => {
  const gestos = [
    ["Por pagar", "nao_informado", null],
    ["50%", "sinal_50", null],
    ["100%", "pago_total", null],
  ] as const;

  for (const [label, status, valor] of gestos) {
    it(`serviço — ${label} → setServicePayment`, async () => {
      vi.mocked(setServicePayment).mockResolvedValue({ ok: true });
      await mount();
      await click(button(rowOf("service:s1"), "Editar"));
      await click(button(dialog(), label));
      expect(setServicePayment).toHaveBeenCalledWith("s1", status, valor);
      expect(setManualChargePayment).not.toHaveBeenCalled();
    });

    it(`avulsa — ${label} → setManualChargePayment`, async () => {
      vi.mocked(setManualChargePayment).mockResolvedValue({ ok: true, cashAmount: 0 });
      await mount();
      await click(button(rowOf("manual_charge:m1"), "Editar"));
      await click(button(dialog(), label));
      expect(setManualChargePayment).toHaveBeenCalledWith("m1", status, valor);
      expect(setServicePayment).not.toHaveBeenCalled();
    });
  }

  it("valor livre (€): estado coerente com o valor, nos dois tipos", async () => {
    vi.mocked(setServicePayment).mockResolvedValue({ ok: true });
    vi.mocked(setManualChargePayment).mockResolvedValue({ ok: true, cashAmount: 20 });
    await mount();
    for (const [key, fn] of [["service:s1", setServicePayment], ["manual_charge:m1", setManualChargePayment]] as const) {
      await click(button(rowOf(key), "Editar"));
      const input = dialog().querySelector('input[aria-label="Valor recebido (€)"]') as HTMLInputElement;
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(input, "20");
      await act(async () => { input.dispatchEvent(new Event("input", { bubbles: true })); });
      await click(button(dialog(), "Guardar valor"));
      expect(fn).toHaveBeenLastCalledWith(key.split(":")[1], "sinal_50", 20);
      await click(dialog().querySelector('button[aria-label="Fechar"]'));
    }
  });

  it("🔴 avulsa com recebimento: valor, IVA e cliente bloqueados no formulário", async () => {
    await mount(data([man("m1", "Cliente Avulsa", { payment_status: "sinal_50" })]));
    await click(button(rowOf("manual_charge:m1"), "Editar"));
    const d = dialog();
    expect(d.textContent).toContain("valor, IVA e cliente ficam bloqueados");
    expect((d.querySelector("select") as HTMLSelectElement).disabled).toBe(true);
    expect((d.querySelector('input[type="checkbox"]') as HTMLInputElement).disabled).toBe(true);
  });

  it("uma recusa da base aparece no editor", async () => {
    vi.mocked(setManualChargePayment).mockResolvedValue({ ok: false, error: "Este mês está fechado." });
    await mount();
    await click(button(rowOf("manual_charge:m1"), "Editar"));
    await click(button(dialog(), "100%"));
    expect(dialog().textContent).toContain("Este mês está fechado.");
  });
});

describe("excluir", () => {
  it("🔴 avulsa sem recebimento: excluir = anular", async () => {
    vi.mocked(voidManualCharge).mockResolvedValue({ ok: true });
    await mount();
    await click(button(rowOf("manual_charge:m1"), "Excluir"));
    await click(button(dialog(), "Excluir"));
    expect(voidManualCharge).toHaveBeenCalledWith("m1");
    expect(deleteCalendarService).not.toHaveBeenCalled();
  });

  it("serviço sem recebimento: caminho seguro do calendário, só esta ocorrência", async () => {
    vi.mocked(deleteCalendarService).mockResolvedValue({ ok: true, deleted: 1, recurring: false });
    await mount();
    await click(button(rowOf("service:s1"), "Excluir"));
    await click(button(dialog(), "Excluir"));
    expect(deleteCalendarService).toHaveBeenCalledWith("s1", "single");
  });

  it("🔴 com recebimento: a LINHA não oferece «Excluir», nos dois tipos", async () => {
    await mount(data([
      svc("s1", "Cliente Serviço", { payment_status: "pago_total" }),
      man("m1", "Cliente Avulsa", { paid_amount: 10, payment_status: "sinal_50" }),
    ]));
    for (const k of ["service:s1", "manual_charge:m1"]) {
      expect(button(rowOf(k), "Excluir")).toBeNull();
      // Editar continua lá: é por ele que se retira o recebimento.
      expect(button(rowOf(k), "Editar")).not.toBeNull();
    }
    expect(dialog()).toBeNull();
    expect(voidManualCharge).toHaveBeenCalledTimes(0);
    expect(deleteCalendarService).toHaveBeenCalledTimes(0);
  });

  it("sem recebimento: «Excluir» continua na linha e segue o writer do tipo", async () => {
    vi.mocked(voidManualCharge).mockResolvedValue({ ok: true });
    vi.mocked(deleteCalendarService).mockResolvedValue({ ok: true, deleted: 1, recurring: false });
    await mount();
    expect(button(rowOf("service:s1"), "Excluir")).not.toBeNull();
    expect(button(rowOf("manual_charge:m1"), "Excluir")).not.toBeNull();
    await click(button(rowOf("manual_charge:m1"), "Excluir"));
    await click(button(dialog(), "Excluir"));
    await click(button(rowOf("service:s1"), "Excluir"));
    await click(button(dialog(), "Excluir"));
    expect(voidManualCharge).toHaveBeenCalledWith("m1");
    expect(deleteCalendarService).toHaveBeenCalledWith("s1", "single");
  });

  it("🔴 defesa em profundidade: recebimento que chega com o diálogo ABERTO tira a confirmação", async () => {
    vi.mocked(getDailyBilling).mockResolvedValue({
      ok: true, data: data([man("m1", "Cliente Avulsa", { payment_status: "pago_total" })]),
    });
    await mount();
    await click(button(rowOf("manual_charge:m1"), "Excluir"));
    expect(button(dialog(), "Excluir")).not.toBeNull();
    // Outra sessão regista o recebimento; o Realtime traz o snapshot novo.
    await act(async () => { rt.subs.find((s) => s.table === "manual_charges")!.cb(); });
    expect(button(dialog(), "Excluir")).toBeNull();
    expect(dialog().textContent).toContain("Retire primeiro o recebimento");
    expect(voidManualCharge).toHaveBeenCalledTimes(0);
  });

  it("recusa da base ao excluir serviço chega traduzida", async () => {
    vi.mocked(deleteCalendarService).mockResolvedValue({
      ok: false, error: "SERVICE_DELETE_BLOCKED_BY_PAYMENT: Este serviço tem um recebimento registado.",
    });
    await mount();
    await click(button(rowOf("service:s1"), "Excluir"));
    await click(button(dialog(), "Excluir"));
    expect(dialog().textContent).toContain("Remova o recebimento antes de o excluir");
    expect(dialog().textContent).not.toContain("SERVICE_DELETE_BLOCKED");
  });
});

describe("Realtime", () => {
  it("🔴 ouve services E manual_charges, ambos filtrados pela empresa", async () => {
    await mount();
    const tabelas = rt.subs.map((s) => `${s.table}|${s.filter}`).sort();
    expect(tabelas).toEqual([`manual_charges|company_id=eq.${EMPRESA}`, `services|company_id=eq.${EMPRESA}`]);
  });

  it("um evento de manual_charges recarrega o dia em vista", async () => {
    vi.mocked(getDailyBilling).mockResolvedValue({ ok: true, data: data([man("m2", "Nova avulsa")]) });
    await mount();
    await act(async () => { rt.subs.find((s) => s.table === "manual_charges")!.cb(); });
    expect(getDailyBilling).toHaveBeenLastCalledWith("2026-09-12");
    expect(host.textContent).toContain("Nova avulsa");
  });

  it("um evento de services recarrega também", async () => {
    vi.mocked(getDailyBilling).mockResolvedValue({ ok: true, data: data([svc("s9", "Novo serviço X")]) });
    await mount();
    await act(async () => { rt.subs.find((s) => s.table === "services")!.cb(); });
    expect(host.textContent).toContain("Novo serviço X");
  });
});

describe("corridas", () => {
  it("🔴 resposta de dia ANTIGO não sobrescreve o dia novo", async () => {
    const dia12 = deferred<Awaited<ReturnType<typeof getDailyBilling>>>();
    const dia13 = deferred<Awaited<ReturnType<typeof getDailyBilling>>>();
    vi.mocked(getDailyBilling).mockReturnValueOnce(dia12.promise).mockReturnValueOnce(dia13.promise);
    await mount();
    await act(async () => { window.dispatchEvent(new Event("focus")); }); // recarga do dia 12 em voo
    await click(host.querySelector('button[aria-label="Dia seguinte"]'));
    await act(async () => dia13.resolve({ ok: true, data: data([man("m13", "Do dia 13")]) }));
    await act(async () => dia12.resolve({ ok: true, data: data([man("m12", "Do dia 12")]) }));
    expect(host.textContent).toContain("Do dia 13");
    expect(host.textContent).not.toContain("Do dia 12");
  });

  it("🔴 recarga antiga do MESMO dia não sobrescreve a mais recente", async () => {
    const antiga = deferred<Awaited<ReturnType<typeof getDailyBilling>>>();
    const recente = deferred<Awaited<ReturnType<typeof getDailyBilling>>>();
    vi.mocked(getDailyBilling).mockReturnValueOnce(antiga.promise).mockReturnValueOnce(recente.promise);
    await mount();
    await act(async () => {
      window.dispatchEvent(new Event("focus"));
      window.dispatchEvent(new Event("focus"));
    });
    await act(async () => recente.resolve({ ok: true, data: data([man("m", "Nome recente")]) }));
    await act(async () => antiga.resolve({ ok: true, data: data([man("m", "Nome antigo")]) }));
    expect(host.textContent).toContain("Nome recente");
    expect(host.textContent).not.toContain("Nome antigo");
  });

  it("mudar de dia não deixa as linhas do dia anterior acionáveis", async () => {
    await mount();
    await click(host.querySelector('button[aria-label="Dia seguinte"]'));
    expect(host.querySelector('input[type="date"]')?.getAttribute("value") ?? (host.querySelector('input[type="date"]') as HTMLInputElement).value).toBe("2026-09-13");
    expect(host.querySelector('[data-billing-row]')).toBeNull();
    expect(host.textContent).toContain("A carregar cobranças");
  });

  it("🔴 a resposta de uma gravação não escreve estado — só a recarga que ela pede", async () => {
    const grava = deferred<Awaited<ReturnType<typeof setManualChargePayment>>>();
    const recarga = deferred<Awaited<ReturnType<typeof getDailyBilling>>>();
    vi.mocked(setManualChargePayment).mockReturnValue(grava.promise);
    vi.mocked(getDailyBilling).mockReturnValue(recarga.promise);
    await mount();
    await click(button(rowOf("manual_charge:m1"), "Editar"));
    await click(button(dialog(), "100%"));
    await act(async () => grava.resolve({ ok: true, cashAmount: 50 }));
    // A base confirmou, mas o ecrã ainda não mudou: o estado vem do snapshot.
    expect(rowOf("manual_charge:m1").textContent).toContain("Por pagar");
    await act(async () => recarga.resolve({ ok: true, data: data([man("m1", "Cliente Avulsa", { payment_status: "pago_total" })]) }));
    expect(rowOf("manual_charge:m1").textContent).toContain("Pago");
  });

  it("🔴 uma linha com gravação em curso não aceita outra", async () => {
    const grava = deferred<Awaited<ReturnType<typeof setServicePayment>>>();
    vi.mocked(setServicePayment).mockReturnValue(grava.promise);
    await mount();
    await click(button(rowOf("service:s1"), "Editar"));
    await click(button(dialog(), "50%"));
    expect((button(dialog(), "100%") as HTMLButtonElement).disabled).toBe(true);
    expect(button(rowOf("service:s1"), "Editar")).toBeNull(); // a linha mostra o spinner
    await act(async () => grava.resolve({ ok: true }));
    expect(setServicePayment).toHaveBeenCalledTimes(1);
  });
});

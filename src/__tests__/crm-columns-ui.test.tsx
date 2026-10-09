// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { LeadRow } from "@/app/actions/crm-leads";

const { saveCrmColumn, deleteCrmColumn, moveLeadBoard, refresh, push, toast } = vi.hoisted(() => ({
  saveCrmColumn: vi.fn(), deleteCrmColumn: vi.fn(), moveLeadBoard: vi.fn(), refresh: vi.fn(), push: vi.fn(), toast: vi.fn(),
}));
vi.mock("@/app/actions/crm-colunas", () => ({ saveCrmColumn, deleteCrmColumn, moveLeadBoard }));
vi.mock("@/app/actions/crm-leads", () => ({ createLead: vi.fn(), updateLead: vi.fn(), reorderLeads: vi.fn() }));
vi.mock("@/app/actions/crm-excluir", () => ({ excluirRegistoCrm: vi.fn() }));
vi.mock("next/navigation", () => ({ useRouter: () => ({ refresh, push }) }));
vi.mock("@/components/ui/toast", () => ({ useToast: () => ({ toast }) }));
import { PipelineClient } from "@/app/(dashboard)/dashboard/crm/_components/pipeline-client";

const EXTRA = "11111111-1111-4111-8111-111111111111";
const LEAD = "22222222-2222-4222-8222-222222222222";
const column = { id: EXTRA, name: "A acompanhar", color: "blue" as const };
const lead: LeadRow = {
  id: LEAD, name: "Lead ganha", stage: "ganho", board_order: 0, created_at: "2026-10-01",
  lead_type: "empresa", contact_name: null, email: null, phone: null, nif: null, address: null,
  source: null, source_detail: null, owner_id: null, owner_name: null, estimated_value: null,
  estimated_value_kind: "mensal", next_action_at: null, next_action_note: null, service_type: null,
  frequency_hint: null, notes: null, lost_reason: null, lost_reason_notes: null, converted_client_id: "cliente",
};
let root: Root, host: HTMLDivElement;
beforeEach(() => {
  vi.clearAllMocks();
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  host = document.createElement("div"); document.body.append(host); root = createRoot(host);
  saveCrmColumn.mockResolvedValue({ ok: true, data: column });
  deleteCrmColumn.mockResolvedValue({ ok: true, data: { id: EXTRA } });
  moveLeadBoard.mockResolvedValue({ ok: true, data: { stage: "ganho", extra_column_id: EXTRA } });
});
afterEach(() => { act(() => root.unmount()); host.remove(); });
function mount(row: LeadRow = lead) {
  act(() => root.render(<PipelineClient leads={[row]} colunasExtras={[column]} erro={null} membros={[]} clientes={[]} />));
}
async function click(label: string) {
  const button = [...document.querySelectorAll("button")].find((b) => b.textContent === label || b.getAttribute("aria-label") === label);
  expect(button).toBeDefined(); await act(async () => button!.click());
}
function fill(input: HTMLInputElement, value: string) {
  Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(input,value);
  input.dispatchEvent(new Event("input", { bubbles: true }));
}

describe("colunas livres no quadro", () => {
  it("cria uma coluna com nome e cor e mantém o formulário em caso de erro", async () => {
    mount(); await click("Nova coluna");
    const form = document.querySelector("form[role='dialog']")!;
    await act(async () => fill(form.querySelector("input")!,"Para confirmar"));
    saveCrmColumn.mockResolvedValueOnce({ ok: false, error: { message: "Falhou" } });
    await act(async () => form.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true })));
    expect(saveCrmColumn).toHaveBeenCalledWith(null, { name: "Para confirmar", color: "blue" });
    expect(document.querySelector("form[role='dialog']")).not.toBeNull();
    expect(toast).toHaveBeenCalledWith("Falhou","error");
    await act(async () => form.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true })));
    expect(document.querySelector("form[role='dialog']")).toBeNull();
    expect(refresh).toHaveBeenCalledOnce();
  });

  it("renomeia uma coluna existente", async () => {
    mount(); await click("Editar coluna A acompanhar");
    const form = document.querySelector("form[role='dialog']")!;
    await act(async () => fill(form.querySelector("input")!,"Seguimento"));
    await act(async () => form.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true })));
    expect(saveCrmColumn).toHaveBeenCalledWith(EXTRA, { name: "Seguimento", color: "blue" });
  });

  it("organiza uma lead ganha pelo seletor sem iniciar uma conversão", async () => {
    mount();
    const picker = host.querySelector("select[aria-label='Organizar Lead ganha']") as HTMLSelectElement;
    await act(async () => { picker.value=EXTRA; picker.dispatchEvent(new Event("change", { bubbles:true })); });
    expect(moveLeadBoard).toHaveBeenCalledWith({ leadId: LEAD, expectedStage: "ganho", expectedExtraColumnId: null, extraColumnId: EXTRA, stage: "ganho" });
    expect(host.querySelector(`[data-column-key='extra:${EXTRA}']`)!.textContent).toContain("Lead ganha");
    expect(push).not.toHaveBeenCalled();
  });

  it("arrasta uma lead ganha para uma coluna extra", async () => {
    mount();
    [...host.querySelectorAll("[data-column-key]")].forEach((el,i) => {
      el.getBoundingClientRect = () => ({ left:i*300, right:i*300+260, top:0, bottom:400, width:260, height:400, x:i*300, y:0, toJSON:() => ({}) });
    });
    const name = [...host.querySelectorAll("span")].find((el) => el.textContent === "Lead ganha")!;
    await act(async () => {
      name.dispatchEvent(new MouseEvent("pointerdown", { bubbles:true, clientX:1550, clientY:100 }));
      window.dispatchEvent(new MouseEvent("pointermove", { clientX:1900,clientY:100 }));
      window.dispatchEvent(new MouseEvent("pointerup", { clientX:1900,clientY:100 }));
    });
    expect(moveLeadBoard).toHaveBeenCalledWith(expect.objectContaining({ extraColumnId: EXTRA, expectedStage:"ganho" }));
    expect(push).not.toHaveBeenCalled();
  });

  it("um conflito de movimento repõe o cartão", async () => {
    moveLeadBoard.mockResolvedValue({ ok: false, error: { message:"O cartão mudou" } });
    mount();
    const picker = host.querySelector("select[aria-label='Organizar Lead ganha']") as HTMLSelectElement;
    await act(async () => { picker.value=EXTRA; picker.dispatchEvent(new Event("change", { bubbles:true })); });
    expect(host.querySelector("[data-column-key='ganho']")!.textContent).toContain("Lead ganha");
    expect(toast).toHaveBeenCalledWith("O cartão mudou","error");
  });

  it("confirma a remoção da coluna, sem chamar exclusão de cartões", async () => {
    mount({ ...lead, extra_column_id: EXTRA }); await click("Apagar coluna A acompanhar");
    expect(document.body.textContent).toContain("Nenhum cartão é excluído");
    expect(deleteCrmColumn).not.toHaveBeenCalled();
    await click("Apagar coluna");
    expect(deleteCrmColumn).toHaveBeenCalledWith(EXTRA);
    expect(refresh).toHaveBeenCalledOnce();
  });
});

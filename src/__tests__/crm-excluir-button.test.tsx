// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { excluirRegistoCrm, refresh, toast } = vi.hoisted(() => ({
  excluirRegistoCrm: vi.fn(), refresh: vi.fn(), toast: vi.fn(),
}));
vi.mock("@/app/actions/crm-excluir", () => ({ excluirRegistoCrm }));
vi.mock("next/navigation", () => ({ useRouter: () => ({ refresh }) }));
vi.mock("@/components/ui/toast", () => ({ useToast: () => ({ toast }) }));
vi.mock("@/app/actions/crm-leads", () => ({
  createLead: vi.fn(), updateLead: vi.fn(), moveLeadStage: vi.fn(), reorderLeads: vi.fn(),
}));
import { ExcluirRegistoButton } from "@/components/crm/excluir-registo-button";
import { PipelineClient } from "@/app/(dashboard)/dashboard/crm/_components/pipeline-client";
import type { LeadRow } from "@/app/actions/crm-leads";

let root: Root;
let host: HTMLDivElement;
beforeEach(() => {
  vi.clearAllMocks();
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
});
afterEach(() => { act(() => root.unmount()); host.remove(); });

async function click(label: string) {
  const button = [...host.querySelectorAll("button")].find((b) => b.textContent === label);
  expect(button).toBeDefined();
  await act(async () => button!.click());
}
function mount(onDeleted = vi.fn()) {
  act(() => root.render(<ExcluirRegistoButton tipo="lead" id="id" nome="Teste" onDeleted={onDeleted} />));
  return onDeleted;
}

describe("botão de excluir", () => {
  it("mostra Excluir em todas as colunas e no cartão aberto, incluindo ganho", async () => {
    const leads = ["novo", "contactado", "visita_agendada", "orcamento_enviado", "ganho", "perdido"].map((stage, i) => ({
      id: `lead-${i}`, name: `Cartão ${stage}`, stage, created_at: "2026-10-01",
      board_order: 0, lead_type: "empresa", estimated_value_kind: "mensal",
      converted_client_id: stage === "ganho" ? "cliente" : null,
      contact_name: null, email: null, phone: null, nif: null, address: null,
      source: null, source_detail: null, owner_id: null, owner_name: null,
      estimated_value: null, next_action_at: null, next_action_note: null,
      service_type: null, frequency_hint: null, notes: null,
      lost_reason: null, lost_reason_notes: null,
    } satisfies LeadRow));
    act(() => root.render(<PipelineClient leads={leads} erro={null} membros={[]} clientes={[]} />));
    for (const lead of leads) {
      expect(host.querySelector(`button[aria-label="Excluir ${lead.name}"]`)).not.toBeNull();
    }
    const name = [...host.querySelectorAll("span")].find((el) => el.textContent === "Cartão ganho");
    await act(async () => name!.click());
    expect(document.querySelector("form button[aria-label='Excluir Cartão ganho']")).not.toBeNull();
    await act(async () => (document.querySelector("form button[aria-label='Excluir Cartão ganho']") as HTMLButtonElement).click());
    expect(document.querySelector("form button[type='submit']")).not.toBeNull();
    expect(excluirRegistoCrm).not.toHaveBeenCalled();
  });

  it("informa sobre a cascata e permite cancelar sem excluir", async () => {
    mount();
    await click("Excluir");
    expect(host.textContent).toContain("as visitas e os orçamentos associados");
    expect(excluirRegistoCrm).not.toHaveBeenCalled();
    await click("Cancelar");
    expect(excluirRegistoCrm).not.toHaveBeenCalled();
    expect(host.textContent).not.toContain("Excluir Teste?");
  });

  it("espera pela resposta e bloqueia duplicações durante a exclusão", async () => {
    let resolve!: (value: unknown) => void;
    excluirRegistoCrm.mockReturnValue(new Promise((r) => { resolve = r; }));
    const onDeleted = mount();
    await click("Excluir");
    const buttons = [...host.querySelectorAll("button")];
    await act(async () => buttons[buttons.length - 1].click());
    expect(host.textContent).toContain("A processar...");
    expect(host.querySelectorAll("button:disabled").length).toBe(2);
    expect(onDeleted).not.toHaveBeenCalled();
    expect(refresh).not.toHaveBeenCalled();
    await act(async () => resolve({ ok: true, data: { id: "id" } }));
    expect(excluirRegistoCrm).toHaveBeenCalledExactlyOnceWith("lead", "id");
    expect(onDeleted).toHaveBeenCalledOnce();
    expect(refresh).toHaveBeenCalledOnce();
  });

  it("mantém o registo em caso de erro", async () => {
    excluirRegistoCrm.mockResolvedValue({ ok: false, error: { message: "Recusado" } });
    const onDeleted = mount();
    await click("Excluir");
    const buttons = [...host.querySelectorAll("button")];
    await act(async () => buttons[buttons.length - 1].click());
    expect(toast).toHaveBeenCalledWith("Recusado", "error");
    expect(onDeleted).not.toHaveBeenCalled();
    expect(refresh).not.toHaveBeenCalled();
  });
});

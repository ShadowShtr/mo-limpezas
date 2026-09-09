// @vitest-environment jsdom
// ============================================================================
// FOLHA — a sheet de ajuste: vencimento base e líquido escrito à mão
// ============================================================================
//
// O que se prova aqui é o comportamento dos controlos, não a aparência.
//
// A justificação do líquido é exigida em três sítios independentes: nesta
// interface, na server action, e numa CHECK da própria tabela. As três são
// precisas — a UI para que a pessoa perceba antes de carregar, a action
// porque quem chama pode não ser este formulário, e a constraint porque o
// SQL cru não passa por nenhuma das outras duas.
//
// Este ficheiro cobre a primeira. `payroll-safety-postgres` cobre as outras.
// ============================================================================
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";

const adjustPayrollRecord = vi.fn(async () => ({ ok: true as const }));

vi.mock("@/app/actions/payroll", () => ({
  adjustPayrollRecord: (...args: unknown[]) =>
    (adjustPayrollRecord as unknown as (...a: unknown[]) => Promise<{ ok: true }>)(...args),
}));

type Registo = import("@/app/actions/payroll").PayrollRecord;

const REGISTO: Registo = {
  id: "r1",
  collaborator_id: "c1",
  full_name: "Ana",
  avatar_url: null,
  period_year: 2026,
  period_month: 9,
  contracted_hours: 168,
  worked_hours: 0,
  overtime_hours: 0,
  absence_hours: 0,
  days_worked: 21,
  hourly_rate: 9.5,
  base_salary: 0,
  gross_salary: 0,
  meal_allowance: 201.6,
  overtime_bonus: 0,
  overtime_rate_pct: 25,
  absence_deductions: 0,
  other_additions: 0,
  other_deductions: 0,
  net_salary: 201.6,
  net_salary_override: null,
  net_salary_override_reason: null,
  notes: null,
  status: "rascunho",
  paid_at: null,
};

let container: HTMLDivElement;
let root: Root;

async function montar(record: Registo = REGISTO) {
  const { PayrollEditSheet } = await import(
    "@/app/(dashboard)/dashboard/folha-pagamento/_components/payroll-edit-sheet"
  );
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  await act(async () => {
    root.render(
      <PayrollEditSheet record={record} onClose={() => {}} onSaved={() => {}} />,
    );
  });
}

/** Escreve num input como o utilizador faria, disparando o onChange do React. */
async function escrever(el: HTMLInputElement | HTMLTextAreaElement, valor: string) {
  const proto = el instanceof HTMLTextAreaElement
    ? window.HTMLTextAreaElement.prototype
    : window.HTMLInputElement.prototype;
  const setter = Object.getOwnPropertyDescriptor(proto, "value")!.set!;
  await act(async () => {
    setter.call(el, valor);
    el.dispatchEvent(new Event("input", { bubbles: true }));
  });
}

const guardar = () =>
  [...container.querySelectorAll("button")].find((b) => b.textContent?.includes("Guardar")) as HTMLButtonElement;

const checkboxOverride = () =>
  container.querySelector('input[type="checkbox"]') as HTMLInputElement;

const inputPorLabel = (texto: string) => {
  const labels = [...container.querySelectorAll("label")];
  const label = labels.find((l) => l.textContent?.includes(texto));
  return label?.parentElement?.querySelector("input, textarea") as HTMLInputElement | HTMLTextAreaElement;
};

describe("sheet de ajuste — vencimento base e líquido à mão", () => {
  beforeEach(() => {
    adjustPayrollRecord.mockClear();
  });

  afterEach(async () => {
    await act(async () => root.unmount());
    container.remove();
  });

  it("por omissão, o líquido não é editável e o Guardar está livre", async () => {
    await montar();
    expect(checkboxOverride().checked).toBe(false);
    expect(guardar().disabled).toBe(false);
  });

  it("ligar a opção parte do valor calculado, e não de um campo vazio", async () => {
    await montar();
    await act(async () => checkboxOverride().click());
    const campo = inputPorLabel("Líquido a pagar") as HTMLInputElement;
    // 0 bruto + 201,60 alimentação = 201,60 — o calculado, não "0,00".
    expect(campo.value).toBe("201.60");
  });

  it("🔴 sem justificação, o Guardar fica bloqueado", async () => {
    await montar();
    await act(async () => checkboxOverride().click());
    await escrever(inputPorLabel("Líquido a pagar") as HTMLInputElement, "250");

    expect(guardar().disabled).toBe(true);
    expect(guardar().title).toMatch(/difere do calculado/i);
    // E carregar não chega à action.
    await act(async () => guardar().click());
    expect(adjustPayrollRecord).not.toHaveBeenCalled();
  });

  it("🔴 com a opção ligada e o campo vazio, o Guardar também fica bloqueado", async () => {
    await montar();
    await act(async () => checkboxOverride().click());
    await escrever(inputPorLabel("Líquido a pagar") as HTMLInputElement, "");

    // Deixar passar aqui gravaria o calculado em silêncio — a interface a
    // decidir por quem tinha ligado a opção de propósito.
    expect(guardar().disabled).toBe(true);
    expect(guardar().title).toMatch(/valor líquido/i);
  });

  it("com valor e justificação, guarda os três campos juntos", async () => {
    await montar();
    await act(async () => checkboxOverride().click());
    await escrever(inputPorLabel("Líquido a pagar") as HTMLInputElement, "250");
    await escrever(inputPorLabel("Porquê") as HTMLTextAreaElement, "acerto combinado");

    expect(guardar().disabled).toBe(false);
    await act(async () => guardar().click());

    expect(adjustPayrollRecord).toHaveBeenCalledTimes(1);
    const [, patch] = adjustPayrollRecord.mock.calls[0] as unknown as [string, Record<string, unknown>];
    expect(patch.net_salary_override).toBe(250);
    expect(patch.net_salary_override_reason).toBe("acerto combinado");
  });

  it("desligar a opção retira o override em vez de o deixar pendurado", async () => {
    await montar({
      ...REGISTO,
      net_salary_override: 250,
      net_salary_override_reason: "acerto",
      net_salary: 250,
    });
    expect(checkboxOverride().checked).toBe(true);

    await act(async () => checkboxOverride().click());
    await act(async () => guardar().click());

    const [, patch] = adjustPayrollRecord.mock.calls[0] as unknown as [string, Record<string, unknown>];
    expect(patch.net_salary_override).toBeNull();
    expect(patch.net_salary_override_reason).toBeNull();
  });

  it("🔴 o vencimento base substitui o bruto por horas na pré-visualização", async () => {
    await montar();
    await escrever(inputPorLabel("Vencimento base do mês") as HTMLInputElement, "870");
    await act(async () => guardar().click());

    const [, patch] = adjustPayrollRecord.mock.calls[0] as unknown as [string, Record<string, unknown>];
    expect(patch.base_salary).toBe(870);
    // O texto do total tem de refletir o base, não 0,00 € de bruto.
    expect(container.textContent).toContain("870,00 € bruto (base)");
  });

  it("a zero, o vencimento base explica que o cálculo é às horas", async () => {
    await montar();
    expect(container.textContent).toMatch(/o bruto é calculado pelas horas/i);
  });
});

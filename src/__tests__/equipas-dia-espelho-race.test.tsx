// @vitest-environment jsdom
// ============================================================================
// Equipas — o dia mostrado é sempre o do último pedido
// ============================================================================
//
// 🔴 O defeito: o efeito cancelava com `clearTimeout`, o que só apanha um
//    `load` que ainda não arrancou. Depois de `carregarDiaEspelho(A)` partir,
//    mudar de data deixava dois pedidos em voo e a ordem de resposta não é
//    garantida:
//
//        pede A → pede B → responde B → setDia(B) → responde A → setDia(A)
//
//    O ecrã ficava com a composição de A por baixo de um input a dizer B.
//
// Um teste que lesse o ficheiro à procura de um `useRef` provaria que alguém
// escreveu um contador, não que a resposta obsoleta deixou de escrever. Por
// isso o componente é montado a sério e as promessas da server action são
// resolvidas à mão, na ordem má de propósito.
// ============================================================================

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import type { DiaAlocacoes } from "@/lib/equipas/tipos";
import type { AusenciaDia } from "@/lib/equipas/ausencias";

const carregarDiaEspelho = vi.hoisted(() => vi.fn());

vi.mock("@/app/actions/equipas-dia-espelho", () => ({
  carregarDiaEspelho: (...a: unknown[]) => carregarDiaEspelho(...a),
}));

import { EquipasDiaEfetivo } from "@/app/(dashboard)/dashboard/equipas/_components/effective-day";

type DiaEspelho = DiaAlocacoes & { ausencias: AusenciaDia[] };

const DIA_A = "2026-09-10";
const DIA_B = "2026-09-11";

/** Um dia com uma pessoa cujo nome identifica de que data veio a resposta. */
function dia(date: string, nome: string): DiaEspelho {
  return {
    date,
    snapshot: `snap-${date}`,
    equipas: [],
    pessoas: [{ id: "p1", full_name: nome, avatar_url: null }],
    viaturasDisponiveis: [],
    efetiva: [{ collaborator_id: "p1", effective_team_id: null, permanent_team_id: null, origem: "permanent", ausente: false }],
    viaturas: [],
    ausencias: [],
  };
}

/** Uma promessa que só resolve quando o teste mandar. */
function adiada<T>() {
  let resolver!: (value: T) => void;
  const promise = new Promise<T>((resolve) => { resolver = resolve; });
  return { promise, resolve: resolver };
}

let container: HTMLDivElement;
let root: Root;

beforeEach(() => {
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  carregarDiaEspelho.mockReset();
});

afterEach(() => {
  act(() => { root.unmount(); });
  container.remove();
});

/**
 * O efeito dispara o `load` dentro de um `setTimeout(..., 0)`. Resolver
 * microtarefas não chega: é preciso deixar passar um macrotask real.
 */
async function correrTimers() {
  await act(async () => { await new Promise((r) => setTimeout(r, 0)); });
}

/** Monta a vista e devolve o input de data já ligado. */
async function montar() {
  await act(async () => {
    root.render(<EquipasDiaEfetivo companyId="empresa-1" initialDate={DIA_A} />);
  });
  await correrTimers();
  const input = container.querySelector('input[type="date"]') as HTMLInputElement;
  expect(input).toBeTruthy();
  return input;
}

/** Muda a data pelo input, como uma pessoa faria. */
async function escolherData(input: HTMLInputElement, valor: string) {
  await act(async () => {
    const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, "value")!.set!;
    setter.call(input, valor);
    input.dispatchEvent(new Event("input", { bubbles: true }));
  });
  await correrTimers();
}

describe("Equipas — resposta obsoleta não escreve estado", () => {
  it("A responde depois de B e a UI continua em B", async () => {
    const pedidoA = adiada<{ ok: true; dia: DiaEspelho }>();
    const pedidoB = adiada<{ ok: true; dia: DiaEspelho }>();
    carregarDiaEspelho
      .mockReturnValueOnce(pedidoA.promise)
      .mockReturnValueOnce(pedidoB.promise);

    const input = await montar();
    await escolherData(input, DIA_B);
    expect(carregarDiaEspelho).toHaveBeenCalledTimes(2);

    // B responde primeiro.
    await act(async () => { pedidoB.resolve({ ok: true, dia: dia(DIA_B, "PESSOA_DE_B") }); });
    expect(container.textContent).toContain("PESSOA_DE_B");

    // A responde depois — e não pode mexer em nada.
    await act(async () => { pedidoA.resolve({ ok: true, dia: dia(DIA_A, "PESSOA_DE_A") }); });
    expect(container.textContent).toContain("PESSOA_DE_B");
    expect(container.textContent).not.toContain("PESSOA_DE_A");
    expect(input.value).toBe(DIA_B);
  });

  it("erro de um pedido antigo não substitui o estado válido do novo", async () => {
    const pedidoA = adiada<{ ok: false; error: string }>();
    const pedidoB = adiada<{ ok: true; dia: DiaEspelho }>();
    carregarDiaEspelho
      .mockReturnValueOnce(pedidoA.promise)
      .mockReturnValueOnce(pedidoB.promise);

    const input = await montar();
    await escolherData(input, DIA_B);

    await act(async () => { pedidoB.resolve({ ok: true, dia: dia(DIA_B, "PESSOA_DE_B") }); });
    expect(container.textContent).toContain("PESSOA_DE_B");

    // O erro chega tarde. Não pode apagar o dia bom nem pintar um alerta.
    await act(async () => { pedidoA.resolve({ ok: false, error: "FALHA_ANTIGA" }); });
    expect(container.textContent).toContain("PESSOA_DE_B");
    expect(container.textContent).not.toContain("FALHA_ANTIGA");
  });

  it("o refresh manual em voo não ultrapassa a mudança de data que veio depois", async () => {
    // O botão usa o mesmo `load` que o efeito, e o input de data não fica
    // desactivado enquanto ele corre. Uma guarda presa ao efeito deixava esta
    // corrida de fora — e é metade do defeito.
    const inicial = adiada<{ ok: true; dia: DiaEspelho }>();
    const refresh = adiada<{ ok: true; dia: DiaEspelho }>();
    const porData = adiada<{ ok: true; dia: DiaEspelho }>();
    carregarDiaEspelho
      .mockReturnValueOnce(inicial.promise)
      .mockReturnValueOnce(refresh.promise)
      .mockReturnValueOnce(porData.promise);

    const input = await montar();
    await act(async () => { inicial.resolve({ ok: true, dia: dia(DIA_A, "PESSOA_INICIAL") }); });

    const botao = container.querySelector('button[aria-label="Atualizar composição efetiva"]') as HTMLButtonElement;
    expect(botao.disabled).toBe(false);
    await act(async () => { botao.dispatchEvent(new MouseEvent("click", { bubbles: true })); });

    // Com o refresh ainda em voo, a data muda.
    await escolherData(input, DIA_B);
    expect(carregarDiaEspelho).toHaveBeenCalledTimes(3);

    await act(async () => { porData.resolve({ ok: true, dia: dia(DIA_B, "PESSOA_DE_B") }); });
    expect(container.textContent).toContain("PESSOA_DE_B");

    // O refresh responde tarde. Traz o dia antigo e não pode entrar.
    await act(async () => { refresh.resolve({ ok: true, dia: dia(DIA_A, "DO_REFRESH_TARDIO") }); });
    expect(container.textContent).toContain("PESSOA_DE_B");
    expect(container.textContent).not.toContain("DO_REFRESH_TARDIO");
    expect(input.value).toBe(DIA_B);
  });

  it("A → B → C com respostas fora de ordem: fica sempre C", async () => {
    // Três em voo, e a resolver na pior ordem possível: C, depois A, depois B.
    // A ordem é controlada pelo teste, não por temporização — o defeito não se
    // prova com sorte.
    const DIA_C = "2026-09-12";
    const pedidoA = adiada<{ ok: true; dia: DiaEspelho }>();
    const pedidoB = adiada<{ ok: true; dia: DiaEspelho }>();
    const pedidoC = adiada<{ ok: true; dia: DiaEspelho }>();
    carregarDiaEspelho
      .mockReturnValueOnce(pedidoA.promise)
      .mockReturnValueOnce(pedidoB.promise)
      .mockReturnValueOnce(pedidoC.promise);

    const input = await montar();
    await escolherData(input, DIA_B);
    await escolherData(input, DIA_C);
    expect(carregarDiaEspelho).toHaveBeenCalledTimes(3);

    await act(async () => { pedidoC.resolve({ ok: true, dia: dia(DIA_C, "PESSOA_DE_C") }); });
    expect(container.textContent).toContain("PESSOA_DE_C");

    await act(async () => { pedidoA.resolve({ ok: true, dia: dia(DIA_A, "PESSOA_DE_A") }); });
    await act(async () => { pedidoB.resolve({ ok: true, dia: dia(DIA_B, "PESSOA_DE_B") }); });

    expect(container.textContent).toContain("PESSOA_DE_C");
    expect(container.textContent).not.toContain("PESSOA_DE_A");
    expect(container.textContent).not.toContain("PESSOA_DE_B");
    expect(input.value).toBe(DIA_C);
  });

  it("o spinner não fica preso quando só chegam respostas obsoletas", async () => {
    // Se uma resposta obsoleta desligasse o spinner, o ecrã dir-se-ia pronto
    // com o pedido bom ainda a caminho. Se nenhuma o desligasse, ficaria preso
    // para sempre. Tem de ser exactamente a última a mandar.
    const pedidoA = adiada<{ ok: true; dia: DiaEspelho }>();
    const pedidoB = adiada<{ ok: false; error: string }>();
    carregarDiaEspelho
      .mockReturnValueOnce(pedidoA.promise)
      .mockReturnValueOnce(pedidoB.promise);

    const input = await montar();
    await escolherData(input, DIA_B);

    const botao = () => container.querySelector('button[aria-label="Atualizar composição efetiva"]') as HTMLButtonElement;
    await act(async () => { pedidoA.resolve({ ok: true, dia: dia(DIA_A, "PESSOA_DE_A") }); });
    expect(botao().disabled, "resposta obsoleta não pode desligar o spinner").toBe(true);

    // O pedido em curso falha — e é ele que tem direito a desligar o spinner.
    await act(async () => { pedidoB.resolve({ ok: false, error: "FALHA_DE_B" }); });
    expect(botao().disabled, "o pedido mais recente desliga o spinner, mesmo falhando").toBe(false);
    expect(container.textContent).toContain("FALHA_DE_B");
  });

  it("resposta obsoleta não desliga o spinner do pedido em curso", async () => {
    // Se `setLoading(false)` escapasse à guarda, o ecrã dir-se-ia carregado
    // enquanto o pedido bom ainda vinha a caminho.
    const pedidoA = adiada<{ ok: true; dia: DiaEspelho }>();
    const pedidoB = adiada<{ ok: true; dia: DiaEspelho }>();
    carregarDiaEspelho
      .mockReturnValueOnce(pedidoA.promise)
      .mockReturnValueOnce(pedidoB.promise);

    const input = await montar();
    await escolherData(input, DIA_B);

    await act(async () => { pedidoA.resolve({ ok: true, dia: dia(DIA_A, "PESSOA_DE_A") }); });

    const botao = container.querySelector('button[aria-label="Atualizar composição efetiva"]') as HTMLButtonElement;
    expect(botao.disabled).toBe(true);
    expect(container.textContent).not.toContain("PESSOA_DE_A");

    await act(async () => { pedidoB.resolve({ ok: true, dia: dia(DIA_B, "PESSOA_DE_B") }); });
    expect(botao.disabled).toBe(false);
    expect(container.textContent).toContain("PESSOA_DE_B");
  });
});

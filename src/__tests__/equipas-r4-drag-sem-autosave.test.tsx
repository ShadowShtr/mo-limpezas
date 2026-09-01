// @vitest-environment jsdom
// ============================================================================
// Equipas R4 — arrastar não escreve, e Disponível aceita largar
// ============================================================================
//
// 🔴 O defeito que este ficheiro fecha foi relatado com prints pelo
//    proprietário e confirmado no código: `handleDragEnd` chamava
//    `moveCollaboratorToTeam` a meio do gesto.
//
//    Um teste estático — procurar a chamada no ficheiro — provaria que alguém
//    apagou uma linha. Não prova que o ecrã deixou de escrever: o mesmo efeito
//    pode voltar por um `useEffect` que sincronize, por um handler noutro
//    ficheiro, ou por um refetch que a interface interprete como confirmação.
//
//    Por isso este teste monta o modal a sério, espia TODAS as server actions,
//    faz os arrastos, e conta as chamadas.
//
// O `@dnd-kit` não corre no jsdom sem uma simulação de ponteiro que seria
// frágil e mediria a biblioteca em vez do nosso código. O que se exercita é o
// contrato que a biblioteca invoca — `onDragEnd` com `active`/`over` — apanhado
// do `DndContext` real através de um duplo que o expõe. O componente por baixo
// é o verdadeiro.
// ============================================================================

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";

// ─── Espiões das server actions ─────────────────────────────────────────────

const carregarDia = vi.hoisted(() => vi.fn());
const guardarDiaEquipas = vi.hoisted(() => vi.fn());

vi.mock("@/app/actions/equipas-r4", () => ({
  carregarDia: (...a: unknown[]) => carregarDia(...a),
  guardarDiaEquipas: (...a: unknown[]) => guardarDiaEquipas(...a),
  guardarEquipaPermanente: vi.fn(),
  arquivarEquipa: vi.fn(),
}));

/**
 * 🔴 O `DndContext` é substituído por um duplo que guarda o `onDragEnd` real do
 *    componente e o expõe. Não se substitui o `handleDragEnd`: esse é o código
 *    em teste. O que se substitui é só o mecanismo de gesto do browser.
 */
const dnd = vi.hoisted(() => ({ onDragEnd: null as ((e: unknown) => void) | null }));

vi.mock("@dnd-kit/core", () => ({
  DndContext: ({ children, onDragEnd }: { children: React.ReactNode; onDragEnd: (e: unknown) => void }) => {
    dnd.onDragEnd = onDragEnd;
    return children;
  },
  DragOverlay: () => null,
  PointerSensor: class {},
  useSensor: () => ({}),
  useSensors: () => [],
  useDraggable: () => ({ attributes: {}, listeners: {}, setNodeRef: () => {}, isDragging: false }),
  useDroppable: () => ({ isOver: false, setNodeRef: () => {} }),
}));

import { TeamAllocationModal, ZONA_DISPONIVEL } from
  "@/app/(dashboard)/dashboard/calendario/_components/team-allocation-modal";

const EMP = "11111111-1111-4111-8111-111111111111";
const T1 = "aaaaaaaa-0000-4000-8000-000000000001";
const T2 = "aaaaaaaa-0000-4000-8000-000000000002";
const T3 = "aaaaaaaa-0000-4000-8000-000000000003";
const A = "bbbbbbbb-0000-4000-8000-00000000000a";
const B = "bbbbbbbb-0000-4000-8000-00000000000b";
const C = "bbbbbbbb-0000-4000-8000-00000000000c";

/**
 * O dia inicial: A e B na Equipa 1, C sem equipa nenhuma.
 * A Equipa 1 tem a viatura 1.
 */
const DIA = {
  date: "2026-08-31",
  snapshot: "S0",
  equipas: [
    { id: T1, name: "Equipa 1", color: "#16A34A", revision: 3 },
    { id: T2, name: "Equipa 2", color: "#0EA5E9", revision: 1 },
    { id: T3, name: "Equipa 3", color: "#F59E0B", revision: 1 },
  ],
  pessoas: [
    { id: A, full_name: "Ana Alves", avatar_url: null },
    { id: B, full_name: "Bruna Barros", avatar_url: null },
    { id: C, full_name: "Carla Costa", avatar_url: null },
  ],
  viaturasDisponiveis: [
    { id: "v1", model: "Kangoo", plate: "AA-01-AA" },
    { id: "v2", model: "Partner", plate: "BB-02-BB" },
  ],
  efetiva: [
    { collaborator_id: A, effective_team_id: T1, permanent_team_id: T1, origem: "permanent", ausente: false },
    { collaborator_id: B, effective_team_id: T1, permanent_team_id: T1, origem: "permanent", ausente: false },
    { collaborator_id: C, effective_team_id: null, permanent_team_id: null, origem: "sem_equipa", ausente: false },
  ],
  viaturas: [{ team_id: T1, vehicle_id: "v1", driver_id: null }],
} as const;

let container: HTMLDivElement;
let root: Root;

beforeEach(() => {
  vi.clearAllMocks();
  dnd.onDragEnd = null;
  carregarDia.mockResolvedValue({ ok: true, dia: structuredClone(DIA) });
  guardarDiaEquipas.mockResolvedValue({ ok: true, snapshot: "S1" });
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
  vi.restoreAllMocks();
});

async function montar() {
  await act(async () => {
    root.render(
      <TeamAllocationModal
        open
        onClose={() => {}}
        companyId={EMP}
        selectedDate={new Date("2026-08-31T09:00:00Z")}
        teams={[]}
      />,
    );
  });
}

/** Um arrasto: o mesmo formato que o `@dnd-kit` entrega ao `onDragEnd`. */
async function arrastar(collaboratorId: string, paraId: string) {
  await act(async () => {
    dnd.onDragEnd?.({
      active: { id: `member-${collaboratorId}`, data: { current: { collaboratorId, fromTeamId: "", fullName: "x" } } },
      over: { id: paraId },
    });
  });
}

const chipsDe = (testid: string) =>
  Array.from(container.querySelectorAll(`[data-testid="${testid}"] [data-testid^="chip-"]`))
    .map((el) => el.getAttribute("data-testid")!.replace("chip-", ""));

const escritas = () => guardarDiaEquipas.mock.calls.length;

// ═══════════════════════════════════════════════════════════════════════════

describe("🔴 arrastar NÃO escreve", () => {
  it("o estado inicial vem da base, e o modal não escreveu nada ao abrir", async () => {
    await montar();
    expect(carregarDia).toHaveBeenCalledTimes(1);
    expect(escritas()).toBe(0);
    expect(chipsDe(`equipa-${T1}`).sort()).toEqual([A, B].sort());
    expect(chipsDe("zona-disponivel")).toEqual([C]);
  });

  it("🔴 quatro alterações seguidas: DB_WRITES = 0, e o rascunho mostra tudo", async () => {
    await montar();

    await arrastar(A, T2);                 // equipa → equipa
    await arrastar(B, ZONA_DISPONIVEL);    // equipa → Disponível
    await arrastar(C, T3);                 // Disponível → equipa

    // E duas mudanças de viatura, que também são rascunho.
    const seletor = container.querySelector<HTMLSelectElement>(
      `select[aria-label="Viatura de Equipa 1"]`)!;
    await act(async () => {
      seletor.value = "v2";
      seletor.dispatchEvent(new Event("change", { bubbles: true }));
    });

    // 🔴 A asserção que fecha o defeito.
    expect(escritas(), "nenhum arrasto pode escrever").toBe(0);
    // E não houve refetch «de confirmação» nenhum.
    expect(carregarDia, "arrastar não relê a base").toHaveBeenCalledTimes(1);

    // O rascunho mostra tudo.
    expect(chipsDe(`equipa-${T1}`)).toEqual([]);
    expect(chipsDe(`equipa-${T2}`)).toEqual([A]);
    expect(chipsDe(`equipa-${T3}`)).toEqual([C]);
    expect(chipsDe("zona-disponivel")).toEqual([B]);
    expect(container.querySelector('[data-testid="indicador-por-guardar"]')).not.toBeNull();
  });

  it("🔴 Guardar faz UMA chamada, com o rascunho final e o snapshot esperado", async () => {
    await montar();
    await arrastar(A, T2);
    await arrastar(B, ZONA_DISPONIVEL);
    await arrastar(C, T3);

    const botao = Array.from(container.querySelectorAll("button"))
      .find((b) => b.textContent?.includes("Guardar alocações"))!;
    await act(async () => { botao.click(); });

    expect(guardarDiaEquipas).toHaveBeenCalledTimes(1);
    const payload = guardarDiaEquipas.mock.calls[0][0] as {
      expectedSnapshot: string;
      overrides: Array<{ collaborator_id: string; team_id: string | null }>;
    };
    expect(payload.expectedSnapshot, "o token de concorrência vai no pedido").toBe("S0");

    const porPessoa = Object.fromEntries(payload.overrides.map((o) => [o.collaborator_id, o.team_id]));
    expect(porPessoa[A]).toBe(T2);
    // 🔴 `null` tem de sobreviver à travessia: é o stand by explícito. Um
    //    `filter(Boolean)` distraído transformá-lo-ia em «sem decisão», e a
    //    Bruna voltaria à Equipa 1 sem ninguém pedir.
    expect(porPessoa).toHaveProperty(B);
    expect(porPessoa[B]).toBeNull();
    expect(porPessoa[C]).toBe(T3);
  });

  it("voltar ao sítio de origem RETIRA o override, em vez de escrever um igual", async () => {
    // A diferença importa no dia seguinte: um override a apontar para a equipa
    // permanente fixaria a decisão sem necessidade.
    await montar();
    await arrastar(A, T2);
    await arrastar(A, T1);

    const botao = Array.from(container.querySelectorAll("button"))
      .find((b) => b.textContent?.includes("Guardar alocações"))!;
    await act(async () => { botao.click(); });

    const payload = guardarDiaEquipas.mock.calls[0][0] as {
      overrides: Array<{ collaborator_id: string }>;
    };
    expect(payload.overrides.map((o) => o.collaborator_id)).not.toContain(A);
  });
});

describe("🔴 Disponível é uma zona de largar, sempre presente", () => {
  it("existe mesmo quando está vazia, e convida a largar", async () => {
    carregarDia.mockResolvedValue({
      ok: true,
      dia: { ...structuredClone(DIA), efetiva: DIA.efetiva.filter((l) => l.collaborator_id !== C) },
    });
    await montar();
    const zona = container.querySelector('[data-testid="zona-disponivel"]')!;
    expect(zona, "a caixa tem de existir com zero pessoas").not.toBeNull();
    expect(zona.textContent).toContain("Arraste pessoas aqui");
  });

  it("🔴 largar alguém em Disponível NÃO a tira da equipa permanente", async () => {
    await montar();
    await arrastar(A, ZONA_DISPONIVEL);

    const botao = Array.from(container.querySelectorAll("button"))
      .find((b) => b.textContent?.includes("Guardar alocações"))!;
    await act(async () => { botao.click(); });

    const payload = guardarDiaEquipas.mock.calls[0][0] as {
      overrides: Array<{ collaborator_id: string; team_id: string | null }>;
    };
    // Só se escreve um override do dia. Nada em `team_members` — esta action
    // nem sequer lhe toca.
    expect(payload.overrides.find((o) => o.collaborator_id === A)?.team_id).toBeNull();
  });

  it("🔴 as duas formas de estar em Disponível são distinguíveis no ecrã", async () => {
    await montar();
    await arrastar(A, ZONA_DISPONIVEL);

    const zona = container.querySelector('[data-testid="zona-disponivel"]')!;
    const chipA = zona.querySelector(`[data-testid="chip-${A}"]`)!;
    const chipC = zona.querySelector(`[data-testid="chip-${C}"]`)!;

    // A tem equipa permanente e foi posta em stand by hoje.
    expect(chipA.getAttribute("title")).toContain("stand by hoje");
    // C não tem equipa nenhuma — não é a mesma coisa.
    expect(chipC.getAttribute("title") ?? "").not.toContain("stand by");
  });
});

describe("🔴 fechar com alterações por guardar", () => {
  it("pergunta antes de descartar, e não grava sozinho", async () => {
    const onClose = vi.fn();
    await act(async () => {
      root.render(
        <TeamAllocationModal
          open onClose={onClose} companyId={EMP}
          selectedDate={new Date("2026-08-31T09:00:00Z")} teams={[]}
        />,
      );
    });
    await arrastar(A, T2);

    const fechar = Array.from(container.querySelectorAll("button"))
      .find((b) => b.textContent?.trim() === "Fechar")!;
    await act(async () => { fechar.click(); });

    // Não fechou, não gravou: perguntou.
    expect(onClose).not.toHaveBeenCalled();
    expect(escritas(), "fechar nunca grava por omissão").toBe(0);
    expect(document.body.textContent).toContain("Descartar alterações não guardadas?");
  });

  it("sem alterações, fechar fecha sem perguntar", async () => {
    const onClose = vi.fn();
    await act(async () => {
      root.render(
        <TeamAllocationModal
          open onClose={onClose} companyId={EMP}
          selectedDate={new Date("2026-08-31T09:00:00Z")} teams={[]}
        />,
      );
    });
    const fechar = Array.from(container.querySelectorAll("button"))
      .find((b) => b.textContent?.trim() === "Fechar")!;
    await act(async () => { fechar.click(); });
    expect(onClose).toHaveBeenCalledTimes(1);
  });
});

describe("🔴 conflito de concorrência no ecrã", () => {
  it("a mensagem explica, e o rascunho NÃO se perde", async () => {
    guardarDiaEquipas.mockResolvedValue({
      ok: false, conflito: true,
      error: "Estas alocações foram alteradas por outra pessoa. Atualize para rever antes de guardar.",
    });
    await montar();
    await arrastar(A, T2);

    const botao = Array.from(container.querySelectorAll("button"))
      .find((b) => b.textContent?.includes("Guardar alocações"))!;
    await act(async () => { botao.click(); });

    expect(container.querySelector('[data-testid="mensagem"]')?.textContent)
      .toContain("alteradas por outra pessoa");
    // 🔴 O trabalho da pessoa continua no ecrã. Descartá-lo num conflito
    //    obrigaria a refazer tudo, e é o momento em que ela menos o merece.
    expect(chipsDe(`equipa-${T2}`)).toEqual([A]);
  });
});

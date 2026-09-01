// @vitest-environment jsdom
// ============================================================================
// Equipas R4 — o cenário exacto que o proprietário relatou
// ============================================================================
//
// 🔴 O relato: «Equipa 1 tem 2 pessoas. Edito, desmarco uma, guardo. O cartão
//    continua a dizer 2, ou diz 2 e mostra 1.»
//
//    A causa estava em `saveEquipa`: `DELETE ALL` + `INSERT ALL` em
//    `team_members`, sem `left_at`. Quem saía desaparecia do histórico, e a
//    contagem do cartão dependia de o React ser recarregado no momento certo.
//
// O que este ficheiro prova, no lado da interface:
//
//   1. o que a folha ENVIA ao guardar — a lista final, a revisão e os membros
//      que estavam à frente de quem editou (o token de concorrência composto);
//   2. que a página é RELIDA depois de guardar, em vez de a contagem ser
//      corrigida só no estado local;
//   3. que o cartão conta a partir da mesma fonte que a folha lê.
//
// O lado da base — `left_at`, histórico preservado, B a passar a Disponível no
// calendário — está provado em `equipas-r4-postgres.test.ts`, contra
// PostgreSQL 17 real. Os dois lados juntos fecham o cenário inteiro.
// ============================================================================

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";

const guardarEquipaPermanente = vi.hoisted(() => vi.fn());
const arquivarEquipa = vi.hoisted(() => vi.fn());
const refresh = vi.hoisted(() => vi.fn());

vi.mock("@/app/actions/equipas-r4", () => ({
  guardarEquipaPermanente: (...a: unknown[]) => guardarEquipaPermanente(...a),
  arquivarEquipa: (...a: unknown[]) => arquivarEquipa(...a),
  carregarDia: vi.fn(),
  guardarDiaEquipas: vi.fn(),
}));

vi.mock("next/navigation", () => ({
  useRouter: () => ({ refresh, push: vi.fn(), replace: vi.fn() }),
}));

import { EquipaSheet } from "@/app/(dashboard)/dashboard/equipas/_components/sheet";
import { EquipasGrid } from "@/app/(dashboard)/dashboard/equipas/_components/grid";

const EMP = "11111111-1111-4111-8111-111111111111";
const T1 = "aaaaaaaa-0000-4000-8000-000000000001";
const A = "bbbbbbbb-0000-4000-8000-00000000000a";
const B = "bbbbbbbb-0000-4000-8000-00000000000b";

const PESSOA_A = { id: A, full_name: "Ana Alves", avatar_url: null };
const PESSOA_B = { id: B, full_name: "Bruna Barros", avatar_url: null };

const COLABORADORES = [
  { ...PESSOA_A, role: "colaborador", status: "ativo" },
  { ...PESSOA_B, role: "colaborador", status: "ativo" },
];

/** O PRESTATE do relato: Equipa 1 com duas pessoas activas. */
const EQUIPA_COM_DOIS = {
  id: T1, name: "Equipa 1", color: "#16A34A", active: true,
  leader_id: null, members: [PESSOA_A, PESSOA_B], revision: 3,
};

/** O POSTSTATE: a mesma equipa, relida da view — que já filtra `left_at`. */
const EQUIPA_COM_UM = { ...EQUIPA_COM_DOIS, members: [PESSOA_A], revision: 4 };

let container: HTMLDivElement;
let root: Root;

beforeEach(() => {
  vi.clearAllMocks();
  guardarEquipaPermanente.mockResolvedValue({ ok: true, teamId: T1, revision: 4 });
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
  vi.restoreAllMocks();
});

async function montarFolha(equipa = EQUIPA_COM_DOIS) {
  await act(async () => {
    root.render(
      <EquipaSheet
        companyId={EMP}
        colaboradores={COLABORADORES}
        membershipSnapshot="membership-s0"
        equipa={equipa}
        trigger={<button>Editar equipa</button>}
      />,
    );
  });
  // Abrir a folha.
  const abrir = Array.from(container.querySelectorAll("button"))
    .find((b) => b.textContent?.includes("Editar equipa"))!;
  await act(async () => { abrir.click(); });
}

/** A caixa de uma pessoa dentro da folha, procurada pelo nome. */
function caixaDe(nome: string): HTMLInputElement {
  const alvo = Array.from(document.querySelectorAll("label, button, div"))
    .find((el) => el.textContent?.trim() === nome && el.querySelector("input,svg") !== null);
  const input = (alvo ?? document.body).querySelector<HTMLInputElement>("input[type=checkbox]");
  if (input) return input;

  // A folha usa botões com estado em vez de checkboxes nativas: devolve-se o
  // elemento clicável correspondente, embrulhado no mesmo contrato.
  const clicavel = Array.from(document.querySelectorAll<HTMLElement>("button, [role=button], label"))
    .find((el) => el.textContent?.includes(nome));
  if (!clicavel) throw new Error(`Não encontrei o selector de "${nome}" na folha.`);
  return clicavel as unknown as HTMLInputElement;
}

// ═══════════════════════════════════════════════════════════════════════════

describe("🔴 remover um membro na aba Equipas — o cenário do proprietário", () => {
  it("a folha abre com as DUAS pessoas seleccionadas", async () => {
    await montarFolha();
    expect(document.body.textContent).toContain("Ana Alves");
    expect(document.body.textContent).toContain("Bruna Barros");
  });

  it("🔴 desmarcar B e guardar envia a lista FINAL, com o token de concorrência composto", async () => {
    await montarFolha();

    await act(async () => { (caixaDe("Bruna Barros") as unknown as HTMLElement).click(); });

    const guardar = Array.from(document.querySelectorAll("button"))
      .find((b) => b.textContent?.match(/Guardar|Atualizar|Criar/))!;
    await act(async () => { guardar.click(); });

    expect(guardarEquipaPermanente).toHaveBeenCalledTimes(1);
    const payload = guardarEquipaPermanente.mock.calls[0][0] as {
      teamId: string; expectedRevision: number; expectedMembers: string[];
      expectedMembershipSnapshot: string; memberIds: string[];
    };

    expect(payload.teamId).toBe(T1);
    // A lista final: só A.
    expect(payload.memberIds).toEqual([A]);

    // 🔴 O token de concorrência são DUAS coisas.
    //
    //    A revisão acompanha `teams`; a composição vive em `team_members`.
    //    Alguém pode acrescentar uma pessoa sem tocar na linha da equipa, e a
    //    revisão ficaria igual — por isso os membros que estavam à frente de
    //    quem editou vão também.
    expect(payload.expectedRevision).toBe(3);
    expect(payload.expectedMembers).toEqual([A, B].sort());
    expect(payload.expectedMembershipSnapshot).toBe("membership-s0");
  });

  it("🔴 depois de guardar, a página é RELIDA — a contagem não se corrige só localmente", async () => {
    await montarFolha();
    await act(async () => { (caixaDe("Bruna Barros") as unknown as HTMLElement).click(); });
    const guardar = Array.from(document.querySelectorAll("button"))
      .find((b) => b.textContent?.match(/Guardar|Atualizar|Criar/))!;
    await act(async () => { guardar.click(); });

    // Sem isto, o cartão continuaria a dizer 2 enquanto a base já dizia 1 —
    // que é exactamente o sintoma relatado.
    expect(refresh).toHaveBeenCalled();
  });

  it("num conflito, a folha relê em vez de insistir", async () => {
    guardarEquipaPermanente.mockResolvedValue({
      ok: false, conflito: true,
      error: "Esta equipa foi alterada por outra pessoa. Atualize para rever antes de guardar.",
    });
    await montarFolha();
    await act(async () => { (caixaDe("Bruna Barros") as unknown as HTMLElement).click(); });
    const guardar = Array.from(document.querySelectorAll("button"))
      .find((b) => b.textContent?.match(/Guardar|Atualizar|Criar/))!;
    await act(async () => { guardar.click(); });

    expect(document.body.textContent).toContain("alterada por outra pessoa");
    expect(refresh).toHaveBeenCalled();
  });
});

describe("🔴 o cartão da equipa conta pertenças ACTIVAS", () => {
  it("com duas pessoas, diz «2 membros»", async () => {
    await act(async () => {
      root.render(
        <EquipasGrid
          equipas={[EQUIPA_COM_DOIS]}
          colaboradores={COLABORADORES}
          companyId={EMP}
          membershipSnapshot="membership-s0"
        />,
      );
    });
    expect(container.textContent).toContain("2 membros");
    expect(container.querySelectorAll('[title="Ana Alves"]')).toHaveLength(1);
    expect(container.querySelectorAll('[title="Bruna Barros"]')).toHaveLength(1);
  });

  it("🔴 depois da remoção, com a view relida, diz «1 membro» e B desaparece", async () => {
    // A view `teams_with_members` já filtra `left_at IS NULL` — é ela a
    // definição canónica de membro activo, e não se cria uma segunda. O cartão
    // conta o que ela devolve.
    await act(async () => {
      root.render(
        <EquipasGrid
          equipas={[EQUIPA_COM_UM]}
          colaboradores={COLABORADORES}
          companyId={EMP}
          membershipSnapshot="membership-s1"
        />,
      );
    });
    expect(container.textContent).toContain("1 membro");
    expect(container.textContent).not.toContain("2 membros");
    expect(container.querySelectorAll('[title="Ana Alves"]')).toHaveLength(1);
    expect(container.querySelectorAll('[title="Bruna Barros"]')).toHaveLength(0);
  });

  it("🔴 o botão de lixo virou ARQUIVAR — nada de hard-delete", async () => {
    const confirmar = vi.spyOn(window, "confirm").mockReturnValue(true);
    arquivarEquipa.mockResolvedValue({ ok: true, membershipsEncerradas: 2 });

    await act(async () => {
      root.render(
        <EquipasGrid
          equipas={[EQUIPA_COM_DOIS]}
          colaboradores={COLABORADORES}
          companyId={EMP}
          membershipSnapshot="membership-s0"
        />,
      );
    });

    const botao = container.querySelector<HTMLButtonElement>('button[title="Arquivar equipa"]')!;
    expect(botao, "o botão passou a ser de arquivar").not.toBeNull();
    await act(async () => { botao.click(); });

    // A pergunta explica o que acontece ao histórico, em vez de dizer «não pode
    // ser desfeito» — porque agora pode.
    expect(confirmar.mock.calls[0][0]).toContain("histórico");
    expect(arquivarEquipa).toHaveBeenCalledWith({
      companyId: EMP,
      teamId: T1,
      expectedRevision: 3,
      expectedMembershipSnapshot: "membership-s0",
    });
  });
});

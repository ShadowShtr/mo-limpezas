// @vitest-environment jsdom
// ============================================================================
// Pesquisa de destinatário — clientes e leads numa só caixa
// ============================================================================
//
// Monta o componente com react-dom + jsdom e escreve como uma pessoa escreve.
// O que importa provar: quem já é cliente aparece (sem acentos, por telefone),
// a opção de criar está sempre no fim, e o Escape fecha a lista sem fechar o
// formulário à volta — que ouve o Escape na `window`.
// ============================================================================

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";

import {
  PesquisaDestinatario,
  normalizarPesquisa,
  type Destinatario,
} from "@/components/crm/pesquisa-destinatario";

const CLIENTES = [
  { id: "c1", name: "Condomínio Alfa", phone: "912 345 678", nif: null, email: null },
  { id: "c2", name: "Óscar Pereira", phone: null, nif: "501234999", email: "oscar@ex.pt" },
];
const LEADS = [{ id: "l1", name: "Condominio Beta" }];

let container: HTMLDivElement;
let root: Root;

beforeEach(() => {
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
});

function montar(props: {
  valor?: Destinatario | null;
  onEscolher?: (d: Destinatario | null) => void;
  onCriarNovo?: (t: string) => void;
}) {
  act(() => {
    root.render(
      <PesquisaDestinatario
        leads={LEADS}
        clientes={CLIENTES}
        valor={props.valor ?? null}
        onEscolher={props.onEscolher ?? vi.fn()}
        onCriarNovo={props.onCriarNovo}
      />,
    );
  });
  return container.querySelector("input") as HTMLInputElement;
}

/** Escreve num input controlado pelo React (o setter nativo dispara o onChange). */
function escrever(input: HTMLInputElement, texto: string) {
  const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!;
  act(() => {
    setter.call(input, texto);
    input.dispatchEvent(new Event("input", { bubbles: true }));
  });
}

const opcoes = () =>
  Array.from(container.querySelectorAll('[role="option"]')).map((o) => o.textContent ?? "");

describe("normalizarPesquisa", () => {
  it("ignora maiúsculas e acentos", () => {
    expect(normalizarPesquisa("  Condomínio ÓSCAR ")).toBe("condominio oscar");
  });
});

describe("PesquisaDestinatario", () => {
  it("encontra clientes e leads sem acentos, clientes primeiro", () => {
    const input = montar({});
    escrever(input, "condominio");
    expect(opcoes()).toEqual(["ClienteCondomínio Alfa", "LeadCondominio Beta"]);
  });

  it("encontra pelo telefone com ou sem espaços, e pelo NIF", () => {
    const input = montar({});
    escrever(input, "912345");
    expect(opcoes()).toEqual(["ClienteCondomínio Alfa"]);
    escrever(input, "501 234");
    expect(opcoes()).toEqual(["ClienteÓscar Pereira"]);
  });

  it("escolher um resultado devolve o tipo e o id", () => {
    const onEscolher = vi.fn();
    const input = montar({ onEscolher });
    escrever(input, "oscar");
    act(() => (container.querySelector('[role="option"]') as HTMLElement).click());
    expect(onEscolher).toHaveBeenCalledWith({ tipo: "cliente", id: "c2", name: "Óscar Pereira" });
  });

  it("a opção de criar fica no fim, com o texto escrito, e o Enter escolhe-a quando é a única", () => {
    const onCriarNovo = vi.fn();
    const input = montar({ onCriarNovo });
    escrever(input, "Zé Ninguém");
    expect(opcoes()).toEqual(["Criar nova lead «Zé Ninguém»"]);
    act(() => {
      input.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
    });
    expect(onCriarNovo).toHaveBeenCalledWith("Zé Ninguém");
  });

  it("sem onCriarNovo não oferece criar", () => {
    const input = montar({});
    escrever(input, "Zé Ninguém");
    expect(opcoes()).toEqual([]);
  });

  it("🔴 o Escape fecha a lista e não chega à window (o formulário não fecha)", () => {
    const naWindow = vi.fn();
    window.addEventListener("keydown", naWindow);
    try {
      const input = montar({});
      escrever(input, "cond");
      expect(opcoes().length).toBeGreaterThan(0);
      act(() => {
        input.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
      });
      expect(opcoes()).toEqual([]);
      expect(naWindow).not.toHaveBeenCalled();
    } finally {
      window.removeEventListener("keydown", naWindow);
    }
  });

  it("com um valor escolhido mostra-o, e «Trocar» volta a pesquisar", () => {
    const onEscolher = vi.fn();
    montar({ valor: { tipo: "lead", id: "l1", name: "Condominio Beta" }, onEscolher });
    expect(container.textContent).toContain("Condominio Beta");
    act(() => (container.querySelector('button[aria-label^="Trocar"]') as HTMLElement).click());
    expect(onEscolher).toHaveBeenCalledWith(null);
  });
});

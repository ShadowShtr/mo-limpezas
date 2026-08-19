// @vitest-environment jsdom
// ============================================================================
// O POPUP DE AVISOS — comportamento real, não leitura de strings
// ============================================================================
// Monta o componente com react-dom + jsdom. A infraestrutura `.tsx` entrou no
// vitest no PR #63, e é o que permite provar coisas como «Escape não fecha» —
// que um teste estático não distinguiria de um `onKeyDown` mal ligado.
//
// 🔴 O invariante central: o popup só sai quando `markNoticeAsRead` devolve
//    sucesso. Fechar por engano marcaria como lido algo que ninguém leu.
// ============================================================================

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import type { NoticeForDisplay } from "@/domain/update-notices/types";

const markNoticeAsRead = vi.fn();

vi.mock("@/app/actions/update-notices", () => ({
  markNoticeAsRead: (...a: unknown[]) => markNoticeAsRead(...a),
}));

const { UpdateNoticeModal } = await import("@/components/update-notices/update-notice-modal");

function aviso(key: string, source: "release" | "manual" = "release"): NoticeForDisplay {
  return {
    key,
    kind: "novidade",
    title: `Título ${key}`,
    message: `Mensagem ${key}`,
    publishedAt: "2026-08-19T12:00:00.000Z",
    source,
  };
}

let container: HTMLDivElement;
let root: Root;

beforeEach(() => {
  vi.clearAllMocks();
  markNoticeAsRead.mockResolvedValue({ ok: true });
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
  document.body.style.overflow = "";
});

function montar(notices: NoticeForDisplay[]) {
  act(() => { root.render(<UpdateNoticeModal notices={notices} />); });
}

function botaoEntendi(): HTMLButtonElement | null {
  return [...container.querySelectorAll("button")].find((b) =>
    /entendi|a guardar/i.test(b.textContent ?? ""),
  ) as HTMLButtonElement | null;
}

async function clicarEntendi() {
  const b = botaoEntendi();
  await act(async () => {
    b?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    await Promise.resolve();
  });
}

describe("aparecer e desaparecer", () => {
  it("um aviso por ler aparece", () => {
    montar([aviso("a")]);
    expect(container.textContent).toContain("Título a");
    expect(container.querySelector('[role="dialog"]')).toBeTruthy();
  });

  it("sem avisos não monta nada", () => {
    montar([]);
    expect(container.querySelector('[role="dialog"]')).toBeNull();
  });

  it("depois de confirmar, o popup sai", async () => {
    montar([aviso("a")]);
    await clicarEntendi();

    expect(markNoticeAsRead).toHaveBeenCalledWith("a");
    expect(container.querySelector('[role="dialog"]')).toBeNull();
  });
});

describe("🔴 não se fecha sem confirmar", () => {
  it("não há botão de fechar", () => {
    montar([aviso("a")]);
    const fechar = [...container.querySelectorAll("button")].filter((b) =>
      /fechar|close|×/i.test(b.textContent ?? "") || b.getAttribute("aria-label")?.match(/fechar|close/i),
    );
    expect(fechar).toHaveLength(0);
  });

  it("Escape não fecha", () => {
    montar([aviso("a")]);
    act(() => {
      document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
    });
    expect(container.querySelector('[role="dialog"]')).toBeTruthy();
    expect(container.textContent).toContain("Título a");
  });

  it("clicar no overlay não fecha", () => {
    montar([aviso("a")]);
    const overlay = container.querySelector('[aria-hidden="true"]');
    act(() => {
      overlay?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    expect(container.querySelector('[role="dialog"]')).toBeTruthy();
  });

  it("🔴 se marcar como lido falhar, o popup fica aberto com o erro", async () => {
    markNoticeAsRead.mockResolvedValue({ ok: false, error: "Sem ligação." });
    montar([aviso("a")]);

    await clicarEntendi();

    // A leitura não ficou registada — fechar aqui perdia-a em silêncio.
    expect(container.querySelector('[role="dialog"]')).toBeTruthy();
    expect(container.textContent).toContain("Sem ligação.");
  });

  it("depois de um erro, tentar outra vez funciona", async () => {
    markNoticeAsRead.mockResolvedValueOnce({ ok: false, error: "Falhou." });
    montar([aviso("a")]);

    await clicarEntendi();
    expect(container.querySelector('[role="dialog"]')).toBeTruthy();

    markNoticeAsRead.mockResolvedValue({ ok: true });
    await clicarEntendi();
    expect(container.querySelector('[role="dialog"]')).toBeNull();
  });
});

describe("🔴 fila — um de cada vez, marcado um a um", () => {
  it("mostra «1 de 3» e avança a cada confirmação", async () => {
    montar([aviso("a"), aviso("b"), aviso("c")]);

    expect(container.textContent).toContain("1 de 3");
    expect(container.textContent).toContain("Título a");

    await clicarEntendi();
    expect(container.textContent).toContain("2 de 3");
    expect(container.textContent).toContain("Título b");

    await clicarEntendi();
    expect(container.textContent).toContain("3 de 3");

    await clicarEntendi();
    expect(container.querySelector('[role="dialog"]')).toBeNull();
  });

  it("🔴 marca um a um, nunca todos de uma vez", async () => {
    montar([aviso("a"), aviso("b"), aviso("c")]);

    await clicarEntendi();
    // Uma chamada, com a chave do primeiro. Marcar os três aqui gravaria
    // leituras de avisos que ainda não foram mostrados.
    expect(markNoticeAsRead).toHaveBeenCalledTimes(1);
    expect(markNoticeAsRead).toHaveBeenCalledWith("a");

    await clicarEntendi();
    expect(markNoticeAsRead).toHaveBeenCalledTimes(2);
    expect(markNoticeAsRead).toHaveBeenLastCalledWith("b");
  });

  it("um erro a meio não avança para o seguinte", async () => {
    montar([aviso("a"), aviso("b")]);

    markNoticeAsRead.mockResolvedValue({ ok: false, error: "Erro." });
    await clicarEntendi();

    // Continua no primeiro: avançar deixaria «a» por ler para sempre.
    expect(container.textContent).toContain("Título a");
    expect(container.textContent).toContain("1 de 2");
  });

  it("um único aviso não mostra contador", () => {
    montar([aviso("a")]);
    expect(container.textContent).not.toContain("1 de 1");
  });
});

describe("conteúdo", () => {
  it("mostra título, mensagem e tipo", () => {
    montar([aviso("a")]);
    expect(container.textContent).toContain("Título a");
    expect(container.textContent).toContain("Mensagem a");
    expect(container.textContent).toContain("Novidade");
  });

  it("trava o scroll do fundo enquanto está aberto", () => {
    montar([aviso("a")]);
    expect(document.body.style.overflow).toBe("hidden");
  });
});

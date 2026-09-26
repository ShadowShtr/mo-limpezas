// @vitest-environment jsdom
// ============================================================================
// O MODAL DE AVISOS — comportamento, não leitura de strings
// ============================================================================
//
// 🔴 Dois invariantes sustentam tudo o resto:
//
//    1. Não se carimba «já mostrei» sem ter mostrado. Carimbar à entrada
//       silenciaria a aba inteira para quem abriu o dashboard antes de haver
//       avisos — que é o caso mais comum de manhã.
//    2. O modal não escreve. Nenhum writer é sequer importado.
// ============================================================================

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import type { AvisoItem } from "@/domain/avisos/types";

const getAvisosVencimento = vi.fn();

vi.mock("@/app/actions/avisos", () => ({
  getAvisosVencimento: () => getAvisosVencimento(),
}));

vi.mock("next/link", () => ({
  default: ({ children, href, onClick }: {
    children: React.ReactNode; href: string; onClick?: () => void;
  }) => <a href={href} onClick={onClick}>{children}</a>,
}));

const { AvisosVencimentoModal } = await import("@/components/avisos/avisos-vencimento-modal");

const CHAVE = "avisos-vencimento:v1:shown";

const aviso = (patch: Partial<AvisoItem> = {}): AvisoItem => ({
  key: "pagamento:p1",
  source: "pagamento",
  itemId: "p1",
  date: "2026-09-26",
  urgencia: "hoje",
  title: "Seguro da carrinha",
  detail: "Vencimento",
  href: "/dashboard/financeiro/pagamentos",
  ...patch,
});

let container: HTMLDivElement;
let root: Root;

function montar(inicial: AvisoItem[]) {
  act(() => { root.render(<AvisosVencimentoModal inicial={inicial} />); });
}

const estaAberto = () => container.querySelector('[role="dialog"]') !== null;

beforeEach(() => {
  vi.clearAllMocks();
  getAvisosVencimento.mockResolvedValue([]);
  window.sessionStorage.clear();
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
});

describe("abrir e não abrir", () => {
  it("sem avisos não abre", () => {
    montar([]);
    expect(estaAberto()).toBe(false);
  });

  // 🔴 O invariante que sustenta a reavaliação. Se isto falhar, quem abre o
  //    dashboard sem nada pendente nunca mais é avisado nessa aba.
  it("sem avisos NÃO grava a marca de sessão", () => {
    montar([]);
    expect(window.sessionStorage.getItem(CHAVE)).toBeNull();
  });

  it("com avisos abre e mostra o conteúdo", () => {
    montar([aviso()]);
    expect(estaAberto()).toBe(true);
    expect(container.textContent).toContain("Seguro da carrinha");
  });

  it("ao abrir, grava a marca de sessão", () => {
    montar([aviso()]);
    expect(window.sessionStorage.getItem(CHAVE)).toBe("1");
  });

  it("agrupa por urgência com os rótulos certos", () => {
    montar([
      aviso({ key: "pagamento:p1", urgencia: "atrasado", date: "2026-09-20" }),
      aviso({ key: "tarefa:t1", source: "tarefa", itemId: "t1", urgencia: "amanha", title: "Recibos" }),
    ]);
    expect(container.textContent).toContain("Atrasados");
    expect(container.textContent).toContain("Amanhã");
    expect(container.textContent).not.toContain("Hoje (");
  });
});

describe("uma vez por sessão da aba", () => {
  it("fechar não reabre na mesma sessão", () => {
    montar([aviso()]);
    const fechar = container.querySelector<HTMLButtonElement>('[aria-label="Fechar avisos"]');
    act(() => { fechar?.click(); });
    expect(estaAberto()).toBe(false);

    // Uma re-renderização com os mesmos avisos não o traz de volta.
    montar([aviso()]);
    expect(estaAberto()).toBe(false);
  });

  it("se a sessão já estiver marcada, não abre de todo", () => {
    window.sessionStorage.setItem(CHAVE, "1");
    montar([aviso()]);
    expect(estaAberto()).toBe(false);
  });

  // Uma aba nova é uma `sessionStorage` nova — aqui simulada limpando-a.
  it("numa sessão nova volta a mostrar", () => {
    window.sessionStorage.setItem(CHAVE, "1");
    montar([aviso()]);
    expect(estaAberto()).toBe(false);

    act(() => root.unmount());
    window.sessionStorage.clear();
    container.remove();
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);

    montar([aviso()]);
    expect(estaAberto()).toBe(true);
  });
});

async function voltarAAba() {
  Object.defineProperty(document, "visibilityState", { value: "visible", configurable: true });
  await act(async () => {
    document.dispatchEvent(new Event("visibilitychange"));
    await Promise.resolve();
  });
}

describe("reavaliação ao voltar à aba", () => {
  it("entrou sem avisos, surgiu um: ao voltar à aba, mostra", async () => {
    montar([]);
    expect(estaAberto()).toBe(false);

    getAvisosVencimento.mockResolvedValue([aviso({ title: "Água" })]);
    await voltarAAba();

    expect(getAvisosVencimento).toHaveBeenCalled();
    expect(estaAberto()).toBe(true);
    expect(container.textContent).toContain("Água");
  });

  it("depois de mostrado, voltar à aba NÃO reconsulta nem reabre", async () => {
    montar([aviso()]);
    const fechar = container.querySelector<HTMLButtonElement>('[aria-label="Fechar avisos"]');
    act(() => { fechar?.click(); });
    getAvisosVencimento.mockClear();

    await voltarAAba();

    expect(getAvisosVencimento).not.toHaveBeenCalled();
    expect(estaAberto()).toBe(false);
  });

  it("aba escondida não dispara consulta nenhuma", async () => {
    montar([]);
    Object.defineProperty(document, "visibilityState", { value: "hidden", configurable: true });
    await act(async () => {
      document.dispatchEvent(new Event("visibilitychange"));
      await Promise.resolve();
    });
    expect(getAvisosVencimento).not.toHaveBeenCalled();
  });

  it("se a reconsulta falhar, a UI não cai", async () => {
    montar([]);
    getAvisosVencimento.mockRejectedValue(new Error("rede"));
    await voltarAAba();
    expect(estaAberto()).toBe(false);
    expect(container.isConnected).toBe(true);
  });
});

describe("storage indisponível", () => {
  // 🔴 Numa janela privada ou com dados de site bloqueados é o ACESSO à
  //    propriedade que lança, não o `getItem`. Sem try/catch, o dashboard
  //    inteiro deixava de renderizar por causa da camada de lembretes.
  it("um sessionStorage que lança não derruba o modal", () => {
    const original = Object.getOwnPropertyDescriptor(window, "sessionStorage");
    Object.defineProperty(window, "sessionStorage", {
      configurable: true,
      get() { throw new DOMException("bloqueado", "SecurityError"); },
    });

    expect(() => montar([aviso()])).not.toThrow();
    // Sem memória de sessão, o comportamento útil é mostrar.
    expect(estaAberto()).toBe(true);

    if (original) Object.defineProperty(window, "sessionStorage", original);
  });
});

describe("o modal não escreve", () => {
  it("não importa nenhum writer das quatro superfícies", async () => {
    const fonte = await import("node:fs").then((fs) =>
      fs.readFileSync("src/components/avisos/avisos-vencimento-modal.tsx", "utf8"));

    for (const proibido of [
      "setPaymentStatus", "updatePayment", "deletePayment",
      "completeTask", "updateTask",
      "updateLead", "convertLead",
      "completeVisit", "cancelVisit",
    ]) {
      expect(fonte, `o modal referencia ${proibido}`).not.toContain(proibido);
    }
    // A única action que conhece é a de leitura.
    expect(fonte).toContain("getAvisosVencimento");
  });
});

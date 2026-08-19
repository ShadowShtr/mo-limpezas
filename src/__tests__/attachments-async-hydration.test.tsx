// @vitest-environment jsdom
// ============================================================================
// ANEXOS — a lista tem de aparecer quando a resposta chega
// ============================================================================
// Origem (2026-08-19): «anexo o ficheiro, guardo, reabro o registo e ele
// desapareceu». A linha continua em `public.attachments` e o ficheiro continua
// no bucket — o que falha é a apresentação.
//
// A causa: `AttachmentsField` fazia
//
//     const [attachments, setAttachments] = useState(initialAttachments);
//
// e `useState` só consome o valor inicial **na montagem**. As três superfícies
// abrem o registo com a lista vazia, disparam `listAttachments()` de forma
// assíncrona e montam o componente imediatamente. Quando a resposta chega, a
// prop muda — e o estado interno não acompanha. O anexo existia, e não se via.
//
// Este ficheiro exercita o componente a sério (react-dom + jsdom), não por
// leitura de strings: um teste estático não distinguiria `useState(prop)` de
// uma sincronização correcta.
//
// 🔴 A correcção não é sincronizar a prop. É o componente passar a ser dono da
//    própria leitura — `listAttachments` a partir de `parentType`/`parentId`.
//    Três pais a repetir o mesmo carregamento assíncrono era a origem do
//    problema, não um detalhe de implementação.
// ============================================================================

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import type { AttachmentView } from "@/lib/attachments";

// As server actions não correm em jsdom: o que importa aqui é *quando* a lista
// aparece, não como o servidor a produz.
const listAttachments = vi.fn();
const addAttachment = vi.fn();
const removeAttachment = vi.fn();
const getAttachmentUrl = vi.fn();

vi.mock("@/app/actions/attachments", () => ({
  listAttachments: (...a: unknown[]) => listAttachments(...a),
  addAttachment: (...a: unknown[]) => addAttachment(...a),
  removeAttachment: (...a: unknown[]) => removeAttachment(...a),
  getAttachmentUrl: (...a: unknown[]) => getAttachmentUrl(...a),
}));

vi.mock("@/components/ui/toast", () => ({
  useToast: () => ({ toast: vi.fn() }),
}));

const { AttachmentsField } = await import("@/components/attachments/attachments-field");

const PARENT_A = "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa";
const PARENT_B = "bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb";

function anexo(nome: string, id = nome): AttachmentView {
  return {
    id,
    source: "attachments",
    name: nome,
    mimeType: "application/pdf",
    sizeBytes: 1024,
    createdAt: "2026-08-19T10:00:00Z",
    storageBucket: "payment-attachments",
    storagePath: `c/p/${nome}`,
  };
}

/** Uma promessa que só resolve quando quisermos — para encenar a latência. */
function adiada<T>() {
  let resolver!: (v: T) => void;
  const promessa = new Promise<T>((r) => { resolver = r; });
  return { promessa, resolver };
}

let container: HTMLDivElement;
let root: Root;

beforeEach(() => {
  vi.clearAllMocks();
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
});

function montar(parentId: string) {
  act(() => {
    root.render(
      <AttachmentsField parentType="fixed_variable_payment" parentId={parentId} />,
    );
  });
}

describe("🔴 hidratação assíncrona — o defeito reportado", () => {
  it("o anexo aparece quando a resposta do servidor chega", async () => {
    const { promessa, resolver } = adiada<{ ok: true; attachments: AttachmentView[] }>();
    listAttachments.mockReturnValue(promessa);

    montar(PARENT_A);

    // Enquanto carrega, a lista ainda não tem nada — mas não pode mentir.
    expect(container.textContent).not.toContain("fatura.pdf");

    await act(async () => {
      resolver({ ok: true, attachments: [anexo("fatura.pdf")] });
      await promessa;
    });

    // 🔴 É aqui que o código antigo falhava: a prop mudava, o estado não.
    expect(container.textContent).toContain("fatura.pdf");
  });

  it("o campo carrega sozinho — os pais não lhe passam a lista", async () => {
    listAttachments.mockResolvedValue({ ok: true, attachments: [anexo("recibo.pdf")] });

    montar(PARENT_A);
    await act(async () => { await Promise.resolve(); });

    expect(listAttachments).toHaveBeenCalledWith("fixed_variable_payment", PARENT_A);
    expect(container.textContent).toContain("recibo.pdf");
  });

  it("legado e novos aparecem juntos", async () => {
    listAttachments.mockResolvedValue({
      ok: true,
      attachments: [
        { ...anexo("antigo.pdf", "legacy:fixed_variable_payment:" + PARENT_A), source: "legacy" as const },
        anexo("novo.pdf"),
      ],
    });

    montar(PARENT_A);
    await act(async () => { await Promise.resolve(); });

    expect(container.textContent).toContain("antigo.pdf");
    expect(container.textContent).toContain("novo.pdf");
  });
});

describe("🔴 estado de carregamento — «Sem anexos» é uma afirmação", () => {
  it("não diz «Sem anexos» enquanto a lista está a carregar", async () => {
    const { promessa, resolver } = adiada<{ ok: true; attachments: AttachmentView[] }>();
    listAttachments.mockReturnValue(promessa);

    montar(PARENT_A);

    // Dizer «Sem anexos» antes de saber é comunicar ausência sem a ter
    // verificado — foi metade da confusão do relato original.
    expect(container.textContent).not.toContain("Sem anexos");
    expect(container.textContent?.toLowerCase()).toContain("carregar");

    await act(async () => {
      resolver({ ok: true, attachments: [] });
      await promessa;
    });

    // Agora sim: o servidor respondeu, e a resposta foi «nenhum».
    expect(container.textContent).toContain("Sem anexos");
  });

  it("um erro de leitura fica visível, não silencioso", async () => {
    listAttachments.mockResolvedValue({ ok: false, error: "Registo não encontrado." });

    montar(PARENT_A);
    await act(async () => { await Promise.resolve(); });

    expect(container.textContent).toContain("Registo não encontrado.");
    // E não pode afirmar ausência quando não conseguiu ler.
    expect(container.textContent).not.toContain("Sem anexos");
  });
});

describe("🔴 resposta atrasada não contamina outro registo", () => {
  it("abrir A, fechar, abrir B — a resposta de A não aparece em B", async () => {
    const a = adiada<{ ok: true; attachments: AttachmentView[] }>();
    const b = adiada<{ ok: true; attachments: AttachmentView[] }>();

    listAttachments
      .mockReturnValueOnce(a.promessa)
      .mockReturnValueOnce(b.promessa);

    montar(PARENT_A);
    // Sem esperar por A, o utilizador salta para B.
    montar(PARENT_B);

    await act(async () => {
      b.resolver({ ok: true, attachments: [anexo("do-b.pdf")] });
      await b.promessa;
    });
    await act(async () => {
      // A chega tarde, com os anexos do registo errado.
      a.resolver({ ok: true, attachments: [anexo("do-a.pdf")] });
      await a.promessa;
    });

    expect(container.textContent).toContain("do-b.pdf");
    expect(container.textContent).not.toContain("do-a.pdf");
  });
});

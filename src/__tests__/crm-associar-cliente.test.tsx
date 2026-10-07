// @vitest-environment jsdom
// ============================================================================
// «Associar a cliente existente» — o diálogo e a action (108)
// ============================================================================
//
// Duas partes:
//
//   · o diálogo, montado a sério: o que segue para a action, e que trocar de
//     cliente nunca deixa escolhido um local do cliente anterior;
//   · a action, por análise do código: as mesmas garantias estruturais da
//     conversão da 104 — empresa da sessão, escrita só pela RPC, cliente
//     nunca escrito.
// ============================================================================

import { readFileSync } from "node:fs";
import { join } from "node:path";

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";

const linkLeadToExistingClient = vi.fn();
const getClientLocationsForLink = vi.fn();
const toast = vi.fn();

vi.mock("@/app/actions/crm-associar-cliente", () => ({
  linkLeadToExistingClient: (...a: unknown[]) => linkLeadToExistingClient(...a),
  getClientLocationsForLink: (...a: unknown[]) => getClientLocationsForLink(...a),
}));
vi.mock("@/components/ui/toast", () => ({ useToast: () => ({ toast }) }));

const { AssociarClienteDialog } = await import(
  "@/app/(dashboard)/dashboard/crm/orcamentos/_components/associar-cliente-dialog"
);

const QUOTE = "33333333-3333-4333-8333-333333333333";
const CLIENTE_A = "44444444-4444-4444-8444-444444444444";
const CLIENTE_B = "55555555-5555-4555-8555-555555555555";
const SEDE_A = "66666666-6666-4666-8666-666666666666";
const SEDE_B = "77777777-7777-4777-8777-777777777777";

const CLIENTES = [
  { id: CLIENTE_A, name: "Condomínio Alfa" },
  { id: CLIENTE_B, name: "Empresa Beta" },
];

let container: HTMLDivElement;
let root: Root;
let onDone: ReturnType<typeof vi.fn>;
let onClose: ReturnType<typeof vi.fn>;

beforeEach(() => {
  vi.clearAllMocks();
  getClientLocationsForLink.mockImplementation(async (id: string) => ({
    ok: true,
    data: id === CLIENTE_A
      ? [{ id: SEDE_A, name: "Sede Alfa", address: "Rua A" }]
      : [{ id: SEDE_B, name: "Sede Beta", address: "Rua B" }],
  }));
  linkLeadToExistingClient.mockResolvedValue({
    ok: true, data: { clientId: CLIENTE_A, locationId: SEDE_A, alreadyConverted: false },
  });
  onDone = vi.fn();
  onClose = vi.fn();
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  act(() => {
    root.render(
      <AssociarClienteDialog
        quoteId={QUOTE}
        leadName="Condomínio Alfa (lead)"
        clientes={CLIENTES}
        onClose={onClose}
        onDone={onDone}
      />,
    );
  });
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
});

function escrever(el: HTMLInputElement, valor: string) {
  Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(el, valor);
  act(() => {
    el.dispatchEvent(new Event("input", { bubbles: true }));
  });
}

async function escolherCliente(texto: string) {
  const caixa = document.querySelector('input[role="combobox"]') as HTMLInputElement;
  escrever(caixa, texto);
  const opcao = document.querySelector<HTMLElement>('[role="option"]')!;
  await act(async () => opcao.click());
}

function botao(texto: string) {
  return [...document.querySelectorAll<HTMLButtonElement>("button")]
    .find((b) => b.textContent?.trim().startsWith(texto))!;
}

const radio = (valor: string) =>
  document.querySelector<HTMLInputElement>(`input[type="radio"][value="${valor}"]`);

describe("o diálogo", () => {
  it("sem cliente escolhido não se pode confirmar", () => {
    expect(botao("Associar e marcar").disabled).toBe(true);
  });

  it("a pesquisa só oferece clientes, e nunca «criar»", () => {
    const caixa = document.querySelector('input[role="combobox"]') as HTMLInputElement;
    escrever(caixa, "a");
    const textos = [...document.querySelectorAll('[role="option"]')].map((o) => o.textContent);
    expect(textos.every((t) => t?.startsWith("Cliente"))).toBe(true);
    expect(textos.some((t) => t?.includes("Criar"))).toBe(false);
  });

  it("local novo por omissão: envia locationId null", async () => {
    await escolherCliente("alfa");
    expect(radio("__novo__")?.checked).toBe(true);
    await act(async () => botao("Associar e marcar").click());

    expect(linkLeadToExistingClient).toHaveBeenCalledWith(QUOTE, CLIENTE_A, null);
    expect(onDone).toHaveBeenCalledWith(CLIENTE_A, false);
  });

  it("escolher um local do cliente envia esse local", async () => {
    await escolherCliente("alfa");
    act(() => radio(SEDE_A)!.click());
    await act(async () => botao("Associar e marcar").click());

    expect(linkLeadToExistingClient).toHaveBeenCalledWith(QUOTE, CLIENTE_A, SEDE_A);
  });

  it("🔴 trocar de cliente volta a «local novo» — o local do anterior nunca vai junto", async () => {
    await escolherCliente("alfa");
    act(() => radio(SEDE_A)!.click());

    await act(async () => botao("Trocar").click());
    await escolherCliente("beta");

    expect(radio(SEDE_A)).toBeNull();
    expect(radio("__novo__")?.checked).toBe(true);
    await act(async () => botao("Associar e marcar").click());
    expect(linkLeadToExistingClient).toHaveBeenCalledWith(QUOTE, CLIENTE_B, null);
  });

  it("um erro da action fica no diálogo: toast, sem onDone", async () => {
    linkLeadToExistingClient.mockResolvedValue({
      ok: false, error: { code: "CONFLICT", message: "Esse local não pertence ao cliente escolhido." },
    });
    await escolherCliente("alfa");
    await act(async () => botao("Associar e marcar").click());

    expect(toast).toHaveBeenCalledWith("Esse local não pertence ao cliente escolhido.", "error");
    expect(onDone).not.toHaveBeenCalled();
    expect(botao("Associar e marcar").disabled).toBe(false);
  });

  it("diz que a ficha do cliente não é alterada", () => {
    expect(document.body.textContent).toContain("a ficha do cliente não é alterada");
  });
});

// ───────────────────────────────────────────────────────────────────────────
describe("🔴 a action — garantias estruturais", () => {
  const src = readFileSync(join(process.cwd(), "src/app/actions/crm-associar-cliente.ts"), "utf8");
  const codigo = src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/.*$/gm, "$1");

  it("começa com \"use server\" e só exporta funções", () => {
    expect(src.trimStart().startsWith('"use server"')).toBe(true);
    expect([...codigo.matchAll(/^export\s+(?:const|let|var)\s+(\w+)/gm)]).toEqual([]);
  });

  it("empresa e actor vêm da sessão, só admin/gestor", () => {
    expect(codigo).toContain("p_company_id: profile.company_id");
    expect(codigo).toContain("p_actor: profile.id");
    expect(codigo).toContain('roles: ["admin", "gestor"]');
    const assinatura = codigo.slice(codigo.indexOf("export async function linkLeadToExistingClient"))
      .split("{")[0];
    expect(assinatura).not.toMatch(/company|actor|leadId/i);
  });

  it("valida os ids antes de qualquer query", () => {
    const corpo = codigo.slice(codigo.indexOf("export async function linkLeadToExistingClient"));
    expect(corpo.indexOf("z.uuid()")).toBeLessThan(corpo.indexOf("requireProfile"));
    expect(corpo.indexOf("z.uuid()")).toBeLessThan(corpo.indexOf(".from("));
  });

  it("🔴 zero escritas directas — a RPC é a única porta, e o cliente nunca é escrito", () => {
    expect(codigo).not.toMatch(/\.(insert|upsert|delete)\(/);
    expect(codigo).not.toMatch(/\.from\([^)]*\)\s*\.\s*update\(/);
    expect([...codigo.matchAll(/\.rpc\("(\w+)"/g)].map((m) => m[1]))
      .toEqual(["link_crm_lead_to_existing_client"]);
  });

  it("a proveniência é source_lead_id, nunca lead_id", () => {
    expect(codigo).toContain("p_lead_id: quote.source_lead_id");
    expect(codigo).not.toMatch(/(^|[^_])\blead_id\b/m);
  });

  it("só audita a associação real, e nunca expõe o erro cru", () => {
    const pos = codigo.indexOf("if (!alreadyConverted)");
    expect(pos).toBeGreaterThan(-1);
    expect(codigo.indexOf("auditLog(", pos)).toBeGreaterThan(pos);
    expect(codigo).not.toMatch(/actionFailure\([^)]*error\.message/);
  });

  it("🔴 todas as sentinelas da 108 têm frase", () => {
    const sql = readFileSync(
      join(process.cwd(), "supabase/migrations/108_crm_associar_cliente_existente.sql"), "utf8");
    const sentinelas = new Set(
      [...sql.matchAll(/RAISE EXCEPTION\s+'([A-Z0-9_]+)/g)].map((m) => m[1])
        .filter((s) => !s.startsWith("CRM_LINK_108_")),
    );
    // Impossíveis numa chamada válida desta action (ids validados antes).
    sentinelas.delete("CONVERSION_QUOTE_REQUIRED");
    sentinelas.delete("LINK_CLIENT_REQUIRED");
    for (const s of sentinelas) expect(codigo, s).toContain(`["${s}"`);
  });
});

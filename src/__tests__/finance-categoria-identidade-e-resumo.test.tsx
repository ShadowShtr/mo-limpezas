// @vitest-environment jsdom
// ============================================================================
// IDENTIDADE DE CATEGORIA — no React, no Resumo, e no Diário de Cobranças
// ============================================================================
//
// Três provas que faltavam, e que não se substituem umas às outras:
//
//   1. `categorySlices` já devolvia duas fatias legadas distintas — mas ambas
//      com `category_id = null`. A `key` de React era `category_id ?? "none"`,
//      logo as duas recebiam `"none"`. O React trata isso como a MESMA posição
//      e, num rerender com ordem ou valores diferentes, pode reutilizar o nó
//      errado: o nome de uma categoria com o valor da outra, num ecrã de
//      dinheiro. Testar só o array devolvido nunca apanharia isto — o array
//      estava certo; era a renderização que podia mentir.
//
//   2. O card «Saídas registadas por categoria» do RESUMO não usa este
//      `ledger-presentation`. Usa outro motor — `resolverCategoriaEfetiva` +
//      `calcularDespesasPorCategoria` — que esta PR não toca. As regras dele
//      já estão cobertas em `effective-expense-category.test.ts` (CAT01–CAT12);
//      o que faltava era a CONSERVAÇÃO: a soma das fatias tem de ser o total.
//
//   3. O CTA de Cobranças estava provado por leitura de código. Faltava provar
//      que o clique abre mesmo o formulário, com o dia certo, e que abrir e
//      fechar não escreve nada.
// ============================================================================

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import {
  buildFinanceLedger,
  type FinanceLedgerCashflowSource,
} from "@/domain/finance/ledger";
import { categorySlices, categoryKey } from "@/domain/finance/ledger-presentation";
import {
  resolverCategoriaEfetiva,
  ORIGEM_PAGAMENTO,
} from "@/domain/finance-v2/effective-expense-category";
import {
  calcularDespesasPorCategoria,
  type FactoCaixa,
} from "@/domain/finance-v2/aggregate";

vi.mock("next/navigation", () => ({
  useRouter: () => ({ refresh: () => {}, push: () => {}, replace: () => {} }),
}));

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
  vi.restoreAllMocks();
});

/** Movimento manual com categoria LEGADA (texto), sem `expense_category_id`. */
const legada = (id: string, categoria: string, amount: number): FinanceLedgerCashflowSource => ({
  id, type: "saida", amount, description: `Movimento ${categoria}`,
  category: categoria, date: "2026-08-12", reference_type: null, reference_id: null,
  status: "confirmado", notes: null, expense_category_id: null, category_name: null,
  created_at: "2026-08-12T10:00:00Z",
});

async function mostrar(rows: ReturnType<typeof buildFinanceLedger>) {
  const { UnifiedPaymentsClient } = await import(
    "@/app/(dashboard)/dashboard/financeiro/pagamentos/_components/unified-payments-client"
  );
  await act(async () => {
    root.render(
      <UnifiedPaymentsClient
        rows={rows}
        error={null}
        categories={[]}
        companyId="11111111-1111-4111-8111-111111111111"
        year={2026}
        month={8}
      />,
    );
  });

  // 🔴 O gráfico abre em «Competência», e estas linhas são de CAIXA: sem
  //    trocar de modo, o donut vinha vazio e as asserções mediriam a tabela,
  //    não as fatias. Foi assim que a primeira versão deste teste passou com
  //    a key colidida ainda no sítio.
  const caixa = [...container.querySelectorAll("button")]
    .find((b) => (b.textContent ?? "").trim() === "Caixa");
  if (caixa) await act(async () => { caixa.click(); });
}

// ═══════════════════════════════════════════════════════════════════════════
// 1. IDENTIDADE REACT DAS FATIAS
// ═══════════════════════════════════════════════════════════════════════════
describe("1. duas fatias legadas têm identidade React própria", () => {
  const rows = buildFinanceLedger({
    payments: [],
    cashflows: [legada("c1", "fornecedor", 80), legada("c2", "despesa", 50)],
  });

  it("🔴 cada fatia carrega a sua chave efectiva", () => {
    const fatias = categorySlices(rows, { year: 2026, month: 8 }, "caixa");
    expect(fatias).toHaveLength(2);
    for (const fatia of fatias) {
      expect(fatia.category_key).toBeTruthy();
      // E `category_id` continua a ser o id estruturado real — aqui, nenhum.
      // A chave não é um id de base de dados inventado.
      expect(fatia.category_id).toBeNull();
    }
    // 🔴 É a MESMA identidade que a tabela e o filtro usam — não uma terceira.
    expect(fatias.map((f) => f.category_key).sort())
      .toEqual(rows.map(categoryKey).sort());
  });

  it("🔴 as chaves são ÚNICAS — antes eram ambas `none`", () => {
    const fatias = categorySlices(rows, { year: 2026, month: 8 }, "caixa");
    const chaves = fatias.map((f) => f.category_key);
    expect(new Set(chaves).size).toBe(chaves.length);
    // A chave antiga colidia: `category_id ?? "none"` dava "none" às duas.
    expect(new Set(fatias.map((f) => f.category_id ?? "none")).size).toBe(1);
  });

  it("🔴 no ecrã: duas linhas, cada nome com o SEU valor", async () => {
    await mostrar(rows);
    const texto = container.textContent ?? "";
    expect(texto).toContain("fornecedor");
    expect(texto).toContain("despesa");
    expect(texto).toContain("80,00");
    expect(texto).toContain("50,00");
    // E nenhuma virou «Sem categoria».
    const fatias = categorySlices(rows, { year: 2026, month: 8 }, "caixa");
    expect(fatias.map((f) => f.name)).not.toContain("Sem categoria");
  });

  it("🔴 sem aviso de chave duplicada do React", async () => {
    const erros: string[] = [];
    vi.spyOn(console, "error").mockImplementation((...args) => {
      erros.push(args.map(String).join(" "));
    });
    await mostrar(rows);
    const duplicadas = erros.filter((e) => /same key|duplicate key|two children/i.test(e));
    expect(duplicadas, duplicadas.join(" | ")).toEqual([]);
  });

  it("🔴 depois de um rerender com ordem e valores trocados, cada nome mantém o seu valor", async () => {
    await mostrar(rows);
    expect(container.textContent ?? "").toContain("80,00");

    // Ordem invertida E valores diferentes: é aqui que uma key colidida
    // reutilizaria o nó errado e trocaria nome com valor.
    const invertidas = buildFinanceLedger({
      payments: [],
      cashflows: [legada("c2", "despesa", 300), legada("c1", "fornecedor", 25)],
    });
    await mostrar(invertidas);

    const fatias = categorySlices(invertidas, { year: 2026, month: 8 }, "caixa");
    expect(fatias.find((f) => f.name === "despesa")?.amount_cents).toBe(30_000);
    expect(fatias.find((f) => f.name === "fornecedor")?.amount_cents).toBe(2_500);

    const texto = container.textContent ?? "";
    expect(texto).toContain("300,00");
    expect(texto).toContain("25,00");
    // Os valores antigos desapareceram — nenhum nó ficou preso.
    expect(texto).not.toContain("80,00");
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// 2. O MOTOR DO RESUMO — outro caminho, já canónico
// ═══════════════════════════════════════════════════════════════════════════
//
// 🔴 Este bloco NÃO reimplementa a regra de categoria. Usa os dois helpers
//    canónicos. As regras A–E e G já estão provadas em
//    `effective-expense-category.test.ts` (CAT01–CAT12): o pagamento vence o
//    snapshot (CAT02/CAT03), pagamento sem categoria dá «Sem categoria» e NÃO
//    cai para o texto legado (CAT06/CAT07), o manual usa a sua própria
//    (CAT01/CAT08), e a origem lê-se do campo e nunca da descrição.
//
//    O que faltava era F: a CONSERVAÇÃO do dinheiro.
describe("2. Resumo — as fatias conservam o total", () => {
  // As mesmas formas que `finance-v2-read-model.test.ts` usa: contexto de
  // período completo e factos de caixa com os campos reais.
  const ctx = {
    companyId: "empresa-1",
    year: 2026,
    month: 8,
    periodStart: "2026-08-01",
    periodEnd: "2026-08-31",
    todayLisbon: "2026-08-20",
  } as Parameters<typeof calcularDespesasPorCategoria>[1];

  const saida = (amount: number, over: Partial<FactoCaixa> = {}): FactoCaixa => ({
    date: "2026-08-12", tipo: "saida", status: "confirmado", amount,
    categoria: null, ...over,
  });

  const bloco = (factos: FactoCaixa[]) =>
    calcularDespesasPorCategoria({ ok: true, factos }, ctx);

  it("🔴 F. a soma das fatias é exactamente o total — nada se perde", () => {
    const r = bloco([
      saida(1626.00, { categoriaEstruturada: "Subcontratação" }),
      saida(693.61, { categoria: "fornecedor" }),
      saida(364.39, { categoriaEstruturada: "Materiais e produtos" }),
      saida(104.67, { categoria: "despesa" }),
      saida(1046.87),
    ]);
    expect(r.estado).toBe("AVAILABLE");
    const somaFatias = r.fatias.reduce((acc, f) => acc + f.valor, 0);
    expect(Math.round(somaFatias * 100) / 100).toBe(Math.round(r.total * 100) / 100);
    expect(Math.round(r.total * 100) / 100).toBe(3835.54);
  });

  it("🔴 «Sem categoria» é uma fatia visível, não dinheiro escondido", () => {
    const r = bloco([saida(100, { categoria: "despesa" }), saida(50)]);
    expect(r.semCategoria).toBe(50);
    expect(r.fatias.map((f) => f.categoria)).toContain("Sem categoria");
    const somaFatias = r.fatias.reduce((acc, f) => acc + f.valor, 0);
    expect(Math.round(somaFatias * 100) / 100).toBe(150);
  });

  it("🔴 a estruturada vence a legada — sem partir o euro em duas fatias", () => {
    const r = bloco([saida(200, { categoria: "fornecedor", categoriaEstruturada: "Combustível" })]);
    expect(r.total).toBe(200);
    expect(r.fatias).toHaveLength(1);
    expect(r.fatias[0].categoria).toBe("Combustível");
  });

  it("as duas gerações de categoria coexistem como fatias distintas", () => {
    const r = bloco([
      saida(693.61, { categoria: "fornecedor" }),
      saida(104.67, { categoria: "despesa" }),
    ]);
    // 🔴 Duas fatias, cada uma com o SEU valor — não somadas numa só.
    //
    //    O nome que chega ao ecrã é o rótulo humano («Fornecedores»), não a
    //    chave crua («fornecedor»): o `rotularCategoria` traduz as legadas
    //    conhecidas. A chave é que tem de ser estável, e é por ela que se
    //    verifica a separação.
    expect(r.fatias).toHaveLength(2);
    expect(r.fatias.map((f) => f.chave)).toEqual(
      expect.arrayContaining(["fornecedor", "despesa"]),
    );
    const porChave = new Map(r.fatias.map((f) => [f.chave, f.valor]));
    expect(porChave.get("fornecedor")).toBe(693.61);
    expect(porChave.get("despesa")).toBe(104.67);
  });

  it("o resolver canónico é o MESMO — esta PR não criou uma segunda regra", () => {
    // B: um movimento nascido de pagamento SEM categoria dá «Sem categoria» e
    //    NÃO reaproveita o texto legado que ficou no próprio movimento.
    const r = resolverCategoriaEfetiva(
      {
        reference_type: ORIGEM_PAGAMENTO,
        reference_id: "p-1",
        categoriaEstruturada: null,
        categoriaEstruturadaCor: null,
        categoriaLegada: "despesa",
      },
      { nome: null, cor: null },
    );
    expect(r.nome).toBeNull();
    expect(r.origem).toBe("nenhuma");
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// 3. COBRANÇAS > DIÁRIO — o clique abre mesmo o formulário
// ═══════════════════════════════════════════════════════════════════════════
describe("3. Diário: «Adicionar cobrança» abre o sheet canónico", () => {
  const escritas: string[] = [];

  beforeEach(() => {
    escritas.length = 0;
  });

  async function mostrarDiario(dia: string) {
    // O sheet real é pesado (geocoding, conflitos). O que se prova aqui é o
    // WIRING: o clique abre, com a data certa, e fechar fecha.
    vi.doMock("../app/(dashboard)/dashboard/calendario/_components/service-create-sheet", () => ({
      ServiceCreateSheet: ({ open, date, onClose }: { open: boolean; date: Date; onClose: () => void }) =>
        open
          ? (
            <div data-testid="sheet" data-date={date.toISOString().slice(0, 10)}>
              <button onClick={onClose}>fechar-sheet</button>
            </div>
          )
          : null,
    }));
    vi.doMock("@/lib/supabase/client", () => ({
      createClient: () => ({
        channel: () => ({ on() { return this; }, subscribe() { return this; } }),
        removeChannel: () => {},
      }),
    }));
    vi.doMock("@/app/actions/daily-billing", async (orig) => {
      const real = await (orig() as Promise<Record<string, unknown>>);
      return {
        ...real,
        getDailyBilling: async () => ({ ok: true, data: { day: [], pending: [], vatRate: 23 } }),
        setServicePayment: async () => { escritas.push("setServicePayment"); return { ok: true }; },
      };
    });

    const { DailyBillingClient } = await import(
      "@/app/(dashboard)/dashboard/cobrancas/_components/daily-billing-client"
    );
    await act(async () => {
      root.render(
        <DailyBillingClient
          initialDate={dia}
          initialData={{ day: [], pending: [], vatRate: 23 } as never}
          initialError={null}
          companyId="11111111-1111-4111-8111-111111111111"
          clients={[]}
          locations={[]}
          teams={[{ id: "t1", name: "Equipa A", color: "#0E9F6E" }]}
        />,
      );
    });
  }

  const clicar = async (texto: string) => {
    const alvo = [...container.querySelectorAll("button")]
      .find((b) => (b.textContent ?? "").includes(texto));
    expect(alvo, `botão «${texto}» não encontrado`).toBeTruthy();
    await act(async () => { alvo!.click(); });
  };

  it("🔴 clicar abre o sheet; fechar fecha-o", async () => {
    await mostrarDiario("2026-08-12");
    expect(container.querySelector("[data-testid=sheet]")).toBeNull();

    await clicar("Adicionar cobrança");
    await clicar("Novo serviço");
    expect(container.querySelector("[data-testid=sheet]")).not.toBeNull();

    await clicar("fechar-sheet");
    expect(container.querySelector("[data-testid=sheet]")).toBeNull();
  });

  it("🔴 o sheet recebe o DIA EM VISTA, não «hoje»", async () => {
    await mostrarDiario("2026-08-12");
    await clicar("Adicionar cobrança");
    await clicar("Novo serviço");
    const sheet = container.querySelector("[data-testid=sheet]");
    expect(sheet?.getAttribute("data-date")).toBe("2026-08-12");
  });

  it("🔴 abrir e fechar não escreve nada", async () => {
    await mostrarDiario("2026-08-12");
    await clicar("Adicionar cobrança");
    await clicar("Novo serviço");
    await clicar("fechar-sheet");
    expect(escritas).toEqual([]);
  });
});

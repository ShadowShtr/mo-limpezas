// ============================================================================
// CATEGORIA EFETIVA — quem manda na classificação de uma saída
// ============================================================================
//
// O sintoma: um pagamento «Vitor - Assistente Virtual» com categoria
// «Subcontratação» não aparecia assim no gráfico. Aparecia como «despesa», o
// texto legado.
//
// A causa: marcar um pagamento como pago cria uma linha em `cash_flow_entries`
// que não herda `expense_category_id`. Medido em produção a 2026-08-26: os 6
// movimentos com origem em pagamento têm todos categoria estruturada nula, e um
// deles vem de um pagamento que tem categoria.
//
// A correção **não** é copiar a categoria para o movimento. Copiar resolveria o
// primeiro ecrã e criaria o problema seguinte: editar a categoria do pagamento
// deixaria o movimento com a antiga, e passariam a existir duas classificações
// do mesmo facto a divergir em silêncio.
//
// Resolve-se na leitura. Uma só verdade: a do pagamento.
// ============================================================================
import { describe, it, expect } from "vitest";
import {
  resolverCategoriaEfetiva, idsDePagamentoAResolver, vinculosPartidos,
  ORIGEM_PAGAMENTO,
} from "@/domain/finance-v2/effective-expense-category";

const manual = (over = {}) => ({
  reference_type: null, reference_id: null,
  categoriaEstruturada: null, categoriaEstruturadaCor: null,
  categoriaLegada: "despesa", ...over,
});

const dePagamento = (id: string, over = {}) => ({
  reference_type: ORIGEM_PAGAMENTO, reference_id: id,
  categoriaEstruturada: null, categoriaEstruturadaCor: null,
  categoriaLegada: "despesa", ...over,
});

describe("quem manda na categoria", () => {
  it("CAT01. um movimento manual usa a sua própria categoria", () => {
    const r = resolverCategoriaEfetiva(
      manual({ categoriaEstruturada: "Combustível", categoriaEstruturadaCor: "amber" }), null);
    expect(r).toEqual({ nome: "Combustível", cor: "amber", origem: "movimento" });
  });

  it("CAT02. 🔴 um movimento nascido de pagamento usa a categoria do pagamento", () => {
    // O caso do «Vitor»: o movimento não tem categoria, o pagamento tem.
    const r = resolverCategoriaEfetiva(
      dePagamento("p-1"), { nome: "Subcontratação", cor: "violet" });
    expect(r).toEqual({ nome: "Subcontratação", cor: "violet", origem: "pagamento" });
  });

  it("CAT03. 🔴 o pagamento ganha a um snapshot divergente no movimento", () => {
    // Se o movimento tivesse sido gravado com uma categoria e o pagamento
    // mudasse depois, seguir o snapshot mostraria a classificação velha.
    const r = resolverCategoriaEfetiva(
      dePagamento("p-1", { categoriaEstruturada: "Materiais", categoriaEstruturadaCor: "slate" }),
      { nome: "Subcontratação", cor: "violet" });
    expect(r.nome).toBe("Subcontratação");
    expect(r.origem).toBe("pagamento");
  });

  it("CAT04+05. mudar a categoria do pagamento muda o resultado, sem tocar no movimento", () => {
    const mov = dePagamento("p-1");
    const antes = resolverCategoriaEfetiva(mov, { nome: "Subcontratação", cor: null });
    const depois = resolverCategoriaEfetiva(mov, { nome: "Fornecedores", cor: null });

    expect(antes.nome).toBe("Subcontratação");
    expect(depois.nome).toBe("Fornecedores");
    // O mesmo objeto de movimento produziu as duas — nada foi escrito nele.
    expect(mov.categoriaEstruturada).toBeNull();
  });

  it("CAT06. 🔴 tirar a categoria do pagamento dá «sem categoria», não o texto legado", () => {
    // A autoridade respondeu «nenhuma». Cair para o legado deixaria uma
    // classificação velha presa no gráfico.
    const r = resolverCategoriaEfetiva(
      dePagamento("p-1", { categoriaLegada: "despesa" }), { nome: null, cor: null });
    expect(r).toEqual({ nome: null, cor: null, origem: "nenhuma" });
  });

  it("CAT07. pagamento sem categoria nunca inventa uma", () => {
    const r = resolverCategoriaEfetiva(dePagamento("p-1"), { nome: "   ", cor: null });
    expect(r.nome).toBeNull();
  });

  it("CAT08. o movimento manual continua independente de pagamentos", () => {
    // Mesmo que exista um pagamento com o mesmo valor, um movimento manual não
    // vai buscar categoria a lado nenhum.
    const r = resolverCategoriaEfetiva(manual({ categoriaEstruturada: "Salários" }), { nome: "Outra", cor: null });
    expect(r.nome).toBe("Salários");
    expect(r.origem).toBe("movimento");
  });

  it("CAT09. um salário manual não é tratado como pagamento", () => {
    const r = resolverCategoriaEfetiva(manual({ categoriaLegada: "salario" }), null);
    expect(r).toEqual({ nome: "salario", cor: null, origem: "legada" });
  });

  it("CAT10. 🔴 vínculo partido degrada para o movimento, e é assinalado", () => {
    // `reference_id` não tem chave estrangeira: apontar para nada é possível.
    const mov = dePagamento("p-inexistente", { categoriaEstruturada: "Materiais" });
    const r = resolverCategoriaEfetiva(mov, null);
    expect(r.nome).toBe("Materiais");   // não desaparece
    expect(r.origem).toBe("movimento");

    // E fica registado, em vez de passar despercebido.
    expect(vinculosPartidos([mov], new Set(["p-1"]))).toEqual(["p-inexistente"]);
  });

  it("CAT10b. um movimento manual nunca conta como vínculo partido", () => {
    expect(vinculosPartidos([manual()], new Set())).toEqual([]);
  });

  it("CAT12. só se procuram pagamentos para quem nasceu deles", () => {
    const ids = idsDePagamentoAResolver([
      manual(), dePagamento("p-1"), dePagamento("p-1"), dePagamento("p-2"),
      manual({ reference_type: "invoice", reference_id: "i-9" }),
    ]);
    expect(ids.sort()).toEqual(["p-1", "p-2"]);   // sem repetidos, sem os outros
  });

  it("texto em branco não é categoria", () => {
    expect(resolverCategoriaEfetiva(manual({ categoriaEstruturada: "  ", categoriaLegada: "  " }), null))
      .toEqual({ nome: null, cor: null, origem: "nenhuma" });
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// Guardas permanentes na leitura
// ═══════════════════════════════════════════════════════════════════════════

describe("as leituras usam a regra, e falham fechadas", () => {
  const ler = async (p: string) => {
    const fs = await import("node:fs");
    const path = await import("node:path");
    return fs.readFileSync(path.join(__dirname, "..", "..", p), "utf8").replace(/\r\n/g, "\n");
  };

  it("CAT11. 🔴 falhar a ler os pagamentos não vira «nenhum tem categoria»", async () => {
    // Um erro tratado como lista vazia mostraria um donut plausível e errado —
    // tudo em «sem categoria» — sem ninguém saber que a leitura falhou.
    for (const f of ["src/app/actions/finance-dashboard-v2.ts", "src/app/actions/cash-flow.ts"]) {
      const src = await ler(f);
      // Ancorar no uso, não no import: o import aparece primeiro no ficheiro.
      const i = src.indexOf("const idsPagamento");
      expect(i, f).toBeGreaterThan(-1);
      const bloco = src.slice(i, i + 1500);
      expect(bloco, f).toMatch(/erroPg/);
      expect(bloco, f).toMatch(/return \{ ok: false/);
    }
  });

  it("as duas leituras partilham o mesmo resolver", async () => {
    // A regra escrita duas vezes divergiria — foi assim que o defeito nasceu.
    for (const f of ["src/app/actions/finance-dashboard-v2.ts", "src/app/actions/cash-flow.ts"]) {
      expect(await ler(f), f).toMatch(/from "@\/domain\/finance-v2\/effective-expense-category"/);
    }
  });

  it("a origem é lida do campo, nunca da descrição", async () => {
    const dom = await ler("src/domain/finance-v2/effective-expense-category.ts");
    expect(dom).toMatch(/reference_type/);
    expect(dom).not.toMatch(/description|descricao/i);
  });

  it("o gráfico continua a ler saídas de caixa, não pagamentos", async () => {
    // Trocar a fonte apagaria ~50 mil euros de histórico do ecrã: só 6 das 296
    // saídas vêm de pagamentos.
    const src = await ler("src/app/actions/finance-dashboard-v2.ts");
    expect(src).toMatch(/\.from\("cash_flow_entries"\)/);
  });

  it("o título diz o que o gráfico mede", async () => {
    const ui = await ler("src/app/(dashboard)/dashboard/financeiro/_components/financial-dashboard-client.tsx");
    expect(ui).toMatch(/titulo="Saídas registadas por categoria"/);
    expect(ui).toMatch(/subtitulo=/);
  });
});

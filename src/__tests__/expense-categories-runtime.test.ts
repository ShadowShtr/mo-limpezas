// ============================================================================
// Categorias de despesa — da migration ao donut
// ============================================================================
//
// O que estes testes defendem, em duas frases:
//
//   · uma categoria só existe se alguém a criou de propósito;
//   · uma despesa só tem categoria se alguém lha deu.
//
// Tudo o resto — inferir «Galp» → Combustível, semear catorze categorias numa
// migration, classificar 444 movimentos antigos por descrição — é inventar
// contabilidade a partir de texto livre, e a partir daí ninguém consegue
// distinguir o que foi decidido do que foi adivinhado.
//
// ---------------------------------------------------------------------------
// 🔴 O que não está provado aqui
// ---------------------------------------------------------------------------
// A 071 **não está aplicada**. Nada disto correu contra uma base com
// `expense_categories`. Prova-se a aritmética pura, o contrato das funções e a
// forma do código; não se prova que o ecrã mostra Combustível, porque hoje não
// pode mostrar.
// ============================================================================

import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

import {
  DEFAULT_EXPENSE_CATEGORY_SUGGESTIONS,
  diferencaDeCategorias,
  normalizarNomeCategoria,
  prepararCategorias,
} from "@/domain/finance-v2/expense-categories";
import {
  calcularDespesasPorCategoria,
  type FactoCaixa,
  type Fonte,
} from "@/domain/finance-v2/aggregate";
import type { FinanceReadContext } from "@/domain/finance-v2/types";

const RAIZ = process.cwd();
const ler = (rel: string) => fs.readFileSync(path.join(RAIZ, rel), "utf8");

const M071 = "supabase/migrations/071_finance_periods_and_expense_categories.sql";
const ACTION = "src/app/actions/expense-categories.ts";
const CASHFLOW = "src/app/actions/cash-flow.ts";
const PAGE = "src/app/(dashboard)/dashboard/financeiro/contas/page.tsx";
const CLIENT = "src/app/(dashboard)/dashboard/financeiro/contas/_components/contas-client.tsx";
const LOADER = "src/app/actions/finance-dashboard-v2.ts";
const DOMINIO = "src/domain/finance-v2/expense-categories.ts";

const CTX: FinanceReadContext = {
  companyId: "A", year: 2026, month: 8,
  periodStart: "2026-08-01", periodEnd: "2026-08-31", todayLisbon: "2026-08-20",
};
const ok = <T,>(factos: T[]): Fonte<T> => ({ ok: true, factos });

// ─── 1. A migration não semeia ───────────────────────────────────────────────

describe("a 071 cria a tabela vazia", () => {
  const sql = ler(M071).replace(/^\s*--.*$/gm, "");

  it("🔴 não insere categoria nenhuma", () => {
    expect(sql).not.toMatch(/INSERT\s+INTO\s+public\.expense_categories/i);
  });

  it("🔴 nem nomeia as sugeridas em SQL", () => {
    // Se os catorze nomes aparecessem no SQL, a próxima pessoa a ler assumiria
    // que estão na base — e a lista real da empresa passaria a ser adivinhada.
    for (const s of DEFAULT_EXPENSE_CATEGORY_SUGGESTIONS) {
      expect(sql, `${s.name} não devia estar no SQL`).not.toContain(s.name);
    }
  });

  it("tem o UNIQUE que torna a criação idempotente", () => {
    expect(sql).toMatch(/UNIQUE\s*\(company_id,\s*normalized_name\)/i);
  });

  it("a categoria da despesa é opcional e sobrevive a apagar a categoria", () => {
    // `ON DELETE SET NULL`: apagar uma categoria não pode levar despesas à
    // frente. O movimento fica sem categoria, e o dinheiro continua lá.
    expect(sql).toMatch(/expense_category_id uuid[\s\S]{0,120}ON DELETE SET NULL/i);
    expect(sql).not.toMatch(/expense_category_id uuid NOT NULL/i);
  });
});

// ─── 2. O catálogo é código, não dados ───────────────────────────────────────

describe("o catálogo sugerido", () => {
  it("tem as catorze", () => {
    expect(DEFAULT_EXPENSE_CATEGORY_SUGGESTIONS).toHaveLength(14);
    for (const nome of [
      "Salários", "Combustível", "Materiais e produtos", "Manutenção", "Viaturas",
      "Equipamentos", "Comunicações", "Seguros", "Instalações", "Contabilidade",
      "Impostos e taxas", "Alimentação", "Subcontratação", "Outros",
    ]) {
      expect(DEFAULT_EXPENSE_CATEGORY_SUGGESTIONS.map((s) => s.name)).toContain(nome);
    }
  });

  it("🔴 é domínio puro — não sabe o que é uma base de dados", () => {
    const fonte = ler(DOMINIO);
    expect(fonte).not.toMatch(/supabase|createClient|createAdminClient/i);
    expect(fonte).not.toMatch(/\.insert\(|\.update\(|\.delete\(|\.from\(/);
    expect(fonte).not.toMatch(/"use server"/);
  });

  it("nenhum nome se repete depois de normalizado", () => {
    const { aCriar, descartados } = prepararCategorias(
      DEFAULT_EXPENSE_CATEGORY_SUGGESTIONS.map((s) => s.name),
    );
    expect(descartados).toEqual([]);
    expect(aCriar).toHaveLength(14);
  });
});

// ─── 3. Idempotência ─────────────────────────────────────────────────────────

describe("🔴 criar as sugeridas duas vezes não duplica", () => {
  const nomes = DEFAULT_EXPENSE_CATEGORY_SUGGESTIONS.map((s) => s.name);

  it("a segunda passagem não tem nada a criar", () => {
    const { aCriar } = prepararCategorias(nomes);
    const primeira = diferencaDeCategorias(aCriar, []);
    expect(primeira).toHaveLength(14);

    // Agora existem: a segunda chamada não encontra nada por criar.
    const segunda = diferencaDeCategorias(aCriar, primeira.map((c) => c.normalizedName));
    expect(segunda).toEqual([]);
  });

  it("e reconhece as que já lá estavam escritas de outra maneira", () => {
    // «combustivel» sem acento, «COMBUSTÍVEL » com espaço: é a mesma
    // categoria. Sem normalizar, ficavam três, e o donut repartia a mesma
    // despesa por três fatias.
    const { aCriar } = prepararCategorias(nomes);
    const jaExistem = ["combustivel", "  MATERIAIS E PRODUTOS  ", "Viaturas"];
    const emFalta = diferencaDeCategorias(aCriar, jaExistem);
    expect(emFalta.map((c) => c.name)).not.toContain("Combustível");
    expect(emFalta.map((c) => c.name)).not.toContain("Materiais e produtos");
    expect(emFalta.map((c) => c.name)).not.toContain("Viaturas");
    expect(emFalta).toHaveLength(11);
  });

  it("normalizar tira acentos, maiúsculas e espaços a mais", () => {
    expect(normalizarNomeCategoria("  COMBUSTÍVEL  ")).toBe("combustivel");
    expect(normalizarNomeCategoria("Materiais  e   produtos")).toBe("materiais e produtos");
  });
});

// ─── 4. A action distingue «falta migrar» de «falhou» ────────────────────────

describe("🔴 a 071 em falta não é a mesma coisa que uma consulta falhada", () => {
  const fonte = ler(ACTION);

  it("só códigos de objecto inexistente contam como «falta migrar»", () => {
    // Um erro de RLS ou de rede tratado como «funcionalidade indisponível»
    // esconderia um problema real atrás de uma explicação tranquilizadora
    // sobre uma migration.
    expect(fonte).toMatch(/\["42P01", "42703", "PGRST205"\]/);
  });

  it("um erro real é registado e assinalado, não silenciado", () => {
    expect(fonte).toMatch(/console\.error\(/);
    expect(fonte).toMatch(/A lista abaixo pode estar incompleta/);
  });

  it("a mensagem de indisponível nomeia a migration", () => {
    expect(fonte).toContain("Categorias disponíveis depois da migration 071.");
  });

  it("🔴 lê antes de escrever, e não escreve se a leitura falhar", () => {
    // Assumir «não existe nenhuma» criaria as catorze por cima das que já lá
    // estavam, e o UNIQUE rejeitaria o lote — ou pior, metade dele.
    const i = fonte.indexOf("export async function createSuggestedExpenseCategories");
    const corpo = fonte.slice(i);
    expect(corpo.indexOf("erroLeitura")).toBeLessThan(corpo.indexOf(".insert("));
  });

  it("uma colisão simultânea não é apresentada como erro", () => {
    // 23505 quer dizer que outra pessoa criou a categoria entretanto. O
    // resultado que o utilizador queria — a categoria existir — aconteceu.
    expect(fonte).toMatch(/23505/);
  });

  it("revalida as três vistas que mostram categorias", () => {
    for (const rota of ["/dashboard/financeiro/contas", "/dashboard/financeiro", "/dashboard/financeiro/fluxo-caixa"]) {
      expect(fonte).toContain(`revalidatePath("${rota}")`);
    }
  });
});

// ─── 5. A escrita da despesa ─────────────────────────────────────────────────

describe("createCashFlowEntry e a categoria", () => {
  const fonte = ler(CASHFLOW);

  it("aceita a categoria, e não a exige", () => {
    expect(fonte).toMatch(/expenseCategoryId\?:\s*string \| null/);
  });

  it("🔴 o nome camelCase não vai para a base", () => {
    // `...data` copiava as chaves tal como estão, e não há coluna nenhuma com
    // esse nome — o insert seria recusado inteiro por um campo que só existe
    // no vocabulário do TypeScript.
    expect(fonte).toMatch(/const \{ expenseCategoryId, \.\.\.colunas \} = data;/);
    expect(fonte).toMatch(/expenseCategoryId \? \{ expense_category_id: expenseCategoryId \} : \{\}/);
  });

  it("🔴 a escrita continua a parecer uma escrita", () => {
    // Uma primeira versão do cast embrulhou o `.insert` numa variável, e o
    // detector de capacidade de escrita deixou de reconhecer esta action.
    // O cliquet acusou duas capacidades «removidas» que estavam bem vivas.
    const i = fonte.indexOf("export async function createCashFlowEntry");
    const corpo = fonte.slice(i, fonte.indexOf("export async function", i + 10));
    expect(corpo).toMatch(/\.from\("cash_flow_entries"\)\s*\n?\s*\.insert\(/);
  });

  it("getAccountsData pede a categoria estruturada", () => {
    expect(fonte).toContain("expense_categories(name, color_token)");
  });

  it("🔴 e recua só quando a 071 falta — nunca para lista vazia", () => {
    const i = fonte.indexOf("export async function getAccountsData");
    const corpo = fonte.slice(i, fonte.indexOf("return { ok: true, toReceive, toPay, expenses };", i));
    expect(corpo).toMatch(/categoriaAindaNaoExiste\(expensesRes\.error\)/);
    // Qualquer outro erro sai como erro.
    expect(corpo).toMatch(/return \{ ok: false, error: expensesRes\.error\.message \}/);
    // E o recuo também verifica o seu próprio erro.
    expect(corpo).toMatch(/semCategoria\.error/);
  });

  it("aceita a relação como objecto e como lista", () => {
    // O PostgREST devolve uma ou outra conforme a cardinalidade que infere.
    // Assumir uma delas dava categoria `null` sem erro nenhum a explicar.
    expect(fonte).toMatch(/Array\.isArray\(r\.expense_categories\)/);
  });
});

// ─── 6. A página e o formulário ──────────────────────────────────────────────

describe("a página das Contas", () => {
  it("carrega o catálogo em paralelo com as contas", () => {
    const fonte = ler(PAGE);
    expect(fonte).toMatch(/Promise\.all\(\[[\s\S]{0,200}getExpenseCategoryCatalog\(\)/);
  });

  it("🔴 o recuo é «indisponível», não «vazio»", () => {
    // Um catálogo vazio faria a UI dizer «ainda não há categorias criadas» a
    // quem tem a base por migrar — e mandava clicar num botão inútil.
    const fonte = ler(PAGE);
    expect(fonte).toMatch(/available: false, categories: \[\], suggestions: \[\], missingSuggestions: \[\]/);
  });
});

describe("o formulário de despesa", () => {
  const fonte = ler(CLIENT);

  it("envia a categoria escolhida", () => {
    expect(fonte).toMatch(/expenseCategoryId: expenseCategoryId \|\| null/);
  });

  it("«Sem categoria» é uma escolha, e fica a null", () => {
    expect(fonte).toContain(">Sem categoria<");
  });

  it("mostra o botão de criar as sugeridas quando faltam", () => {
    expect(fonte).toMatch(/expenseCatalog\.missingSuggestions\.length > 0/);
    expect(fonte).toContain("Criar categorias sugeridas");
    expect(fonte).toContain("handleCreateSuggestions");
  });

  it("🔴 sem a 071, mantém o select antigo e diz porquê", () => {
    expect(fonte).toMatch(/expenseCatalog\.available \?/);
    expect(fonte).toMatch(/ficam\s*\n?\s*disponíveis quando a migration 071 for aplicada/);
    expect(fonte).toContain(">Despesa geral<");
  });

  it("a linha otimista só mostra categorias que existem", () => {
    // Inventar um nome aqui faria a linha mudar sozinha no refresh seguinte.
    expect(fonte).toMatch(/expenseCatalog\.categories\.find\(\(c\) => c\.id === expenseCategoryId\)\?\.name \?\? null/);
  });

  it("a tabela usa a categoria real quando existe, e a legada quando não", () => {
    expect(fonte).toMatch(/e\.expense_category_name \?/);
    expect(fonte).toMatch(/CATEGORY_LABELS\[e\.category\]/);
  });
});

// ─── 7. O donut ──────────────────────────────────────────────────────────────

describe("🔴 o donut usa a categoria estruturada", () => {
  const saida = (amount: number, categoria: string | null, estruturada?: string | null): FactoCaixa => ({
    date: "2026-08-10", tipo: "saida", status: "confirmado", amount, categoria,
    categoriaEstruturada: estruturada,
  });

  it("uma despesa com categoria real aparece pelo nome real", () => {
    const b = calcularDespesasPorCategoria(ok([saida(50, "fornecedor", "Combustível")]), CTX);
    expect(b.fatias.map((f) => f.categoria)).toEqual(["Combustível"]);
    expect(b.fatias[0].valor).toBe(50);
  });

  it("🔴 e não é contada também pela legada", () => {
    // Somar as duas dimensões partiria o mesmo euro por duas fatias, e o total
    // do donut deixava de bater com os Custos.
    const b = calcularDespesasPorCategoria(ok([saida(50, "fornecedor", "Combustível")]), CTX);
    expect(b.total).toBe(50);
    expect(b.fatias).toHaveLength(1);
  });

  it("uma despesa antiga sem categoria fica «Sem categoria»", () => {
    // «Sem categoria» é uma fatia própria, e não uma omissão: o donut tem de
    // mostrar 100 % dos custos, senão o total desmente-o.
    const b = calcularDespesasPorCategoria(ok([saida(30, null)]), CTX);
    expect(b.semCategoria).toBe(30);
    expect(b.fatias.map((f) => f.categoria)).toEqual(["Sem categoria"]);
    expect(b.fatias[0].chave).toBeNull();
  });

  it("🔴 «Galp» não vira Combustível sozinho", () => {
    // A descrição nunca entra nesta conta — nem sequer chega ao agregador.
    const b = calcularDespesasPorCategoria(ok([saida(50, null)]), CTX);
    expect(b.fatias.map((f) => f.categoria)).not.toContain("Combustível");
    expect(b.semCategoria).toBe(50);
  });

  it("as duas coexistem sem se misturarem", () => {
    const b = calcularDespesasPorCategoria(
      ok([saida(50, "fornecedor", "Combustível"), saida(20, "fornecedor"), saida(10, null)]),
      CTX,
    );
    expect(b.total).toBe(80);
    expect(b.semCategoria).toBe(10);
    const porNome = Object.fromEntries(b.fatias.map((f) => [f.categoria, f.valor]));
    expect(porNome["Combustível"]).toBe(50);
    // A legada mantém o rótulo que sempre teve — `fornecedor` → «Fornecedores».
    expect(porNome["Fornecedores"]).toBe(20);
    expect(porNome["Sem categoria"]).toBe(10);
  });

  it("o nome mantém as maiúsculas com que foi escrito", () => {
    // A chave de agrupamento é minúscula; o rótulo não tem de ser.
    const b = calcularDespesasPorCategoria(ok([saida(10, null, "Materiais e produtos")]), CTX);
    expect(b.fatias[0].categoria).toBe("Materiais e produtos");
  });

  it("o carregador pede o nome, e recua se a 071 faltar", () => {
    const fonte = ler(LOADER);
    expect(fonte).toContain("expense_categories(name)");
    expect(fonte).toMatch(/categoriaEstruturadaEmFalta\(error\)/);
  });
});

// ─── 8. Nada classifica por texto ────────────────────────────────────────────

describe("🔴 não há classificação automática em lado nenhum", () => {
  it("nenhum destes ficheiros olha para a descrição para decidir categoria", () => {
    // O comentário que explica a regra também contém as palavras — por isso
    // varre-se o código sem comentários. É a armadilha «mencionar ≠ usar»,
    // que já apanhou este projecto mais do que uma vez.
    for (const rel of [ACTION, CASHFLOW, LOADER, DOMINIO, "src/domain/finance-v2/aggregate.ts"]) {
      const codigo = ler(rel).replace(/^\s*(\/\/|\*|\/\*).*$/gm, "");
      expect(codigo, `${rel} menciona Galp`).not.toMatch(/galp/i);
      expect(codigo, `${rel} testa a descrição`).not.toMatch(/description.*(includes|match|test)\(/i);
    }
  });

  it("nenhum faz backfill do histórico", () => {
    for (const rel of [ACTION, CASHFLOW, M071]) {
      const codigo = ler(rel).replace(/^\s*(--|\/\/|\*).*$/gm, "");
      expect(codigo, `${rel} faz UPDATE em massa`)
        .not.toMatch(/UPDATE\s+(public\.)?cash_flow_entries\s+SET\s+expense_category_id/i);
    }
  });
});

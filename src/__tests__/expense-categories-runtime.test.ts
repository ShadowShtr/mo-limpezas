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
  corDaCategoria,
  distinguirCores,
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
    expect(fonte).toContain("expense_categories(name, color_token)");
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

// ─── 9. Do donut até à correcção da despesa ──────────────────────────────────
//
// O donut mostrava percentagens e mais nada: 50 % de quê, e de que despesas?
// Um número que não leva a lado nenhum obriga a ir procurar à mão o movimento
// que se quer corrigir.

describe("🔴 o donut leva às despesas, e as despesas editam-se", () => {
  const DONUT = "src/components/financeiro/v2/finance-intelligence.tsx";
  const PAINEL = "src/app/(dashboard)/dashboard/financeiro/_components/financial-dashboard-client.tsx";

  it("cada fatia leva às despesas dessa categoria", () => {
    expect(ler(DONUT)).toMatch(/hrefDe\?\.\(a\) \?\? null/);
    expect(ler(PAINEL)).toMatch(/dashboard\/financeiro\/contas\?mes=.*categoria=/);
  });

  it("e o mês vai com o link — a categoria de Agosto abre Agosto", () => {
    // Sem o mês, clicar numa fatia de Julho abriria as despesas do mês
    // corrente, e os números não bateriam com a fatia de onde se veio.
    expect(ler(PAINEL)).toMatch(/snapshot\.period\.year/);
  });

  it("o donut mostra valores, não só percentagens", () => {
    // «50 %» sem base não diz se são 50 € ou 5 000 €.
    const fonte = ler(DONUT);
    expect(fonte).toMatch(/fmtEur\(a\.valor\)/);
    expect(fonte).toMatch(/fmtEur\(total\)/);
  });

  it("🔴 Contas avisa quando a lista chega filtrada", () => {
    // Sem o aviso, quem chega do donut vê três despesas onde havia doze e
    // conclui que se perderam.
    const fonte = ler(CLIENT);
    expect(fonte).toMatch(/categoriaInicial && \(/);
    expect(fonte).toMatch(/href="\/dashboard\/financeiro\/contas"/);
  });

  it("o filtro compara pela categoria real e pela legada", () => {
    // Uma despesa antiga só tem a legada. Comparar só pela estruturada faria
    // a fatia «Fornecedores» abrir uma lista vazia.
    const fonte = ler(CLIENT);
    expect(fonte).toMatch(/e\.expense_category_name \?\? e\.category/);
  });

  it("uma despesa pode ser editada, e não só marcada como paga", () => {
    const fonte = ler(CLIENT);
    expect(fonte).toContain("abrirEdicao");
    expect(fonte).toContain("handleUpdate");
    expect(fonte).toMatch(/editando \? "Editar despesa" : "Registar despesa"/);
  });

  it("🔴 editar pode retirar a categoria, não só trocá-la", () => {
    // `|| null`: escolher «Sem categoria» tem de reverter uma categoria posta
    // por engano. Se o `null` não fosse enviado, ficava lá para sempre.
    const fonte = ler(CLIENT);
    const i = fonte.indexOf("function handleUpdate");
    const corpo = fonte.slice(i, fonte.indexOf("function handleCreate", i));
    expect(corpo).toMatch(/expenseCategoryId: expenseCategoryId \|\| null/);
  });

  it("a action aceita data e categoria, e valida a data", () => {
    const fonte = ler(CASHFLOW);
    const i = fonte.indexOf("export async function updateCashFlowEntry");
    const corpo = fonte.slice(i, i + 3000);
    expect(corpo).toMatch(/date\?:\s*string/);
    expect(corpo).toMatch(/expenseCategoryId\?:\s*string \| null/);
    // A mesma validação que fechou a corrupção `"72026-01-01"` de Julho.
    expect(corpo).toMatch(/isValidIsoDateString\(data\.date\)/);
  });

  it("🔴 `undefined` não apaga a categoria; `null` apaga", () => {
    // Se o patch enviasse sempre a chave, uma actualização só do valor punha
    // a categoria a `null` sem ninguém pedir.
    const fonte = ler(CASHFLOW);
    expect(fonte).toMatch(/expenseCategoryId !== undefined \? \{ expense_category_id: expenseCategoryId \} : \{\}/);
  });
});

// ─── 10. Cada categoria com a sua cor ────────────────────────────────────────
//
// O donut mostrava tudo roxo fora das treze chaves de uma palavra que o mapa
// conhecia. Um gráfico onde três fatias têm a mesma cor não é um gráfico.

describe("🔴 as cores distinguem as categorias", () => {
  const saida = (amount: number, estruturada: string | null, cor?: string | null): FactoCaixa => ({
    date: "2026-08-10", tipo: "saida", status: "confirmado", amount,
    categoria: null, categoriaEstruturada: estruturada, categoriaEstruturadaCor: cor,
  });

  it("as sugeridas têm cada uma a sua cor", () => {
    const b = calcularDespesasPorCategoria(ok([
      saida(10, "Combustível"), saida(20, "Materiais e produtos"),
      saida(30, "Viaturas"), saida(40, "Impostos e taxas"),
      saida(50, "Subcontratação"), saida(60, "Alimentação"),
    ]), CTX);
    const cores = b.fatias.map((f) => f.cor);
    expect(new Set(cores).size).toBe(cores.length);
  });

  it("🔴 nomes de várias palavras deixaram de cair todos na mesma cor", () => {
    // Era este o defeito: o mapa só tinha chaves de uma palavra, e o resto
    // apanhava o mesmo `#8B5CF6`.
    const b = calcularDespesasPorCategoria(ok([
      saida(10, "Materiais e produtos"), saida(20, "Impostos e taxas"),
    ]), CTX);
    expect(b.fatias[0].cor).not.toBe(b.fatias[1].cor);
  });

  it("Combustível é laranja e Fornecedores é azul", () => {
    const laranja = calcularDespesasPorCategoria(ok([saida(10, "Combustível")]), CTX);
    expect(laranja.fatias[0].cor).toBe("#FF7A1A");

    const azul = calcularDespesasPorCategoria(
      ok([{ date: "2026-08-10", tipo: "saida", status: "confirmado", amount: 10, categoria: "fornecedor" }]),
      CTX,
    );
    expect(azul.fatias[0].cor).toBe("#3B82F6");
  });

  it("a cor guardada na categoria manda sobre a nossa tabela", () => {
    // É configurável na base. Uma cor escolhida por quem usa não deve ser
    // sobreposta por um mapa nosso.
    const b = calcularDespesasPorCategoria(ok([saida(10, "Combustível", "#123456")]), CTX);
    expect(b.fatias[0].cor).toBe("#123456");
  });

  it("uma cor inválida na base não passa para o ecrã", () => {
    const b = calcularDespesasPorCategoria(ok([saida(10, "Combustível", "vermelho")]), CTX);
    expect(b.fatias[0].cor).toBe("#FF7A1A");
  });

  it("🔴 duas categorias nunca saem com a mesma cor no mesmo gráfico", () => {
    // Duas categorias inventadas que calhem no mesmo índice da paleta lêem-se
    // como uma fatia só. A segunda muda para a primeira cor livre.
    const nomes = Array.from({ length: 9 }, (_, i) => `Categoria ${i}`);
    const b = calcularDespesasPorCategoria(ok(nomes.map((n, i) => saida(10 + i, n))), CTX);
    const cores = b.fatias.filter((f) => f.chave !== null).map((f) => f.cor);
    expect(new Set(cores).size).toBe(cores.length);
  });

  it("a maior fatia fica com a sua cor própria; quem muda é a menor", () => {
    const b = calcularDespesasPorCategoria(ok([saida(1000, "Combustível"), saida(1, "Outra")]), CTX);
    expect(b.fatias[0].cor).toBe("#FF7A1A");
  });

  it("«Sem categoria» é sempre cinzento", () => {
    const b = calcularDespesasPorCategoria(
      ok([saida(10, "Combustível"), { date: "2026-08-10", tipo: "saida", status: "confirmado", amount: 5, categoria: null }]),
      CTX,
    );
    expect(b.fatias.find((f) => f.chave === null)?.cor).toBe("#CBD5E1");
  });

  it("a mesma categoria tem sempre a mesma cor", () => {
    // Uma cor aleatória por render tornaria o donut incomparável de um mês
    // para o outro.
    const uma = calcularDespesasPorCategoria(ok([saida(10, "Portagens")]), CTX).fatias[0].cor;
    const outra = calcularDespesasPorCategoria(ok([saida(99, "Portagens")]), CTX).fatias[0].cor;
    expect(uma).toBe(outra);
  });

  it("nove categorias cabem no gráfico antes de haver «Outros»", () => {
    // Com catorze possíveis, cortar às cinco mandava quase tudo para «Outros»
    // — e «Outros» não é uma categoria com que se decida alguma coisa.
    const nomes = Array.from({ length: 9 }, (_, i) => `Cat ${i}`);
    const b = calcularDespesasPorCategoria(ok(nomes.map((n, i) => saida(10 + i, n))), CTX);
    expect(b.fatias.map((f) => f.categoria)).not.toContain("Outros");
  });
});

// ─── 11. As duas defesas da cor, testadas em separado ────────────────────────
//
// 🔴 Escrito depois de uma mutação as apanhar as duas vivas.
//
// Os testes acima passavam com o `?? "#8B5CF6"` de volta **e** com o desempate
// removido — cada defesa mascarava a falha da outra: o desempate corrigia o
// roxo repetido, e os nomes que escolhi nunca colidiam no hash, por isso o
// desempate nunca chegava a ser exercido.
//
// Duas defesas só estão provadas se forem medidas uma a uma.

describe("🔴 a paleta de recurso, sozinha", () => {
  it("nomes desconhecidos recebem cores diferentes", () => {
    // Sem `distinguirCores` pelo meio. Se voltar o `?? "#8B5CF6"`, estas
    // quatro saem iguais e o teste falha aqui, onde tem de falhar.
    const cores = ["Portagens", "Uniformes", "Publicidade", "Rendas"]
      .map((n) => corDaCategoria(n.toLowerCase()));
    expect(new Set(cores).size).toBeGreaterThan(1);
  });

  it("e nunca a mesma cor para todos", () => {
    const cores = Array.from({ length: 24 }, (_, i) => corDaCategoria(`categoria inventada ${i}`));
    expect(new Set(cores).size).toBeGreaterThanOrEqual(8);
  });

  it("a cor de um nome desconhecido é estável", () => {
    expect(corDaCategoria("portagens")).toBe(corDaCategoria("portagens"));
  });
});

describe("🔴 o desempate, sozinho", () => {
  it("duas fatias com a mesma cor deixam de a ter", () => {
    // Entrada com colisão deliberada, em vez de esperar que o hash colida por
    // acaso — que foi o que fez este guarda passar despercebido.
    const saida = distinguirCores([
      { chave: "a", cor: "#FF7A1A" },
      { chave: "b", cor: "#FF7A1A" },
      { chave: "c", cor: "#FF7A1A" },
    ]);
    expect(new Set(saida.map((f) => f.cor)).size).toBe(3);
  });

  it("a primeira fica com a cor que trazia", () => {
    const saida = distinguirCores([
      { chave: "a", cor: "#FF7A1A" },
      { chave: "b", cor: "#FF7A1A" },
    ]);
    expect(saida[0].cor).toBe("#FF7A1A");
    expect(saida[1].cor).not.toBe("#FF7A1A");
  });

  it("«Sem categoria» pode repetir a cor de quem for", () => {
    // O cinzento significa ausência, e é o único que não se troca.
    const saida = distinguirCores([
      { chave: "a", cor: "#CBD5E1" },
      { chave: null, cor: "#CBD5E1" },
    ]);
    expect(saida[1].cor).toBe("#CBD5E1");
  });

  it("🔴 e o agregador usa-o mesmo", () => {
    // Testar a função e não a sua utilização é a armadilha «mencionar ≠ usar»,
    // que já apanhou este projecto várias vezes. Remover a chamada em
    // `calcularDespesasPorCategoria` passava por todos os outros testes.
    //
    // «Publicidade» e «Ferramentas» colidem mesmo na paleta de recurso —
    // procurados de propósito, em vez de esperar que o hash colidisse por
    // acaso, que foi o erro da primeira versão destes testes.
    const saida = (nome: string, amount: number): FactoCaixa => ({
      date: "2026-08-10", tipo: "saida", status: "confirmado", amount,
      categoria: null, categoriaEstruturada: nome,
    });
    expect(corDaCategoria("publicidade")).toBe(corDaCategoria("ferramentas"));

    const b = calcularDespesasPorCategoria(ok([saida("Publicidade", 100), saida("Ferramentas", 50)]), CTX);
    expect(b.fatias).toHaveLength(2);
    expect(b.fatias[0].cor).not.toBe(b.fatias[1].cor);
  });

  it("cores já distintas passam intactas", () => {
    const entrada = [{ chave: "a", cor: "#FF7A1A" }, { chave: "b", cor: "#16A35A" }];
    expect(distinguirCores(entrada)).toEqual(entrada);
  });

  it("mais fatias do que cores não rebenta", () => {
    const entrada = Array.from({ length: 30 }, (_, i) => ({ chave: `c${i}`, cor: "#FF7A1A" }));
    expect(() => distinguirCores(entrada)).not.toThrow();
    expect(distinguirCores(entrada)).toHaveLength(30);
  });
});

// ─── 12. O que o donut não mostra, e diz que não mostra ──────────────────────
//
// Achado real: registou-se uma despesa de Combustível e ela não apareceu no
// gráfico. Não era das cores nem das categorias — o donut conta só movimentos
// `confirmado`, e as despesas registadas em Contas nascem `pendente`.

describe("🔴 despesas por confirmar não desaparecem em silêncio", () => {
  const desp = (amount: number, status: string, cat: string | null = "Combustível"): FactoCaixa => ({
    date: "2026-08-10", tipo: "saida", status, amount,
    categoria: null, categoriaEstruturada: cat,
  });

  it("uma despesa pendente não entra no gráfico", () => {
    // E é correcto que não entre: se entrasse, o total do donut deixava de
    // bater com o KPI «Custos» ao lado, e ninguém saberia em qual acreditar.
    const b = calcularDespesasPorCategoria(ok([desp(50, "pendente")]), CTX);
    expect(b.total).toBe(0);
    expect(b.fatias).toEqual([]);
  });

  it("🔴 mas é contada e anunciada", () => {
    const b = calcularDespesasPorCategoria(ok([desp(50, "pendente")]), CTX);
    expect(b.pendentes).toEqual({ total: 50, contagem: 1 });
  });

  it("confirmada, entra no gráfico e sai dos pendentes", () => {
    const b = calcularDespesasPorCategoria(ok([desp(50, "confirmado")]), CTX);
    expect(b.total).toBe(50);
    expect(b.fatias[0].categoria).toBe("Combustível");
    expect(b.pendentes.contagem).toBe(0);
  });

  it("as duas contas não se misturam", () => {
    const b = calcularDespesasPorCategoria(
      ok([desp(100, "confirmado"), desp(50, "pendente"), desp(25, "pendente", "Viaturas")]),
      CTX,
    );
    expect(b.total).toBe(100);
    expect(b.pendentes).toEqual({ total: 75, contagem: 2 });
  });

  it("pendentes de outro mês não contam", () => {
    const b = calcularDespesasPorCategoria(
      ok([{ ...desp(50, "pendente"), date: "2026-07-10" }]), CTX,
    );
    expect(b.pendentes.contagem).toBe(0);
  });

  it("uma leitura falhada não inventa pendentes a zero", () => {
    const b = calcularDespesasPorCategoria({ ok: false, erro: "timeout" }, CTX);
    expect(b.estado).toBe("ERROR");
    expect(b.pendentes).toEqual({ total: 0, contagem: 0 });
  });

  it("🔴 o painel mostra o aviso, e só quando há pendentes", () => {
    const painel = ler("src/app/(dashboard)/dashboard/financeiro/_components/financial-dashboard-client.tsx");
    expect(painel).toMatch(/pendentes\.contagem > 0/);
    expect(painel).toMatch(/por confirmar/);
    expect(painel).toMatch(/marcadas como\s+pagas/);
  });
});

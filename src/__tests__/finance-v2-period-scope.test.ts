// ============================================================================
// O período governa todas as abas financeiras
// ============================================================================
//
// O seletor diz «Agosto 2026». Se uma aba responder sobre outro horizonte, a
// interface está a afirmar uma coisa que o motor não sustenta — e o utilizador
// não tem como perceber qual das duas está certa.
//
// Já se encontraram três casos:
//
//   getFinancialDashboard   ignorava o período por completo    → corrigido
//   getAccountsData         devolvia toda a história           → corrigido
//   getBankReconciliationData  últimos 500 movimentos de sempre → corrigido
//
// Estes testes existem para o quarto não passar despercebido.
// ============================================================================

import { describe, it, expect } from "vitest";
import fs from "node:fs";
import path from "node:path";

import { stripComments } from "@/lib/finance-write-surface";
import { calcularKpis, type FactoFatura, type FactoFolha, type Fonte } from "@/domain/finance-v2/aggregate";
import type { FinanceReadContext } from "@/domain/finance-v2/types";

const ROOT = process.cwd();
const ler = (rel: string) => fs.readFileSync(path.join(ROOT, rel), "utf8");
const codigo = (rel: string) => stripComments(ler(rel));

const ctx = (year: number, month: number): FinanceReadContext => ({
  companyId: "A", year, month,
  periodStart: `${year}-${String(month).padStart(2, "0")}-01`,
  periodEnd: `${year}-${String(month).padStart(2, "0")}-${new Date(Date.UTC(year, month, 0)).getUTCDate()}`,
  todayLisbon: "2026-08-12",
});

// ─── 1. As sete páginas resolvem o período ───────────────────────────────────

const PAGINAS = [
  "src/app/(dashboard)/dashboard/financeiro/page.tsx",
  "src/app/(dashboard)/dashboard/financeiro/pagamentos/page.tsx",
  "src/app/(dashboard)/dashboard/financeiro/contas/page.tsx",
  "src/app/(dashboard)/dashboard/financeiro/fluxo-caixa/page.tsx",
  "src/app/(dashboard)/dashboard/financeiro/conciliacao/page.tsx",
  "src/app/(dashboard)/dashboard/cobrancas/page.tsx",
  "src/app/(dashboard)/dashboard/folha-pagamento/page.tsx",
];

describe("todas as vistas leem o mesmo `?mes=`", () => {
  it("cada página resolve o período da rota", () => {
    for (const p of PAGINAS) {
      expect(codigo(p), `${p} não lê o período`).toMatch(/parseFinancePeriod\(params\.mes\)/);
    }
  });

  it("🔴 nenhuma página decide o mês pelo relógio", () => {
    // `new Date()` numa página de servidor decide o mês em UTC, e discorda do
    // seletor durante a primeira hora do dia em hora de verão.
    for (const p of PAGINAS) {
      expect(codigo(p), `${p} usa o relógio`).not.toMatch(/new Date\(\)\.getMonth|new Date\(\)\.getFullYear/);
    }
  });
});

// ─── 2. Os carregadores aceitam o período ────────────────────────────────────

describe("os carregadores recebem o período, e usam-no", () => {
  it("🔴 getAccountsData filtra os três blocos", () => {
    const src = codigo("src/app/actions/cash-flow.ts");
    const i = src.indexOf("export async function getAccountsData");
    // Até ao fim da função, e não uma janela de N caracteres: a janela fixa
    // encolhe sozinha sempre que alguém acrescenta um comentário, e o teste
    // passa a medir o comprimento do texto em vez do comportamento.
    const corpo = src.slice(i, src.indexOf("return { ok: true, toReceive, toPay, expenses };", i));

    expect(corpo, "assinatura sem período").toMatch(/input\?:\s*\{\s*year:\s*number;\s*month:\s*number\s*\}/);
    // Faturas pelo **período contabilístico**, salários pelo período da folha,
    // despesas pela data do movimento. As faturas filtravam por `due_date`, e
    // isso fazia Contas e o Resumo discordarem sobre o mês de uma fatura de
    // Julho que vence em Agosto.
    //
    // 🔴 O filtro das faturas deixou de ser um `gte("period_start")` em SQL: um
    //    `period_start` nulo não satisfaz a comparação, e essas faturas
    //    desapareciam de **todos** os meses das Contas enquanto o dashboard as
    //    contava pelo vencimento. Agora o SQL é uma rede larga e quem decide é
    //    `estaPorReceber`, partilhado com o motor.
    expect(corpo).toMatch(/period_start\.is\.null/);
    expect(corpo).toContain("estaPorReceber(");
    expect(corpo, "o filtro fino não volta para o SQL").not.toMatch(/invoicesQ\.gte\("period_start"/);
    expect(corpo).toMatch(/payrollQ\.eq\("period_year"/);
    // A consulta das despesas passou a ser uma função, para poder ser repetida
    // sem o `join` de `expense_categories` quando a 071 ainda não existe. O
    // filtro pela data do movimento é o mesmo.
    expect(corpo).toMatch(/q\.gte\("date", periodo\.inicio\)\.lte\("date", periodo\.fim\)/);
  });

  it("🔴 getBankReconciliationData filtra os movimentos", () => {
    const src = codigo("src/app/actions/bank-reconciliation.ts");
    expect(src).toMatch(/period\?:\s*\{\s*year:\s*number;\s*month:\s*number\s*\}/);
    expect(src).toMatch(/txQuery\.gte\("transaction_date"/);
  });

  it("as páginas passam mesmo o período aos carregadores", () => {
    expect(codigo("src/app/(dashboard)/dashboard/financeiro/contas/page.tsx"))
      .toMatch(/getAccountsData\(\s*\{\s*year:\s*period\.year,\s*month:\s*period\.month\s*\}\s*\)/);
    expect(codigo("src/app/(dashboard)/dashboard/financeiro/conciliacao/page.tsx"))
      .toMatch(/period:\s*\{\s*year:\s*period\.year,\s*month:\s*period\.month\s*\}/);
  });

  it("o Resumo usa o motor novo, não o legado, para os números", () => {
    const src = codigo("src/app/(dashboard)/dashboard/financeiro/page.tsx");
    expect(src).toMatch(/getFinanceDashboardV2\(\s*\{\s*year:\s*period\.year,\s*month:\s*period\.month\s*\}\s*\)/);
  });
});

// ─── 3. Julho 100 / Agosto 200 ───────────────────────────────────────────────

describe("🔴 Julho 100, Agosto 200", () => {
  const ok = <T,>(f: T[]): Fonte<T> => ({ ok: true, factos: f });
  const semFolha: Fonte<FactoFolha> = ok([]);
  const fatura = (o: Partial<FactoFatura>): FactoFatura => ({
    id: "f", status: "pendente", total: 0, dueDate: null, paidAt: null,
    periodStart: null, clientId: null, clientName: null, ...o,
  });

  const faturas = ok([
    fatura({ id: "jul", total: 100, periodStart: "2026-07-01", dueDate: "2026-07-31" }),
    fatura({ id: "ago", total: 200, periodStart: "2026-08-01", dueDate: "2026-08-31" }),
  ]);

  it("Faturado muda com o mês", () => {
    expect(calcularKpis(faturas, ok([]), semFolha, ctx(2026, 7)).faturado.valor).toBe(100);
    expect(calcularKpis(faturas, ok([]), semFolha, ctx(2026, 8)).faturado.valor).toBe(200);
  });

  it("🔴 Em aberto também — e não a carteira toda", () => {
    // Era o defeito que restava: «Em aberto» somava faturas de todos os
    // períodos, e não mudava ao trocar de mês.
    const jul = calcularKpis(faturas, ok([]), semFolha, ctx(2026, 7)).emAberto.valor;
    const ago = calcularKpis(faturas, ok([]), semFolha, ctx(2026, 8)).emAberto.valor;
    expect(jul).toBe(100);
    expect(ago).toBe(200);
    expect(jul).not.toBe(ago);
  });

  it("Custos e Recebido seguem as datas dos movimentos", () => {
    const caixa = ok([
      { date: "2026-07-05", tipo: "entrada" as const, status: "confirmado", amount: 100, categoria: null },
      { date: "2026-08-05", tipo: "entrada" as const, status: "confirmado", amount: 200, categoria: null },
      { date: "2026-07-06", tipo: "saida" as const, status: "confirmado", amount: 10, categoria: "fornecedor" },
      { date: "2026-08-06", tipo: "saida" as const, status: "confirmado", amount: 20, categoria: "fornecedor" },
    ]);
    expect(calcularKpis(ok([]), caixa, semFolha, ctx(2026, 7)).recebido.valor).toBe(100);
    expect(calcularKpis(ok([]), caixa, semFolha, ctx(2026, 8)).recebido.valor).toBe(200);
    expect(calcularKpis(ok([]), caixa, semFolha, ctx(2026, 7)).custos.valor).toBe(10);
    expect(calcularKpis(ok([]), caixa, semFolha, ctx(2026, 8)).custos.valor).toBe(20);
  });

  it("🔴 uma falha continua a não virar zero, em qualquer mês", () => {
    for (const m of [7, 8]) {
      const k = calcularKpis({ ok: false, erro: "timeout" }, ok([]), semFolha, ctx(2026, m));
      expect(k.faturado.estado).toBe("ERROR");
      expect(k.faturado.valor).toBeNull();
    }
  });
});

// ─── 4. Aging: global, e assumido como tal ───────────────────────────────────

describe("aging — global por decisão explícita", () => {
  it("é a carteira vencida inteira, e isso está escrito", () => {
    // Uma decisão que fica assumida em vez de silenciosa: o aging responde
    // «que dívida antiga existe hoje», não «que dívida nasceu em Agosto».
    // Filtrá-lo pelo mês esvaziaria os baldes de +30 dias precisamente quando
    // são mais úteis.
    const src = ler("src/domain/finance-v2/aggregate.ts");
    const i = src.indexOf("export function calcularAging");
    const corpo = src.slice(Math.max(i - 900, 0), i + 400);
    expect(corpo, "a decisão tem de estar documentada").toMatch(/carteira|global|idade/i);
  });
});

// ─── 5. Falha nunca vira zero, nas escritas também ───────────────────────────

describe("🔴 os carregadores não engolem erros", () => {
  it("getAccountsData verifica as três consultas", () => {
    // A das despesas faltava: uma falha devolvia lista vazia e o cartão
    // «A Pagar (Despesas)» mostrava 0,00 € — indistinguível de um mês sem
    // despesas nenhumas.
    const src = codigo("src/app/actions/cash-flow.ts");
    for (const q of ["invoicesRes", "payrollRes", "expensesRes"]) {
      expect(src, `${q} sem verificação de erro`).toContain(`if (${q}.error)`);
    }
  });

  it("🔴 Contas e o dashboard usam o mesmo critério de período para faturas", () => {
    // Filtrar por `due_date` num lado e `period_start` no outro faz uma fatura
    // de Julho que vence a 5 de Agosto aparecer em meses diferentes nas duas
    // áreas — e nenhuma das duas está obviamente errada a olhar para ela.
    // 🔴 Já não são dois critérios parecidos: é **um**. A TASK 12 mediu os dois
    //    lado a lado e encontrou-os a discordar em dois casos reais — uma
    //    fatura `pendente` com `paid_at` preenchido, e uma sem `period_start`.
    //    A definição passou a viver num sítio só.
    const contas = codigo("src/app/actions/cash-flow.ts");
    expect(contas).toContain("estaPorReceber(");
    expect(contas, "due_date não é período contabilístico")
      .not.toMatch(/invoicesQ\.gte\("due_date"/);

    // E o motor usa a mesma função para o mesmo KPI.
    const motor = codigo("src/domain/finance-v2/aggregate.ts");
    expect(motor).toMatch(/export function periodoDaFatura/);
    expect(motor).toMatch(/export function estaPorReceber/);
    expect(motor).toMatch(/faturas\.factos\.filter\(\(f\) => estaPorReceber\(f, ctx\)\)/);
  });

  it("🔴 generateInvoices não transforma falha em «nada a faturar»", () => {
    // Se a consulta das avenças falhar e o erro for ignorado, a função devolve
    // sucesso com zero faturas: ninguém é faturado nesse mês e o ecrã diz que
    // correu bem. Custa dinheiro por cobrar, em silêncio.
    const src = codigo("src/app/actions/invoices.ts");
    const i = src.indexOf("export async function _generateInvoices");
    const corpo = src.slice(i > -1 ? i : 0, (i > -1 ? i : 0) + 12000);

    for (const guarda of [
      /if \(monthlyErr\) return/,
      /if \(fixedLocErr\) return/,
      /if \(locErr\) return/,
      /if \(cliErr\) return/,
      /if \(existingErr\) return/,
      /if \(activeContractsErr\) return/,
    ]) {
      expect(corpo, `guarda em falta: ${guarda}`).toMatch(guarda);
    }
  });

  it("🔴 uma fatura que falha a gravar não é saltada em silêncio", () => {
    const src = codigo("src/app/actions/invoices.ts");
    // O `continue` fazia a fatura desaparecer sem rasto, com a função a
    // devolver sucesso e menos faturas do que devia.
    //
    // A guarda mudou de forma com a 072: já não há dois pedidos para guardar,
    // há um. O que se exige continua a ser o mesmo — a falha aborta a geração
    // e nomeia o cliente, em vez de saltar para o seguinte.
    // Só dentro do ciclo que cria as faturas: os `continue` que filtram
    // serviços antes disso são legítimos, e proibir a palavra em todo o
    // ficheiro media texto em vez de comportamento.
    const i = src.indexOf("for (const [clientId, svcs] of byClient)");
    const geracao = src.slice(i, src.indexOf("revalidatePath(", i));
    expect(geracao).not.toMatch(/continue;/);
    expect(geracao).toMatch(/if \(!criada\.ok\) \{/);
    expect(geracao).toMatch(/return \{ ok: false, error: `\$\{nome\}: \$\{criada\.error\}` \}/);
  });

  it("um IVA errado não passa por omissão silenciosa", () => {
    const src = codigo("src/app/actions/invoices.ts");
    expect(src).toMatch(/settingsErr && settingsErr\.code !== "PGRST116"/);
  });
});

// ─── 6. Os prédios podem mesmo receber valor ─────────────────────────────────

describe("🔴 o valor do prédio é introduzível", () => {
  it("createBuildingCard aceita a avença", () => {
    // O card do Resumo mostra `monthly_value`, e os 146 prédios têm-no todos a
    // null — mas não havia forma de o preencher. Um número que só se pode ler
    // nunca deixa de ser desconhecido.
    const src = codigo("src/app/actions/building-cards.ts");
    const i = src.indexOf("export async function createBuildingCard");
    const corpo = src.slice(i, i + 1800);
    expect(corpo).toMatch(/monthlyValue\?: number \| null/);
    // Passou a gravar o valor **já validado no servidor**, não o que veio no
    // pedido: `NaN` e negativos não chegam à base.
    expect(corpo).toMatch(/monthly_value: avenca\.valor/);
  });

  it("o formulário tem o campo, e vazio significa sem valor", () => {
    const form = codigo("src/app/(dashboard)/dashboard/clientes/_components/predios-table.tsx");
    expect(form).toMatch(/monthlyValue/);
    expect(form, "vazio → null, nunca zero").toMatch(/bruto === ""\s*\?\s*null/);
    expect(form).toMatch(/monthlyValue: valorMensal/);
  });

  it("🔴 alterar um prédio revalida o Resumo financeiro", () => {
    // Sem isto, mudar uma avença não mexia no número que o dono estava a ver.
    const src = codigo("src/app/actions/building-cards.ts");
    expect((src.match(/revalidatePath\("\/dashboard\/financeiro"\)/g) ?? []).length)
      .toBeGreaterThanOrEqual(2);
  });
});

// ─── 7. Nenhuma escrita fica a meio, e nenhuma falha parcial passa ───────────

describe("🔴 uma fatura nunca fica sem linhas", () => {
  const src = codigo("src/app/actions/invoices.ts");

  it("🔴 deixou de haver dois pedidos para compensar", () => {
    // O que aqui estava era uma compensação: gravava-se o cabeçalho, gravavam-
    // -se as linhas e, se as linhas falhassem, apagava-se o cabeçalho.
    // Funcionava enquanto a compensação corresse — e se o processo morresse
    // entre os dois, ficava um documento sem linhas, com subtotal e total
    // certos e o ar de uma fatura normal na lista.
    //
    // Com a 072 aplicada, a transacção é da base. Não há janela entre os dois
    // pedidos porque não há dois pedidos.
    const i = src.indexOf("for (const [clientId, svcs] of byClient)");
    const geracao = src.slice(i, src.indexOf("revalidatePath(", i));
    expect(geracao).toContain("criarFaturaComLinhas(admin");
    expect(geracao, "insert directo de volta").not.toMatch(/\.from\("invoices"\)[\s\S]{0,80}\.insert\(/);
    expect(geracao, "linhas em pedido separado").not.toMatch(/\.from\("invoice_items"\)/);
    expect(geracao, "compensação já não é precisa").not.toMatch(/\.delete\(\)/);
  });

  it("🔴 e a base recusa uma fatura sem linhas", () => {
    // A garantia mudou de sítio, não desapareceu. Um documento a zero com o
    // aspecto de emitido é pior do que um erro.
    const sql = codigo("supabase/migrations/072_invoice_atomic_creation.sql");
    expect(sql).toMatch(/jsonb_array_length\(p_items\) = 0/);
    expect(sql).toMatch(/RAISE EXCEPTION 'Uma fatura sem linhas/);
    // E confere que gravou tantas linhas quantas recebeu.
    expect(sql).toMatch(/v_itens <> jsonb_array_length\(p_items\)/);
  });

  it("a aplicação nem chega a pedir uma fatura vazia", () => {
    const helper = codigo("src/lib/finance-rpc/invoice-creation.ts");
    expect(helper).toMatch(/entrada\.items\.length === 0/);
  });

  it("uma falha diz de que cliente é", () => {
    // «Falha ao criar a fatura» sozinho obriga a adivinhar qual dos clientes
    // do lote é que ficou por faturar.
    const i = src.indexOf("if (!criada.ok)");
    expect(i).toBeGreaterThan(-1);
    expect(src.slice(i, i + 400)).toMatch(/clientMap\[clientId\]\?\.name/);
  });
});

describe("🔴 a avença do prédio é validada no servidor", () => {
  const src = codigo("src/app/actions/building-cards.ts");

  it("existe um validador, e as duas actions usam-no", () => {
    // Uma server action é um endpoint: um pedido feito à mão ou um cliente em
    // cache chegam cá sem passar pelo `<input>`. E `NaN` propaga-se por
    // qualquer soma que o toque.
    expect(src).toMatch(/function validarAvenca/);
    expect((src.match(/validarAvenca\(input\.monthlyValue\)/g) ?? []).length).toBe(2);
  });

  it("delega no validador partilhado, que é testado a executar", () => {
    // 🔴 Havia aqui dois testes que liam o texto do validador e confirmavam que
    //    as linhas certas existiam. As linhas existiam — e a regra estava
    //    errada: `Math.round(v * 100) !== v * 100` recusava 0,29 €, 10,12 € e
    //    19,99 €, porque o binário não representa esses valores exactamente.
    //
    //    Um teste que verifica que o código existe não verifica que o código
    //    está certo. A regra passou para `@/domain/finance-v2/money`, que é
    //    importável, e as provas estão em `finance-v2-money.test.ts` — a
    //    correr, com esses valores.
    expect(src).toMatch(/validarValorMonetario/);
    expect(src, "a regra não pode voltar para dentro da action")
      .not.toMatch(/Math\.round\(valor \* 100\) !== valor \* 100/);
  });

});

describe("🔴 a Conciliação falha de forma explícita", () => {
  const src = codigo("src/app/actions/bank-reconciliation.ts");

  it("as três consultas do carregamento são verificadas", () => {
    // Sem contas e sem importações, a página lê-se como «esta empresa nunca
    // importou nada» — e o utilizador reimporta o mesmo extrato.
    for (const q of ["txRes", "impRes", "accRes"]) {
      expect(src, `${q} sem verificação`).toContain(`if (${q}.error)`);
    }
  });

  it("uma falha nas sugestões não vira «zero sugestões»", () => {
    // Indistinguível de um extrato em que nada casa — e a conciliação passaria
    // a ser toda manual sem ninguém perceber porquê.
    expect(src).toMatch(/const \{ data: matches, error: matchesErr \}/);
    expect(src).toMatch(/if \(matchesErr\) return/);
  });
});

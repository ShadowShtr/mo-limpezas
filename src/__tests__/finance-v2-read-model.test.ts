// ============================================================================
// Financeiro V2 — o modelo de leitura
// ============================================================================
//
// O defeito que motivou esta ronda: `getFinancialDashboard` ignorava o período
// e calculava sempre o mês corrente. O seletor dizia «Agosto 2026» e os KPIs
// respondiam sobre outra coisa — a interface a afirmar algo que o motor não
// sustentava.
//
// O primeiro teste deste ficheiro é esse. Se Julho e Agosto devolverem o mesmo
// com fixtures diferentes, falha.
// ============================================================================

import { describe, it, expect } from "vitest";
import fs from "node:fs";
import path from "node:path";

import { createWriteCapabilityResolver, stripComments } from "@/lib/finance-write-surface";

import {
  calcularAging,
  calcularAlertas,
  calcularKpis,
  calcularTopClientes,
  calcularDespesasPorCategoria,
  calcularPredios,
  ESTADOS_FATURADO,
  ESTADOS_PAGA,
  ESTADOS_FATURA_VALIDOS,
  type FactoPredio,
  corDaCategoria,
  diasEntre,
  somarDias,
  type FactoCaixa,
  type FactoFatura,
  type FactoFolha,
  type Fonte,
} from "@/domain/finance-v2/aggregate";
import type { FinanceReadContext } from "@/domain/finance-v2/types";

const ctx = (year: number, month: number, hoje = "2026-08-12"): FinanceReadContext => ({
  companyId: "empresa-A",
  year,
  month,
  periodStart: `${year}-${String(month).padStart(2, "0")}-01`,
  periodEnd: `${year}-${String(month).padStart(2, "0")}-${new Date(Date.UTC(year, month, 0)).getUTCDate()}`,
  todayLisbon: hoje,
});

const fatura = (o: Partial<FactoFatura>): FactoFatura => ({
  id: "f1", status: "pendente", total: 100, dueDate: null, paidAt: null,
  periodStart: null, clientId: null, clientName: null, ...o,
});

const caixa = (o: Partial<FactoCaixa>): FactoCaixa => ({
  date: "2026-08-10", tipo: "entrada", status: "confirmado", amount: 100, categoria: null, ...o,
});

const ok = <T,>(factos: T[]): Fonte<T> => ({ ok: true, factos });
const falhou = <T,>(erro: string): Fonte<T> => ({ ok: false, erro });
const semFolha: Fonte<FactoFolha> = ok([]);

// ─── 1. O PERÍODO GOVERNA TUDO ───────────────────────────────────────────────

describe("🔴 o período selecionado governa o snapshot", () => {
  const faturas = ok([
    fatura({ id: "jul", total: 100, periodStart: "2026-07-01" }),
    fatura({ id: "ago", total: 200, periodStart: "2026-08-01" }),
  ]);

  it("Julho devolve 100 e Agosto devolve 200", () => {
    expect(calcularKpis(faturas, ok([]), semFolha, ctx(2026, 7)).faturado.valor).toBe(100);
    expect(calcularKpis(faturas, ok([]), semFolha, ctx(2026, 8)).faturado.valor).toBe(200);
  });

  it("🔴 dois meses diferentes não podem dar o mesmo resultado", () => {
    // Era exactamente isto que acontecia: o loader legado ignorava o argumento
    // e respondia sempre sobre o mês do relógio.
    const jul = calcularKpis(faturas, ok([]), semFolha, ctx(2026, 7)).faturado.valor;
    const ago = calcularKpis(faturas, ok([]), semFolha, ctx(2026, 8)).faturado.valor;
    expect(jul).not.toBe(ago);
  });

  it("nenhum KPI depende do relógio — só do contexto", () => {
    // Mesmos factos, mesmo período, "hoje" diferente: os KPIs não se mexem.
    const a = calcularKpis(faturas, ok([]), semFolha, ctx(2026, 8, "2026-08-01"));
    const b = calcularKpis(faturas, ok([]), semFolha, ctx(2026, 8, "2026-12-31"));
    expect(a.faturado.valor).toBe(b.faturado.valor);
  });

  it("o mês muda também os clientes e a série", () => {
    const comCliente = ok([
      fatura({ id: "j", total: 100, periodStart: "2026-07-01", clientId: "c1", clientName: "Alfa" }),
      fatura({ id: "a", total: 200, periodStart: "2026-08-01", clientId: "c2", clientName: "Beta" }),
    ]);
    expect(calcularTopClientes(comCliente, ctx(2026, 7)).clientes[0].clientName).toBe("Alfa");
    expect(calcularTopClientes(comCliente, ctx(2026, 8)).clientes[0].clientName).toBe("Beta");
  });
});

// ─── 2. ZERO REAL ≠ INDISPONÍVEL ≠ ERRO ──────────────────────────────────────

describe("🔴 zero real, indisponível e erro são três coisas diferentes", () => {
  it("carregou e não há nada → AVAILABLE 0", () => {
    // Agosto tem mesmo zero faturado. Isso é um facto, e mostra-se `0,00 €`.
    const k = calcularKpis(ok([]), ok([]), semFolha, ctx(2026, 8));
    expect(k.faturado.estado).toBe("AVAILABLE");
    expect(k.faturado.valor).toBe(0);
  });

  it("a fonte falhou → ERROR, valor null", () => {
    // O padrão que este projecto passou meses a caçar: `data ?? []` a
    // transformar uma query rebentada num zero indistinguível do verdadeiro.
    const k = calcularKpis(falhou("timeout"), ok([]), semFolha, ctx(2026, 8));
    expect(k.faturado.estado).toBe("ERROR");
    expect(k.faturado.valor).toBeNull();
  });

  it("os dois estados não produzem o mesmo resultado", () => {
    const zero = calcularKpis(ok([]), ok([]), semFolha, ctx(2026, 8)).faturado;
    const erro = calcularKpis(falhou("x"), ok([]), semFolha, ctx(2026, 8)).faturado;
    expect(zero).not.toEqual(erro);
  });

  it("sem faturação, a margem em percentagem é indisponível — não Infinity", () => {
    const k = calcularKpis(ok([]), ok([caixa({ tipo: "saida", amount: 500 })]), semFolha, ctx(2026, 8));
    expect(k.margemPct.estado).toBe("UNAVAILABLE");
    expect(k.margemPct.valor).toBeNull();
    expect(Number.isFinite(k.margem.valor!)).toBe(true);
    expect(k.margem.valor).toBe(-500);
  });
});

// ─── 3. Rascunho não é faturado ──────────────────────────────────────────────

describe("um rascunho não é receita", () => {
  it("faturas em rascunho não contam como faturado", () => {
    // É o caso real: as 11 faturas da base estão todas em `rascunho`. Contá-las
    // seria dizer que se pediu dinheiro a clientes que nunca receberam nada.
    const k = calcularKpis(
      ok([fatura({ status: "rascunho", total: 3300, periodStart: "2026-08-01" })]),
      ok([]), semFolha, ctx(2026, 8),
    );
    expect(k.faturado.valor).toBe(0);
    expect(k.faturado.estado).toBe("AVAILABLE");
  });

  it("uma fatura emitida conta", () => {
    const k = calcularKpis(
      ok([fatura({ status: "pendente", total: 3300, periodStart: "2026-08-01" })]),
      ok([]), semFolha, ctx(2026, 8),
    );
    expect(k.faturado.valor).toBe(3300);
  });
});

// ─── 4. Salário não é contado duas vezes ─────────────────────────────────────

describe("🔴 SALARY_DOUBLE_COUNT", () => {
  const folha = ok([{ grossSalary: 1000, netSalary: 800, workedHours: 160, status: "aprovado" }]);

  it("se o salário já saiu do caixa, a folha não é somada por cima", () => {
    const k = calcularKpis(
      ok([]),
      ok([caixa({ tipo: "saida", amount: 1000, categoria: "salario" })]),
      folha,
      ctx(2026, 8),
    );
    expect(k.custos.valor, "1000, não 2000").toBe(1000);
  });

  it("sem salário no caixa, a folha entra", () => {
    const k = calcularKpis(
      ok([]),
      ok([caixa({ tipo: "saida", amount: 300, categoria: "fornecedor" })]),
      folha,
      ctx(2026, 8),
    );
    expect(k.custos.valor).toBe(1300);
  });

  it("folha em falha → custos PARTIAL, e diz porquê", () => {
    const k = calcularKpis(
      ok([]),
      ok([caixa({ tipo: "saida", amount: 300, categoria: "fornecedor" })]),
      falhou("folha indisponível"),
      ctx(2026, 8),
    );
    expect(k.custos.estado).toBe("PARTIAL");
    expect(k.custos.valor).toBe(300);
    expect(k.custos.nota).toBeTruthy();
  });
});

// ─── 5. Recebido vem de uma fonte só ─────────────────────────────────────────

describe("recebido não soma duas fontes", () => {
  it("conta entradas de caixa confirmadas, não `paid_at` das faturas", () => {
    // Se ambas representassem o mesmo recebimento, somá-las duplicava-o.
    const k = calcularKpis(
      ok([fatura({ status: "pago", total: 500, paidAt: "2026-08-05", periodStart: "2026-08-01" })]),
      ok([caixa({ tipo: "entrada", amount: 500, date: "2026-08-05" })]),
      semFolha,
      ctx(2026, 8),
    );
    expect(k.recebido.valor, "500, não 1000").toBe(500);
  });

  it("entradas pendentes não contam como recebidas", () => {
    const k = calcularKpis(
      ok([]),
      ok([caixa({ tipo: "entrada", amount: 500, status: "pendente" })]),
      semFolha,
      ctx(2026, 8),
    );
    expect(k.recebido.valor).toBe(0);
  });
});

// ─── 6. Alertas: vazio verde ≠ erro ──────────────────────────────────────────

describe("🔴 alertas — vazio e erro não podem parecer iguais", () => {
  it("fontes carregadas e nada a assinalar → AVAILABLE, lista vazia", () => {
    const b = calcularAlertas(ok([]), ok([]), ctx(2026, 8));
    expect(b.estado).toBe("AVAILABLE");
    expect(b.alertas).toEqual([]);
  });

  it("fonte de faturas falhou → ERROR, nunca verde", () => {
    const b = calcularAlertas(falhou("500"), ok([]), ctx(2026, 8));
    expect(b.estado).toBe("ERROR");
    expect(b.alertas).toEqual([]);
  });

  it("os dois não produzem o mesmo bloco", () => {
    expect(calcularAlertas(ok([]), ok([]), ctx(2026, 8)))
      .not.toEqual(calcularAlertas(falhou("x"), ok([]), ctx(2026, 8)));
  });

  it("vencido traz contagem, montante e a mais antiga", () => {
    const b = calcularAlertas(
      ok([
        fatura({ id: "a", total: 100, dueDate: "2026-08-01" }),
        fatura({ id: "b", total: 200, dueDate: "2026-07-15" }),
      ]),
      ok([]),
      ctx(2026, 8, "2026-08-12"),
    );
    const v = b.alertas.find((a) => a.tipo === "VENCIDO")!;
    expect(v.count).toBe(2);
    expect(v.amount).toBe(300);
    expect(v.oldestDueDate).toBe("2026-07-15");
  });

  it("vence em 7 dias usa dias civis, e não apanha o que já venceu", () => {
    const b = calcularAlertas(
      ok([
        fatura({ id: "hoje", total: 10, dueDate: "2026-08-12" }),
        fatura({ id: "limite", total: 20, dueDate: "2026-08-19" }),
        fatura({ id: "fora", total: 40, dueDate: "2026-08-20" }),
        fatura({ id: "vencida", total: 80, dueDate: "2026-08-01" }),
      ]),
      ok([]),
      ctx(2026, 8, "2026-08-12"),
    );
    const p = b.alertas.find((a) => a.tipo === "VENCE_7_DIAS")!;
    expect(p.count).toBe(2);
    expect(p.amount).toBe(30);
  });
});

// ─── 7. Aging ────────────────────────────────────────────────────────────────

describe("aging — cada fatura num balde só", () => {
  const hoje = "2026-08-12";
  const faturas = ok([
    fatura({ id: "d2", total: 10, dueDate: somarDias(hoje, -2) }),
    fatura({ id: "d9", total: 20, dueDate: somarDias(hoje, -9) }),
    fatura({ id: "d20", total: 40, dueDate: somarDias(hoje, -20) }),
    fatura({ id: "d45", total: 80, dueDate: somarDias(hoje, -45) }),
  ]);

  it("2, 9, 20 e 45 dias caem nos quatro baldes", () => {
    const a = calcularAging(faturas, ctx(2026, 8, hoje));
    expect(a.faixas.map((f) => f.count)).toEqual([1, 1, 1, 1]);
    expect(a.faixas.map((f) => f.amount)).toEqual([10, 20, 40, 80]);
  });

  it("🔴 a soma dos baldes é igual ao total vencido", () => {
    const a = calcularAging(faturas, ctx(2026, 8, hoje));
    const alertas = calcularAlertas(faturas, ok([]), ctx(2026, 8, hoje));
    const v = alertas.alertas.find((x) => x.tipo === "VENCIDO")!;
    expect(a.faixas.reduce((n, f) => n + f.count, 0)).toBe(v.count);
    expect(a.faixas.reduce((n, f) => n + f.amount, 0)).toBe(v.amount);
  });

  it("as fronteiras dos baldes não deixam cair nada", () => {
    for (const d of [1, 7, 8, 15, 16, 30, 31]) {
      const a = calcularAging(ok([fatura({ total: 5, dueDate: somarDias(hoje, -d) })]), ctx(2026, 8, hoje));
      expect(a.faixas.reduce((n, f) => n + f.count, 0), `${d} dias`).toBe(1);
    }
  });
});

// ─── 8. Top clientes determinístico ─────────────────────────────────────────

describe("top clientes", () => {
  it("ordena por valor e desempata pelo nome", () => {
    const f = ok([
      fatura({ id: "1", total: 100, periodStart: "2026-08-01", clientId: "b", clientName: "Beta" }),
      fatura({ id: "2", total: 100, periodStart: "2026-08-01", clientId: "a", clientName: "Alfa" }),
      fatura({ id: "3", total: 300, periodStart: "2026-08-01", clientId: "c", clientName: "Gama" }),
    ]);
    const t = calcularTopClientes(f, ctx(2026, 8));
    expect(t.clientes.map((c) => c.clientName)).toEqual(["Gama", "Alfa", "Beta"]);
    expect(t.clientes[0].share).toBeCloseTo(0.6, 3);
  });

  it("é estável entre execuções", () => {
    const f = ok([
      fatura({ id: "1", total: 50, periodStart: "2026-08-01", clientId: "x", clientName: "Xis" }),
      fatura({ id: "2", total: 50, periodStart: "2026-08-01", clientId: "y", clientName: "Ipsilon" }),
    ]);
    const a = calcularTopClientes(f, ctx(2026, 8)).clientes.map((c) => c.clientId);
    const b = calcularTopClientes(f, ctx(2026, 8)).clientes.map((c) => c.clientId);
    expect(a).toEqual(b);
  });
});

// ─── 9. Aritmética de datas sem fuso ────────────────────────────────────────

describe("datas — aritmética UTC, sem depender do fuso do processo", () => {
  it("soma dias atravessando meses e anos", () => {
    expect(somarDias("2026-08-28", 7)).toBe("2026-09-04");
    expect(somarDias("2026-12-31", 1)).toBe("2027-01-01");
    expect(somarDias("2026-03-01", -1)).toBe("2026-02-28");
  });

  it("conta dias entre datas", () => {
    expect(diasEntre("2026-08-01", "2026-08-12")).toBe(11);
    expect(diasEntre("2026-07-15", "2026-08-12")).toBe(28);
  });
});

// ─── 10. O motor não consegue escrever ───────────────────────────────────────

describe("🔴 fail-closed de escrita", () => {
  const ROOT = process.cwd();
  const MOTOR = "src/app/actions/finance-dashboard-v2.ts";
  const ler = (rel: string) => fs.readFileSync(path.join(ROOT, rel), "utf8");

  it("o motor não faz nenhuma mutação directa", () => {
    // Este ficheiro alimenta o Resumo, que é a página de entrada do módulo. Se
    // escrever, abrir a página escreve — exactamente o incidente que se passou
    // semanas a conter.
    const src = stripComments(ler(MOTOR));
    expect(src).not.toMatch(/\.(insert|update|upsert|delete)\s*\(/);
    expect(src).not.toMatch(/\.rpc\s*\(/);
  });

  it("nenhuma das actions que importa é capaz de escrever", () => {
    const resolvedor = createWriteCapabilityResolver((rel) => {
      try { return ler(rel); } catch { return null; }
    });
    expect(resolvedor.exportsThatWrite(MOTOR)).toEqual([]);
  });

  it("a agregação é pura — não conhece Supabase nem tabelas", () => {
    const src = stripComments(ler("src/domain/finance-v2/aggregate.ts"));
    expect(src).not.toMatch(/@\/lib\/supabase|createClient|createAdminClient/);
    expect(src).not.toMatch(/\.from\s*\(\s*["'`]/);
  });

  it("o motor recebe o período — não o inventa", () => {
    const src = stripComments(ler(MOTOR));
    expect(src).toMatch(/year:\s*number;\s*month:\s*number/);
    // `new Date()` só aparece para o carimbo `generatedAt` e para o último dia
    // do mês; nunca para decidir *qual* é o mês.
    expect(src).not.toMatch(/new Date\(\)\.getMonth|new Date\(\)\.getFullYear/);
  });
});

// ─── 11. Despesas por categoria ──────────────────────────────────────────────

describe("despesas por categoria", () => {
  const saida = (amount: number, categoria: string | null, date = "2026-08-10"): FactoCaixa =>
    ({ date, tipo: "saida", status: "confirmado", amount, categoria });

  it("🔴 as fatias somam sempre o total das despesas", () => {
    // Um donut cujas fatias não somam o todo mente sobre proporções.
    const b = calcularDespesasPorCategoria(
      ok([saida(100, "salario"), saida(50, "combustivel"), saida(25, null)]),
      ctx(2026, 8),
    );
    expect(b.total).toBe(175);
    expect(b.fatias.reduce((n, f) => n + f.valor, 0)).toBe(b.total);
    expect(b.fatias.reduce((n, f) => n + f.share, 0)).toBeCloseTo(1, 2);
  });

  it("🔴 não adivinha categoria — sem categoria fica «Sem categoria»", () => {
    // Inferir "Galp" → combustível por texto seria fabricar contabilidade a
    // partir de uma descrição escrita à pressa.
    const b = calcularDespesasPorCategoria(ok([saida(80, null)]), ctx(2026, 8));
    const sem = b.fatias.find((f) => f.chave === null)!;
    expect(sem.categoria).toBe("Sem categoria");
    expect(sem.valor).toBe(80);
    expect(b.semCategoria).toBe(80);
  });

  it("agrupa o excedente em «Outros», e só quando existe mesmo", () => {
    const muitas = ["salario", "combustivel", "material", "seguro", "viatura", "equipamento", "outro"]
      .map((c, i) => saida(100 - i, c));
    const b = calcularDespesasPorCategoria(ok(muitas), ctx(2026, 8), 5);
    expect(b.fatias.filter((f) => f.chave === "__outros__")).toHaveLength(1);

    const poucas = calcularDespesasPorCategoria(ok([saida(10, "salario")]), ctx(2026, 8), 5);
    expect(poucas.fatias.some((f) => f.chave === "__outros__")).toBe(false);
  });

  it("só conta saídas do período — mas confirmadas e pendentes", () => {
    // 🔴 Mudou de propósito. Este gráfico responde a «em que estamos a
    //    gastar», e uma despesa registada já é um gasto conhecido; esperar
    //    pela confirmação fazia com que quem acabou de a lançar não a
    //    encontrasse em lado nenhum.
    //
    //    O KPI «Custos» **não** mudou: continua a contar só o dinheiro que
    //    saiu. A divergência é real, é conhecida, e o card explica-a.
    const b = calcularDespesasPorCategoria(
      ok([
        saida(100, "salario"),
        { date: "2026-07-10", tipo: "saida", status: "confirmado", amount: 999, categoria: "salario" },
        { date: "2026-08-10", tipo: "saida", status: "pendente", amount: 50, categoria: "salario" },
        { date: "2026-08-10", tipo: "entrada", status: "confirmado", amount: 999, categoria: null },
      ]),
      ctx(2026, 8),
    );
    expect(b.total).toBe(150);
    expect(b.pendentes).toEqual({ total: 50, contagem: 1 });
  });

  it("🔴 o KPI «Custos» continua a contar só o que saiu", () => {
    // A prova de que a mudança ficou confinada ao gráfico. Se os Custos
    // passassem também a incluir pendentes, a Margem do mês mudava sozinha.
    const k = calcularKpis(
      ok([]),
      ok([
        saida(100, "salario"),
        { date: "2026-08-10", tipo: "saida", status: "pendente", amount: 50, categoria: "salario" },
      ]),
      ok([]),
      ctx(2026, 8),
    );
    expect(k.custos.valor).toBe(100);
  });

  it("a fonte falhou → ERROR, não um donut vazio", () => {
    const b = calcularDespesasPorCategoria(falhou("timeout"), ctx(2026, 8));
    expect(b.estado).toBe("ERROR");
    expect(b.fatias).toEqual([]);
  });

  it("a cor de uma categoria é estável entre chamadas", () => {
    // Cor aleatória por render faria a mesma categoria mudar de cor entre
    // carregamentos, e o donut deixaria de se comparar de mês para mês.
    expect(corDaCategoria("salario")).toBe(corDaCategoria("salario"));
    expect(corDaCategoria("salario")).not.toBe(corDaCategoria("combustivel"));
    expect(corDaCategoria(null)).toBeTruthy();
  });

  it("ordena por valor e desempata pelo nome", () => {
    const b = calcularDespesasPorCategoria(
      ok([saida(50, "viatura"), saida(50, "combustivel"), saida(90, "salario")]),
      ctx(2026, 8),
    );
    expect(b.fatias.map((f) => f.chave)).toEqual(["salario", "combustivel", "viatura"]);
  });
});

// ─── 12. Prédios ─────────────────────────────────────────────────────────────

describe("prédios — cadeia própria, e um total que não mente", () => {
  const predio = (o: Partial<FactoPredio>): FactoPredio => ({
    id: "p1", name: "Edifício A", address: "Rua X", weekday: "mon",
    sortOrder: 0, monthlyValue: 100, ...o,
  });

  it("ordena por sort_order e desempata pelo nome", () => {
    const b = calcularPredios(ok([
      predio({ id: "3", name: "Zeta", sortOrder: 1 }),
      predio({ id: "1", name: "Beta", sortOrder: 0 }),
      predio({ id: "2", name: "Alfa", sortOrder: 0 }),
    ]));
    expect(b.linhas.map((l) => l.nome)).toEqual(["Alfa", "Beta", "Zeta"]);
  });

  it("🔴 valor nulo é desconhecido, nunca zero", () => {
    // A avença destes prédios ficou por preencher na importação, de propósito.
    // Mostrar 0,00 € diria que não rendem nada.
    const b = calcularPredios(ok([predio({ monthlyValue: null })]));
    expect(b.linhas[0].valor).toBeNull();
    expect(b.totalConhecido, "sem nenhum valor conhecido não há total").toBeNull();
    expect(b.estado).toBe("PARTIAL");
  });

  it("🔴 o caso real: 146 prédios, nenhum com valor", () => {
    const muitos = Array.from({ length: 146 }, (_, i) =>
      predio({ id: `p${i}`, name: `Prédio ${i}`, sortOrder: i, monthlyValue: null }));
    const b = calcularPredios(ok(muitos));
    expect(b.contagem).toBe(146);
    expect(b.comValor).toBe(0);
    expect(b.semValor).toBe(146);
    expect(b.totalConhecido).toBeNull();
    expect(b.estado).toBe("PARTIAL");
    expect(b.nota).toMatch(/Nenhum prédio tem avença/);
  });

  it("o total soma só os conhecidos, e diz quantos são", () => {
    const b = calcularPredios(ok([
      predio({ id: "a", name: "A", monthlyValue: 100 }),
      predio({ id: "b", name: "B", monthlyValue: 50 }),
      predio({ id: "c", name: "C", monthlyValue: null }),
    ]));
    expect(b.totalConhecido).toBe(150);
    expect(b.comValor).toBe(2);
    expect(b.semValor).toBe(1);
    expect(b.estado, "faltam valores → parcial").toBe("PARTIAL");
  });

  it("todos conhecidos → AVAILABLE", () => {
    const b = calcularPredios(ok([
      predio({ id: "a", name: "A", monthlyValue: 100 }),
      predio({ id: "b", name: "B", monthlyValue: 50 }),
    ]));
    expect(b.estado).toBe("AVAILABLE");
    expect(b.totalConhecido).toBe(150);
  });

  it("zero prédios é zero real, não indisponível", () => {
    const b = calcularPredios(ok([]));
    expect(b.estado).toBe("AVAILABLE");
    expect(b.totalConhecido).toBe(0);
    expect(b.contagem).toBe(0);
  });

  it("🔴 consulta falhada é ERROR, nunca zero", () => {
    const b = calcularPredios(falhou("timeout"));
    expect(b.estado).toBe("ERROR");
    expect(b.totalConhecido).toBeNull();
    expect(b.linhas).toEqual([]);
  });

  it("🔴 duplicados entre dias são assinalados, não deduplicados", () => {
    // Quatro prédios reais aparecem em dois dias — são duas visitas ao mesmo
    // sítio. Agrupar por nome seria inferência sobre texto livre: dois prédios
    // podem chamar-se «Pedrogão 14» e ser edifícios distintos.
    const b = calcularPredios(ok([
      predio({ id: "1", name: "Pedrogão 14", weekday: "mon", monthlyValue: null }),
      predio({ id: "2", name: "Pedrogão 14", weekday: "thu", monthlyValue: null }),
      predio({ id: "3", name: "Outro", monthlyValue: null }),
    ]));
    expect(b.contagem, "as três linhas continuam lá").toBe(3);
    expect(b.linhas.filter((l) => l.repetido)).toHaveLength(2);
    expect(b.repetidos).toBe(1);
  });

  it("🔴 duplicado COM valor força estado parcial e avisa", () => {
    // Este é o caso perigoso: somar as duas contaria a mesma avença duas vezes.
    const b = calcularPredios(ok([
      predio({ id: "1", name: "Repetido", weekday: "mon", monthlyValue: 100 }),
      predio({ id: "2", name: "Repetido", weekday: "thu", monthlyValue: 100 }),
    ]));
    expect(b.estado).toBe("PARTIAL");
    expect(b.nota).toMatch(/vários dias/);
    expect(b.totalConhecido, "o total é a soma bruta, e o aviso diz porquê").toBe(200);
  });
});

// ─── 13. Os estados do domínio existem mesmo na base ─────────────────────────

describe("🔴 os estados de fatura são os da base, não os que fariam sentido", () => {
  // O defeito mais consequente desta PR, e o mais silencioso.
  //
  // O agregador usava `emitida`, `enviada`, `paga`, `vencida` e `parcial`.
  // Nenhum existe: a restrição em `008_financial.sql` só aceita
  // `rascunho`, `pendente`, `pago`, `vencido` e `cancelado`.
  //
  // Nenhuma fatura correspondia a nenhum estado, e `faturado`, `emAberto`, o
  // aging, o top de clientes e o histórico do cliente ficavam a zero **para
  // sempre**, com qualquer dado. O sintoma esteve escondido porque as 11
  // faturas da base são todas `rascunho`: o resultado errado era igual ao
  // certo, e só apareceria no dia da primeira fatura emitida.

  const migration = fs.readFileSync(
    path.join(process.cwd(), "supabase/migrations/008_financial.sql"), "utf8",
  );

  /** Os estados que a base aceita, lidos do `CHECK` da migration. */
  const permitidos = (() => {
    // Há dois `CHECK (status IN (...))` nesta migration — o das faturas e o da
    // folha de pagamento (`rascunho, aprovado, pago`). Identificar pela
    // posição seria frágil; identifica-se pelo conteúdo, que é o que
    // distingue os dois.
    //
    // Sem a flag `/s`: o auditor compila com um alvo anterior a es2018.
    const blocos = [...migration.matchAll(/CHECK\s*\(status\s+IN\s*\(([^)]+)\)\)/gi)]
      .map((x) => x[1].split(",").map((v) => v.trim().replace(/^'|'$/g, "")));

    const daFatura = blocos.find((b) => b.includes("cancelado") && b.includes("vencido"));
    expect(daFatura, "o CHECK dos estados de fatura tem de ser encontrável").toBeDefined();
    return daFatura!;
  })();

  it("a leitura do CHECK encontrou os cinco estados", () => {
    // Se a extracção falhar, tudo o resto passaria por vacuidade.
    expect(permitidos.sort()).toEqual(
      ["cancelado", "pago", "pendente", "rascunho", "vencido"],
    );
  });

  it("🔴 todo o estado que o domínio usa existe na base", () => {
    for (const e of ESTADOS_FATURADO) {
      expect(permitidos, `"${e}" não existe no CHECK da base`).toContain(e);
    }
    for (const e of ESTADOS_PAGA) {
      expect(permitidos, `"${e}" não existe no CHECK da base`).toContain(e);
    }
  });

  it("o inventário do domínio cobre exactamente o CHECK", () => {
    expect([...ESTADOS_FATURA_VALIDOS].sort()).toEqual(permitidos.sort());
  });

  it("rascunho e cancelado ficam de fora do faturado", () => {
    expect(ESTADOS_FATURADO).not.toContain("rascunho");
    expect(ESTADOS_FATURADO).not.toContain("cancelado");
  });

  it("recebido é um subconjunto de faturado", () => {
    // Uma fatura paga é, necessariamente, uma fatura emitida.
    for (const e of ESTADOS_PAGA) {
      expect(ESTADOS_FATURADO as readonly string[]).toContain(e);
    }
  });

  it("🔴 com os estados certos, uma fatura emitida conta mesmo", () => {
    // A prova de que o defeito era real: com o estado antigo, isto dava 0.
    const k = calcularKpis(
      ok([fatura({ status: "pendente", total: 500, periodStart: "2026-08-01" })]),
      ok([]), semFolha, ctx(2026, 8),
    );
    expect(k.faturado.valor).toBe(500);

    const comEstadoInventado = calcularKpis(
      ok([fatura({ status: "emitida", total: 500, periodStart: "2026-08-01" })]),
      ok([]), semFolha, ctx(2026, 8),
    );
    expect(comEstadoInventado.faturado.valor, "um estado que a base não aceita não conta").toBe(0);
  });
});

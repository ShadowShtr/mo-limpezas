// ============================================================================
// TASK 12 — testes-espelho: as superfícies falam a mesma língua?
// ============================================================================
//
// O dashboard, o separador Contas e o histórico do cliente lêem os **mesmos**
// factos e mostram-nos ao lado uns dos outros. Cada um tem o seu caminho de
// código. Nada obriga os três a concordar, e quando discordam não há erro
// nenhum — há dois números certos-à-vista e uma pessoa a escolher em qual
// acreditar.
//
// ---------------------------------------------------------------------------
// 🔴 Porque é que os números esperados estão escritos à mão
// ---------------------------------------------------------------------------
// A armadilha destes testes é somar a fixture com a mesma expressão que o
// código usa e comparar o resultado com ele próprio. Isso passa sempre, e não
// testa nada — é a mesma suposição escrita duas vezes.
//
// Por isso o livro-razão abaixo tem os totais **contados à mão**, linha a
// linha, com a conta escrita ao lado. Se o código mudar de opinião sobre o que
// conta, o número deixa de bater com o que está aqui em texto.
//
// ---------------------------------------------------------------------------
// O que estes testes não são
// ---------------------------------------------------------------------------
// Não tocam na base. São os agregadores puros sobre factos conhecidos. Provam
// concordância entre superfícies, não que a leitura real traz estes factos.
// ============================================================================

import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

import {
  calcularKpis,
  calcularTopClientes,
  estaPorReceber,
  periodoDaFatura,
  type FactoCaixa,
  type FactoFatura,
  type FactoFolha,
  type Fonte,
} from "@/domain/finance-v2/aggregate";
import { montarHistoricoCliente } from "@/domain/finance-v2/client-history";
import type { FinanceReadContext } from "@/domain/finance-v2/types";

const ok = <T,>(factos: T[]): Fonte<T> => ({ ok: true, factos });

const CTX: FinanceReadContext = {
  companyId: "A",
  year: 2026,
  month: 8,
  periodStart: "2026-08-01",
  periodEnd: "2026-08-31",
  todayLisbon: "2026-08-20",
};

// ─── O livro-razão ───────────────────────────────────────────────────────────
//
// Agosto de 2026. Seis faturas, escolhidas para cobrir cada caso em que duas
// superfícies podem discordar.

const FATURAS: FactoFatura[] = [
  // 1. Emitida e por pagar. Conta em Faturado e em Em aberto.
  { id: "f1", status: "pendente", total: 123.00, dueDate: "2026-09-15", paidAt: null,
    periodStart: "2026-08-01", clientId: "c1", clientName: "Parque Norte" },

  // 2. Emitida e paga. Conta em Faturado, **não** em Em aberto.
  { id: "f2", status: "pago", total: 246.00, dueDate: "2026-08-20", paidAt: "2026-08-18",
    periodStart: "2026-08-01", clientId: "c1", clientName: "Parque Norte" },

  // 3. Vencida. Conta nos dois.
  { id: "f3", status: "vencido", total: 61.50, dueDate: "2026-08-05", paidAt: null,
    periodStart: "2026-08-01", clientId: "c2", clientName: "Zeglo" },

  // 4. 🔴 `pendente` com recebimento registado. Foi aqui que as duas
  //    superfícies discordaram: o dashboard não a contava como dívida, a
  //    consulta das Contas contava. O dinheiro já entrou.
  { id: "f4", status: "pendente", total: 500.00, dueDate: "2026-08-10", paidAt: "2026-08-12",
    periodStart: "2026-08-01", clientId: "c2", clientName: "Zeglo" },

  // 5. 🔴 Sem `period_start`, vencimento em Agosto. O dashboard contava-a pelo
  //    vencimento; a consulta das Contas filtrava por `period_start` em SQL e
  //    deixava-a de fora — não do mês errado, de todos os meses.
  { id: "f5", status: "pendente", total: 80.00, dueDate: "2026-08-28", paidAt: null,
    periodStart: null, clientId: "c3", clientName: "Liliana Ribeiro" },

  // 6. Rascunho. Não conta em lado nenhum: é um documento que o cliente nunca
  //    viu. As 11 faturas reais da base estão todas assim.
  { id: "f6", status: "rascunho", total: 999.00, dueDate: "2026-08-30", paidAt: null,
    periodStart: "2026-08-01", clientId: "c1", clientName: "Parque Norte" },
];

// Contas à mão, para Agosto:
//
//   Faturado  = 123,00 + 246,00 + 61,50 + 500,00 + 80,00        = 1 010,50
//               (f6 é rascunho, fica de fora)
//   Em aberto = 123,00 +          61,50 +          80,00        =   264,50
//               (f2 paga; f4 tem paid_at; f6 rascunho)
//
const FATURADO_A_MAO = 1010.5;
const EM_ABERTO_A_MAO = 264.5;

// O caixa é a fonte autoritativa do Recebido — as faturas também têm `paid_at`,
// e somar as duas contaria o mesmo dinheiro duas vezes.
//
//   Recebido = 246,00 + 500,00 = 746,00
//   Custos   = 2 563,51  (os Custos reais de Agosto na base)
const CAIXA: FactoCaixa[] = [
  { date: "2026-08-18", tipo: "entrada", amount: 246.00, categoria: "servico", status: "confirmado" },
  { date: "2026-08-12", tipo: "entrada", amount: 500.00, categoria: "servico", status: "confirmado" },
  { date: "2026-08-05", tipo: "saida", amount: 2563.51, categoria: "despesa", status: "confirmado" },
];
const RECEBIDO_A_MAO = 746.0;
const CUSTOS_A_MAO = 2563.51;

const SEM_FOLHA: Fonte<FactoFolha> = ok([]);

/**
 * O que o separador Contas lista em «A Receber» — a mesma função que o KPI
 * «Em aberto» usa, que é precisamente o ponto.
 */
function contasAReceber(faturas: FactoFatura[], ctx: FinanceReadContext) {
  return faturas.filter((f) => estaPorReceber(f, ctx));
}

const somar = (ns: number[]) => Math.round(ns.reduce((a, b) => a + b, 0) * 100) / 100;

// ─── 1. Cada superfície bate com a conta feita à mão ─────────────────────────

describe("cada superfície bate com o livro-razão", () => {
  const kpis = calcularKpis(ok(FATURAS), ok(CAIXA), SEM_FOLHA, CTX);

  it("dashboard: Faturado", () => {
    expect(kpis.faturado.valor).toBe(FATURADO_A_MAO);
    expect(kpis.faturado.estado).toBe("AVAILABLE");
  });

  it("dashboard: Em aberto", () => {
    expect(kpis.emAberto.valor).toBe(EM_ABERTO_A_MAO);
  });

  it("dashboard: Recebido vem do caixa, não do paid_at das faturas", () => {
    expect(kpis.recebido.valor).toBe(RECEBIDO_A_MAO);
  });

  it("dashboard: Custos", () => {
    expect(kpis.custos.valor).toBe(CUSTOS_A_MAO);
  });

  it("dashboard: Margem é Faturado − Custos, e o sinal é o real", () => {
    // 1 010,50 − 2 563,51 = −1 553,01. Um mês negativo mostra-se negativo.
    expect(kpis.margem.valor).toBe(-1553.01);
  });

  it("Contas: «A Receber» soma o mesmo que o livro-razão", () => {
    expect(somar(contasAReceber(FATURAS, CTX).map((f) => f.total))).toBe(EM_ABERTO_A_MAO);
  });
});

// ─── 2. 🔴 O espelho ─────────────────────────────────────────────────────────

describe("🔴 as superfícies concordam entre si", () => {
  it("«Em aberto» do dashboard = soma de «A Receber» das Contas", () => {
    const kpis = calcularKpis(ok(FATURAS), ok(CAIXA), SEM_FOLHA, CTX);
    const contas = somar(contasAReceber(FATURAS, CTX).map((f) => f.total));
    expect(kpis.emAberto.valor).toBe(contas);
  });

  it("🔴 uma fatura pendente com recebimento registado não é dívida em lado nenhum", () => {
    // O caso que estava a divergir. `paid_at` preenchido quer dizer que o
    // dinheiro entrou, independentemente de alguém ter mudado o estado.
    const listada = contasAReceber(FATURAS, CTX).map((f) => f.id);
    expect(listada).not.toContain("f4");

    const semF4 = FATURAS.filter((f) => f.id !== "f4");
    expect(calcularKpis(ok(semF4), ok(CAIXA), SEM_FOLHA, CTX).emAberto.valor)
      .toBe(calcularKpis(ok(FATURAS), ok(CAIXA), SEM_FOLHA, CTX).emAberto.valor);
  });

  it("🔴 uma fatura sem period_start aparece nas duas, pelo vencimento", () => {
    // Não é uma questão de mês errado: filtrada em SQL por `period_start`, esta
    // fatura desaparecia de **todos** os meses das Contas enquanto o dashboard
    // a contava.
    expect(periodoDaFatura(FATURAS[4])).toBe("2026-08-28");
    expect(contasAReceber(FATURAS, CTX).map((f) => f.id)).toContain("f5");

    const semF5 = FATURAS.filter((f) => f.id !== "f5");
    const comF5 = calcularKpis(ok(FATURAS), ok(CAIXA), SEM_FOLHA, CTX).emAberto.valor!;
    const sem = calcularKpis(ok(semF5), ok(CAIXA), SEM_FOLHA, CTX).emAberto.valor!;
    expect(Math.round((comF5 - sem) * 100) / 100).toBe(80);
  });

  it("Faturado − Recebido não é «Em aberto», e é suposto não ser", () => {
    // Confusão fácil de fazer a ler o ecrã: 1 010,50 − 746,00 = 264,50, que
    // por acaso bate. Bate porque nesta fixture todo o recebido veio de
    // faturas do próprio mês — não é uma identidade. O teste fixa que a
    // coincidência é isso mesmo, para ninguém a transformar em regra.
    const kpis = calcularKpis(ok(FATURAS), ok(CAIXA), SEM_FOLHA, CTX);
    const caixaComRecebimentoAntigo: FactoCaixa[] = [
      ...CAIXA,
      { date: "2026-08-03", tipo: "entrada", amount: 300, categoria: "servico", status: "confirmado" },
    ];
    const outro = calcularKpis(ok(FATURAS), ok(caixaComRecebimentoAntigo), SEM_FOLHA, CTX);
    expect(outro.emAberto.valor).toBe(kpis.emAberto.valor);
    expect(outro.recebido.valor).toBe(1046);
  });
});

// ─── 3. O histórico do cliente ───────────────────────────────────────────────

describe("o histórico do cliente conta o mesmo que o dashboard", () => {
  it("🔴 o faturado do cliente em Agosto bate com a sua parte do total", () => {
    // Parque Norte: 123,00 + 246,00 = 369,00 (o rascunho de 999,00 não conta).
    const historico = montarHistoricoCliente(ok(FATURAS), "c1", 2026);
    const agosto = historico.months.find((m) => m.month === 8);
    expect(agosto?.invoiced).toBe(369);

    const doCliente = FATURAS.filter((f) => f.clientId === "c1");
    const kpisDoCliente = calcularKpis(ok(doCliente), ok([]), SEM_FOLHA, CTX);
    expect(kpisDoCliente.faturado.valor).toBe(369);
  });

  it("🔴 a soma dos clientes é o total, sem sobra nem falta", () => {
    // Se um cliente escapar à repartição, o total continua certo e o detalhe
    // fica errado — que é o mais difícil de notar.
    const clientes = ["c1", "c2", "c3"];
    const porCliente = clientes.map((id) => {
      const suas = FATURAS.filter((f) => f.clientId === id);
      return calcularKpis(ok(suas), ok([]), SEM_FOLHA, CTX).faturado.valor ?? 0;
    });
    expect(somar(porCliente)).toBe(FATURADO_A_MAO);
  });

  it("o top de clientes usa a mesma base que os KPIs", () => {
    const top = calcularTopClientes(ok(FATURAS), CTX);
    expect(top.estado).toBe("AVAILABLE");
    expect(somar(top.clientes.map((c) => c.value))).toBe(FATURADO_A_MAO);
    // Zeglo (61,50 + 500,00 = 561,50) à frente de Parque Norte (369,00).
    expect(top.clientes[0]?.clientName).toBe("Zeglo");
    expect(top.clientes[0]?.value).toBe(561.5);
    // A fatia é sobre o mesmo total: 561,50 / 1 010,50 = 0,55566…, que o
    // agregador arredonda a três casas para não pôr ruído no ecrã.
    expect(top.clientes[0]?.share).toBe(0.556);
    // As fatias somam o todo — nenhum cliente fica fora da repartição.
    expect(somar(top.clientes.map((c) => c.share))).toBeCloseTo(1, 2);
  });
});

// ─── 4. Uma falha não vira zero em nenhuma superfície ────────────────────────

describe("🔴 uma falha de leitura não vira zero", () => {
  const falha: Fonte<FactoFatura> = { ok: false, erro: "timeout" };

  it("o dashboard diz que não sabe, em vez de dizer que não há", () => {
    const kpis = calcularKpis(falha, ok(CAIXA), SEM_FOLHA, CTX);
    expect(kpis.faturado.valor).toBeNull();
    expect(kpis.faturado.estado).toBe("ERROR");
    expect(kpis.emAberto.valor).toBeNull();
  });

  it("e a margem não se calcula com metade dos dados", () => {
    // 0 − 2 563,51 seria um número plausível, e completamente inventado.
    const kpis = calcularKpis(falha, ok(CAIXA), SEM_FOLHA, CTX);
    expect(kpis.margem.valor).toBeNull();
    expect(kpis.margem.estado).toBe("UNAVAILABLE");
  });

  it("um mês sem faturas é zero, e isso é diferente de não saber", () => {
    const kpis = calcularKpis(ok([]), ok([]), SEM_FOLHA, CTX);
    expect(kpis.faturado.valor).toBe(0);
    expect(kpis.faturado.estado).toBe("AVAILABLE");
  });
});

// ─── 5. O mês é o mês ────────────────────────────────────────────────────────

describe("o período selecionado manda em todas as superfícies", () => {
  const JULHO: FinanceReadContext = {
    ...CTX, month: 7, periodStart: "2026-07-01", periodEnd: "2026-07-31",
  };

  it("nenhuma fatura de Agosto entra em Julho", () => {
    expect(calcularKpis(ok(FATURAS), ok(CAIXA), SEM_FOLHA, JULHO).faturado.valor).toBe(0);
    expect(contasAReceber(FATURAS, JULHO)).toEqual([]);
  });

  it("o caixa de Agosto também não", () => {
    expect(calcularKpis(ok(FATURAS), ok(CAIXA), SEM_FOLHA, JULHO).recebido.valor).toBe(0);
    expect(calcularKpis(ok(FATURAS), ok(CAIXA), SEM_FOLHA, JULHO).custos.valor).toBe(0);
  });

  it("🔴 uma fatura no último dia do mês pertence ao mês", () => {
    // Fronteiras inclusivas nas duas pontas. Um `<` em vez de `<=` perderia o
    // dia 31 — e o mês fechava sempre a faltar um dia de faturação.
    const ultima: FactoFatura = {
      id: "fx", status: "pendente", total: 10, dueDate: "2026-08-31", paidAt: null,
      periodStart: "2026-08-31", clientId: "c9", clientName: "Fronteira",
    };
    expect(estaPorReceber(ultima, CTX)).toBe(true);
    expect(estaPorReceber({ ...ultima, periodStart: "2026-09-01" }, CTX)).toBe(false);
    expect(estaPorReceber({ ...ultima, periodStart: "2026-08-01" }, CTX)).toBe(true);
    expect(estaPorReceber({ ...ultima, periodStart: "2026-07-31" }, CTX)).toBe(false);
  });
});

// ─── 6. 🔴 E a página usa mesmo esta definição? ──────────────────────────────
//
// Os testes acima comparam duas superfícies que agora chamam a **mesma**
// função — o que os torna quase tautológicos, e vale a pena dizê-lo em vez de
// os apresentar como prova de concordância.
//
// O que impede a divergência de voltar não é a comparação: é `getAccountsData`
// usar o predicado partilhado em vez de reconstruir o seu. É isso que se mede
// aqui, na fonte, porque é o único sítio onde a regressão pode entrar.

describe("🔴 o separador Contas usa a definição partilhada, não uma sua", () => {
  const fonte = fs.readFileSync(
    path.join(process.cwd(), "src/app/actions/cash-flow.ts"), "utf8",
  );
  const corpo = fonte.slice(
    fonte.indexOf("export async function getAccountsData"),
    fonte.indexOf("return { ok: true, toReceive, toPay, expenses };"),
  );
  const semComentarios = corpo.replace(/^\s*(\/\/|\*|\/\*).*$/gm, "");

  it("importa e chama estaPorReceber", () => {
    expect(fonte).toMatch(/import \{ estaPorReceber \} from "@\/domain\/finance-v2\/aggregate"/);
    expect(semComentarios).toContain("estaPorReceber(");
  });

  it("🔴 não reconstrói o filtro de período em SQL", () => {
    // `gte("period_start", …)` exclui as faturas com `period_start` nulo, e
    // essas desapareciam de todos os meses. A pré-selecção tem de as deixar
    // passar para o predicado decidir.
    expect(semComentarios).not.toMatch(/\.gte\("period_start"/);
    expect(semComentarios).toMatch(/period_start\.is\.null/);
  });

  it("a consulta traz as colunas de que o predicado precisa", () => {
    // Sem `paid_at` no `select`, o predicado receberia `undefined` e voltaria
    // a contar como dívida a fatura que já foi paga — em silêncio.
    const select = semComentarios.slice(semComentarios.indexOf('.from("invoices")'));
    for (const coluna of ["paid_at", "period_start", "due_date", "status", "total"]) {
      expect(select, `${coluna} em falta no select`).toContain(coluna);
    }
  });
});

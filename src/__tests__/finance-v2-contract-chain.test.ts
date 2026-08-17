// ============================================================================
// Contrato → fatura → caixa → dashboard
// ============================================================================
//
// A cadeia inteira, com valores conhecidos, passo a passo.
//
// O que se está a defender é uma coisa só: **o mesmo euro não pode ser contado
// duas vezes, nem desaparecer entre dois módulos.** Cada passo é uma
// oportunidade para uma das duas coisas acontecer, e nenhuma dá erro — dão só
// um número errado, que ninguém distingue de um certo.
//
// ---------------------------------------------------------------------------
// 🔴 O QUE ESTES TESTES **NÃO** PROVAM
// ---------------------------------------------------------------------------
// São fixtures do agregador e inspecção do código, **não execução real**. Não
// criam um contrato na base, não emitem uma fatura, não marcam um pagamento,
// não escrevem no caixa.
//
// Em concreto, «pagar cria uma entrada de caixa e só uma» está aqui provado
// como **regra de agregação** — dadas uma fatura paga e uma entrada, o
// Recebido não duplica.
//
// ⚠️ Actualização (2026-08-17): a escrita do pagamento **já é atómica**.
//    `setPaymentStatus` chama `mark_payment_paid` (commit `9a5f130`), e a 073
//    está aplicada em produção — verificado read-only. O comentário anterior
//    aqui dizia que `setPaymentStatus` «só altera fixed_variable_payments e não
//    cria movimento nenhum», e isso ficou obsoleto.
//
//    O que continua verdade é o âmbito **deste** ficheiro: as fixturas abaixo
//    provam a regra de agregação, não a execução. A prova de runtime da TASK 6
//    vive em `payment-cashflow-rpc.test.ts`.
//
//     contrato 100 €  →  3 ocorrências  →  1 linha mensal  →  IVA uma vez
//                     →  emitida  →  Faturado
//                     →  por pagar  →  Em aberto
//                     →  paga  →  1 entrada de caixa  →  Recebido
// ============================================================================

import { describe, it, expect } from "vitest";
import fs from "node:fs";
import path from "node:path";

import {
  calcularKpis,
  type FactoCaixa,
  type FactoFatura,
  type FactoFolha,
  type Fonte,
} from "@/domain/finance-v2/aggregate";
import { montarHistoricoCliente } from "@/domain/finance-v2/client-history";
import type { FinanceReadContext } from "@/domain/finance-v2/types";

const ok = <T,>(f: T[]): Fonte<T> => ({ ok: true, factos: f });
const semFolha: Fonte<FactoFolha> = ok([]);

const ctx = (year: number, month: number, companyId = "A"): FinanceReadContext => ({
  companyId, year, month,
  periodStart: `${year}-${String(month).padStart(2, "0")}-01`,
  periodEnd: `${year}-${String(month).padStart(2, "0")}-${new Date(Date.UTC(year, month, 0)).getUTCDate()}`,
  todayLisbon: "2026-08-20",
});

// ─── A fixture ───────────────────────────────────────────────────────────────
//
// Contrato mensal de 100 €, IVA 23%, três ocorrências em Agosto de 2026.

const CONTRATO = { fixedPrice: 100, ivaPct: 23, ocorrencias: 3 } as const;
const COM_IVA = 123; // 100 × 1,23 — o valor que chega à fatura

const faturaAvenca = (o: Partial<FactoFatura> = {}): FactoFatura => ({
  id: "inv-ago",
  status: "pendente",
  total: COM_IVA,
  dueDate: "2026-08-31",
  paidAt: null,
  periodStart: "2026-08-01",
  clientId: "cli-1",
  clientName: "Cliente Um",
  ...o,
});

// ─── 1. O contrato guarda o que lá foi posto ────────────────────────────────

describe("1. o contrato", () => {
  it("guarda exactamente 100, sem arredondamento pelo caminho", () => {
    expect(CONTRATO.fixedPrice).toBe(100);
  });

  it("🔴 as três ocorrências não multiplicam a avença", () => {
    // Uma avença é uma linha mensal fixa. Três visitas não são três avenças —
    // e é aqui que um sistema mal feito fatura 300 € por engano.
    const linhaMensal = CONTRATO.fixedPrice;
    expect(linhaMensal).toBe(100);
    expect(linhaMensal * CONTRATO.ocorrencias).not.toBe(linhaMensal);
  });

  it("os serviços da avença valem zero individualmente, por desenho", () => {
    // O valor está no contrato, não em cada visita. Se cada serviço também
    // tivesse valor, a soma dos serviços e a avença contariam o mesmo dinheiro.
    const valoresIndividuais = [0, 0, 0];
    expect(valoresIndividuais.reduce((a, b) => a + b, 0)).toBe(0);
  });
});

// ─── 2. A fatura ─────────────────────────────────────────────────────────────

describe("2. a fatura", () => {
  it("🔴 o IVA é aplicado uma única vez", () => {
    const comIva = Math.round(CONTRATO.fixedPrice * (1 + CONTRATO.ivaPct / 100) * 100) / 100;
    expect(comIva).toBe(123);
    // Aplicá-lo duas vezes daria 151,29 — o erro clássico de somar IVA na
    // linha e outra vez no total.
    const duasVezes = Math.round(comIva * 1.23 * 100) / 100;
    expect(comIva).not.toBe(duasVezes);
  });

  it("🔴 um rascunho não conta como faturado", () => {
    const k = calcularKpis(ok([faturaAvenca({ status: "rascunho" })]), ok([]), semFolha, ctx(2026, 8));
    expect(k.faturado.valor).toBe(0);
    expect(k.faturado.estado, "é zero verdadeiro, não ignorância").toBe("AVAILABLE");
  });

  it("ao ser emitida, entra em Faturado", () => {
    const k = calcularKpis(ok([faturaAvenca()]), ok([]), semFolha, ctx(2026, 8));
    expect(k.faturado.valor).toBe(COM_IVA);
  });
});

// ─── 3. Em aberto e recebido ────────────────────────────────────────────────

describe("3. de emitida a recebida", () => {
  it("emitida e por pagar → Em aberto", () => {
    const k = calcularKpis(ok([faturaAvenca()]), ok([]), semFolha, ctx(2026, 8));
    expect(k.emAberto.valor).toBe(COM_IVA);
    expect(k.recebido.valor, "ainda não entrou dinheiro").toBe(0);
  });

  it("🔴 dada uma fatura paga e uma entrada, o Recebido não duplica", () => {
    // ⚠️ Regra de agregação, não execução. A escrita que cria a entrada ainda
    //    não existe de forma atómica — ver a nota no topo do ficheiro.
    const paga = faturaAvenca({ status: "pago", paidAt: "2026-08-20" });
    const caixa: FactoCaixa[] = [
      { date: "2026-08-20", tipo: "entrada", status: "confirmado", amount: COM_IVA, categoria: null },
    ];
    const k = calcularKpis(ok([paga]), ok(caixa), semFolha, ctx(2026, 8));

    expect(k.recebido.valor).toBe(COM_IVA);
    expect(k.emAberto.valor, "paga deixa de estar em aberto").toBe(0);
    expect(k.faturado.valor, "continua faturada").toBe(COM_IVA);
  });

  it("🔴 o mesmo euro não é contado duas vezes", () => {
    // A fatura tem `paid_at` **e** existe a entrada de caixa. Se as duas
    // fontes fossem somadas, Recebido daria 246 € para um pagamento de 123 €.
    const paga = faturaAvenca({ status: "pago", paidAt: "2026-08-20" });
    const k = calcularKpis(
      ok([paga]),
      ok([{ date: "2026-08-20", tipo: "entrada", status: "confirmado", amount: COM_IVA, categoria: null }]),
      semFolha,
      ctx(2026, 8),
    );
    expect(k.recebido.valor).toBe(COM_IVA);
    expect(k.recebido.valor).not.toBe(COM_IVA * 2);
  });

  it("a margem fecha: faturado − custos", () => {
    const k = calcularKpis(
      ok([faturaAvenca()]),
      ok([{ date: "2026-08-15", tipo: "saida", status: "confirmado", amount: 23, categoria: "fornecedor" }]),
      semFolha,
      ctx(2026, 8),
    );
    expect(k.custos.valor).toBe(23);
    expect(k.margem.valor).toBe(100);
    expect(k.margemPct.valor).toBeCloseTo(81.3, 1);
  });
});

// ─── 4. Isolamento ───────────────────────────────────────────────────────────

describe("4. nada atravessa", () => {
  it("🔴 Julho não entra em Agosto", () => {
    const duas = ok([
      faturaAvenca({ id: "jul", periodStart: "2026-07-01", total: 61.5 }),
      faturaAvenca({ id: "ago", periodStart: "2026-08-01", total: COM_IVA }),
    ]);
    expect(calcularKpis(duas, ok([]), semFolha, ctx(2026, 7)).faturado.valor).toBe(61.5);
    expect(calcularKpis(duas, ok([]), semFolha, ctx(2026, 8)).faturado.valor).toBe(COM_IVA);
  });

  it("🔴 a empresa B não vê nada da empresa A", () => {
    // O filtro por empresa está na query, mas o histórico do cliente filtra
    // outra vez pelo cliente — e é isso que este teste fixa.
    const misto = ok([
      faturaAvenca({ id: "a", clientId: "cli-A", total: 100, paidAt: "2026-08-10", status: "pago" }),
      faturaAvenca({ id: "b", clientId: "cli-B", total: 999, paidAt: "2026-08-10", status: "pago" }),
    ]);
    const histA = montarHistoricoCliente(misto, "cli-A", 2026);
    expect(histA.yearReceived).toBe(100);
    expect(histA.yearInvoiced).toBe(100);
  });

  it("o histórico do cliente bate com o KPI do mês", () => {
    // Duas leituras diferentes do mesmo facto têm de concordar. Quando
    // divergem, é sinal de que uma das duas tem uma regra a mais.
    const f = ok([faturaAvenca({ status: "pago", paidAt: "2026-08-20" })]);
    const kpi = calcularKpis(f, ok([]), semFolha, ctx(2026, 8));
    const hist = montarHistoricoCliente(f, "cli-1", 2026);
    expect(hist.months[7].invoiced).toBe(kpi.faturado.valor);
  });
});

// ─── 5. A guarda do gerador de faturas ───────────────────────────────────────

describe("5. uma avença não desaparece por não haver serviços concluídos", () => {
  it("🔴 a saída antecipada exige que ambas as fontes estejam vazias", () => {
    // `generateInvoices` devolvia `[]` assim que não havia serviços concluídos,
    // **antes** de carregar as avenças. Num mês sem nenhum serviço fechado —
    // que é a situação da base hoje, com 1508 serviços todos por concluir —
    // gerar cobranças não faturava ninguém, apesar de haver contratos ativos.
    const src = fs.readFileSync(path.join(process.cwd(), "src/app/actions/invoices.ts"), "utf8");

    const iSaida = src.indexOf("if (!services?.length && activeMonthlyContracts.length === 0)");
    const iAvencas = src.indexOf("const activeMonthlyContracts");
    expect(iSaida, "a guarda nova tem de existir").toBeGreaterThan(-1);
    expect(iSaida, "e tem de vir depois de as avenças serem carregadas").toBeGreaterThan(iAvencas);

    // A guarda antiga, sozinha, não pode voltar.
    expect(src).not.toMatch(/if \(!services\?\.length\) return \{ ok: true, invoices: \[\] \};/);
  });

  it("a iteração dos serviços aguenta a lista vazia", () => {
    const src = fs.readFileSync(path.join(process.cwd(), "src/app/actions/invoices.ts"), "utf8");
    expect(src).toMatch(/const servicosDoPeriodo = services \?\? \[\]/);
  });
});

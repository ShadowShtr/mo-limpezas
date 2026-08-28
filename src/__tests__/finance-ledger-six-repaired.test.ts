// ============================================================================
// As seis obrigações reparadas, vistas pelo razão unificado
// ============================================================================
//
// A 2026-08-28 seis movimentos de caixa legados — saídas pendentes sem origem
// — foram ligados a seis obrigações criadas para eles, com proveniência
// `adopted_existing`. Nenhum movimento foi criado ou apagado: os mesmos seis
// `cash_flow_entries` ganharam `reference_type` e `reference_id`.
//
// 🔴 É exactamente aqui que uma leitura ingénua duplicaria o dinheiro.
//
//    Antes da reparação havia seis factos económicos, cada um só do lado do
//    caixa. Depois há seis pares — e um par **continua a ser um facto**. Uma
//    leitura que some as duas tabelas mostra 3020,66 € onde há 1510,33 €, e
//    ninguém a olhar para o ecrã tem como saber qual dos números é o certo.
//
// Estes ensaios usam a forma real dos seis: descrições, valores, competências
// e categorias como ficaram em produção — as cinco sem equivalência
// determinística com categoria nula, e a sexta com a estruturada preservada.
// Os ids são inventados: um id de produção num ficheiro versionado não
// acrescenta prova nenhuma e é dado que não devia sair de lá.
// ============================================================================

import { describe, expect, it } from "vitest";
import {
  buildFinanceLedger,
  type FinanceLedgerCashflowSource,
  type FinanceLedgerPaymentSource,
} from "@/domain/finance/ledger";

const CATEGORIA_PRESERVADA = "cat-preservada-0001";

/** As seis, como ficaram: obrigação pendente + movimento pendente ligado. */
const SEIS = [
  { n: 1, desc: "Fornecedor A - FT 027828", valor: 153.75, data: "2026-07-10", ano: 2026, mes: 7, cat: null },
  { n: 2, desc: "Fornecedor B - FT 000468", valor: 147.60, data: "2026-07-10", ano: 2026, mes: 7, cat: null },
  { n: 3, desc: "Fornecedor C - FT 523", valor: 351.96, data: "2026-07-20", ano: 2026, mes: 7, cat: null },
  { n: 4, desc: "Fornecedor C - FT 571", valor: 289.23, data: "2026-08-07", ano: 2026, mes: 8, cat: null },
  { n: 5, desc: "Oficina - FT 116", valor: 203.40, data: "2026-08-13", ano: 2026, mes: 8, cat: null },
  { n: 6, desc: "Fornecedor C - FT 605", valor: 364.39, data: "2026-08-21", ano: 2026, mes: 8, cat: CATEGORIA_PRESERVADA },
] as const;

const TOTAL_CENTIMOS = 151_033;

function par(l: (typeof SEIS)[number]) {
  const pagamento: FinanceLedgerPaymentSource = {
    id: `pay-${l.n}`,
    kind: "variavel",
    description: l.desc,
    amount: l.valor,
    due_date: null,
    status: "pendente",
    period_year: l.ano,
    period_month: l.mes,
    paid_at: null,
    expense_category_id: l.cat,
    category_name: l.cat ? "Fornecedores" : null,
    created_at: `${l.data}T09:00:00Z`,
    updated_at: `${l.data}T09:00:00Z`,
  };
  const movimento: FinanceLedgerCashflowSource = {
    id: `cf-${l.n}`,
    type: "saida",
    amount: l.valor,
    description: l.desc,
    category: l.n % 2 === 0 ? "despesa" : "fornecedor",
    date: l.data,
    reference_type: "fixed_variable_payment",
    reference_id: `pay-${l.n}`,
    status: "pendente",
    expense_category_id: l.cat,
    category_name: l.cat ? "Fornecedores" : null,
    created_at: `${l.data}T09:00:00Z`,
  };
  return { pagamento, movimento };
}

const pares = SEIS.map(par);
const razao = () => buildFinanceLedger({
  payments: pares.map((p) => p.pagamento),
  cashflows: pares.map((p) => p.movimento),
});

// ═══════════════════════════════════════════════════════════════════════════

describe("as seis reparadas — um par é um facto económico", () => {
  it("🔴 seis linhas, não doze", () => {
    expect(razao()).toHaveLength(6);
  });

  it("🔴 o total é 1510,33 € — não o dobro", () => {
    const soma = razao().reduce((s, r) => s + (r.amount_cents ?? 0), 0);
    expect(soma).toBe(TOTAL_CENTIMOS);
    expect(soma).not.toBe(TOTAL_CENTIMOS * 2);
  });

  it("cada linha é a obrigação, com o movimento absorvido", () => {
    for (const linha of razao()) {
      expect(linha.row_kind).toBe("payment");
      expect(linha.is_linked).toBe(true);
      expect(linha.is_manual).toBe(false);
    }
  });

  it("🔴 as duas identidades continuam distinguíveis por dentro", () => {
    // Um facto no ecrã, duas linhas na base. Se o razão perdesse um dos ids,
    // deixaria de ser possível voltar à origem do número — e é a origem que
    // sustenta a proveniência e o desmarcar seguro.
    // Procura por id, não por posição: o razão ordena por data descendente,
    // e depender da ordem de entrada seria testar o array em vez do modelo.
    for (const l of SEIS) {
      const linha = razao().find((r) => r.payment_id === `pay-${l.n}`)!;
      expect(linha, `pay-${l.n} em falta`).toBeDefined();
      expect(linha.cashflow_id).toBe(`cf-${l.n}`);
    }
  });

  it("nenhuma linha é marcada como problema de integridade", () => {
    for (const linha of razao()) expect(linha.integrity_issue).toBeNull();
  });

  it("competências preservadas: três em Julho, três em Agosto", () => {
    const comp = razao()
      .map((r) => `${r.competence_year}/${String(r.competence_month).padStart(2, "0")}`)
      .sort();
    expect(comp.filter((c) => c === "2026/07")).toHaveLength(3);
    expect(comp.filter((c) => c === "2026/08")).toHaveLength(3);
  });

  it("🔴 a categoria não é inventada: cinco nulas, uma preservada", () => {
    const cats = razao().map((r) => r.expense_category_id);
    expect(cats.filter((c) => c === null)).toHaveLength(5);
    expect(cats.filter((c) => c === CATEGORIA_PRESERVADA)).toHaveLength(1);
  });

  it("a data de caixa vem do movimento, e a obrigação continua sem vencimento", () => {
    for (const l of SEIS) {
      const linha = razao().find((r) => r.payment_id === `pay-${l.n}`)!;
      expect(linha.cash_date).toBe(l.data);
      expect(linha.due_date).toBeNull();
    }
  });

  it("todas são saídas pendentes — nenhuma aparece como paga", () => {
    for (const linha of razao()) {
      expect(linha.direction).toBe("saida");
      expect(linha.payment_status).toBe("pendente");
      expect(linha.cashflow_status).toBe("pendente");
    }
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// O que não pode regredir com elas
// ═══════════════════════════════════════════════════════════════════════════

describe("as seis convivem com o resto sem se confundirem", () => {
  const manual: FinanceLedgerCashflowSource = {
    id: "cf-manual", type: "saida", amount: 40, description: "Papelaria",
    category: "despesa", date: "2026-08-15", reference_type: null, reference_id: null,
    status: "confirmado", expense_category_id: null, category_name: null,
    created_at: "2026-08-15T10:00:00Z",
  };
  const entrada: FinanceLedgerCashflowSource = {
    ...manual, id: "cf-entrada", type: "entrada", amount: 900,
    description: "Recebimento", category: "faturacao",
  };
  const porPagar: FinanceLedgerPaymentSource = {
    ...pares[0].pagamento, id: "pay-sem-caixa", description: "Seguro",
    amount: 100, expense_category_id: null, category_name: null,
  };

  const completo = () => buildFinanceLedger({
    payments: [...pares.map((p) => p.pagamento), porPagar],
    cashflows: [...pares.map((p) => p.movimento), manual, entrada],
  });

  it("seis pares + uma obrigação por pagar + dois manuais = nove linhas", () => {
    expect(completo()).toHaveLength(9);
  });

  it("a obrigação sem movimento continua representada, e não ligada", () => {
    const r = completo().find((x) => x.payment_id === "pay-sem-caixa")!;
    expect(r.is_linked).toBe(false);
    expect(r.cashflow_id).toBeNull();
    expect(r.amount_cents).toBe(10_000);
  });

  it("o movimento manual mantém identidade própria", () => {
    const r = completo().find((x) => x.row_id === "cashflow:cf-manual")!;
    expect(r).toMatchObject({ row_kind: "cashflow", is_manual: true, is_linked: false, origin: "manual" });
  });

  it("🔴 entrada e saída preservam o sinal — uma não vira a outra", () => {
    const e = completo().find((x) => x.row_id === "cashflow:cf-entrada")!;
    expect(e.direction).toBe("entrada");
    expect(e.amount_cents).toBe(90_000);
    expect(completo().filter((r) => r.direction === "saida")).toHaveLength(8);
  });

  it("o total do conjunto soma cada facto uma só vez", () => {
    // 1510,33 (as seis) + 100,00 (por pagar) + 40,00 (manual) + 900,00 (entrada)
    const soma = completo().reduce((s, r) => s + (r.amount_cents ?? 0), 0);
    expect(soma).toBe(TOTAL_CENTIMOS + 10_000 + 4_000 + 90_000);
  });

  it("a ordenação é estável e determinística", () => {
    const a = completo().map((r) => r.row_id);
    const b = buildFinanceLedger({
      payments: [porPagar, ...pares.map((p) => p.pagamento)].reverse(),
      cashflows: [entrada, manual, ...pares.map((p) => p.movimento)].reverse(),
    }).map((r) => r.row_id);
    expect(b).toEqual(a);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// Isolamento por empresa
// ═══════════════════════════════════════════════════════════════════════════

describe("isolamento por empresa", () => {
  it("🔴 o razão só vê o que a consulta lhe dá — não filtra sozinho", () => {
    // `buildFinanceLedger` é puro e não conhece `company_id`: o isolamento é
    // da consulta e do RLS, e tem de continuar a sê-lo. Dizer aqui que o
    // modelo filtra seria descrever uma garantia que ele não dá, e é assim
    // que um filtro em falta passa despercebido.
    //
    // O que se fixa é o contrato: entra um conjunto de uma empresa, sai o
    // razão dessa empresa, e nenhuma linha nasce do nada.
    const entrada = { payments: pares.map((p) => p.pagamento), cashflows: pares.map((p) => p.movimento) };
    const linhas = buildFinanceLedger(entrada);
    const idsEntrada = new Set([
      ...entrada.payments.map((p) => `payment:${p.id}`),
      ...entrada.cashflows.map((c) => `cashflow:${c.id}`),
    ]);
    for (const linha of linhas) expect(idsEntrada.has(linha.row_id)).toBe(true);
  });

  it("um movimento de outra empresa a apontar para um pagamento ausente é sinalizado, não absorvido", () => {
    // Se a consulta alguma vez trouxer um movimento cujo pagamento não está
    // no conjunto, o razão não o esconde nem inventa a obrigação.
    const intruso: FinanceLedgerCashflowSource = {
      ...pares[0].movimento, id: "cf-intruso", reference_id: "pay-de-outra-empresa",
    };
    const linhas = buildFinanceLedger({ payments: [], cashflows: [intruso] });
    expect(linhas).toHaveLength(1);
    expect(linhas[0]).toMatchObject({
      row_id: "cashflow:cf-intruso", integrity_issue: "orphan_payment_reference",
    });
  });
});

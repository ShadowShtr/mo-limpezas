// ============================================================================
// Histórico financeiro do cliente
// ============================================================================
//
// A pergunta da gestão era literal: «quanto é que este cliente nos pagou em
// cada mês, e quanto já pagou no ano?».
//
// Estes testes existem sobretudo para uma coisa: garantir que a resposta nunca
// inclui dinheiro que o cliente não pagou — nem de outro cliente, nem de outro
// ano, nem de um rascunho que ninguém chegou a enviar.
// ============================================================================

import { describe, it, expect } from "vitest";
import fs from "node:fs";
import path from "node:path";

import { montarHistoricoCliente, NOMES_MESES } from "@/domain/finance-v2/client-history";
import type { FactoFatura, Fonte } from "@/domain/finance-v2/aggregate";
import {
  DEFAULT_EXPENSE_CATEGORY_SUGGESTIONS,
  diferencaDeCategorias,
  normalizarNomeCategoria,
  prepararCategorias,
} from "@/domain/finance-v2/expense-categories";
import { createWriteCapabilityResolver, stripComments } from "@/lib/finance-write-surface";

const fatura = (o: Partial<FactoFatura>): FactoFatura => ({
  id: "f", status: "pendente", total: 100, dueDate: null, paidAt: null,
  periodStart: null, clientId: "A", clientName: "Cliente A", ...o,
});
const ok = <T,>(factos: T[]): Fonte<T> => ({ ok: true, factos });
const falhou = <T,>(erro: string): Fonte<T> => ({ ok: false, erro });

// ─── 1. Doze meses, sempre ───────────────────────────────────────────────────

describe("histórico do cliente — doze meses, sempre", () => {
  it("meses sem movimento são zero real, não buracos", () => {
    // Um mês em falta lê-se como uma falha nos dados; uma barra vazia lê-se
    // como um mês sem faturação. São coisas diferentes.
    const h = montarHistoricoCliente(
      ok([
        fatura({ id: "1", total: 820, periodStart: "2026-01-10", paidAt: "2026-01-20" }),
        fatura({ id: "2", total: 650, periodStart: "2026-03-10", paidAt: "2026-03-20" }),
        fatura({ id: "3", total: 658, periodStart: "2026-08-10", paidAt: "2026-08-20" }),
      ]),
      "A", 2026,
    );
    expect(h.months).toHaveLength(12);
    expect(h.months.map((m) => m.month)).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12]);
    expect(h.months[1].received, "Fevereiro sem movimento").toBe(0);
    expect(h.months[0].received).toBe(820);
    expect(h.months[7].received).toBe(658);
  });

  it("os totais do ano batem com a soma dos meses", () => {
    const h = montarHistoricoCliente(
      ok([
        fatura({ id: "1", total: 100, periodStart: "2026-02-01", paidAt: "2026-02-15" }),
        fatura({ id: "2", total: 250, periodStart: "2026-05-01" }),
      ]),
      "A", 2026,
    );
    expect(h.yearInvoiced).toBe(350);
    expect(h.yearReceived).toBe(100);
    expect(h.yearOutstanding).toBe(250);
    expect(h.months.reduce((a, m) => a + m.invoiced, 0)).toBe(h.yearInvoiced);
    expect(h.months.reduce((a, m) => a + m.received, 0)).toBe(h.yearReceived);
  });

  it("há doze nomes de mês, na ordem", () => {
    expect(NOMES_MESES).toHaveLength(12);
    expect(NOMES_MESES[0]).toBe("Jan");
    expect(NOMES_MESES[11]).toBe("Dez");
  });
});

// ─── 2. Isolamento ───────────────────────────────────────────────────────────

describe("🔴 isolamento — nada de outro cliente, nada de outro ano", () => {
  const misto = ok([
    fatura({ id: "a1", clientId: "A", total: 100, periodStart: "2026-03-01", paidAt: "2026-03-05" }),
    fatura({ id: "b1", clientId: "B", total: 999, periodStart: "2026-03-01", paidAt: "2026-03-05" }),
    fatura({ id: "a2", clientId: "A", total: 777, periodStart: "2025-03-01", paidAt: "2025-03-05" }),
  ]);

  it("o histórico de A não tem um cêntimo de B", () => {
    const h = montarHistoricoCliente(misto, "A", 2026);
    expect(h.yearInvoiced).toBe(100);
    expect(h.yearReceived).toBe(100);
  });

  it("o histórico de B não tem um cêntimo de A", () => {
    const h = montarHistoricoCliente(misto, "B", 2026);
    expect(h.yearInvoiced).toBe(999);
  });

  it("2025 não entra em 2026", () => {
    expect(montarHistoricoCliente(misto, "A", 2026).yearInvoiced).toBe(100);
    expect(montarHistoricoCliente(misto, "A", 2025).yearInvoiced).toBe(777);
  });
});

// ─── 3. Semântica ────────────────────────────────────────────────────────────

describe("🔴 um rascunho não é faturação", () => {
  it("faturas em rascunho não contam", () => {
    // Dar a um cliente um histórico de pagamentos que ele nunca fez é a
    // conversa mais difícil que um sistema destes pode provocar.
    const h = montarHistoricoCliente(
      ok([fatura({ status: "rascunho", total: 5000, periodStart: "2026-04-01" })]),
      "A", 2026,
    );
    expect(h.yearInvoiced).toBe(0);
    expect(h.estado).toBe("EMPTY");
  });

  it("em aberto é faturado por receber, não faturado menos recebido", () => {
    const h = montarHistoricoCliente(
      ok([
        fatura({ id: "1", total: 300, periodStart: "2026-06-01" }),
        fatura({ id: "2", status: "pago", total: 200, periodStart: "2026-06-01", paidAt: "2026-06-10" }),
      ]),
      "A", 2026,
    );
    expect(h.months[5].outstanding).toBe(300);
    expect(h.months[5].received).toBe(200);
  });
});

// ─── 4. Fonte de recebimento única ──────────────────────────────────────────

describe("recebido não vem de duas fontes ao mesmo tempo", () => {
  it("com fonte de caixa, o `paid_at` da fatura não é somado por cima", () => {
    const h = montarHistoricoCliente(
      ok([fatura({ status: "pago", total: 500, periodStart: "2026-07-01", paidAt: "2026-07-10" })]),
      "A", 2026,
      ok([{ date: "2026-07-10", amount: 500 }]),
    );
    expect(h.yearReceived, "500, não 1000").toBe(500);
  });

  it("sem fonte de caixa, usa o `paid_at`", () => {
    const h = montarHistoricoCliente(
      ok([fatura({ status: "pago", total: 500, periodStart: "2026-07-01", paidAt: "2026-07-10" })]),
      "A", 2026,
    );
    expect(h.yearReceived).toBe(500);
  });
});

// ─── 5. Estados ──────────────────────────────────────────────────────────────

describe("AVAILABLE, EMPTY e ERROR são três coisas", () => {
  it("sem movimento no ano → EMPTY, com doze meses a zero", () => {
    const h = montarHistoricoCliente(ok([]), "A", 2026);
    expect(h.estado).toBe("EMPTY");
    expect(h.months).toHaveLength(12);
    expect(h.yearReceived).toBe(0);
  });

  it("🔴 fonte falhou → ERROR, e não se parece com um ano sem movimento", () => {
    const erro = montarHistoricoCliente(falhou("timeout"), "A", 2026);
    const vazio = montarHistoricoCliente(ok([]), "A", 2026);
    expect(erro.estado).toBe("ERROR");
    expect(erro.nota).toBeTruthy();
    expect(erro.estado).not.toBe(vazio.estado);
  });

  it("a fonte de recebimentos em falha também dá ERROR", () => {
    const h = montarHistoricoCliente(ok([]), "A", 2026, falhou("500"));
    expect(h.estado).toBe("ERROR");
  });
});

// ─── 6. Catálogo de categorias ───────────────────────────────────────────────

describe("categorias sugeridas — proposta, não dado", () => {
  it("o catálogo existe no código e tem as catorze", () => {
    expect(DEFAULT_EXPENSE_CATEGORY_SUGGESTIONS).toHaveLength(14);
    expect(DEFAULT_EXPENSE_CATEGORY_SUGGESTIONS.every((c) => c.name && c.colorToken)).toBe(true);
  });

  it("normalizar ignora acentos, maiúsculas e espaços a mais", () => {
    // Sem isto, «Combustível» e «combustivel» entrariam como duas categorias e
    // a mesma despesa apareceria repartida por duas fatias do donut.
    expect(normalizarNomeCategoria("Combustível")).toBe(normalizarNomeCategoria(" COMBUSTIVEL "));
    expect(normalizarNomeCategoria("Materiais  e   produtos")).toBe("materiais e produtos");
  });

  it("preparar descarta vazios e duplicados, e diz quais", () => {
    const r = prepararCategorias(["Salários", "  ", "salarios", "Viaturas"]);
    expect(r.aCriar.map((c) => c.name)).toEqual(["Salários", "Viaturas"]);
    expect(r.descartados.map((d) => d.motivo)).toEqual(["vazio", "duplicado"]);
  });

  it("🔴 criar sugeridas é idempotente — a segunda vez não cria nada", () => {
    const { aCriar } = prepararCategorias(DEFAULT_EXPENSE_CATEGORY_SUGGESTIONS.map((c) => c.name));
    const jaExistem = aCriar.map((c) => c.name);
    expect(diferencaDeCategorias(aCriar, [])).toHaveLength(14);
    expect(diferencaDeCategorias(aCriar, jaExistem), "nada por criar à segunda").toEqual([]);
  });

  it("reconhece o que já existe mesmo escrito de outra maneira", () => {
    const { aCriar } = prepararCategorias(["Combustível", "Viaturas"]);
    expect(diferencaDeCategorias(aCriar, ["COMBUSTIVEL"]).map((c) => c.name)).toEqual(["Viaturas"]);
  });
});

// ─── 7. Write budget ─────────────────────────────────────────────────────────

describe("🔴 o histórico é só leitura", () => {
  const ROOT = process.cwd();
  const ler = (rel: string) => fs.readFileSync(path.join(ROOT, rel), "utf8");

  it("nem o histórico nem o catálogo tocam na base", () => {
    for (const f of [
      "src/domain/finance-v2/client-history.ts",
      "src/domain/finance-v2/expense-categories.ts",
    ]) {
      const src = stripComments(ler(f));
      expect(src, `${f} conhece Supabase`).not.toMatch(/@\/lib\/supabase|createAdminClient/);
      expect(src, `${f} escreve`).not.toMatch(/\.(insert|update|upsert|delete|rpc)\s*\(/);
    }
  });

  it("o motor do dashboard continua sem capacidade de escrita", () => {
    const resolvedor = createWriteCapabilityResolver((rel) => {
      try { return ler(rel); } catch { return null; }
    });
    expect(resolvedor.exportsThatWrite("src/app/actions/finance-dashboard-v2.ts")).toEqual([]);
  });
});

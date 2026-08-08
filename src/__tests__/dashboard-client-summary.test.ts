// T15 — Resumo financeiro por cliente.
//
// O gráfico "Receita por Cliente" soma `invoices.total` (com IVA, com
// rascunhos) e um cliente sem fatura emitida **não aparece** — mesmo com
// serviços realizados no ano.

import { describe, it, expect } from "vitest";
import {
  buildClientSummaries,
  clientValueBy,
  clientsPerformedWithoutInvoice,
  topClientsBy,
  totalClientValue,
  type ClientRankingBasis,
} from "@/domain/dashboard/client-summary";
import { legacyClientRevenue } from "@/domain/dashboard/legacy-dashboard";
import { eurosToCents } from "@/domain/billing/money";

const cents = (v: number) => eurosToCents(v)!;

describe("buildClientSummaries", () => {
  it("agrega várias contribuições do mesmo cliente", () => {
    const [s] = buildClientSummaries([
      { clientId: "c1", invoicedCents: cents(100) },
      { clientId: "c1", invoicedCents: cents(50) },
      { clientId: "c1", receivedCents: cents(120) },
      { clientId: "c1", performedCents: cents(200), completedServices: 2 },
    ]);
    expect(s.invoicedCents).toBe(cents(150));
    expect(s.receivedCents).toBe(cents(120));
    expect(s.performedCents).toBe(cents(200));
    expect(s.completedServices).toBe(2);
    expect(s.outstandingCents).toBe(cents(30));
  });

  it("um cliente com trabalho feito e sem fatura APARECE", () => {
    // É esta a correcção: o gráfico antigo esconde-o por completo.
    const sums = buildClientSummaries([
      { clientId: "c1", invoicedCents: cents(100) },
      { clientId: "c2", performedCents: cents(300), completedServices: 3 },
    ]);
    expect(sums.map((s) => s.clientId)).toEqual(["c1", "c2"]);

    const antigo = legacyClientRevenue(
      [{ total: 100, status: "pendente", periodStart: "2026-08-01", clientId: "c1" }],
      2026,
    );
    expect(antigo.map((c) => c.clientId)).toEqual(["c1"]);
  });

  it("marca quem tem trabalho realizado e nenhuma fatura", () => {
    const sums = buildClientSummaries([
      { clientId: "c1", invoicedCents: cents(100), performedCents: cents(100) },
      { clientId: "c2", performedCents: cents(300) },
      { clientId: "c3", invoicedCents: cents(50) },
    ]);
    expect(clientsPerformedWithoutInvoice(sums).map((s) => s.clientId)).toEqual(["c2"]);
  });

  it("em aberto pode ser negativo — nunca se faz clamp", () => {
    const [s] = buildClientSummaries([
      { clientId: "c1", invoicedCents: cents(100), receivedCents: cents(250) },
    ]);
    expect(s.outstandingCents).toBe(cents(-150));
  });

  it("a ordem é determinística, independente da ordem de chegada", () => {
    const a = buildClientSummaries([
      { clientId: "c2", invoicedCents: cents(1) },
      { clientId: "c1", invoicedCents: cents(1) },
    ]);
    const b = buildClientSummaries([
      { clientId: "c1", invoicedCents: cents(1) },
      { clientId: "c2", invoicedCents: cents(1) },
    ]);
    expect(a.map((s) => s.clientId)).toEqual(b.map((s) => s.clientId));
  });

  it("um conjunto vazio dá lista vazia", () => {
    expect(buildClientSummaries([])).toEqual([]);
  });

  it("o DTO não tem campo para nome de cliente", () => {
    // Um resumo financeiro pode acabar num ficheiro exportado.
    const [s] = buildClientSummaries([{ clientId: "c1", invoicedCents: cents(1) }]);
    expect(Object.keys(s).sort()).toEqual([
      "clientId", "completedServices", "invoicedCents", "outstandingCents",
      "performedCents", "performedWithoutInvoice", "receivedCents",
    ]);
  });
});

describe("topClientsBy", () => {
  const sums = buildClientSummaries([
    { clientId: "c1", invoicedCents: cents(100), receivedCents: cents(100), performedCents: cents(50) },
    { clientId: "c2", invoicedCents: cents(500), receivedCents: cents(0), performedCents: cents(600) },
    { clientId: "c3", invoicedCents: cents(200), receivedCents: cents(200), performedCents: cents(10) },
  ]);

  it("a ordem muda conforme a grandeza escolhida", () => {
    expect(topClientsBy(sums, "invoiced").map((s) => s.clientId)).toEqual(["c2", "c3", "c1"]);
    expect(topClientsBy(sums, "received").map((s) => s.clientId)).toEqual(["c3", "c1", "c2"]);
    expect(topClientsBy(sums, "performed").map((s) => s.clientId)).toEqual(["c2", "c1", "c3"]);
    expect(topClientsBy(sums, "outstanding").map((s) => s.clientId)).toEqual(["c2", "c1", "c3"]);
  });

  it("respeita o limite", () => {
    expect(topClientsBy(sums, "invoiced", 2)).toHaveLength(2);
    expect(topClientsBy(sums, "invoiced", 0)).toHaveLength(0);
  });

  it("empates desempatam por clientId — a ordem nunca oscila", () => {
    const empatados = buildClientSummaries([
      { clientId: "cb", invoicedCents: cents(100) },
      { clientId: "ca", invoicedCents: cents(100) },
    ]);
    expect(topClientsBy(empatados, "invoiced").map((s) => s.clientId)).toEqual(["ca", "cb"]);
  });

  it("clientValueBy devolve a grandeza pedida", () => {
    const c2 = sums.find((s) => s.clientId === "c2")!;
    const casos: [ClientRankingBasis, number][] = [
      ["invoiced", cents(500)], ["received", cents(0)],
      ["performed", cents(600)], ["outstanding", cents(500)],
    ];
    for (const [basis, expected] of casos) {
      expect(clientValueBy(c2, basis)).toBe(expected);
    }
  });

  it("totalClientValue soma a grandeza sobre todos", () => {
    expect(totalClientValue(sums, "invoiced")).toBe(cents(800));
    expect(totalClientValue(sums, "received")).toBe(cents(300));
    expect(totalClientValue([], "invoiced")).toBe(0);
  });
});

// A janela de geração dos fixos recorrentes — o que o cron pede à 107.
import { describe, expect, it } from "vitest";
import {
  chaveCorrente,
  isIntervaloRecorrencia,
  janelaDeGeracao,
  PISO_GERACAO,
  somarMeses,
} from "@/domain/finance/payment-recurrence";

describe("janela de geração", () => {
  it("🔴 hoje (Outubro/2026): Novembro a Fevereiro — Outubro nunca", () => {
    expect(janelaDeGeracao("2026-10-01")).toEqual({ de: 202611, ate: 202702 });
    expect(janelaDeGeracao("2026-10-31")).toEqual({ de: 202611, ate: 202702 });
  });

  it("sempre quatro meses à frente, sem o corrente", () => {
    expect(janelaDeGeracao("2026-11-15")).toEqual({ de: 202612, ate: 202703 });
    expect(janelaDeGeracao("2027-09-01")).toEqual({ de: 202710, ate: 202801 });
  });

  it("antes do piso não pede nada abaixo de Novembro/2026", () => {
    const j = janelaDeGeracao("2026-08-10");
    expect(j.de).toBe(PISO_GERACAO);
    expect(j.ate).toBe(202612);
  });

  it("aritmética de meses atravessa o ano nos dois sentidos", () => {
    expect(somarMeses(202612, 1)).toBe(202701);
    expect(somarMeses(202611, 3)).toBe(202702);
    expect(somarMeses(202701, -1)).toBe(202612);
    expect(somarMeses(202605, 12)).toBe(202705);
  });

  it("chave do mês corrente", () => {
    expect(chaveCorrente("2026-10-01")).toBe(202610);
  });

  it("só as periodicidades que a 107 aceita", () => {
    for (const n of [1, 2, 3, 6, 12]) expect(isIntervaloRecorrencia(n)).toBe(true);
    for (const n of [0, 4, 5, 24, 1.5, "1", null]) expect(isIntervaloRecorrencia(n)).toBe(false);
  });
});

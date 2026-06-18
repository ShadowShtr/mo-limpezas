import { describe, it, expect } from "vitest";
import {
  dailyContractedMinutes,
  timesheetWorkedMinutes,
  hasOpenTimesheet,
  isAbsentOn,
  balanceMinutes,
  formatHM,
} from "@/lib/ponto-calc";

describe("dailyContractedMinutes", () => {
  it("divide horas mensais por 22 dias úteis", () => {
    expect(dailyContractedMinutes(220)).toBe(600); // 10h/dia
  });
  it("trata null/zero como 0", () => {
    expect(dailyContractedMinutes(null)).toBe(0);
    expect(dailyContractedMinutes(0)).toBe(0);
  });
});

describe("timesheetWorkedMinutes", () => {
  const now = new Date("2026-06-18T12:00:00Z").getTime();

  it("soma durações de registos fechados", () => {
    const rows = [
      { clock_in_at: "x", clock_out_at: "y", duration_minutes: 120 },
      { clock_in_at: "x", clock_out_at: "y", duration_minutes: 60 },
    ];
    expect(timesheetWorkedMinutes(rows, now)).toBe(180);
  });

  it("conta tempo decorrido para registo em curso", () => {
    const rows = [{ clock_in_at: "2026-06-18T10:00:00Z", clock_out_at: null, duration_minutes: null }];
    expect(timesheetWorkedMinutes(rows, now)).toBe(120);
  });
});

describe("hasOpenTimesheet", () => {
  it("deteta entrada sem saída", () => {
    expect(hasOpenTimesheet([{ clock_in_at: "x", clock_out_at: null, duration_minutes: null }])).toBe(true);
    expect(hasOpenTimesheet([{ clock_in_at: "x", clock_out_at: "y", duration_minutes: 10 }])).toBe(false);
  });
});

describe("isAbsentOn", () => {
  const abs = [{ starts_on: "2026-06-17", ends_on: "2026-06-19" }];
  it("verdadeiro dentro do intervalo", () => {
    expect(isAbsentOn(abs, "2026-06-18")).toBe(true);
  });
  it("falso fora do intervalo", () => {
    expect(isAbsentOn(abs, "2026-06-20")).toBe(false);
  });
});

describe("balanceMinutes / formatHM", () => {
  it("calcula saldo", () => {
    expect(balanceMinutes(300, 600)).toBe(-300);
  });
  it("formata com sinal", () => {
    expect(formatHM(-300)).toBe("-05:00");
    expect(formatHM(90, true)).toBe("+01:30");
    expect(formatHM(0)).toBe("00:00");
  });
});

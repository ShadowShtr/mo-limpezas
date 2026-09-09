// ============================================================================
// Vencimento base e líquido escrito à mão — as regras de cálculo
// ============================================================================
//
// O que estas duas coisas vêm resolver está escrito na 098. Aqui prova-se o
// comportamento, incluindo os casos onde é fácil enganar-se: um base a zero
// não é «sem resposta», e um `null` da pessoa não é a mesma coisa que um `0`.
// ============================================================================

import { describe, expect, it } from "vitest";
import {
  calcCollaboratorPayroll,
  calcAdjustedNetSalary,
  resolveBaseSalary,
} from "@/lib/payroll-calc";

const SETTINGS = { defaultHourlyRate: 9.5, mealAllowanceDay: 9.6, overtimeRatePct: 25 };
const INICIO = "2026-09-01";
const FIM = "2026-09-30";

/** 21 dias × 8h, um ponto por dia. */
function pontos(dias: number, horasPorDia = 8) {
  return Array.from({ length: dias }, (_, i) => ({
    duration_minutes: horasPorDia * 60,
    clock_in_at: `2026-09-${String(i + 1).padStart(2, "0")}T08:00:00.000Z`,
  }));
}

describe("resolveBaseSalary — de quem vem o vencimento base", () => {
  it("o da pessoa ganha ao da empresa", () => {
    expect(resolveBaseSalary(1000, 870)).toBe(1000);
  });

  it("sem base na pessoa, vale o da empresa", () => {
    expect(resolveBaseSalary(null, 870)).toBe(870);
    expect(resolveBaseSalary(undefined, 870)).toBe(870);
  });

  it("🔴 zero na pessoa é uma resposta, não uma ausência", () => {
    // Quem tem 0 é pago às horas de propósito. Cair no da empresa dar-lhe-ia
    // um vencimento base que ninguém lhe atribuiu — e ninguém daria por isso
    // até ao recibo sair errado.
    expect(resolveBaseSalary(0, 870)).toBe(0);
  });

  it("sem base em lado nenhum, é zero", () => {
    expect(resolveBaseSalary(null, null)).toBe(0);
    expect(resolveBaseSalary(undefined, undefined)).toBe(0);
  });

  it("🔴 valores impossíveis não passam a salário", () => {
    expect(resolveBaseSalary(Number.NaN, 870)).toBe(0);
    expect(resolveBaseSalary(Number.POSITIVE_INFINITY, 870)).toBe(0);
    expect(resolveBaseSalary(-500, 870)).toBe(0);
  });

  it("arredonda aos cêntimos", () => {
    expect(resolveBaseSalary(870.005, null)).toBe(870.01);
  });
});

describe("o bruto com vencimento base", () => {
  it("🔴 o bruto é o base, e as horas não lhe tocam", () => {
    const com21dias = calcCollaboratorPayroll(
      pontos(21), [], 168, 9.5, SETTINGS, INICIO, FIM, 0, 0, 870,
    );
    const com15dias = calcCollaboratorPayroll(
      pontos(15), [], 168, 9.5, SETTINGS, INICIO, FIM, 0, 0, 870,
    );

    expect(com21dias.grossSalary).toBe(870);
    expect(com15dias.grossSalary).toBe(870);
  });

  it("as horas continuam a ser contadas — deixam é de decidir o salário", () => {
    const r = calcCollaboratorPayroll(
      pontos(21), [], 168, 9.5, SETTINGS, INICIO, FIM, 0, 0, 870,
    );
    expect(r.workedHours).toBe(168);
    expect(r.daysWorked).toBe(21);
    expect(r.baseSalary).toBe(870);
  });

  it("horas acima das contratadas continuam a pagar-se por cima", () => {
    // 22 dias × 8h = 176h, contratadas 168 → 8h extra a 25%.
    const r = calcCollaboratorPayroll(
      pontos(22), [], 168, 9.5, SETTINGS, INICIO, FIM, 0, 0, 870,
    );
    expect(r.overtimeHours).toBe(8);
    expect(r.overtimeBonus).toBe(19); // 8 × 9,50 × 0,25
    expect(r.grossSalary).toBe(870);  // o extra não entra no bruto
  });

  it("o subsídio de alimentação continua por dia trabalhado", () => {
    const r = calcCollaboratorPayroll(
      pontos(21), [], 168, 9.5, SETTINGS, INICIO, FIM, 0, 0, 870,
    );
    expect(r.mealAllowance).toBe(201.6); // 21 × 9,60
  });

  it("o líquido soma tudo pela mesma conta de sempre", () => {
    const r = calcCollaboratorPayroll(
      pontos(22), [], 168, 9.5, SETTINGS, INICIO, FIM, 0, 0, 870,
    );
    expect(r.netSalary).toBe(
      calcAdjustedNetSalary(870, r.mealAllowance, r.overtimeBonus, 0, r.absenceDeductions, 0),
    );
  });
});

describe("sem vencimento base, nada muda", () => {
  it("🔴 o cálculo antigo mantém-se intacto", () => {
    // Ninguém é obrigado a migrar de modelo por esta alteração existir.
    const semBase = calcCollaboratorPayroll(
      pontos(21), [], 168, 9.5, SETTINGS, INICIO, FIM, 0, 0, null,
    );
    expect(semBase.baseSalary).toBe(0);
    expect(semBase.grossSalary).toBe(Math.round(168 * 9.5 * 100) / 100);
  });

  it("o base da empresa aplica-se a quem não tem o seu", () => {
    const r = calcCollaboratorPayroll(
      pontos(21), [], 168, 9.5,
      { ...SETTINGS, defaultBaseSalaryMonthly: 870 },
      INICIO, FIM, 0, 0, null,
    );
    expect(r.grossSalary).toBe(870);
  });

  it("🔴 quem tem base zero explícito continua às horas, mesmo com base na empresa", () => {
    const r = calcCollaboratorPayroll(
      pontos(21), [], 168, 9.5,
      { ...SETTINGS, defaultBaseSalaryMonthly: 870 },
      INICIO, FIM, 0, 0, 0,
    );
    expect(r.grossSalary).toBe(Math.round(168 * 9.5 * 100) / 100);
  });
});

describe("o problema que isto veio resolver", () => {
  it("🔴 antes, o salário mínimo só se atingia torcendo a taxa horária", () => {
    // A produção mostrava hourly_rate entre 5,23 e 9,50 — sinal de que a taxa
    // andou a ser usada como se fosse o total. Para 168h dar 870 €, a taxa
    // tinha de ser 5,18: um número que não é o valor da hora de ninguém.
    const taxaTorcida = Math.round((870 / 168) * 100) / 100;
    expect(taxaTorcida).toBeCloseTo(5.18, 2);

    const antes = calcCollaboratorPayroll(
      pontos(21), [], 168, taxaTorcida, SETTINGS, INICIO, FIM, 0, 0, null,
    );
    // Aproxima-se, mas não bate certo — e as horas extra passariam a ser
    // calculadas sobre uma taxa inventada.
    expect(antes.grossSalary).not.toBe(870);

    const agora = calcCollaboratorPayroll(
      pontos(21), [], 168, 9.5, SETTINGS, INICIO, FIM, 0, 0, 870,
    );
    expect(agora.grossSalary).toBe(870);
    // E a taxa horária volta a poder ser a taxa horária a sério: as horas
    // extra passam a ser calculadas sobre 9,50 €, não sobre um número
    // inventado para o total bater.
    expect(agora.overtimeBonus).toBe(0); // 168h = as contratadas, sem extra
  });

  it("🔴 um mês com menos horas não corta o vencimento base", () => {
    // É esta a diferença que interessa a quem recebe: faltar dois dias não
    // transforma o salário mínimo noutra coisa. Os descontos por falta, esses,
    // continuam a existir e a ser explícitos.
    const cheio = calcCollaboratorPayroll(
      pontos(21), [], 168, 9.5, SETTINGS, INICIO, FIM, 0, 0, 870,
    );
    const curto = calcCollaboratorPayroll(
      pontos(19), [], 168, 9.5, SETTINGS, INICIO, FIM, 0, 0, 870,
    );
    expect(curto.grossSalary).toBe(cheio.grossSalary);
    // O que muda é o subsídio de alimentação, que é mesmo por dia.
    expect(curto.mealAllowance).toBeLessThan(cheio.mealAllowance);
  });
});

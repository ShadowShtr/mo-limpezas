// T14 — Métricas operacionais.
//
// Dois defeitos cobertos:
//
//   1. `reports.ts` agrupa `em_curso` e `sem_cobertura` no balde "agendado"
//      através de um `else` final, que também engoliria qualquer estado novo.
//   2. as três grandezas de horas (planeadas, trabalhadas, ausência) não têm
//      hoje fronteira nenhuma entre si.

import { describe, it, expect } from "vitest";
import {
  buildOperationalMetrics,
  computeAbsenceHours,
  computeScheduledHours,
  computeWorkedHours,
  countServices,
  emptyServiceCounts,
  filterTimesheets,
  isPerformed,
  occupiesSchedule,
  sumOperationalMetrics,
} from "@/domain/reports/operational-metrics";
import { legacyCountServices } from "@/domain/reports/legacy-reports";
import { monthPeriod, dayPeriod } from "@/domain/reports/period";
import { SERVICE_STATUSES, isServiceStatus } from "@/domain/reports/report-sources";
import type { ServiceInput, TimesheetInput } from "@/domain/reports/report-sources";
import { eurosToCents } from "@/domain/billing/money";

const AGOSTO = monthPeriod(2026, 8)!;
const cents = (v: number) => eurosToCents(v)!;

function svc(over: Partial<ServiceInput> = {}): ServiceInput {
  return {
    id: `s${Math.random()}`,
    occurrenceDate: "2026-08-05",
    status: "agendado",
    contractId: null,
    valueCents: cents(50),
    applyVat: true,
    workedMinutes: null,
    scheduledMinutes: 120,
    ...over,
  };
}

function sheet(over: Partial<TimesheetInput> = {}): TimesheetInput {
  return {
    id: `t${Math.random()}`,
    collaboratorId: "c1",
    date: "2026-08-05",
    durationMinutes: 120,
    serviceId: null,
    ...over,
  };
}

describe("estados de serviço", () => {
  it("conhece exactamente os estados do CHECK da migration 006", () => {
    expect([...SERVICE_STATUSES]).toEqual([
      "agendado", "em_curso", "concluido", "cancelado", "falta", "sem_cobertura",
    ]);
  });

  it("rejeita estados inventados", () => {
    expect(isServiceStatus("pendente")).toBe(false);
    expect(isServiceStatus("")).toBe(false);
    expect(isServiceStatus(null)).toBe(false);
  });

  it("só o cancelado não ocupa a agenda", () => {
    for (const s of SERVICE_STATUSES) {
      expect(occupiesSchedule(s)).toBe(s !== "cancelado");
    }
  });

  it("só o concluído é trabalho realizado", () => {
    for (const s of SERVICE_STATUSES) {
      expect(isPerformed(s)).toBe(s === "concluido");
    }
  });
});

describe("countServices", () => {
  const services = SERVICE_STATUSES.map((status, i) =>
    svc({ id: `s${i}`, status, occurrenceDate: "2026-08-05" }),
  );

  it("dá um contador por estado, sem baldes", () => {
    const { counts } = countServices(services, AGOSTO);
    expect(counts.agendado).toBe(1);
    expect(counts.em_curso).toBe(1);
    expect(counts.concluido).toBe(1);
    expect(counts.cancelado).toBe(1);
    expect(counts.falta).toBe(1);
    expect(counts.sem_cobertura).toBe(1);
    expect(counts.total).toBe(6);
    expect(counts.unknown).toBe(0);
  });

  it("separa o que o código antigo agrupa", () => {
    // O `else` final do reports.ts mete em_curso e sem_cobertura em "agendado".
    const antigo = legacyCountServices(services);
    const { counts } = countServices(services, AGOSTO);
    expect(antigo.agendado).toBe(3);
    expect(counts.agendado).toBe(1);
    expect(counts.agendado + counts.em_curso + counts.sem_cobertura).toBe(antigo.agendado);
  });

  it("um estado desconhecido nunca entra no balde de agendado", () => {
    const { counts, issues } = countServices([svc({ id: "x", status: "inventado" })], AGOSTO);
    expect(counts.unknown).toBe(1);
    expect(counts.agendado).toBe(0);
    expect(issues.map((i) => i.code)).toContain("UNKNOWN_STATUS");
    // O antigo contá-lo-ia como agendado, sem aviso nenhum.
    expect(legacyCountServices([svc({ id: "x", status: "inventado" })]).agendado).toBe(1);
  });

  it("detecta o mesmo services.id duas vezes", () => {
    const { counts, issues } = countServices([svc({ id: "d" }), svc({ id: "d" })], AGOSTO);
    expect(counts.total).toBe(1);
    expect(issues.map((i) => i.code)).toContain("DUPLICATE_SERVICE_ID");
  });

  it("exclui e assinala uma linha fora da janela", () => {
    const { counts, issues } = countServices([svc({ occurrenceDate: "2026-09-01" })], AGOSTO);
    expect(counts.total).toBe(0);
    expect(issues.map((i) => i.code)).toContain("RECORD_OUTSIDE_PERIOD");
  });

  it("um conjunto vazio dá zeros e nenhum problema", () => {
    const { counts, issues } = countServices([], AGOSTO);
    expect(counts).toEqual(emptyServiceCounts());
    expect(issues).toHaveLength(0);
  });
});

describe("horas", () => {
  it("as planeadas só contam o que ocupa a agenda", () => {
    const metric = computeScheduledHours([
      svc({ status: "agendado", scheduledMinutes: 120 }),
      svc({ status: "concluido", scheduledMinutes: 60 }),
      svc({ status: "cancelado", scheduledMinutes: 600 }),
    ]);
    expect(metric.hours).toBe(3);
    expect(metric.origin).toBe("services_scheduled");
  });

  it("assinala serviços sem duração planeada em vez de os contar como zero", () => {
    const metric = computeScheduledHours([
      svc({ scheduledMinutes: 60 }),
      svc({ scheduledMinutes: null }),
    ]);
    expect(metric.hours).toBe(1);
    expect(metric.note).toContain("1 serviço");
  });

  it("devolve null quando nenhum serviço tem duração planeada", () => {
    const metric = computeScheduledHours([svc({ scheduledMinutes: null })]);
    expect(metric.hours).toBeNull();
  });

  it("as trabalhadas vêm do ponto e assinalam os pontos abertos", () => {
    const metric = computeWorkedHours([
      sheet({ durationMinutes: 120 }),
      sheet({ durationMinutes: 90 }),
      sheet({ durationMinutes: null }), // clock-in sem clock-out
    ]);
    expect(metric.hours).toBe(3.5);
    expect(metric.note).toContain("1 ponto");
  });

  it("as de ausência ficam null sem jornada declarada", () => {
    expect(computeAbsenceHours(3, null).hours).toBeNull();
    expect(computeAbsenceHours(3, 8).hours).toBe(24);
    expect(computeAbsenceHours(null, 8).hours).toBeNull();
  });

  it("planeadas, trabalhadas e ausência têm origens distintas e nunca se somam", () => {
    const m = buildOperationalMetrics({
      services: [svc({ status: "concluido", scheduledMinutes: 120 })],
      timesheets: [sheet({ durationMinutes: 90 })],
      window: AGOSTO,
      absenceDays: 1,
      absenceHoursPerDay: 8,
    });
    expect(m.scheduledHours.origin).toBe("services_scheduled");
    expect(m.workedHours.origin).toBe("timesheets");
    expect(m.absenceHours.origin).toBe("absences");
    expect(m.scheduledHours.hours).toBe(2);
    expect(m.workedHours.hours).toBe(1.5);
    expect(m.absenceHours.hours).toBe(8);
  });
});

describe("filterTimesheets", () => {
  it("exclui e assinala pontos fora da janela", () => {
    const { accepted, issues } = filterTimesheets(
      [sheet({ id: "t1" }), sheet({ id: "t2", date: "2026-09-01" })],
      AGOSTO,
    );
    expect(accepted.map((t) => t.id)).toEqual(["t1"]);
    expect(issues[0].code).toBe("RECORD_OUTSIDE_PERIOD");
  });
});

describe("buildOperationalMetrics", () => {
  it("deriva agendado, concluído, cancelado e falta das contagens", () => {
    const m = buildOperationalMetrics({
      services: [
        svc({ id: "1", status: "concluido" }),
        svc({ id: "2", status: "cancelado" }),
        svc({ id: "3", status: "falta" }),
        svc({ id: "4", status: "sem_cobertura" }),
      ],
      timesheets: [],
      window: AGOSTO,
      absenceDays: 0,
    });
    expect(m.completed).toBe(1);
    expect(m.cancelled).toBe(1);
    expect(m.absences).toBe(1);
    // Agendado = tudo o que ocupa a agenda, incluindo falta e sem_cobertura.
    expect(m.scheduled).toBe(3);
  });
});

describe("sumOperationalMetrics", () => {
  it("as contagens e as horas são aditivas entre dias", () => {
    const dia = (date: string) =>
      buildOperationalMetrics({
        services: [svc({ id: `s-${date}`, occurrenceDate: date, status: "concluido", scheduledMinutes: 60 })],
        timesheets: [sheet({ id: `t-${date}`, date, durationMinutes: 60 })],
        window: dayPeriod(date)!,
        absenceDays: 1,
        absenceHoursPerDay: 8,
      });

    const total = sumOperationalMetrics([dia("2026-08-01"), dia("2026-08-02"), dia("2026-08-03")]);
    expect(total.counts.concluido).toBe(3);
    expect(total.completed).toBe(3);
    expect(total.scheduledHours.hours).toBe(3);
    expect(total.workedHours.hours).toBe(3);
    expect(total.absenceDays).toBe(3);
    expect(total.absenceHours.hours).toBe(24);
  });

  it("um período sem base contamina o total com uma nota, não com um zero", () => {
    const comBase = buildOperationalMetrics({
      services: [svc({ scheduledMinutes: 60 })],
      timesheets: [],
      window: AGOSTO,
      absenceDays: 1,
      absenceHoursPerDay: 8,
    });
    const semBase = buildOperationalMetrics({
      services: [svc({ scheduledMinutes: null })],
      timesheets: [],
      window: AGOSTO,
      absenceDays: null,
    });
    const total = sumOperationalMetrics([comBase, semBase]);
    expect(total.absenceDays).toBeNull();
    expect(total.scheduledHours.note).toContain("incompleto");
  });
});

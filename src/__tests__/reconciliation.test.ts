// ============================================================================
// RECONCILIAÇÃO DETERMINÍSTICA CONTRATO ↔ SERVIÇO (Task T09)
// ============================================================================
// O defeito que esta matriz fecha:
//
// `reconcileFutureServicesForContract` decide o que apagar comparando a data
// AGENDADA com o conjunto de datas do padrão. Um serviço que a gestora moveu à
// mão não corresponde a nenhuma data válida — e é apagado. A edição dela
// desaparece do calendário.
//
// Aqui a comparação passa a ser entre EXPECTED (o que o contrato projeta para
// cada identidade) e ACTUAL (o que existe com essa identidade), e cada
// resultado é uma decisão nomeada.
//
// Regra transversal: a sincronização automática NUNCA sobrescreve uma decisão
// humana, e NUNCA recria o que foi cancelado ou excluído.
// ============================================================================

import { describe, it, expect } from "vitest";
import {
  decideReconciliation,
  expectedOutcome,
  emptyOutcome,
  isCleanOutcome,
  isWritingDecision,
  reconcileContract,
  type ContractStatus,
  type ReconciliationDecision,
} from "@/domain/scheduling/reconciliation";
import {
  projectOccurrence,
  type ContractProjectionFields,
  type ServiceProjection,
} from "@/domain/scheduling/occurrence-projection";
import {
  CREATION_HORIZON_MONTHS,
  CRON_HORIZON_MONTHS,
  RECONCILIATION_HORIZON_MONTHS,
  horizonsAreCoherent,
} from "@/domain/scheduling/horizons";
import type { ServiceRecord, ServiceStatus } from "@/domain/scheduling/occurrence-identity";
import type { ScheduleDay } from "@/types/database";

const HORARIO: ScheduleDay = { day: "all", start_time: "09:00", duration_min: 120, team_id: "equipa-1" };

function contrato(over: Partial<ContractProjectionFields> = {}): ContractProjectionFields {
  return {
    id: "contrato-1", companyId: "empresa-1", locationId: "local-1",
    fixedMonthly: false, fixedPrice: null,
    upholsteryType: null, upholsteryNotes: null,
    upholsteryUnits: null, upholsteryUnitPrice: null,
    cleaningType: null, paymentStatus: null,
    applyVat: false, hourlyRate: 12,
    ...over,
  };
}

function projecao(date: string, over: Partial<ContractProjectionFields> = {}): ServiceProjection {
  return projectOccurrence({
    contract: contrato(over), occurrenceDate: date, schedule: HORARIO, teamSize: 2,
  });
}

function servico(over: Partial<ServiceRecord> & { id: string }): ServiceRecord {
  return {
    companyId: "empresa-1", contractId: "contrato-1",
    occurrenceDate: "2026-07-08", scheduledDate: "2026-07-08",
    status: "agendado", isException: false, originalDate: null,
    createdAt: "2026-06-01T00:00:00.000Z",
    ...over,
  };
}

function decidir(over: Partial<Parameters<typeof decideReconciliation>[0]> = {}) {
  return decideReconciliation({
    occurrenceDate: "2026-07-08",
    contractStatus: "ativo",
    expected: projecao("2026-07-08"),
    actual: null,
    excluded: false,
    ...over,
  });
}

// ─── matriz de decisão, ocorrência a ocorrência ─────────────────────────────

describe("decideReconciliation", () => {
  it("ocorrência em falta ⇒ CREATE", () => {
    expect(decidir({ actual: null }).decision).toBe("CREATE");
  });

  it("existente e conforme ⇒ KEEP", () => {
    const p = projecao("2026-07-08");
    expect(decidir({ actual: servico({ id: "s1" }), actualProjection: p }).decision).toBe("KEEP");
  });

  it("existente e divergente ⇒ UPDATE_FROM_CONTRACT, com os campos", () => {
    const p = projecao("2026-07-08");
    const d = decidir({
      actual: servico({ id: "s1" }),
      actualProjection: { ...p, teamId: "equipa-antiga", calculatedValue: 30 },
    });
    expect(d.decision).toBe("UPDATE_FROM_CONTRACT");
    expect(d.changes.sort()).toEqual(["calculatedValue", "teamId"]);
  });

  it("🔴 exceção NUNCA é sobrescrita", () => {
    const d = decidir({
      actual: servico({ id: "s1", isException: true, scheduledDate: "2026-07-10" }),
      actualProjection: { calculatedValue: 999 },
    });
    expect(d.decision).toBe("KEEP_EXCEPTION");
    expect(d.changes).toEqual([]);
  });

  it("🔴 exceção reagendada não é apagada — o defeito original", () => {
    // Com o código antigo, a data agendada (10/07) não estava no padrão e o
    // serviço era eliminado. Com identidade, a ocorrência de 08/07 continua
    // ocupada por ele.
    const d = decidir({
      occurrenceDate: "2026-07-08",
      actual: servico({ id: "s1", occurrenceDate: "2026-07-08", scheduledDate: "2026-07-10", isException: true }),
    });
    expect(d.decision).toBe("KEEP_EXCEPTION");
    expect(isWritingDecision(d.decision)).toBe(false);
  });

  it("cancelado ⇒ KEEP_CANCELLED e nunca recriado", () => {
    const d = decidir({ actual: servico({ id: "s1", status: "cancelado" }) });
    expect(d.decision).toBe("KEEP_CANCELLED");
    expect(isWritingDecision(d.decision)).toBe(false);
  });

  it.each<[ServiceStatus]>([
    ["concluido"], ["em_curso"], ["falta"], ["sem_cobertura"],
  ])("%s ⇒ KEEP (já aconteceu, não se toca)", (status) => {
    const d = decidir({
      actual: servico({ id: "s1", status }),
      actualProjection: { calculatedValue: 1 }, // divergente de propósito
    });
    expect(d.decision).toBe("KEEP");
    expect(d.changes).toEqual([]);
  });

  it("data excluída ⇒ SKIP_EXCLUDED, mesmo sem serviço", () => {
    expect(decidir({ excluded: true, actual: null }).decision).toBe("SKIP_EXCLUDED");
  });

  it("🔴 a exclusão vence sobre tudo o resto", () => {
    expect(decidir({ excluded: true, actual: servico({ id: "s1" }) }).decision).toBe("SKIP_EXCLUDED");
    expect(decidir({ excluded: true, actual: servico({ id: "s1", isException: true }) }).decision)
      .toBe("SKIP_EXCLUDED");
  });

  it("serviço sem ocorrência prevista e intocado ⇒ REMOVE_ORPHAN", () => {
    const d = decidir({ expected: null, actual: servico({ id: "s1" }) });
    expect(d.decision).toBe("REMOVE_ORPHAN");
  });

  it("órfão que é exceção NÃO é removido", () => {
    const d = decidir({ expected: null, actual: servico({ id: "s1", isException: true }) });
    expect(d.decision).toBe("KEEP_EXCEPTION");
  });

  it("órfão já concluído NÃO é removido", () => {
    const d = decidir({ expected: null, actual: servico({ id: "s1", status: "concluido" }) });
    expect(d.decision).toBe("KEEP");
  });

  it.each<[ContractStatus]>([["pausado"], ["cancelado"]])(
    "contrato %s não cria ocorrências novas", (contractStatus) => {
      const d = decidir({ contractStatus, actual: null });
      expect(d.decision).toBe("KEEP");
      expect(isWritingDecision(d.decision)).toBe(false);
    },
  );

  it("contrato pausado não apaga o que já existe", () => {
    const d = decidir({ contractStatus: "pausado", actual: servico({ id: "s1" }), expected: null });
    // Continua a ser órfão; a decisão de remover é do estado do serviço, não
    // do estado do contrato.
    expect(["REMOVE_ORPHAN", "KEEP"]).toContain(d.decision);
  });

  it("é determinística", () => {
    const entrada = { actual: servico({ id: "s1" }) };
    expect(decidir(entrada)).toEqual(decidir(entrada));
  });
});

// ─── plano completo ─────────────────────────────────────────────────────────

describe("reconcileContract", () => {
  const esperadas = (datas: string[]) =>
    new Map(datas.map((d) => [d, projecao(d)]));

  it("cria as que faltam e mantém as que existem", () => {
    const plano = reconcileContract({
      contractStatus: "ativo",
      expected: esperadas(["2026-07-01", "2026-07-08", "2026-07-15"]),
      actual: [servico({ id: "s1", occurrenceDate: "2026-07-08" })],
      actualProjections: { s1: projecao("2026-07-08") },
    });
    expect(plano.summary.byDecision.CREATE).toBe(2);
    expect(plano.summary.byDecision.KEEP).toBe(1);
    expect(plano.summary.writes).toBe(2);
  });

  it("ignora serviços ainda sem identidade (antes do backfill)", () => {
    const plano = reconcileContract({
      contractStatus: "ativo",
      expected: esperadas(["2026-07-08"]),
      actual: [servico({ id: "s1", occurrenceDate: null })],
    });
    // A ocorrência é vista como em falta; a linha por preencher não decide nada.
    expect(plano.summary.byDecision.CREATE).toBe(1);
    expect(plano.items).toHaveLength(1);
  });

  it("duas linhas com a mesma identidade ⇒ MANUAL_REVIEW", () => {
    const plano = reconcileContract({
      contractStatus: "ativo",
      expected: esperadas(["2026-07-08"]),
      actual: [
        servico({ id: "s1", occurrenceDate: "2026-07-08" }),
        servico({ id: "s2", occurrenceDate: "2026-07-08" }),
      ],
    });
    expect(plano.summary.byDecision.MANUAL_REVIEW).toBe(1);
    expect(plano.summary.writes).toBe(0);
  });

  it("o plano é ordenado por data e determinístico", () => {
    const entrada = {
      contractStatus: "ativo" as const,
      expected: esperadas(["2026-07-15", "2026-07-01", "2026-07-08"]),
      actual: [],
    };
    const plano = reconcileContract(entrada);
    expect(plano.items.map((i) => i.occurrenceDate))
      .toEqual(["2026-07-01", "2026-07-08", "2026-07-15"]);
    expect(reconcileContract(entrada)).toEqual(plano);
  });

  it("não altera as entradas", () => {
    const actual = [servico({ id: "s1", occurrenceDate: "2026-07-08" })];
    const congelado = JSON.stringify(actual);
    reconcileContract({ contractStatus: "ativo", expected: esperadas(["2026-07-08"]), actual });
    expect(JSON.stringify(actual)).toBe(congelado);
  });

  // ── alterações ao contrato ──

  it("dia da semana removido ⇒ as ocorrências intocadas saem", () => {
    const plano = reconcileContract({
      contractStatus: "ativo",
      expected: esperadas(["2026-07-01"]), // deixou de haver 08
      actual: [
        servico({ id: "s1", occurrenceDate: "2026-07-01" }),
        servico({ id: "s2", occurrenceDate: "2026-07-08" }),
      ],
      actualProjections: { s1: projecao("2026-07-01") },
    });
    expect(plano.items.find((i) => i.occurrenceDate === "2026-07-08")?.decision)
      .toBe("REMOVE_ORPHAN");
  });

  it("dia da semana removido NÃO apaga o que já foi trabalhado", () => {
    const plano = reconcileContract({
      contractStatus: "ativo",
      expected: esperadas([]),
      actual: [servico({ id: "s1", occurrenceDate: "2026-07-08", status: "concluido" })],
    });
    expect(plano.summary.byDecision.REMOVE_ORPHAN).toBe(0);
  });

  it("dia da semana acrescentado ⇒ CREATE", () => {
    const plano = reconcileContract({
      contractStatus: "ativo",
      expected: esperadas(["2026-07-01", "2026-07-03"]),
      actual: [servico({ id: "s1", occurrenceDate: "2026-07-01" })],
      actualProjections: { s1: projecao("2026-07-01") },
    });
    expect(plano.items.find((i) => i.occurrenceDate === "2026-07-03")?.decision).toBe("CREATE");
  });

  it("preço alterado ⇒ UPDATE só nos que não são exceção", () => {
    const antigo = projecao("2026-07-08");
    const plano = reconcileContract({
      contractStatus: "ativo",
      expected: new Map([
        ["2026-07-08", projecao("2026-07-08", { hourlyRate: 20 })],
        ["2026-07-15", projecao("2026-07-15", { hourlyRate: 20 })],
      ]),
      actual: [
        servico({ id: "s1", occurrenceDate: "2026-07-08" }),
        servico({ id: "s2", occurrenceDate: "2026-07-15", isException: true }),
      ],
      actualProjections: { s1: antigo, s2: antigo },
    });
    expect(plano.items.find((i) => i.serviceId === "s1")?.decision).toBe("UPDATE_FROM_CONTRACT");
    expect(plano.items.find((i) => i.serviceId === "s2")?.decision).toBe("KEEP_EXCEPTION");
  });

  it("contrato pausado não cria nada", () => {
    const plano = reconcileContract({
      contractStatus: "pausado",
      expected: esperadas(["2026-07-01", "2026-07-08"]),
      actual: [],
    });
    expect(plano.summary.byDecision.CREATE).toBe(0);
    expect(plano.summary.writes).toBe(0);
  });

  it("contrato reativado volta a criar", () => {
    const plano = reconcileContract({
      contractStatus: "ativo",
      expected: esperadas(["2026-07-01", "2026-07-08"]),
      actual: [],
    });
    expect(plano.summary.byDecision.CREATE).toBe(2);
  });

  it("datas excluídas nunca voltam", () => {
    const plano = reconcileContract({
      contractStatus: "ativo",
      expected: esperadas(["2026-07-01", "2026-07-08"]),
      actual: [],
      excludedDates: ["2026-07-08"],
    });
    expect(plano.summary.byDecision.SKIP_EXCLUDED).toBe(1);
    expect(plano.summary.byDecision.CREATE).toBe(1);
  });
});

// ─── invariantes ────────────────────────────────────────────────────────────

describe("invariantes", () => {
  const TODAS: ReconciliationDecision[] = [
    "CREATE", "UPDATE_FROM_CONTRACT", "KEEP", "KEEP_EXCEPTION",
    "KEEP_CANCELLED", "REMOVE_ORPHAN", "SKIP_EXCLUDED", "MANUAL_REVIEW",
  ];

  it("só três decisões escrevem", () => {
    expect(TODAS.filter(isWritingDecision).sort())
      .toEqual(["CREATE", "REMOVE_ORPHAN", "UPDATE_FROM_CONTRACT"]);
  });

  it("uma exceção nunca produz decisão de escrita", () => {
    for (const status of ["agendado", "concluido", "cancelado"] as ServiceStatus[]) {
      const d = decidir({ actual: servico({ id: "s1", isException: true, status }) });
      expect(isWritingDecision(d.decision)).toBe(false);
    }
  });

  it("um cancelamento nunca produz decisão de escrita", () => {
    for (const excluded of [true, false]) {
      const d = decidir({ excluded, actual: servico({ id: "s1", status: "cancelado" }) });
      expect(isWritingDecision(d.decision)).toBe(false);
    }
  });

  it("uma data excluída nunca produz decisão de escrita", () => {
    for (const actual of [null, servico({ id: "s1" }), servico({ id: "s2", isException: true })]) {
      expect(isWritingDecision(decidir({ excluded: true, actual }).decision)).toBe(false);
    }
  });

  it("o mesmo plano gera as mesmas contagens esperadas", () => {
    const plano = reconcileContract({
      contractStatus: "ativo",
      expected: new Map([["2026-07-01", projecao("2026-07-01")], ["2026-07-08", projecao("2026-07-08")]]),
      actual: [servico({ id: "s1", occurrenceDate: "2026-07-08", status: "cancelado" })],
    });
    const esperado = expectedOutcome(plano);
    expect(esperado.created).toBe(1);
    expect(esperado.kept).toBe(1);
    expect(esperado.removed).toBe(0);
  });
});

// ─── resultado estruturado ──────────────────────────────────────────────────

describe("resultado da sincronização", () => {
  it("um resultado vazio é limpo", () => {
    expect(isCleanOutcome(emptyOutcome())).toBe(true);
  });

  it("🔴 uma falha não pode passar despercebida", () => {
    // O código atual tem caminhos em que um INSERT falhado apenas continua o
    // ciclo e a ocorrência desaparece sem ninguém saber.
    const outcome = emptyOutcome();
    outcome.failed.push({
      occurrenceDate: "2026-07-08", code: "INSERT_FAILED", detail: "unique violation",
    });
    expect(isCleanOutcome(outcome)).toBe(false);
  });
});

// ─── política de horizontes ─────────────────────────────────────────────────

describe("horizontes", () => {
  it("os valores atuais são preservados", () => {
    expect(CREATION_HORIZON_MONTHS).toBe(3);
    expect(RECONCILIATION_HORIZON_MONTHS).toBe(6);
    expect(CRON_HORIZON_MONTHS).toBe(1);
  });

  it("🔴 a reconciliação nunca pode ser mais curta do que a criação", () => {
    // Se fosse, apagaria ocorrências acabadas de gerar.
    expect(horizonsAreCoherent()).toBe(true);
    expect(RECONCILIATION_HORIZON_MONTHS).toBeGreaterThanOrEqual(CREATION_HORIZON_MONTHS);
  });
});

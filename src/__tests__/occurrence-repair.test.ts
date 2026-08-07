// ============================================================================
// DIAGNÓSTICO E PLANEAMENTO DE REPARAÇÃO (Task T08)
// ============================================================================
// Regra que estes testes protegem: NADA é apagado, e nada é adivinhado.
//
// O planeador produz intenções, não escrita. Quando dois serviços duplicados
// têm ambos trabalho real associado (registo de ponto, linha de fatura),
// fundir destruiria informação de uma cliente real — nesse caso a resposta
// obrigatória é MANUAL_REVIEW, nunca uma escolha automática.
//
// Todos os dados são sintéticos.
// ============================================================================

import { describe, it, expect } from "vitest";
import {
  chooseSurvivor,
  diagnose,
  planRepair,
  validateSnapshot,
  NO_DEPENDENCIES,
  type ContractRecord,
  type DependencySignals,
  type RepairSnapshot,
} from "@/domain/scheduling/occurrence-repair";
import type { ServiceRecord } from "@/domain/scheduling/occurrence-identity";

const EMPRESA = "empresa-1";
const JANELA = { start: "2026-07-01", end: "2026-07-31" };

/** Contrato semanal às quartas: 01, 08, 15, 22 e 29 de julho de 2026. */
function contratoSemanal(over: Partial<ContractRecord> = {}): ContractRecord {
  return {
    id: "contrato-1",
    companyId: EMPRESA,
    status: "ativo",
    frequency: "weekly",
    weekdays: [3],
    intervalDays: 1,
    startsOn: "2026-07-01",
    endsOn: null,
    excludedDates: [],
    ...over,
  };
}

function servico(over: Partial<ServiceRecord> & { id: string }): ServiceRecord {
  return {
    companyId: EMPRESA,
    contractId: "contrato-1",
    occurrenceDate: null,
    scheduledDate: "2026-07-08",
    status: "agendado",
    isException: false,
    originalDate: null,
    createdAt: "2026-06-01T10:00:00.000Z",
    ...over,
  };
}

function deps(over: Partial<DependencySignals>): DependencySignals {
  return { ...NO_DEPENDENCIES, ...over };
}

function snapshot(over: Partial<RepairSnapshot> = {}): RepairSnapshot {
  return { window: JANELA, contracts: [contratoSemanal()], services: [], ...over };
}

// ─── validação da entrada ───────────────────────────────────────────────────

describe("validateSnapshot", () => {
  it("aceita um snapshot bem formado", () => {
    expect(validateSnapshot(snapshot({ services: [servico({ id: "s1" })] }))).toEqual([]);
  });

  it("rejeita janela inválida", () => {
    expect(validateSnapshot(snapshot({ window: { start: "ontem", end: "2026-07-31" } })).length)
      .toBeGreaterThan(0);
  });

  it("assinala datas de serviço corrompidas", () => {
    const problemas = validateSnapshot(snapshot({
      services: [servico({ id: "s1", scheduledDate: "72026-01-01" })],
    }));
    expect(problemas.some((p) => p.includes("s1"))).toBe(true);
  });

  it("assinala contratos com starts_on corrompido", () => {
    const problemas = validateSnapshot(snapshot({
      contracts: [contratoSemanal({ startsOn: "2026-02-30" })],
    }));
    expect(problemas.some((p) => p.includes("contrato-1"))).toBe(true);
  });
});

// ─── diagnóstico ────────────────────────────────────────────────────────────

describe("diagnose", () => {
  it("classifica serviços normais e conta as ocorrências em falta", () => {
    const r = diagnose(snapshot({
      services: [
        servico({ id: "s1", scheduledDate: "2026-07-01" }),
        servico({ id: "s2", scheduledDate: "2026-07-08" }),
      ],
    }));
    expect(r.summary.byClass.NORMAL).toBe(2);
    // Faltam 15, 22 e 29 de julho.
    expect(r.summary.missingOccurrences).toBe(3);
    expect(r.missingOccurrences.map((m) => m.occurrenceDate))
      .toEqual(["2026-07-15", "2026-07-22", "2026-07-29"]);
  });

  it("deteta duplicados no mesmo dia", () => {
    const r = diagnose(snapshot({
      services: [
        servico({ id: "s1", scheduledDate: "2026-07-08" }),
        servico({ id: "s2", scheduledDate: "2026-07-08" }),
      ],
    }));
    expect(r.summary.duplicateGroups).toBe(1);
    expect(r.summary.duplicateServices).toBe(2);
    expect(r.duplicateGroups[0].serviceIds).toEqual(["s1", "s2"]);
    expect(r.duplicateGroups[0].date).toBe("2026-07-08");
  });

  it("não conta como duplicado dois serviços em dias diferentes", () => {
    const r = diagnose(snapshot({
      services: [
        servico({ id: "s1", scheduledDate: "2026-07-01" }),
        servico({ id: "s2", scheduledDate: "2026-07-08" }),
      ],
    }));
    expect(r.summary.duplicateGroups).toBe(0);
  });

  it("não confunde contratos diferentes no mesmo dia", () => {
    const r = diagnose(snapshot({
      contracts: [contratoSemanal(), contratoSemanal({ id: "contrato-2" })],
      services: [
        servico({ id: "s1", contractId: "contrato-1", scheduledDate: "2026-07-08" }),
        servico({ id: "s2", contractId: "contrato-2", scheduledDate: "2026-07-08" }),
      ],
    }));
    expect(r.summary.duplicateGroups).toBe(0);
  });

  it("conta serviços avulsos sem os tratar como problema", () => {
    const r = diagnose(snapshot({
      services: [servico({ id: "s1", contractId: null })],
    }));
    expect(r.summary.servicesWithoutContract).toBe(1);
    expect(r.summary.byClass.STANDALONE).toBe(1);
    expect(r.summary.needsManualReview).toBe(0);
  });

  it("assinala contratos inexistentes", () => {
    const r = diagnose(snapshot({
      services: [servico({ id: "s1", contractId: "contrato-fantasma" })],
    }));
    expect(r.summary.servicesWithUnknownContract).toBe(1);
    expect(r.summary.byClass.MISSING_CONTRACT).toBe(1);
  });

  it("assinala serviços em datas que o contrato declara excluídas", () => {
    const r = diagnose(snapshot({
      contracts: [contratoSemanal({ excludedDates: ["2026-07-08"] })],
      services: [servico({ id: "s1", scheduledDate: "2026-07-08" })],
    }));
    expect(r.summary.excludedButPresent).toBe(1);
    expect(r.excludedButPresent[0].serviceId).toBe("s1");
  });

  it("uma data excluída não conta como ocorrência em falta", () => {
    const r = diagnose(snapshot({
      contracts: [contratoSemanal({ excludedDates: ["2026-07-15"] })],
      services: [],
    }));
    expect(r.missingOccurrences.map((m) => m.occurrenceDate)).not.toContain("2026-07-15");
  });

  it("assinala original_date preenchida — nenhum código a escreve", () => {
    const r = diagnose(snapshot({
      services: [servico({ id: "s1", originalDate: "2026-07-01" })],
    }));
    expect(r.summary.originalDatePresent).toBe(1);
  });

  it("conta quantos casos exigem revisão humana", () => {
    const r = diagnose(snapshot({
      services: [
        servico({ id: "s1", scheduledDate: "2026-07-01" }),                        // NORMAL
        servico({ id: "s2", scheduledDate: "2026-07-10", isException: true }),      // RESCHEDULED
        servico({ id: "s3", scheduledDate: "2026-07-09" }),                        // DATE_INCONSISTENT
      ],
    }));
    expect(r.summary.needsManualReview).toBe(2);
  });

  it("é determinístico", () => {
    const s = snapshot({
      services: [
        servico({ id: "s2", scheduledDate: "2026-07-08" }),
        servico({ id: "s1", scheduledDate: "2026-07-08" }),
      ],
    });
    expect(diagnose(s)).toEqual(diagnose(s));
  });

  it("não altera o snapshot recebido", () => {
    const s = snapshot({ services: [servico({ id: "s1" })] });
    const congelado = JSON.stringify(s);
    diagnose(s);
    expect(JSON.stringify(s)).toBe(congelado);
  });
});

// ─── escolha do sobrevivente ────────────────────────────────────────────────

describe("chooseSurvivor", () => {
  it("nunca escolhe simplesmente o primeiro id", () => {
    const a = servico({ id: "aaa", status: "agendado" });
    const b = servico({ id: "zzz", status: "concluido" });
    expect(chooseSurvivor([a, b]).survivor.id).toBe("zzz");
  });

  it("prefere quem tem registo de ponto", () => {
    const a = servico({ id: "s1", status: "concluido" });
    const b = servico({ id: "s2", status: "agendado" });
    const r = chooseSurvivor([a, b], { s2: deps({ timesheets: 1 }) });
    expect(r.survivor.id).toBe("s2");
  });

  it("prefere quem tem linha de fatura", () => {
    const r = chooseSurvivor(
      [servico({ id: "s1" }), servico({ id: "s2" })],
      { s2: deps({ invoiceItems: 1 }) },
    );
    expect(r.survivor.id).toBe("s2");
  });

  it("🔴 dois lados com trabalho real ⇒ MANUAL_REVIEW", () => {
    const r = chooseSurvivor(
      [servico({ id: "s1" }), servico({ id: "s2" })],
      { s1: deps({ timesheets: 1 }), s2: deps({ invoiceItems: 1 }) },
    );
    expect(r.safety).toBe("MANUAL_REVIEW");
  });

  it("dependências leves no não-sobrevivente também exigem revisão", () => {
    const r = chooseSurvivor(
      [servico({ id: "s1", status: "concluido" }), servico({ id: "s2" })],
      { s1: deps({ timesheets: 1 }), s2: deps({ photos: 2 }) },
    );
    expect(r.survivor.id).toBe("s1");
    expect(r.safety).toBe("MANUAL_REVIEW");
  });

  it("só o sobrevivente com dependências ⇒ seguro", () => {
    const r = chooseSurvivor(
      [servico({ id: "s1" }), servico({ id: "s2" })],
      { s1: deps({ timesheets: 2, photos: 1 }) },
    );
    expect(r.survivor.id).toBe("s1");
    expect(r.safety).toBe("SAFE_TO_MERGE");
  });

  it("sem dependências nenhumas, decide por estado e antiguidade", () => {
    const antigo = servico({ id: "s1", createdAt: "2026-01-01T00:00:00.000Z" });
    const novo = servico({ id: "s2", createdAt: "2026-06-01T00:00:00.000Z" });
    const r = chooseSurvivor([novo, antigo]);
    expect(r.survivor.id).toBe("s1");
    expect(r.safety).toBe("SAFE_TO_MERGE");
  });

  it("prefere a exceção manual a um gerado automaticamente", () => {
    const r = chooseSurvivor([
      servico({ id: "s1", createdAt: "2026-06-01T00:00:00.000Z" }),
      servico({ id: "s2", isException: true, createdAt: "2026-06-01T00:00:00.000Z" }),
    ]);
    expect(r.survivor.id).toBe("s2");
  });

  it("cancelado nunca sobrevive a um agendado", () => {
    const r = chooseSurvivor([
      servico({ id: "s1", status: "cancelado" }),
      servico({ id: "s2", status: "agendado" }),
    ]);
    expect(r.survivor.id).toBe("s2");
  });

  it("é determinística mesmo com tudo igual", () => {
    const a = servico({ id: "s2" });
    const b = servico({ id: "s1" });
    expect(chooseSurvivor([a, b]).survivor.id).toBe("s1");
    expect(chooseSurvivor([b, a]).survivor.id).toBe("s1");
  });
});

// ─── plano ──────────────────────────────────────────────────────────────────

describe("planRepair", () => {
  it("propõe a identidade dos casos inequívocos", () => {
    const s = snapshot({ services: [servico({ id: "s1", scheduledDate: "2026-07-08" })] });
    const plano = planRepair(diagnose(s), s);
    const acao = plano.actions.find((a) => a.serviceId === "s1");
    expect(acao?.type).toBe("SET_OCCURRENCE_DATE");
    expect(acao?.occurrenceDate).toBe("2026-07-08");
  });

  it("marca como ambíguo o que não consegue decidir", () => {
    const s = snapshot({
      services: [servico({ id: "s1", scheduledDate: "2026-07-10", isException: true })],
    });
    const plano = planRepair(diagnose(s), s);
    expect(plano.actions.find((a) => a.serviceId === "s1")?.type).toBe("MARK_AMBIGUOUS");
  });

  it("cancelado gera DO_NOT_RECREATE", () => {
    const s = snapshot({
      services: [servico({ id: "s1", scheduledDate: "2026-07-08", status: "cancelado" })],
    });
    const plano = planRepair(diagnose(s), s);
    expect(plano.actions.find((a) => a.serviceId === "s1")?.type).toBe("DO_NOT_RECREATE");
  });

  it("duplicados dão um sobrevivente e candidatos, nunca um DELETE", () => {
    const s = snapshot({
      services: [
        servico({ id: "s1", scheduledDate: "2026-07-08", status: "concluido" }),
        servico({ id: "s2", scheduledDate: "2026-07-08" }),
      ],
    });
    const plano = planRepair(diagnose(s), s);
    expect(plano.actions.find((a) => a.serviceId === "s1")?.type).toBe("KEEP_SERVICE");
    expect(plano.actions.find((a) => a.serviceId === "s2")?.type).toBe("DEDUPLICATE_CANDIDATE");
    for (const acao of plano.actions) {
      expect(acao.type).not.toMatch(/DELETE|DROP|TRUNCATE/);
    }
  });

  it("duplicados com trabalho dos dois lados saem como MANUAL_REVIEW", () => {
    const s = snapshot({
      services: [
        servico({ id: "s1", scheduledDate: "2026-07-08" }),
        servico({ id: "s2", scheduledDate: "2026-07-08" }),
      ],
      dependencies: { s1: deps({ timesheets: 1 }), s2: deps({ invoiceItems: 1 }) },
    });
    const plano = planRepair(diagnose(s), s);
    expect(plano.summary.byType.DEDUPLICATE_CANDIDATE).toBe(0);
    expect(plano.summary.byType.MANUAL_REVIEW).toBeGreaterThan(0);
    expect(plano.summary.safeToMerge).toBe(0);
  });

  it("ocorrências em falta ficam para a geração idempotente", () => {
    const plano = planRepair(diagnose(snapshot()), snapshot());
    expect(plano.summary.byType.LINK_OCCURRENCE).toBe(5); // 01, 08, 15, 22, 29
  });

  it("serviços avulsos não geram ação nenhuma", () => {
    const s = snapshot({ services: [servico({ id: "s1", contractId: null })] });
    const plano = planRepair(diagnose(s), s);
    expect(plano.actions.some((a) => a.serviceId === "s1")).toBe(false);
  });

  it("contrato inexistente exige revisão humana", () => {
    const s = snapshot({ services: [servico({ id: "s1", contractId: "fantasma" })] });
    const plano = planRepair(diagnose(s), s);
    expect(plano.actions.find((a) => a.serviceId === "s1")?.type).toBe("MANUAL_REVIEW");
  });

  it("o plano é determinístico e ordenado", () => {
    const s = snapshot({
      services: [
        servico({ id: "s3", scheduledDate: "2026-07-22" }),
        servico({ id: "s1", scheduledDate: "2026-07-01" }),
        servico({ id: "s2", scheduledDate: "2026-07-08" }),
      ],
    });
    const primeiro = planRepair(diagnose(s), s);
    const segundo = planRepair(diagnose(s), s);
    expect(primeiro).toEqual(segundo);

    const chaves = primeiro.actions.map(
      (a) => `${a.contractId}|${a.occurrenceDate}|${a.type}|${a.serviceId}`,
    );
    expect([...chaves].sort()).toEqual(chaves);
  });

  it("um snapshot já reparado não produz ações sobre serviços", () => {
    const s = snapshot({
      services: ["2026-07-01", "2026-07-08", "2026-07-15", "2026-07-22", "2026-07-29"].map(
        (d, i) => servico({ id: `s${i}`, scheduledDate: d, occurrenceDate: d }),
      ),
    });
    const plano = planRepair(diagnose(s), s);
    expect(plano.summary.byType.LINK_OCCURRENCE).toBe(0);
    expect(plano.summary.byType.MARK_AMBIGUOUS).toBe(0);
    expect(plano.summary.byType.MANUAL_REVIEW).toBe(0);
  });

  it("nenhuma ação do plano escreve — só descreve", () => {
    const s = snapshot({
      services: [
        servico({ id: "s1", scheduledDate: "2026-07-08" }),
        servico({ id: "s2", scheduledDate: "2026-07-08" }),
        servico({ id: "s3", scheduledDate: "2026-07-10", isException: true }),
      ],
    });
    const congelado = JSON.stringify(s);
    planRepair(diagnose(s), s);
    expect(JSON.stringify(s)).toBe(congelado);
  });
});

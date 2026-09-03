import { describe, expect, it } from "vitest";
import { toAtomicServicePlan } from "@/domain/scheduling/atomic-contract-plan";
import type { CivilDate } from "@/domain/scheduling/civil-date";
import type { ReconciliationPlan } from "@/domain/scheduling/reconciliation";
import type { ServiceProjection } from "@/domain/scheduling/occurrence-projection";

const projection: ServiceProjection = {
  companyId: "company-1", contractId: "contract-1", locationId: "location-1",
  occurrenceDate: "2026-09-03" as CivilDate, scheduledStart: "2026-09-03T09:00:00+01:00",
  scheduledEnd: "2026-09-03T11:00:00+01:00", teamId: "team-1", numPeople: 2,
  hourlyRate: 12, calculatedValue: 48, applyVat: true, cleaningType: null,
  paymentStatus: null, upholsteryType: null, upholsteryNotes: null,
  upholsteryUnits: null, upholsteryUnitPrice: null, status: "agendado",
};

function makePlan(items: ReconciliationPlan["items"]): ReconciliationPlan {
  return {
    summary: {
      total: items.length,
      byDecision: {
        CREATE: 0, UPDATE_FROM_CONTRACT: 0, KEEP: 0, KEEP_EXCEPTION: 0,
        KEEP_CANCELLED: 0, REMOVE_ORPHAN: 0, SKIP_EXCLUDED: 0, MANUAL_REVIEW: 0,
      },
      writes: items.length,
    },
    items,
  };
}

describe("plano de contrato atómico", () => {
  it("serializa CREATE/UPDATE/REMOVE e descarta decisões sem escrita", () => {
    const result = toAtomicServicePlan(makePlan([
      { occurrenceDate: "2026-09-03" as CivilDate, decision: "CREATE", reason: "", serviceId: null, changes: [] },
      { occurrenceDate: "2026-09-04" as CivilDate, decision: "UPDATE_FROM_CONTRACT", reason: "", serviceId: "s1", changes: [] },
      { occurrenceDate: "2026-09-05" as CivilDate, decision: "REMOVE_ORPHAN", reason: "", serviceId: "s2", changes: [] },
      { occurrenceDate: "2026-09-06" as CivilDate, decision: "KEEP", reason: "", serviceId: "s3", changes: [] },
    ]), new Map([["2026-09-03" as CivilDate, projection]]));

    expect(result.map((item) => item.decision)).toEqual(["CREATE", "UPDATE_FROM_CONTRACT", "REMOVE_ORPHAN"]);
    expect(result[0].payload).toMatchObject({ location_id: "location-1", team_id: "team-1" });
    expect(result[2]).not.toHaveProperty("payload");
  });

  it("recusa plano que possa escrever sem identidade ou projeção", () => {
    expect(() => toAtomicServicePlan(makePlan([
      { occurrenceDate: "2026-09-03" as CivilDate, decision: "UPDATE_FROM_CONTRACT", reason: "", serviceId: null, changes: [] },
    ]), new Map())).toThrow("sem service_id");
  });
});

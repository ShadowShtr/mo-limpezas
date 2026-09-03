import type { CivilDate } from "./civil-date";
import type { ReconciliationPlan } from "./reconciliation";
import type { ServiceProjection } from "./occurrence-projection";

export type AtomicServicePayload = {
  location_id: string;
  team_id: string | null;
  scheduled_start: string;
  scheduled_end: string;
  hourly_rate: number | null;
  calculated_value: number | null;
  apply_vat: boolean;
  num_people: number;
  cleaning_type: string | null;
  payment_status: string | null;
  upholstery_type: string | null;
  upholstery_notes: string | null;
  upholstery_units: number | null;
  upholstery_unit_price: number | null;
};

export type AtomicServicePlanItem = {
  occurrence_date: CivilDate;
  decision: "CREATE" | "UPDATE_FROM_CONTRACT" | "REMOVE_ORPHAN";
  service_id: string | null;
  payload?: AtomicServicePayload;
};

function toPayload(projection: ServiceProjection): AtomicServicePayload {
  return {
    location_id: projection.locationId,
    team_id: projection.teamId,
    scheduled_start: projection.scheduledStart,
    scheduled_end: projection.scheduledEnd,
    hourly_rate: projection.hourlyRate,
    calculated_value: projection.calculatedValue,
    apply_vat: projection.applyVat,
    num_people: projection.numPeople,
    cleaning_type: projection.cleaningType,
    payment_status: projection.paymentStatus,
    upholstery_type: projection.upholsteryType,
    upholstery_notes: projection.upholsteryNotes,
    upholstery_units: projection.upholsteryUnits,
    upholstery_unit_price: projection.upholsteryUnitPrice,
  };
}

/**
 * Converte decisões puras em intenções de escrita. A função não fala com a
 * base: o RPC candidato é a única camada autorizada a aplicar este plano.
 */
export function toAtomicServicePlan(
  plan: ReconciliationPlan,
  expected: ReadonlyMap<CivilDate, ServiceProjection>,
): AtomicServicePlanItem[] {
  return plan.items.flatMap((item) => {
      if (item.decision !== "CREATE" && item.decision !== "UPDATE_FROM_CONTRACT" && item.decision !== "REMOVE_ORPHAN") {
        return [];
      }
      const projection = expected.get(item.occurrenceDate);
      if (item.decision === "CREATE" && !projection) {
        throw new Error(`Plano inválido: CREATE sem projeção para ${item.occurrenceDate}`);
      }
      if (item.decision !== "CREATE" && !item.serviceId) {
        throw new Error(`Plano inválido: ${item.decision} sem service_id para ${item.occurrenceDate}`);
      }
      return [{
        occurrence_date: item.occurrenceDate,
        decision: item.decision,
        service_id: item.serviceId,
        ...(projection ? { payload: toPayload(projection) } : {}),
      }];
    });
}

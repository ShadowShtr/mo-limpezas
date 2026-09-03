import { addDaysToDateString } from "@/lib/lisbon-time";

export interface AusenciaDia {
  collaborator_id: string;
  absence_type: string;
  starts_on: string;
  ends_on: string;
}

const LABELS: Record<string, string> = {
  doenca_com_baixa: "Doença com baixa",
  doenca_sem_baixa: "Doença sem baixa",
  pessoal_justificado: "Ausência pessoal justificada",
  pessoal_injustificado: "Ausência pessoal injustificada",
  ferias: "Férias",
  feriado: "Feriado",
  formacao: "Formação",
  outro: "Ausente",
};

export function absenceTypeLabel(type: string): string {
  return LABELS[type] ?? "Ausente";
}

function formatCivilDate(date: string, withYear: boolean): string {
  const [year, month, day] = date.split("-");
  return withYear ? `${day}/${month}/${year}` : `${day}/${month}`;
}

/** ends_on é o último dia ausente; regresso é o dia seguinte. */
export function absenceDisplay(absence: AusenciaDia): {
  typeLabel: string;
  departureLabel: string;
  returnLabel: string;
} {
  const returnDate = addDaysToDateString(absence.ends_on, 1);
  const crossesYear = absence.starts_on.slice(0, 4) !== returnDate.slice(0, 4);
  return {
    typeLabel: absenceTypeLabel(absence.absence_type),
    departureLabel: formatCivilDate(absence.starts_on, crossesYear),
    returnLabel: formatCivilDate(returnDate, crossesYear),
  };
}

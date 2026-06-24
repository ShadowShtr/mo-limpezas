// Tipos de limpeza, estado de pagamento e estofos — partilhado entre o wizard de
// Contratos e a criação rápida de Serviços (calendário). Mantém labels consistentes
// num único sítio para evitar duplicação/confusão de nomes.

export type CleaningType =
  | "manutencao"
  | "manutencao_lisboa"
  | "pos_obra"
  | "pos_obra_lisboa"
  | "geral"
  | "geral_lisboa"
  | "estofos";

export const CLEANING_TYPES: { value: CleaningType; label: string }[] = [
  { value: "manutencao", label: "Manutenção" },
  { value: "manutencao_lisboa", label: "Manutenção - Lisboa" },
  { value: "pos_obra", label: "Pós-Obra" },
  { value: "pos_obra_lisboa", label: "Pós-Obra - Lisboa" },
  { value: "geral", label: "Geral" },
  { value: "geral_lisboa", label: "Geral - Lisboa" },
  { value: "estofos", label: "Estofos" },
];

export const CLEANING_TYPE_LABELS: Record<string, string> = Object.fromEntries(
  CLEANING_TYPES.map((t) => [t.value, t.label]),
);

export type PaymentStatus = "nao_informado" | "sinal_50" | "pago_total";

export const PAYMENT_STATUSES: { value: PaymentStatus; label: string }[] = [
  { value: "nao_informado", label: "Não informado" },
  { value: "sinal_50", label: "Sinal 50% pago" },
  { value: "pago_total", label: "Pago na totalidade" },
];

export const PAYMENT_STATUS_LABELS: Record<string, string> = Object.fromEntries(
  PAYMENT_STATUSES.map((s) => [s.value, s.label]),
);

export type UpholsteryType =
  | "sofa"
  | "poltrona"
  | "cadeira"
  | "tapete"
  | "colchao"
  | "unidade"
  | "outro";

export const UPHOLSTERY_TYPES: { value: UpholsteryType; label: string }[] = [
  { value: "sofa", label: "Sofá" },
  { value: "poltrona", label: "Poltrona" },
  { value: "cadeira", label: "Cadeira" },
  { value: "tapete", label: "Tapete" },
  { value: "colchao", label: "Colchão" },
  { value: "unidade", label: "Unidade" },
  { value: "outro", label: "Outro" },
];

export const UPHOLSTERY_TYPE_LABELS: Record<string, string> = Object.fromEntries(
  UPHOLSTERY_TYPES.map((t) => [t.value, t.label]),
);

/** Mostra os campos de quantidade × preço unitário quando o estofado é por unidade. */
export function isUpholsteryUnit(upholsteryType: string | null | undefined): boolean {
  return upholsteryType === "unidade";
}

// Tipos que exigem controlo de pagamento (sinal 50% / total).
const PAYMENT_RELEVANT: ReadonlySet<string> = new Set<CleaningType>([
  "geral",
  "geral_lisboa",
  "pos_obra",
  "pos_obra_lisboa",
]);

/** Mostra o campo "Estado do pagamento" para Geral e Pós-Obra (com/sem Lisboa). */
export function showsPaymentStatus(cleaningType: string | null | undefined): boolean {
  return !!cleaningType && PAYMENT_RELEVANT.has(cleaningType);
}

/** Mostra os campos de estofado quando o tipo é Estofos. */
export function isUpholstery(cleaningType: string | null | undefined): boolean {
  return cleaningType === "estofos";
}

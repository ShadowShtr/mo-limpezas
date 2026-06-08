export type CancelType =
  | "client_request"
  | "weather"
  | "operational"
  | "equipment"
  | "other";

export const CANCEL_TYPE_LABELS: Record<CancelType, string> = {
  client_request: "Pedido do cliente",
  weather:        "Condições climatéricas",
  operational:    "Problema operacional",
  equipment:      "Problema de equipamento",
  other:          "Outro motivo",
};

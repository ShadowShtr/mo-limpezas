import type { ClienteRpc } from "./payment-cashflow";

export const RPC_ESTADO_FATURA = "set_invoice_status_atomic" as const;

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const ESTADOS = new Set(["rascunho", "pendente", "pago", "vencido", "cancelado"]);

export interface EntradaEstadoFatura {
  invoiceId: string;
  companyId: string;
  actorId: string;
  status: string;
  paymentMethod: string | null;
  mutationId: string;
  expectedRevision: number;
}
export type ResultadoEstadoFatura =
  | { ok: true; revision: number; cashFlowEntryId: string | null; noChange: boolean }
  | { ok: false; error: string; code: string };

export function construirArgumentosEstadoFatura(
  input: EntradaEstadoFatura,
): { ok: true; args: Record<string, unknown> } | { ok: false; error: string } {
  for (const [label, value] of [
    ["Fatura", input.invoiceId],
    ["Empresa", input.companyId],
    ["Utilizador", input.actorId],
    ["Mutação", input.mutationId],
  ] as const) {
    if (!UUID.test(value)) return { ok: false, error: `${label} inválida.` };
  }
  if (!ESTADOS.has(input.status)) return { ok: false, error: "Estado de fatura inválido." };
  if (!Number.isSafeInteger(input.expectedRevision) || input.expectedRevision < 1) {
    return { ok: false, error: "Revisão de fatura inválida." };
  }

  return {
    ok: true,
    args: {
      p_invoice_id: input.invoiceId,
      p_company_id: input.companyId,
      p_actor: input.actorId,
      p_status: input.status,
      p_payment_method: input.paymentMethod,
      p_mutation_id: input.mutationId,
      p_expected_revision: input.expectedRevision,
    },
  };
}

function erroLegivel(code: string, fallback?: string): string {
  if (code === "REVISION_CONFLICT") return "A fatura foi alterada noutro ecrã. Atualize e tente novamente.";
  if (code === "FINANCIAL_PERIOD_CLOSED") return "O período financeiro desta operação está fechado.";
  if (code === "RECONCILED_CASHFLOW") return "O recebimento está conciliado e não pode ser removido.";
  if (code === "CASHFLOW_INVOICE_MISMATCH") return "A fatura e o recebimento associado divergem. Nada foi alterado.";
  if (code === "FORBIDDEN_ACTOR") return "Sem permissão para alterar esta fatura.";
  if (code === "NOT_FOUND") return "Fatura não encontrada.";
  if (code === "INVALID_INPUT") return "Os dados da alteração são inválidos.";
  if (code === "RPC_MISSING") return "A operação atómica de faturas ainda não está disponível nesta base.";
  return fallback || "A base recusou alterar a fatura.";
}

export function interpretarRespostaEstadoFatura(response: {
  data: unknown;
  error: { message: string; code?: string } | null;
}): ResultadoEstadoFatura {
  if (response.error) {
    const missing = response.error.code === "PGRST202" || response.error.code === "42883" ||
      /could not find the function|does not exist/i.test(response.error.message);
    const code = missing ? "RPC_MISSING" : response.error.code || "DATABASE_ERROR";
    return { ok: false, code, error: erroLegivel(code, response.error.message) };
  }

  const row = Array.isArray(response.data) ? response.data[0] : response.data;
  if (!row || typeof row !== "object") {
    return { ok: false, code: "INVALID_RESPONSE", error: "A base respondeu sem identificar a alteração." };
  }
  const value = row as Record<string, unknown>;
  if (value.ok !== true) {
    const code = typeof value.code === "string" ? value.code : "DATABASE_ERROR";
    return { ok: false, code, error: erroLegivel(code) };
  }

  const invoice = value.invoice as Record<string, unknown> | undefined;
  const revision = Number(invoice?.revision);
  if (!Number.isSafeInteger(revision) || revision < 1) {
    return { ok: false, code: "INVALID_RESPONSE", error: "A base respondeu sem a revisão atual da fatura." };
  }
  const cash = value.cash_flow_entry as Record<string, unknown> | null | undefined;
  return {
    ok: true,
    revision,
    cashFlowEntryId: typeof cash?.id === "string" ? cash.id : null,
    noChange: value.no_change === true,
  };
}

export async function alterarEstadoFatura(
  client: ClienteRpc,
  input: EntradaEstadoFatura,
): Promise<ResultadoEstadoFatura> {
  const built = construirArgumentosEstadoFatura(input);
  if (!built.ok) return { ok: false, code: "INVALID_INPUT", error: built.error };
  return interpretarRespostaEstadoFatura(await client.rpc(RPC_ESTADO_FATURA, built.args));
}

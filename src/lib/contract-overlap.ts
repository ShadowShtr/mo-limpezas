import type { createAdminClient } from "@/lib/supabase/admin";

export interface ContractPeriod {
  starts_on: string;
  ends_on: string | null;
}

export interface MonthlyContractCandidate extends ContractPeriod {
  id: string;
}

/**
 * Duas janelas [starts_on, ends_on] sobrepõem-se? `ends_on` nulo é tratado
 * como aberto no futuro (sem fim). Regra: a.starts_on <= b.ends_on(ou infinito)
 * E b.starts_on <= a.ends_on(ou infinito).
 */
export function periodsOverlap(a: ContractPeriod, b: ContractPeriod): boolean {
  const aEnd = a.ends_on ?? "9999-12-31";
  const bEnd = b.ends_on ?? "9999-12-31";
  return a.starts_on <= bEnd && b.starts_on <= aEnd;
}

/**
 * De uma lista de contratos candidatos (mesma empresa/local, avença mensal
 * ativa), devolve os que se sobrepõem ao novo período. `excludeContractId`
 * serve para uma edição não se acusar de sobrepor a si própria.
 */
export function findOverlappingMonthlyContracts(
  candidates: MonthlyContractCandidate[],
  newPeriod: ContractPeriod,
  excludeContractId?: string,
): MonthlyContractCandidate[] {
  return candidates.filter(
    (c) => c.id !== excludeContractId && periodsOverlap(c, newPeriod),
  );
}

type AdminClient = ReturnType<typeof createAdminClient>;

/**
 * Verifica em produção se já existe outro contrato de avença mensal ATIVO
 * para o mesmo local com período sobreposto ao indicado. Usar antes de
 * criar/ativar um contrato `fixed_monthly` para não deixar entrar uma
 * segunda avença sobreposta (que duplicaria a linha na fatura — ver
 * generateInvoices em src/app/actions/invoices.ts).
 */
export async function hasOverlappingMonthlyContract(
  admin: AdminClient,
  params: {
    companyId: string;
    locationId: string;
    startsOn: string;
    endsOn: string | null;
    excludeContractId?: string;
  },
): Promise<{ overlapping: boolean; conflictingIds: string[] }> {
  const { data } = await admin
    .from("contracts")
    .select("id, starts_on, ends_on")
    .eq("company_id", params.companyId)
    .eq("location_id", params.locationId)
    .eq("status", "ativo")
    .eq("fixed_monthly", true);

  const candidates = (data ?? []) as MonthlyContractCandidate[];
  const overlapping = findOverlappingMonthlyContracts(
    candidates,
    { starts_on: params.startsOn, ends_on: params.endsOn },
    params.excludeContractId,
  );

  return { overlapping: overlapping.length > 0, conflictingIds: overlapping.map((c) => c.id) };
}

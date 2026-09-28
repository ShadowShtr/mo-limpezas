// ============================================================================
// Cobrança diária — o read model da união serviço / cobrança avulsa
// ============================================================================
//
// Puro: sem Supabase, sem React, sem relógio. Recebe linhas já lidas e decide
// quanto cada uma vale, quanto já entrou e se ainda conta como pendente.
//
// ---------------------------------------------------------------------------
// Duas origens, uma união discriminada
// ---------------------------------------------------------------------------
//
//   service        um serviço agendado — tem local, hora, referência, avença
//   manual_charge  uma nota de cobrança avulsa — tem cliente, data civil e
//                  descrição, e NÃO tem local, serviço nem hora
//
// 🔴 A cobrança avulsa não finge ser um serviço. Não recebe um local inventado
//    («Nota de cobrança» no lugar do nome do local), nem uma hora inventada:
//    os campos que só existem num serviço só existem no ramo `service`. Quem
//    precisar de um deles tem de perguntar primeiro de que tipo é a linha — e
//    é isso que impede um ecrã de mostrar um local que não existe.
//
// ---------------------------------------------------------------------------
// UMA regra de valor para os dois tipos
// ---------------------------------------------------------------------------
//
// Total com IVA, recebido e em falta calculam-se da MESMA maneira para as duas
// origens — é a mesma fórmula que as RPCs 091/097 aplicam do lado da base
// (valor livre registado > estado 50/100 sobre o total com IVA). O que difere
// é só a origem do valor base, e essa decisão fica no leitor da origem.
// ============================================================================

import { lisbonDateOf } from "@/lib/lisbon-time";

export type BillingPaymentStatus = "nao_informado" | "sinal_50" | "pago_total";

interface BillingRowBase {
  id: string;
  client_id: string | null;
  client_name: string;
  /** Valor base, sem IVA. */
  value: number;
  apply_vat: boolean;
  payment_status: BillingPaymentStatus;
  paid_amount: number | null;
  paid_at: string | null;
  notes: string | null;
}

export interface ServiceBillingRow extends BillingRowBase {
  type: "service";
  reference_number: string | null;
  scheduled_start: string;
  status: string;
  location_name: string;
  /** Valor mostrado é a fatia mensal da avença ÷ serviços do mês. */
  is_avenca: boolean;
}

export interface ManualChargeBillingRow extends BillingRowBase {
  type: "manual_charge";
  /** Data civil `YYYY-MM-DD` da obrigação — sem hora. */
  charge_date: string;
  description: string;
}

export type DailyBillingRow = ServiceBillingRow | ManualChargeBillingRow;

/** Chave única entre as duas origens: os ids vêm de tabelas diferentes. */
export function billingRowKey(row: DailyBillingRow): string {
  return `${row.type}:${row.id}`;
}

/** A data civil da linha — o eixo por que se decide dia e pendentes. */
export function billingRowCivilDate(row: DailyBillingRow): string {
  return row.type === "manual_charge" ? row.charge_date : lisbonDateOf(row.scheduled_start);
}

const cent = (n: number): number => Math.round(n * 100) / 100;

/** Total da linha, com IVA quando aplicável. */
export function billingTotal(row: DailyBillingRow, vatRate: number): number {
  return cent(row.value * (row.apply_vat ? 1 + vatRate / 100 : 1));
}

/**
 * Quanto já entrou desta linha, em €.
 *
 * Valor livre registado > estado 50/100 sobre o total com IVA. Limitado ao
 * total: um recebimento maior do que a linha não faz a linha valer mais.
 */
export function billingReceived(row: DailyBillingRow, vatRate: number): number {
  const total = billingTotal(row, vatRate);
  let recebido = 0;
  if (row.paid_amount != null) recebido = row.paid_amount;
  else if (row.payment_status === "pago_total") recebido = total;
  else if (row.payment_status === "sinal_50") recebido = total / 2;
  return cent(Math.max(0, Math.min(recebido, total)));
}

export function billingOutstanding(row: DailyBillingRow, vatRate: number): number {
  return cent(Math.max(0, billingTotal(row, vatRate) - billingReceived(row, vatRate)));
}

/**
 * A linha ainda conta como «por cobrar»?
 *
 * Uma linha paga a 100% sai; uma linha sem valor a cobrar também (um serviço
 * a 0 € não é dívida de ninguém). A avença não entra nos pendentes: a fatia
 * mostrada é uma distribuição da mensalidade, e cobrá-la dia a dia duplicaria
 * a cobrança da própria avença.
 */
export function isPendingReceivable(row: DailyBillingRow, vatRate: number): boolean {
  if (row.type === "service" && row.is_avenca) return false;
  if (row.value <= 0) return false;
  return billingOutstanding(row, vatRate) > 0;
}

export interface DailyBillingKpis {
  total: number;
  received: number;
  outstanding: number;
  pendingTotal: number;
  counts: { day: number; services: number; manualCharges: number; pending: number };
}

/**
 * Os KPIs do ecrã, calculados uma vez sobre a união.
 *
 * 🔴 Sem contagem dupla, por construção: cada linha entra UMA vez, pela sua
 *    chave `tipo:id`. Uma linha que viesse repetida nas duas listas (dia e
 *    pendentes) só contaria uma vez em cada bloco, e as duas listas são
 *    disjuntas por data — o dia é `= data`, os pendentes são `< data`.
 */
export function dailyBillingKpis(
  day: readonly DailyBillingRow[],
  pending: readonly DailyBillingRow[],
  vatRate: number,
): DailyBillingKpis {
  const dia = unicas(day);
  const pend = unicas(pending).filter((r) => isPendingReceivable(r, vatRate));
  const total = cent(dia.reduce((s, r) => s + billingTotal(r, vatRate), 0));
  const received = cent(dia.reduce((s, r) => s + billingReceived(r, vatRate), 0));
  return {
    total,
    received,
    outstanding: cent(Math.max(0, total - received)),
    pendingTotal: cent(pend.reduce((s, r) => s + billingOutstanding(r, vatRate), 0)),
    counts: {
      day: dia.length,
      services: dia.filter((r) => r.type === "service").length,
      manualCharges: dia.filter((r) => r.type === "manual_charge").length,
      pending: pend.length,
    },
  };
}

function unicas(rows: readonly DailyBillingRow[]): DailyBillingRow[] {
  const vistas = new Set<string>();
  const out: DailyBillingRow[] = [];
  for (const r of rows) {
    const k = billingRowKey(r);
    if (vistas.has(k)) continue;
    vistas.add(k);
    out.push(r);
  }
  return out;
}

/**
 * O estado coerente com um valor livre recebido: ≥ total → pago_total; > 0 →
 * sinal_50; 0 → por pagar. As RPCs recusam estado e valor incoerentes, por
 * isso a interface tem de os mandar coerentes.
 */
export function statusForCustomAmount(amount: number, total: number): BillingPaymentStatus {
  if (amount >= total - 0.005) return "pago_total";
  if (amount > 0) return "sinal_50";
  return "nao_informado";
}

/** Tem dinheiro registado? As mesmas testemunhas locais que as RPCs olham. */
export function hasRegisteredPayment(row: DailyBillingRow): boolean {
  return row.payment_status !== "nao_informado" || (row.paid_amount ?? 0) > 0;
}

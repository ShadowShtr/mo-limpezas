// ============================================================================
// T14 — Formas de entrada do relatório
// ============================================================================
//
// 🚨 INTEGRIDADE DE DADOS FINANCEIROS
// Módulo puro. Declara TIPOS e normalizações sobre linhas JÁ CARREGADAS.
// Não lê a base, não escreve, não conhece Supabase. Nada aqui altera dados.
//
// ----------------------------------------------------------------------------
//
// Porquê tipos próprios em vez de reutilizar `src/types/database.ts`.
//
// Três razões, todas medidas:
//
// 1. **Só o que é preciso entra.** O relatório não precisa de morada, telefone,
//    código de acesso ou notas do serviço. Um tipo que só declara os campos
//    técnicos impede que dados sensíveis cheguem a um DTO que pode acabar num
//    CSV exportado. É a mesma disciplina do `pickContract` da T08.
//
// 2. **A data de negócio é explícita.** As linhas reais têm `scheduled_start`
//    (timestamptz), `created_at`, `paid_at`, `date`, `period_start`… e o código
//    actual escolhe umas e outras sem critério visível. Aqui cada entrada
//    declara UMA data civil de negócio, já resolvida no fuso de Lisboa por quem
//    carregou. O domínio nunca vê um timestamp e por isso nunca pode enganar-se
//    no fuso.
//
// 3. **Dinheiro entra em cêntimos.** A conversão de `numeric(10,2)` para
//    cêntimos acontece uma vez, na fronteira, com `eurosToCents` da T11.
//    Dentro do domínio não há vírgula flutuante.

import { type CivilDate } from "../scheduling/civil-date";
import { type MoneyCents } from "../billing/money";

// ─── Serviços ───────────────────────────────────────────────────────────────

/**
 * Estados reais de `services.status`, tal como o CHECK da migration 006 os
 * define. **Não inventar estados**: `sem_cobertura` existe no schema e nenhum
 * dos relatórios actuais o trata (cai no balde "agendado" em `reports.ts` e no
 * "expected" do dashboard).
 */
export const SERVICE_STATUSES = [
  "agendado",
  "em_curso",
  "concluido",
  "cancelado",
  "falta",
  "sem_cobertura",
] as const;

export type ServiceStatus = (typeof SERVICE_STATUSES)[number];

export function isServiceStatus(value: unknown): value is ServiceStatus {
  return typeof value === "string" && (SERVICE_STATUSES as readonly string[]).includes(value);
}

export interface ServiceInput {
  id: string;
  /**
   * Dia civil do serviço em Lisboa. Quem carrega converte `scheduled_start`
   * uma vez; o domínio nunca vê o timestamp.
   */
  occurrenceDate: CivilDate;
  /** Valor lido de `status`. `string` e não `ServiceStatus` de propósito: um
   *  estado desconhecido na base tem de ser detectável, não rejeitado à entrada. */
  status: string;
  /** `services.contract_id`. `null` para serviços avulsos. */
  contractId: string | null;
  /**
   * Valor do serviço em cêntimos, já resolvido (`manual_value ?? calculated_value`).
   * `null` = sem base para calcular. **Não é zero.**
   *
   * Para ocorrências de avença este valor é 0 por desenho (o contrato fatura à
   * parte) — a fatia mensal vem da alocação, não daqui.
   */
  valueCents: MoneyCents | null;
  /** `services.apply_vat`. */
  applyVat: boolean;
  /** Minutos efectivamente trabalhados, de `actual_start`/`actual_end`. */
  workedMinutes: number | null;
  /** Minutos planeados, de `scheduled_start`/`scheduled_end`. */
  scheduledMinutes: number | null;
}

// ─── Contratos ──────────────────────────────────────────────────────────────

export interface ContractInput {
  id: string;
  /** `contracts.fixed_monthly`. */
  fixedMonthly: boolean;
  /** `contracts.fixed_price` em cêntimos. `null` = sem valor definido. */
  fixedPriceCents: MoneyCents | null;
  /** `contracts.apply_vat`. */
  applyVat: boolean;
  /** Vigência do contrato. `endsOn` a `null` = sem fim previsto. */
  startsOn: CivilDate | null;
  endsOn: CivilDate | null;
  /** `contracts.status`. Só `ativo` conta como contratado. */
  status: string;
}

// ─── Faturas ────────────────────────────────────────────────────────────────

export interface InvoiceInput {
  id: string;
  /** Data de negócio: início do período faturado (`invoices.period_start`). */
  periodStart: CivilDate;
  /** `invoices.due_date`. `null` = sem vencimento definido. */
  dueDate: CivilDate | null;
  /** `invoices.subtotal` em cêntimos. */
  netCents: MoneyCents;
  /** `invoices.vat_amount` em cêntimos. */
  vatCents: MoneyCents;
  /** `invoices.total` em cêntimos. */
  grossCents: MoneyCents;
  /** `invoices.vat_rate`, em pontos percentuais. Só para rotular. */
  vatRatePct: number;
  /** `rascunho` | `pendente` | `pago` | `vencido` | `cancelado`. */
  status: string;
  /** Nº de `invoice_items` associados. `null` = itens não carregados. */
  itemCount: number | null;
}

export const INVOICE_STATUSES = [
  "rascunho",
  "pendente",
  "pago",
  "vencido",
  "cancelado",
] as const;

export type InvoiceStatus = (typeof INVOICE_STATUSES)[number];

export function isInvoiceStatus(value: unknown): value is InvoiceStatus {
  return typeof value === "string" && (INVOICE_STATUSES as readonly string[]).includes(value);
}

// ─── Caixa ──────────────────────────────────────────────────────────────────

export interface CashFlowInput {
  id: string;
  /** `cash_flow_entries.date`. Já é uma coluna `date` — sem fuso envolvido. */
  date: CivilDate;
  /** `entrada` | `saida`. */
  type: string;
  /** Valor absoluto em cêntimos, tal como está na coluna. */
  amountCents: MoneyCents;
  /** `faturacao` | `salario` | `despesa` | `fornecedor` | `outro`. */
  category: string;
  /** `pendente` | `confirmado`. Só o confirmado é dinheiro reconhecido. */
  status: string;
}

// ─── Folha ──────────────────────────────────────────────────────────────────

export interface PayrollInput {
  id: string;
  periodYear: number;
  periodMonth: number;
  /** `payroll_records.net_salary` em cêntimos. */
  netSalaryCents: MoneyCents;
  /** `rascunho` | `aprovado` | `pago`. */
  status: string;
}

// ─── Horas e ausências ──────────────────────────────────────────────────────

export interface TimesheetInput {
  id: string;
  collaboratorId: string;
  /** Dia civil do clock-in em Lisboa. */
  date: CivilDate;
  /** `timesheets.duration_minutes`. `null` = ponto ainda aberto. */
  durationMinutes: number | null;
  serviceId: string | null;
}

export interface AbsenceInput {
  id: string;
  collaboratorId: string;
  /** `absences.absence_type`. */
  type: string;
  startsOn: CivilDate;
  endsOn: CivilDate;
}

export const ABSENCE_TYPES = [
  "doenca_com_baixa",
  "doenca_sem_baixa",
  "pessoal_justificado",
  "pessoal_injustificado",
  "ferias",
  "feriado",
  "formacao",
  "outro",
] as const;

export type AbsenceType = (typeof ABSENCE_TYPES)[number];

export function isAbsenceType(value: unknown): value is AbsenceType {
  return typeof value === "string" && (ABSENCE_TYPES as readonly string[]).includes(value);
}

// ─── Configuração fiscal ────────────────────────────────────────────────────

/**
 * A taxa vem sempre de `company_settings.vat_rate`. `null` quando a leitura
 * falhou — e nesse caso **não se assume 23%**. O código actual faz
 * `settingsRow?.vat_rate ?? 23` em cinco sítios: se a consulta falhar, o
 * relatório apresenta IVA português a 23% como se fosse configuração da
 * empresa. Aqui isso torna-se `VAT_RATE_UNAVAILABLE`.
 */
export interface VatSettingsInput {
  ratePct: number | null;
}

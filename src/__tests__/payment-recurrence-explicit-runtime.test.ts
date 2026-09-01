import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const payments = readFileSync(join(process.cwd(), "src/app/actions/payments.ts"), "utf8");
const page = readFileSync(join(process.cwd(), "src/app/(dashboard)/dashboard/financeiro/pagamentos/page.tsx"), "utf8");
const recurrence = readFileSync(join(process.cwd(), "src/app/actions/payment-recurrence.ts"), "utf8");

describe("recorrência explícita", () => {
  it("getPayments e reminder continuam sem writer de preparação", () => {
    expect(payments).not.toContain("prepareRecurringPaymentsMonth");
    expect(payments).not.toContain("prepare_recurring_payments_month_atomic");
    expect(payments).not.toContain("ensureMonth(");
  });

  it("a UI expõe Preparar mês como ato explícito", () => {
    expect(page).toContain("PrepareRecurringMonth");
    expect(page).toContain("Preparar mês");
  });

  it("preview só lê e a confirmação é a única chamada à RPC de geração", () => {
    const previewStart = recurrence.indexOf("export async function previewRecurringPaymentsMonth");
    const configStart = recurrence.indexOf("export async function configurePaymentRecurrence");
    const previewBody = recurrence.slice(previewStart, configStart);
    expect(previewBody).not.toContain(".insert(");
    expect(previewBody).not.toContain(".update(");
    expect(previewBody).not.toContain(".delete(");
    expect(previewBody).not.toContain("prepare_recurring_payments_month_atomic");

    const prepareStart = recurrence.indexOf("export async function prepareRecurringPaymentsMonth");
    expect(recurrence.slice(prepareStart)).toContain('admin.rpc("prepare_recurring_payments_month_atomic"');
  });

  it("legado UNKNOWN não é inferido por descrição, source_id, valor ou histórico", () => {
    const previewStart = recurrence.indexOf("export async function previewRecurringPaymentsMonth");
    const configStart = recurrence.indexOf("export async function configurePaymentRecurrence");
    const previewBody = recurrence.slice(previewStart, configStart);
    expect(previewBody).toContain('row.recurrence_state === "LEGACY_RECURRENCE_UNKNOWN"');
    expect(previewBody).not.toMatch(/description.*interval/i);
    expect(previewBody).not.toMatch(/amount.*interval/i);
  });
});

"use client";

import { AlertCircle, ArrowUpRight, ArrowDownRight } from "lucide-react";
import Link from "next/link";

function fmtEur(v: number) {
  return v.toLocaleString("pt-PT", { minimumFractionDigits: 2, maximumFractionDigits: 2 }) + " €";
}
function fmtDate(s: string | null) {
  return s ? new Date(s).toLocaleDateString("pt-PT") : "—";
}

interface ToReceive {
  id: string;
  invoice_number: string;
  client_name: string;
  total: number;
  due_date: string | null;
  status: string;
}
interface ToPay {
  id: string;
  collaborator_name: string;
  net_salary: number;
  period: string;
  status: string;
}

interface Props {
  toReceive: ToReceive[];
  toPay: ToPay[];
  error: string | null;
}

export function ContasClient({ toReceive, toPay, error }: Props) {
  const totalReceive = toReceive.reduce((s, r) => s + r.total, 0);
  const totalPay     = toPay.reduce((s, r) => s + r.net_salary, 0);

  return (
    <div className="space-y-6">
      {error && (
        <div className="flex items-center gap-3 p-4 bg-red-50 border border-red-200 rounded-xl text-sm text-red-700">
          <AlertCircle className="w-4 h-4 shrink-0" />
          {error}
        </div>
      )}

      {/* KPI banner */}
      <div className="grid grid-cols-2 gap-4">
        <div className="bg-white rounded-xl border border-green-200 p-5">
          <div className="flex items-center gap-2 mb-2">
            <ArrowUpRight className="w-5 h-5 text-green-600" />
            <p className="text-sm font-semibold text-[var(--color-text-main)]">A Receber</p>
          </div>
          <p className="text-2xl font-bold text-green-600">{fmtEur(totalReceive)}</p>
          <p className="text-xs text-[var(--color-text-muted)] mt-1">{toReceive.length} fatura{toReceive.length !== 1 ? "s" : ""} pendente{toReceive.length !== 1 ? "s" : ""}</p>
        </div>
        <div className="bg-white rounded-xl border border-red-200 p-5">
          <div className="flex items-center gap-2 mb-2">
            <ArrowDownRight className="w-5 h-5 text-red-600" />
            <p className="text-sm font-semibold text-[var(--color-text-main)]">A Pagar (Salários)</p>
          </div>
          <p className="text-2xl font-bold text-red-600">{fmtEur(totalPay)}</p>
          <p className="text-xs text-[var(--color-text-muted)] mt-1">{toPay.length} registo{toPay.length !== 1 ? "s" : ""} aprovado{toPay.length !== 1 ? "s" : ""}</p>
        </div>
      </div>

      {/* A Receber */}
      <div className="bg-white rounded-xl border border-[var(--color-border)]">
        <div className="flex items-center justify-between px-5 py-4 border-b border-[var(--color-border)]">
          <div className="flex items-center gap-2">
            <ArrowUpRight className="w-4 h-4 text-green-600" />
            <h3 className="text-sm font-semibold text-[var(--color-text-main)]">Faturas Pendentes (a receber)</h3>
          </div>
          <Link href="/dashboard/cobrancas" className="text-xs text-[var(--color-primary)] hover:underline">Ver cobranças →</Link>
        </div>
        {toReceive.length === 0 ? (
          <div className="py-10 text-center">
            <p className="text-sm text-[var(--color-text-muted)]">Sem faturas pendentes. Tudo cobrado!</p>
          </div>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full">
              <thead>
                <tr className="bg-[var(--color-background)] border-b border-[var(--color-border)]">
                  <th className="text-left px-4 py-3 text-xs font-medium text-[var(--color-text-muted)] uppercase tracking-wide">Nº</th>
                  <th className="text-left px-4 py-3 text-xs font-medium text-[var(--color-text-muted)] uppercase tracking-wide">Cliente</th>
                  <th className="text-left px-4 py-3 text-xs font-medium text-[var(--color-text-muted)] uppercase tracking-wide">Vencimento</th>
                  <th className="text-right px-4 py-3 text-xs font-medium text-[var(--color-text-muted)] uppercase tracking-wide">Total</th>
                  <th className="text-left px-4 py-3 text-xs font-medium text-[var(--color-text-muted)] uppercase tracking-wide">Estado</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-[var(--color-border)]">
                {toReceive.map((r) => (
                  <tr key={r.id} className="hover:bg-[var(--color-background)] transition-colors">
                    <td className="px-4 py-3 text-sm font-medium text-[var(--color-text-main)]">{r.invoice_number}</td>
                    <td className="px-4 py-3 text-sm text-[var(--color-text-main)]">{r.client_name}</td>
                    <td className={`px-4 py-3 text-sm ${r.status === "vencido" ? "text-red-600 font-medium" : "text-[var(--color-text-sub)]"}`}>{fmtDate(r.due_date)}</td>
                    <td className="px-4 py-3 text-sm font-semibold text-right text-green-600">{fmtEur(r.total)}</td>
                    <td className="px-4 py-3">
                      <span className={`text-xs px-2 py-0.5 rounded-full font-medium ${r.status === "vencido" ? "bg-red-100 text-red-700" : "bg-amber-100 text-amber-700"}`}>
                        {r.status === "vencido" ? "Vencido" : "Pendente"}
                      </span>
                    </td>
                  </tr>
                ))}
              </tbody>
              <tfoot className="border-t-2 border-[var(--color-border)]">
                <tr>
                  <td colSpan={3} className="px-4 py-3 text-sm font-semibold text-[var(--color-text-main)]">Total a receber</td>
                  <td className="px-4 py-3 text-sm font-bold text-right text-green-600">{fmtEur(totalReceive)}</td>
                  <td />
                </tr>
              </tfoot>
            </table>
          </div>
        )}
      </div>

      {/* A Pagar */}
      <div className="bg-white rounded-xl border border-[var(--color-border)]">
        <div className="flex items-center justify-between px-5 py-4 border-b border-[var(--color-border)]">
          <div className="flex items-center gap-2">
            <ArrowDownRight className="w-4 h-4 text-red-600" />
            <h3 className="text-sm font-semibold text-[var(--color-text-main)]">Salários Aprovados (a pagar)</h3>
          </div>
          <Link href="/dashboard/folha-pagamento" className="text-xs text-[var(--color-primary)] hover:underline">Ver folha →</Link>
        </div>
        {toPay.length === 0 ? (
          <div className="py-10 text-center">
            <p className="text-sm text-[var(--color-text-muted)]">Sem salários pendentes de pagamento.</p>
          </div>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full">
              <thead>
                <tr className="bg-[var(--color-background)] border-b border-[var(--color-border)]">
                  <th className="text-left px-4 py-3 text-xs font-medium text-[var(--color-text-muted)] uppercase tracking-wide">Colaborador</th>
                  <th className="text-left px-4 py-3 text-xs font-medium text-[var(--color-text-muted)] uppercase tracking-wide">Período</th>
                  <th className="text-right px-4 py-3 text-xs font-medium text-[var(--color-text-muted)] uppercase tracking-wide">Líquido</th>
                  <th className="text-left px-4 py-3 text-xs font-medium text-[var(--color-text-muted)] uppercase tracking-wide">Estado</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-[var(--color-border)]">
                {toPay.map((r) => (
                  <tr key={r.id} className="hover:bg-[var(--color-background)] transition-colors">
                    <td className="px-4 py-3 text-sm text-[var(--color-text-main)]">{r.collaborator_name}</td>
                    <td className="px-4 py-3 text-sm text-[var(--color-text-sub)]">{r.period}</td>
                    <td className="px-4 py-3 text-sm font-semibold text-right text-red-600">{fmtEur(r.net_salary)}</td>
                    <td className="px-4 py-3">
                      <span className="text-xs px-2 py-0.5 rounded-full bg-blue-100 text-blue-700 font-medium">Aprovado</span>
                    </td>
                  </tr>
                ))}
              </tbody>
              <tfoot className="border-t-2 border-[var(--color-border)]">
                <tr>
                  <td colSpan={2} className="px-4 py-3 text-sm font-semibold text-[var(--color-text-main)]">Total a pagar</td>
                  <td className="px-4 py-3 text-sm font-bold text-right text-red-600">{fmtEur(totalPay)}</td>
                  <td />
                </tr>
              </tfoot>
            </table>
          </div>
        )}
      </div>
    </div>
  );
}

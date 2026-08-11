"use client";

import { useState, useTransition } from "react";
import {
  FileText, RefreshCw, CheckCircle, Banknote,
  Download, Pencil, Loader2, AlertCircle, ChevronDown, ChevronUp,
} from "lucide-react";
import {
  calculateAndSavePayroll,
  approvePayrollRecords,
  markPayrollPaid,
  type PayrollRecord,
} from "@/app/actions/payroll";
import { PayrollEditSheet } from "./payroll-edit-sheet";
import { Kpi } from "@/components/financeiro/v2/primitives";
import { usePagination, Pagination } from "@/components/ui/pagination";

// ─── Helpers ──────────────────────────────────────────────────────────────────

function fmtEur(v: number) {
  return v.toLocaleString("pt-PT", { minimumFractionDigits: 2, maximumFractionDigits: 2 }) + " €";
}
function fmtH(h: number) {
  return `${h.toFixed(1)}h`;
}

const STATUS_LABEL: Record<PayrollRecord["status"], string> = {
  rascunho: "Rascunho",
  aprovado: "Aprovado",
  pago:     "Pago",
};
const STATUS_COLOR: Record<PayrollRecord["status"], string> = {
  rascunho: "bg-gray-100 text-gray-600",
  aprovado: "bg-blue-100 text-blue-700",
  pago:     "bg-green-100 text-green-700",
};

// ─── Props ────────────────────────────────────────────────────────────────────

interface Props {
  initialRecords: PayrollRecord[];
  companyId: string;
  mesParam: string;
  year: number;
  month: number;
  mesLabel: string;
  /**
   * A folha do período está por calcular (ou incompleta) — há colaboradores
   * activos sem registo.
   *
   * Existe porque o cálculo deixou de acontecer sozinho durante o render da
   * página (ver o comentário em `folha-pagamento/page.tsx`). Em vez de gravar
   * em silêncio, a página diz que falta calcular e oferece a acção.
   */
  needsCalculation: boolean;
  /** Quantos colaboradores activos deviam ter registo neste período. */
  expectedRecords: number;
}

// ─── Componente ───────────────────────────────────────────────────────────────

export function PayrollClient({ initialRecords, companyId, mesParam, year, month, mesLabel, needsCalculation, expectedRecords }: Props) {
  const [records, setRecords] = useState<PayrollRecord[]>(initialRecords);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [editing, setEditing]   = useState<PayrollRecord | null>(null);
  const [expandedId, setExpandedId] = useState<string | null>(null);
  const [error, setError]       = useState<string | null>(null);
  const [isPending, startTransition] = useTransition();

  // Totais
  const totalBruto = records.reduce((s, r) => s + r.gross_salary, 0);
  const totalSub   = records.reduce((s, r) => s + r.meal_allowance, 0);
  const totalExtra = records.reduce((s, r) => s + r.overtime_bonus, 0);
  const totalDesc  = records.reduce((s, r) => s + r.absence_deductions + r.other_deductions, 0);
  const totalLiq   = records.reduce((s, r) => s + r.net_salary, 0);

  const pag = usePagination(records, 30);

  function toggleSelect(id: string) {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }
  function toggleAll() {
    if (selected.size === records.length) {
      setSelected(new Set());
    } else {
      setSelected(new Set(records.map((r) => r.id)));
    }
  }

  function handleRecalculate() {
    setError(null);
    startTransition(async () => {
      const res = await calculateAndSavePayroll(companyId, year, month);
      if (res.ok) {
        setRecords(res.records);
        setSelected(new Set());
      } else {
        setError(res.error);
      }
    });
  }

  function handleApprove() {
    if (!selected.size) return;
    setError(null);
    startTransition(async () => {
      const res = await approvePayrollRecords([...selected]);
      if (res.ok) {
        setRecords((prev) =>
          prev.map((r) => selected.has(r.id) ? { ...r, status: "aprovado" } : r),
        );
        setSelected(new Set());
      } else {
        setError(res.error ?? "Erro ao aprovar.");
      }
    });
  }

  function handlePay() {
    if (!selected.size) return;
    setError(null);
    startTransition(async () => {
      const res = await markPayrollPaid([...selected]);
      if (res.ok) {
        setRecords((prev) =>
          prev.map((r) =>
            selected.has(r.id)
              ? { ...r, status: "pago", paid_at: new Date().toISOString() }
              : r,
          ),
        );
        setSelected(new Set());
      } else {
        setError(res.error ?? "Erro ao marcar como pago.");
      }
    });
  }

  async function handleExportPdf() {
    const { default: jsPDF } = await import("jspdf");
    const { default: autoTable } = await import("jspdf-autotable");

    const doc = new jsPDF({ unit: "mm", format: "a4" });
    const pageW = 210;
    const margin = 14;

    // Cabeçalho
    doc.setFillColor(22, 163, 74);
    doc.rect(0, 0, pageW, 26, "F");
    doc.setTextColor(255, 255, 255);
    doc.setFontSize(14);
    doc.setFont("helvetica", "bold");
    doc.text("Folha de Pagamento", margin, 11);
    doc.setFontSize(10);
    doc.setFont("helvetica", "normal");
    doc.text(mesLabel.charAt(0).toUpperCase() + mesLabel.slice(1), margin, 19);
    doc.setTextColor(0, 0, 0);

    autoTable(doc, {
      startY: 32,
      margin: { left: margin, right: margin },
      head: [["Colaborador", "Horas", "Bruto", "Sub. Alim.", "Extra", "Desc.", "Líquido", "Estado"]],
      body: records.map((r) => [
        r.full_name,
        fmtH(r.worked_hours),
        fmtEur(r.gross_salary),
        fmtEur(r.meal_allowance),
        fmtEur(r.overtime_bonus),
        fmtEur(r.absence_deductions + r.other_deductions),
        fmtEur(r.net_salary),
        STATUS_LABEL[r.status],
      ]),
      foot: [["TOTAL", "", fmtEur(totalBruto), fmtEur(totalSub), fmtEur(totalExtra), fmtEur(totalDesc), fmtEur(totalLiq), ""]],
      headStyles:  { fillColor: [22, 163, 74], textColor: 255, fontStyle: "bold", fontSize: 8 },
      footStyles:  { fillColor: [240, 253, 244], textColor: [15, 23, 42], fontStyle: "bold", fontSize: 8 },
      bodyStyles:  { fontSize: 8 },
      alternateRowStyles: { fillColor: [248, 250, 252] },
    });

    doc.save(`folha-pagamento-${mesParam}.pdf`);
  }

  function handleSaved(updated: PayrollRecord) {
    setRecords((prev) => prev.map((r) => r.id === updated.id ? updated : r));
    setEditing(null);
  }

  const hasSelected = selected.size > 0;
  const allAprovavel = hasSelected && [...selected].every((id) => {
    const r = records.find((x) => x.id === id);
    return r?.status === "rascunho";
  });
  const allPagavel = hasSelected && [...selected].every((id) => {
    const r = records.find((x) => x.id === id);
    return r?.status === "aprovado";
  });

  return (
    <>
      <div className="space-y-5">
        {/* Financeiro V2 (PR A): a folha está por calcular.
            Antes, esta situação era resolvida pelo render da página, que
            gravava sozinho. Agora é dita ao utilizador, e a gravação só
            acontece se ele a pedir. */}
        {needsCalculation && (
          <div
            role="status"
            className="bg-amber-50 border border-amber-200 rounded-xl px-4 py-3 flex flex-wrap items-center justify-between gap-3"
          >
            <div className="min-w-0">
              <p className="text-sm font-semibold text-amber-900">
                {records.length === 0
                  ? `Nenhuma folha calculada para ${mesLabel}.`
                  : `Folha incompleta em ${mesLabel}: ${records.length} de ${expectedRecords} colaboradores.`}
              </p>
              <p className="text-xs text-amber-800 mt-0.5">
                Abrir esta página não calcula nada. Usa &quot;Recalcular folha&quot; quando quiseres gerar.
              </p>
            </div>
            <button
              onClick={handleRecalculate}
              disabled={isPending}
              className="shrink-0 flex items-center gap-2 px-4 py-2 rounded-lg bg-amber-600 text-white text-sm font-semibold hover:bg-amber-700 transition-colors disabled:opacity-50"
            >
              {isPending ? <Loader2 className="w-4 h-4 animate-spin" /> : <RefreshCw className="w-4 h-4" />}
              Recalcular folha
            </button>
          </div>
        )}

        {/* Toolbar: ações do período (o mês é do módulo, na URL) */}
        <div className="bg-white rounded-xl border border-[var(--color-border)] px-4 py-3 flex flex-wrap items-center gap-3">
          <button
            onClick={handleRecalculate}
            disabled={isPending}
            className="flex items-center gap-2 px-4 py-2 rounded-lg border border-[var(--color-border)] text-sm text-[var(--color-text-sub)] hover:bg-[var(--color-background)] transition-colors disabled:opacity-50"
          >
            {isPending ? <Loader2 className="w-4 h-4 animate-spin" /> : <RefreshCw className="w-4 h-4" />}
            Recalcular folha
          </button>

          <div className="flex-1" />

          {allAprovavel && (
            <button
              onClick={handleApprove}
              disabled={isPending}
              className="flex items-center gap-2 px-4 py-2 rounded-lg bg-blue-600 text-white text-sm font-semibold hover:bg-blue-700 transition-colors disabled:opacity-50"
            >
              <CheckCircle className="w-4 h-4" />
              Aprovar {selected.size > 1 ? `(${selected.size})` : ""}
            </button>
          )}

          {allPagavel && (
            <button
              onClick={handlePay}
              disabled={isPending}
              className="flex items-center gap-2 px-4 py-2 rounded-lg bg-[var(--color-primary)] text-white text-sm font-semibold hover:bg-[var(--color-primary-hover)] transition-colors disabled:opacity-50"
            >
              <Banknote className="w-4 h-4" />
              Marcar pago {selected.size > 1 ? `(${selected.size})` : ""}
            </button>
          )}

          {records.length > 0 && (
            <button
              onClick={handleExportPdf}
              className="flex items-center gap-2 px-4 py-2 rounded-lg border border-[var(--color-border)] text-sm text-[var(--color-text-sub)] hover:bg-[var(--color-background)] transition-colors"
            >
              <Download className="w-4 h-4" />
              PDF
            </button>
          )}
        </div>

        {/* Erro */}
        {error && (
          <div className="flex items-center gap-2 p-3 rounded-lg bg-red-50 border border-red-200 text-sm text-red-700">
            <AlertCircle className="w-4 h-4 shrink-0" />
            {error}
          </div>
        )}

        {/* KPIs */}
        {records.length > 0 && (
          <div className="grid grid-cols-2 md:grid-cols-5 gap-3">
            <KpiCard label="Salário Bruto"      value={fmtEur(totalBruto)} />
            <KpiCard label="Sub. Alimentação"   value={fmtEur(totalSub)} />
            <KpiCard label="Horas Extra"        value={fmtEur(totalExtra)} />
            <KpiCard label="Descontos"          value={fmtEur(totalDesc)} danger />
            <KpiCard label="Total Líquido"      value={fmtEur(totalLiq)} highlight />
          </div>
        )}

        {/* Tabela */}
        {records.length === 0 ? (
          <div className="py-16 text-center">
            <FileText className="w-10 h-10 mx-auto text-[var(--color-text-muted)] mb-3" />
            <p className="text-sm text-[var(--color-text-muted)] mb-4">
              Sem registos para este período. Clica em <strong>Recalcular</strong> para gerar.
            </p>
            <button
              onClick={handleRecalculate}
              disabled={isPending}
              className="inline-flex items-center gap-2 px-5 py-2.5 rounded-lg bg-[var(--color-primary)] text-white text-sm font-semibold hover:bg-[var(--color-primary-hover)] transition-colors disabled:opacity-50"
            >
              {isPending ? <Loader2 className="w-4 h-4 animate-spin" /> : <RefreshCw className="w-4 h-4" />}
              Calcular folha de {mesLabel}
            </button>
          </div>
        ) : (
          <div className="rounded-xl border border-[var(--color-border)] overflow-hidden bg-white">
            <table className="w-full text-sm">
              <thead className="bg-[var(--color-background)] border-b border-[var(--color-border)]">
                <tr>
                  <th className="px-4 py-3 w-10">
                    <input
                      type="checkbox"
                      checked={selected.size === records.length && records.length > 0}
                      onChange={toggleAll}
                      className="rounded border-[var(--color-border)] text-[var(--color-primary)] focus:ring-[var(--color-primary)]"
                    />
                  </th>
                  <th className="text-left px-4 py-3 text-xs font-semibold uppercase tracking-wider text-[var(--color-text-muted)]">Colaborador</th>
                  <th className="text-right px-4 py-3 text-xs font-semibold uppercase tracking-wider text-[var(--color-text-muted)]">Horas</th>
                  <th className="text-right px-4 py-3 text-xs font-semibold uppercase tracking-wider text-[var(--color-text-muted)]">Bruto</th>
                  <th className="text-right px-4 py-3 text-xs font-semibold uppercase tracking-wider text-[var(--color-text-muted)]">Sub. Alim.</th>
                  <th className="text-right px-4 py-3 text-xs font-semibold uppercase tracking-wider text-[var(--color-text-muted)]">Extra</th>
                  <th className="text-right px-4 py-3 text-xs font-semibold uppercase tracking-wider text-[var(--color-text-muted)]">Descontos</th>
                  <th className="text-right px-4 py-3 text-xs font-semibold uppercase tracking-wider text-[var(--color-text-muted)] font-bold">Líquido</th>
                  <th className="px-4 py-3 text-xs font-semibold uppercase tracking-wider text-[var(--color-text-muted)]">Estado</th>
                  <th className="px-4 py-3 w-16" />
                </tr>
              </thead>
              <tbody className="divide-y divide-[var(--color-border)]">
                {pag.pageItems.map((r) => (
                  <>
                    <tr
                      key={r.id}
                      className={`hover:bg-[var(--color-background)] transition-colors ${selected.has(r.id) ? "bg-[var(--color-primary-light)]" : "bg-white"}`}
                    >
                      <td className="px-4 py-3">
                        <input
                          type="checkbox"
                          checked={selected.has(r.id)}
                          onChange={() => toggleSelect(r.id)}
                          className="rounded border-[var(--color-border)] text-[var(--color-primary)] focus:ring-[var(--color-primary)]"
                        />
                      </td>
                      <td className="px-4 py-3">
                        <div className="flex items-center gap-2">
                          <div className="w-7 h-7 rounded-full bg-[var(--color-primary-muted)] flex items-center justify-center shrink-0 overflow-hidden text-xs font-semibold text-[var(--color-primary)]">
                            {r.avatar_url
                              // eslint-disable-next-line @next/next/no-img-element
                              ? <img src={r.avatar_url} alt="" className="w-full h-full object-cover" />
                              : r.full_name.split(" ").slice(0, 2).map((w) => w[0]).join("").toUpperCase()
                            }
                          </div>
                          <span className="font-medium text-[var(--color-text-main)]">{r.full_name}</span>
                          {r.notes && (
                            <span className="text-xs text-[var(--color-text-muted)] italic truncate max-w-[120px]">{r.notes}</span>
                          )}
                        </div>
                      </td>
                      <td className="px-4 py-3 text-right text-[var(--color-text-sub)]">
                        <button
                          onClick={() => setExpandedId(expandedId === r.id ? null : r.id)}
                          className="flex items-center gap-1 ml-auto hover:text-[var(--color-primary)] transition-colors"
                        >
                          {fmtH(r.worked_hours)}
                          {expandedId === r.id
                            ? <ChevronUp className="w-3 h-3" />
                            : <ChevronDown className="w-3 h-3" />
                          }
                        </button>
                      </td>
                      <td className="px-4 py-3 text-right text-[var(--color-text-sub)]">{fmtEur(r.gross_salary)}</td>
                      <td className="px-4 py-3 text-right text-[var(--color-text-sub)]">{fmtEur(r.meal_allowance)}</td>
                      <td className="px-4 py-3 text-right text-[var(--color-text-sub)]">
                        {r.overtime_bonus > 0 ? fmtEur(r.overtime_bonus) : "—"}
                      </td>
                      <td className="px-4 py-3 text-right text-red-600">
                        {(r.absence_deductions + r.other_deductions) > 0
                          ? fmtEur(r.absence_deductions + r.other_deductions)
                          : "—"}
                      </td>
                      <td className="px-4 py-3 text-right font-semibold text-[var(--color-text-main)]">
                        {fmtEur(r.net_salary)}
                      </td>
                      <td className="px-4 py-3">
                        <span className={`inline-flex px-2 py-0.5 rounded-full text-xs font-medium ${STATUS_COLOR[r.status]}`}>
                          {STATUS_LABEL[r.status]}
                        </span>
                      </td>
                      <td className="px-4 py-3">
                        <button
                          onClick={() => setEditing(r)}
                          disabled={r.status === "pago"}
                          className="p-1.5 rounded-lg text-[var(--color-text-muted)] hover:text-[var(--color-primary)] hover:bg-[var(--color-primary-light)] transition-colors disabled:opacity-30"
                          title="Ajustar"
                        >
                          <Pencil className="w-3.5 h-3.5" />
                        </button>
                      </td>
                    </tr>

                    {/* Detalhe expandido */}
                    {expandedId === r.id && (
                      <tr key={`${r.id}-detail`} className="bg-[var(--color-background)]">
                        <td colSpan={10} className="px-8 py-3">
                          <div className="grid grid-cols-2 md:grid-cols-4 gap-4 text-xs text-[var(--color-text-muted)]">
                            <div>
                              <p className="font-medium mb-0.5">Horas contratadas</p>
                              <p className="text-[var(--color-text-main)]">{fmtH(r.contracted_hours)}</p>
                            </div>
                            <div>
                              <p className="font-medium mb-0.5">Horas trabalhadas</p>
                              <p className="text-[var(--color-text-main)]">{fmtH(r.worked_hours)}</p>
                            </div>
                            <div>
                              <p className="font-medium mb-0.5">Horas extra</p>
                              <p className="text-[var(--color-text-main)]">{fmtH(r.overtime_hours)}</p>
                            </div>
                            <div>
                              <p className="font-medium mb-0.5">Horas falta</p>
                              <p className="text-[var(--color-text-main)]">{fmtH(r.absence_hours)}</p>
                            </div>
                            <div>
                              <p className="font-medium mb-0.5">Dias trabalhados</p>
                              <p className="text-[var(--color-text-main)]">{r.days_worked}d</p>
                            </div>
                            <div>
                              <p className="font-medium mb-0.5">Valor/hora</p>
                              <p className="text-[var(--color-text-main)]">{fmtEur(r.hourly_rate)}</p>
                            </div>
                            <div>
                              <p className="font-medium mb-0.5">Outros acréscimos</p>
                              <p className="text-[var(--color-text-main)]">{fmtEur(r.other_additions)}</p>
                            </div>
                            <div>
                              <p className="font-medium mb-0.5">Outros descontos</p>
                              <p className="text-[var(--color-text-main)] text-red-600">{fmtEur(r.other_deductions)}</p>
                            </div>
                          </div>
                        </td>
                      </tr>
                    )}
                  </>
                ))}
              </tbody>
              <tfoot className="border-t-2 border-[var(--color-border)] bg-[var(--color-background)]">
                <tr>
                  <td colSpan={3} className="px-4 py-3 text-xs font-semibold text-[var(--color-text-muted)] uppercase">
                    Total ({records.length} colaborador{records.length !== 1 ? "es" : ""})
                  </td>
                  <td className="px-4 py-3 text-right text-sm font-semibold text-[var(--color-text-main)]">{fmtEur(totalBruto)}</td>
                  <td className="px-4 py-3 text-right text-sm font-semibold text-[var(--color-text-main)]">{fmtEur(totalSub)}</td>
                  <td className="px-4 py-3 text-right text-sm font-semibold text-[var(--color-text-main)]">{fmtEur(totalExtra)}</td>
                  <td className="px-4 py-3 text-right text-sm font-semibold text-red-600">{fmtEur(totalDesc)}</td>
                  <td className="px-4 py-3 text-right text-sm font-bold text-[var(--color-primary)]">{fmtEur(totalLiq)}</td>
                  <td colSpan={2} />
                </tr>
              </tfoot>
            </table>
            <Pagination {...pag} hideWhenSinglePage />
          </div>
        )}
      </div>

      {editing && (
        <PayrollEditSheet
          record={editing}
          onClose={() => setEditing(null)}
          onSaved={handleSaved}
        />
      )}
    </>
  );
}

// ─── KPI Card ─────────────────────────────────────────────────────────────────

/**
 * Financeiro V2: passou a desenhar com o primitivo partilhado.
 * Assinatura intacta — nenhum ponto de chamada foi tocado.
 */
function KpiCard({
  label, value, highlight, danger,
}: { label: string; value: string; highlight?: boolean; danger?: boolean }) {
  return <Kpi label={label} value={value} tone={danger ? "danger" : highlight ? "positive" : "neutral"} />;
}

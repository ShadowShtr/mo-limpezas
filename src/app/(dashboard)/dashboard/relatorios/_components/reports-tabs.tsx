"use client";

import { useState } from "react";
import {
  Clock,
  AlertTriangle,
  TrendingUp,
  BarChart3,
  Download,
  FileText,
  CalendarDays,
} from "lucide-react";
import type { HorasRow, AbsentismoRow, ReceitaRow, ServicosRow, FaturacaoDiaRow } from "@/app/actions/reports";
import { downloadCsv } from "@/lib/csv";

type Tab = "horas" | "absentismo" | "receita" | "servicos" | "faturacao";

interface Props {
  horas: HorasRow[];
  absentismo: AbsentismoRow[];
  receita: ReceitaRow[];
  servicosPorEquipa: ServicosRow[];
  faturacaoDiaria: FaturacaoDiaRow[];
  mesLabel: string;
  mesParam: string;
  vatRate: number;
}

function fmtHoras(minutes: number) {
  const h = Math.floor(minutes / 60);
  const m = minutes % 60;
  return m > 0 ? `${h}h${String(m).padStart(2, "0")}` : `${h}h`;
}

function fmtEuros(value: number) {
  return value.toLocaleString("pt-PT", { minimumFractionDigits: 2, maximumFractionDigits: 2 }) + " €";
}

function exportCsv(filename: string, headers: string[], rows: string[][]) {
  downloadCsv(filename, headers, rows);
}

async function exportClientePdf(row: ReceitaRow, mesLabel: string, vatRate: number) {
  const vatFactor = vatRate / 100;
  const { default: jsPDF } = await import("jspdf");
  const doc = new jsPDF({ unit: "mm", format: "a4" });

  const margin = 14;
  const pageW = 210;

  // Cabeçalho
  doc.setFillColor(22, 163, 74);
  doc.rect(0, 0, pageW, 28, "F");
  doc.setTextColor(255, 255, 255);
  doc.setFontSize(16);
  doc.setFont("helvetica", "bold");
  doc.text("Escala — Extrato de Serviços", margin, 12);
  doc.setFontSize(9);
  doc.setFont("helvetica", "normal");
  doc.text(`Período: ${mesLabel}`, margin, 20);
  doc.text(`Emitido em: ${new Date().toLocaleDateString("pt-PT")}`, pageW - margin - 45, 20);

  // Dados do cliente
  doc.setTextColor(0, 0, 0);
  let y = 38;
  doc.setFontSize(11);
  doc.setFont("helvetica", "bold");
  doc.text("Cliente:", margin, y);
  doc.setFont("helvetica", "normal");
  doc.text(row.client_name, margin + 20, y);

  // Tabela de serviços
  y = 52;
  doc.setFillColor(240, 240, 240);
  doc.rect(margin, y - 5, pageW - margin * 2, 7, "F");
  doc.setFontSize(9);
  doc.setFont("helvetica", "bold");
  doc.text("Data", margin + 1, y);
  doc.text("Local", margin + 30, y);
  doc.text("Duração", margin + 110, y);
  doc.text("Valor (€)", margin + 140, y);
  doc.line(margin, y + 2, pageW - margin, y + 2);

  doc.setFont("helvetica", "normal");
  y += 8;

  const sortedServices = [...row.services].sort(
    (a, b) => new Date(a.date).getTime() - new Date(b.date).getTime(),
  );

  for (const s of sortedServices) {
    if (y > 270) {
      doc.addPage();
      y = 20;
    }
    const date = new Date(s.date).toLocaleDateString("pt-PT");
    const dur = s.duration_min > 0 ? fmtHoras(s.duration_min) : "—";
    const locTrunc = s.location_name.length > 42 ? s.location_name.slice(0, 40) + "…" : s.location_name;
    doc.text(date, margin + 1, y);
    doc.text(locTrunc, margin + 30, y);
    doc.text(dur, margin + 110, y);
    doc.text(s.value.toFixed(2), margin + 140, y);
    y += 6;
  }

  // Totais
  y += 4;
  doc.line(margin, y, pageW - margin, y);
  y += 6;
  const iva = row.total_receita * vatFactor;
  const total = row.total_receita * (1 + vatFactor);

  doc.setFont("helvetica", "bold");
  doc.text("Subtotal (s/ IVA):", margin + 100, y); doc.setFont("helvetica", "normal"); doc.text(row.total_receita.toFixed(2) + " €", margin + 150, y); y += 6;
  doc.setFont("helvetica", "bold");
  doc.text(`IVA ${vatRate}%:`, margin + 100, y); doc.setFont("helvetica", "normal"); doc.text(iva.toFixed(2) + " €", margin + 150, y); y += 6;
  doc.setFillColor(22, 163, 74);
  doc.rect(margin + 95, y - 5, pageW - margin * 2 - 95, 8, "F");
  doc.setTextColor(255, 255, 255);
  doc.setFont("helvetica", "bold");
  doc.text("Total (c/ IVA):", margin + 100, y); doc.text(total.toFixed(2) + " €", margin + 150, y);

  doc.save(`extrato-${row.client_name.replace(/\s+/g, "-").toLowerCase()}-${mesLabel}.pdf`);
}

const TABS: { key: Tab; label: string; icon: React.ElementType }[] = [
  { key: "horas",      label: "Horas",      icon: Clock },
  { key: "absentismo", label: "Absentismo", icon: AlertTriangle },
  { key: "receita",    label: "Receita",    icon: TrendingUp },
  { key: "servicos",   label: "Serviços",   icon: BarChart3 },
  { key: "faturacao",  label: "Faturação diária", icon: CalendarDays },
];

const ABSENCE_LABELS: Record<string, string> = {
  doenca_com_baixa:    "Doença c/ baixa",
  doenca_sem_baixa:    "Doença s/ baixa",
  pessoal_justificado: "Pessoal justif.",
  pessoal_injustificado: "Pessoal injustif.",
  ferias:              "Férias",
  outros:              "Outros",
};

export function ReportsTabs({ horas, absentismo, receita, servicosPorEquipa, faturacaoDiaria, mesLabel, mesParam, vatRate }: Props) {
  const vatFactor = vatRate / 100;
  const [tab, setTab] = useState<Tab>("horas");

  return (
    <div className="space-y-5">
      {/* Tab Navigation */}
      <div className="flex gap-1 bg-[var(--color-background)] rounded-xl p-1 w-fit">
        {TABS.map(({ key, label, icon: Icon }) => (
          <button
            key={key}
            onClick={() => setTab(key)}
            className={`flex items-center gap-2 px-4 py-2 rounded-lg text-sm font-medium transition-colors ${
              tab === key
                ? "bg-white text-[var(--color-primary)] shadow-sm border border-[var(--color-border)]"
                : "text-[var(--color-text-sub)] hover:text-[var(--color-text-main)]"
            }`}
          >
            <Icon className="w-4 h-4" />
            {label}
          </button>
        ))}
      </div>

      {/* ── HORAS ── */}
      {tab === "horas" && (
        <div className="space-y-3">
          <div className="flex items-center justify-between">
            <p className="text-sm text-[var(--color-text-muted)]">
              {horas.length} colaborador{horas.length !== 1 ? "es" : ""}
            </p>
            <button
              onClick={() =>
                exportCsv(
                  `horas-${mesParam}.csv`,
                  ["Colaborador", "Horas Contratadas", "Horas Trabalhadas", "Serviços", "Ocupação %"],
                  horas.map((r) => [
                    r.full_name,
                    r.contracted_hours_month.toString(),
                    (r.actual_minutes / 60).toFixed(1),
                    r.services_count.toString(),
                    r.contracted_hours_month > 0
                      ? ((r.actual_minutes / 60 / r.contracted_hours_month) * 100).toFixed(1)
                      : "0",
                  ]),
                )
              }
              className="flex items-center gap-2 px-3 py-1.5 rounded-lg border border-[var(--color-border)] text-sm text-[var(--color-text-sub)] hover:bg-[var(--color-background)] transition-colors"
            >
              <Download className="w-4 h-4" />
              CSV
            </button>
          </div>

          {horas.length === 0 ? (
            <EmptyState text="Sem registos de horas neste período." />
          ) : (
            <div className="bg-white rounded-xl border border-[var(--color-border)] overflow-x-auto">
              <table className="w-full text-sm">
                <thead>
                  <tr className="border-b border-[var(--color-border)]">
                    <Th>Colaborador</Th>
                    <Th align="right">Contratadas</Th>
                    <Th align="right">Trabalhadas</Th>
                    <Th align="right">Serviços</Th>
                    <Th align="right">Ocupação</Th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-[var(--color-border)]">
                  {horas.map((r) => {
                    const pct = r.contracted_hours_month > 0
                      ? (r.actual_minutes / 60 / r.contracted_hours_month) * 100
                      : 0;
                    return (
                      <tr key={r.id} className="hover:bg-[var(--color-background)]">
                        <Td>{r.full_name}</Td>
                        <Td align="right">{r.contracted_hours_month}h</Td>
                        <Td align="right">{fmtHoras(r.actual_minutes)}</Td>
                        <Td align="right">{r.services_count}</Td>
                        <Td align="right">
                          <div className="flex items-center justify-end gap-2">
                            <div className="w-20 h-1.5 bg-gray-200 rounded-full overflow-hidden">
                              <div
                                className={`h-full rounded-full ${pct >= 90 ? "bg-green-500" : pct >= 60 ? "bg-yellow-400" : "bg-red-400"}`}
                                style={{ width: `${Math.min(pct, 100)}%` }}
                              />
                            </div>
                            <span className={`font-medium ${pct >= 90 ? "text-green-600" : pct >= 60 ? "text-yellow-600" : "text-red-500"}`}>
                              {pct.toFixed(0)}%
                            </span>
                          </div>
                        </Td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          )}
        </div>
      )}

      {/* ── ABSENTISMO ── */}
      {tab === "absentismo" && (
        <div className="space-y-3">
          <div className="flex items-center justify-between">
            <p className="text-sm text-[var(--color-text-muted)]">
              {absentismo.length} colaborador{absentismo.length !== 1 ? "es" : ""} com faltas
            </p>
            <button
              onClick={() =>
                exportCsv(
                  `absentismo-${mesParam}.csv`,
                  ["Colaborador", "Total Dias", "Doença c/ baixa", "Doença s/ baixa", "Pessoal justif.", "Pessoal injustif.", "Férias", "Outros"],
                  absentismo.map((r) => [
                    r.full_name,
                    r.total_dias.toString(),
                    r.doenca_com_baixa.toString(),
                    r.doenca_sem_baixa.toString(),
                    r.pessoal_justificado.toString(),
                    r.pessoal_injustificado.toString(),
                    r.ferias.toString(),
                    r.outros.toString(),
                  ]),
                )
              }
              className="flex items-center gap-2 px-3 py-1.5 rounded-lg border border-[var(--color-border)] text-sm text-[var(--color-text-sub)] hover:bg-[var(--color-background)] transition-colors"
            >
              <Download className="w-4 h-4" />
              CSV
            </button>
          </div>

          {absentismo.length === 0 ? (
            <EmptyState text="Sem faltas registadas neste período." />
          ) : (
            <div className="bg-white rounded-xl border border-[var(--color-border)] overflow-x-auto">
              <table className="w-full text-sm">
                <thead>
                  <tr className="border-b border-[var(--color-border)]">
                    <Th>Colaborador</Th>
                    <Th align="right">Total</Th>
                    {Object.entries(ABSENCE_LABELS).map(([key, label]) => (
                      <Th key={key} align="right">{label}</Th>
                    ))}
                  </tr>
                </thead>
                <tbody className="divide-y divide-[var(--color-border)]">
                  {absentismo.map((r) => (
                    <tr key={r.id} className="hover:bg-[var(--color-background)]">
                      <Td>{r.full_name}</Td>
                      <Td align="right">
                        <span className="font-semibold text-orange-600">{r.total_dias}d</span>
                      </Td>
                      <Td align="right">{r.doenca_com_baixa > 0 ? `${r.doenca_com_baixa}d` : "—"}</Td>
                      <Td align="right">{r.doenca_sem_baixa > 0 ? `${r.doenca_sem_baixa}d` : "—"}</Td>
                      <Td align="right">{r.pessoal_justificado > 0 ? `${r.pessoal_justificado}d` : "—"}</Td>
                      <Td align="right">{r.pessoal_injustificado > 0 ? `${r.pessoal_injustificado}d` : "—"}</Td>
                      <Td align="right">{r.ferias > 0 ? `${r.ferias}d` : "—"}</Td>
                      <Td align="right">{r.outros > 0 ? `${r.outros}d` : "—"}</Td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </div>
      )}

      {/* ── RECEITA ── */}
      {tab === "receita" && (
        <div className="space-y-3">
          <div className="flex items-center justify-between">
            <p className="text-sm text-[var(--color-text-muted)]">
              {receita.length} cliente{receita.length !== 1 ? "s" : ""} · Total:{" "}
              <span className="font-semibold text-green-600">
                {fmtEuros(receita.reduce((s, r) => s + r.total_receita, 0))}
              </span>
            </p>
            <button
              onClick={() =>
                exportCsv(
                  `receita-${mesParam}.csv`,
                  ["Cliente", "Serviços", "Receita (s/ IVA)", `IVA ${vatRate}%`, "Total (c/ IVA)"],
                  receita.map((r) => [
                    r.client_name,
                    r.servicos_count.toString(),
                    r.total_receita.toFixed(2),
                    (r.total_receita * vatFactor).toFixed(2),
                    (r.total_receita * (1 + vatFactor)).toFixed(2),
                  ]),
                )
              }
              className="flex items-center gap-2 px-3 py-1.5 rounded-lg border border-[var(--color-border)] text-sm text-[var(--color-text-sub)] hover:bg-[var(--color-background)] transition-colors"
            >
              <Download className="w-4 h-4" />
              CSV
            </button>
          </div>

          {receita.length === 0 ? (
            <EmptyState text="Sem serviços concluídos neste período." />
          ) : (
            <div className="bg-white rounded-xl border border-[var(--color-border)] overflow-x-auto">
              <table className="w-full text-sm">
                <thead>
                  <tr className="border-b border-[var(--color-border)]">
                    <Th>Cliente</Th>
                    <Th align="right">Serviços</Th>
                    <Th align="right">Subtotal</Th>
                    <Th align="right">IVA {vatRate}%</Th>
                    <Th align="right">Total c/ IVA</Th>
                    <Th align="right">Extrato PDF</Th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-[var(--color-border)]">
                  {receita.map((r) => (
                    <tr key={r.client_id} className="hover:bg-[var(--color-background)]">
                      <Td>{r.client_name}</Td>
                      <Td align="right">{r.servicos_count}</Td>
                      <Td align="right">{fmtEuros(r.total_receita)}</Td>
                      <Td align="right">{fmtEuros(r.total_receita * vatFactor)}</Td>
                      <Td align="right">
                        <span className="font-semibold text-green-700">{fmtEuros(r.total_receita * (1 + vatFactor))}</span>
                      </Td>
                      <Td align="right">
                        <button
                          onClick={() => exportClientePdf(r, mesLabel, vatRate)}
                          title="Gerar extrato PDF"
                          className="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-lg border border-[var(--color-border)] text-xs text-[var(--color-text-sub)] hover:bg-[var(--color-background)] hover:text-[var(--color-primary)] transition-colors"
                        >
                          <FileText className="w-3.5 h-3.5" />
                          PDF
                        </button>
                      </Td>
                    </tr>
                  ))}
                </tbody>
                <tfoot>
                  <tr className="border-t-2 border-[var(--color-border)] bg-[var(--color-background)]">
                    <Td><span className="font-semibold">Total</span></Td>
                    <Td align="right">
                      <span className="font-semibold">{receita.reduce((s, r) => s + r.servicos_count, 0)}</span>
                    </Td>
                    <Td align="right">
                      <span className="font-semibold">{fmtEuros(receita.reduce((s, r) => s + r.total_receita, 0))}</span>
                    </Td>
                    <Td align="right">
                      <span className="font-semibold">{fmtEuros(receita.reduce((s, r) => s + r.total_receita * vatFactor, 0))}</span>
                    </Td>
                    <Td align="right">
                      <span className="font-bold text-green-700">{fmtEuros(receita.reduce((s, r) => s + r.total_receita * (1 + vatFactor), 0))}</span>
                    </Td>
                    <Td />
                  </tr>
                </tfoot>
              </table>
            </div>
          )}
        </div>
      )}

      {/* ── SERVIÇOS ── */}
      {tab === "servicos" && (
        <div className="space-y-3">
          <div className="flex items-center justify-between">
            <p className="text-sm text-[var(--color-text-muted)]">
              {servicosPorEquipa.reduce((s, r) => s + r.total, 0)} serviço{servicosPorEquipa.reduce((s, r) => s + r.total, 0) !== 1 ? "s" : ""} no período
            </p>
            <button
              onClick={() =>
                exportCsv(
                  `servicos-${mesParam}.csv`,
                  ["Equipa", "Total", "Concluídos", "Cancelados", "Faltas", "Agendados"],
                  servicosPorEquipa.map((r) => [
                    r.team_name,
                    r.total.toString(),
                    r.concluido.toString(),
                    r.cancelado.toString(),
                    r.falta.toString(),
                    r.agendado.toString(),
                  ]),
                )
              }
              className="flex items-center gap-2 px-3 py-1.5 rounded-lg border border-[var(--color-border)] text-sm text-[var(--color-text-sub)] hover:bg-[var(--color-background)] transition-colors"
            >
              <Download className="w-4 h-4" />
              CSV
            </button>
          </div>

          {servicosPorEquipa.length === 0 ? (
            <EmptyState text="Sem serviços neste período." />
          ) : (
            <div className="bg-white rounded-xl border border-[var(--color-border)] overflow-x-auto">
              <table className="w-full text-sm">
                <thead>
                  <tr className="border-b border-[var(--color-border)]">
                    <Th>Equipa</Th>
                    <Th align="right">Total</Th>
                    <Th align="right">Concluídos</Th>
                    <Th align="right">Cancelados</Th>
                    <Th align="right">Faltas</Th>
                    <Th align="right">Agendados</Th>
                    <Th>Taxa de Execução</Th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-[var(--color-border)]">
                  {servicosPorEquipa.map((r) => {
                    const pct = r.total > 0 ? (r.concluido / r.total) * 100 : 0;
                    return (
                      <tr key={r.team_id} className="hover:bg-[var(--color-background)]">
                        <Td>{r.team_name}</Td>
                        <Td align="right"><span className="font-semibold">{r.total}</span></Td>
                        <Td align="right"><span className="text-green-600 font-medium">{r.concluido}</span></Td>
                        <Td align="right"><span className="text-gray-500">{r.cancelado}</span></Td>
                        <Td align="right"><span className="text-red-500">{r.falta}</span></Td>
                        <Td align="right"><span className="text-blue-500">{r.agendado}</span></Td>
                        <Td>
                          <div className="flex items-center gap-2">
                            <div className="w-20 h-1.5 bg-gray-200 rounded-full overflow-hidden">
                              <div
                                className={`h-full rounded-full ${pct >= 90 ? "bg-green-500" : pct >= 70 ? "bg-yellow-400" : "bg-red-400"}`}
                                style={{ width: `${pct}%` }}
                              />
                            </div>
                            <span className={`text-xs font-medium ${pct >= 90 ? "text-green-600" : pct >= 70 ? "text-yellow-600" : "text-red-500"}`}>
                              {pct.toFixed(0)}%
                            </span>
                          </div>
                        </Td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          )}
        </div>
      )}

      {/* ── FATURAÇÃO DIÁRIA ── */}
      {tab === "faturacao" && (
        <div className="space-y-3">
          <div className="flex items-center justify-between">
            <p className="text-sm text-[var(--color-text-muted)]">
              {faturacaoDiaria.length} dia{faturacaoDiaria.length !== 1 ? "s" : ""} com faturação · Total:{" "}
              <span className="font-semibold text-green-600">
                {fmtEuros(faturacaoDiaria.reduce((s, r) => s + r.total, 0))}
              </span>
            </p>
            <button
              onClick={() =>
                exportCsv(
                  `faturacao-diaria-${mesParam}.csv`,
                  ["Data", "Serviços", "Subtotal", `IVA`, "Total"],
                  faturacaoDiaria.map((r) => [
                    r.date,
                    r.servicos_count.toString(),
                    r.subtotal.toFixed(2),
                    r.iva.toFixed(2),
                    r.total.toFixed(2),
                  ]),
                )
              }
              className="flex items-center gap-2 px-3 py-1.5 rounded-lg border border-[var(--color-border)] text-sm text-[var(--color-text-sub)] hover:bg-[var(--color-background)] transition-colors"
            >
              <Download className="w-4 h-4" />
              CSV
            </button>
          </div>

          {faturacaoDiaria.length === 0 ? (
            <EmptyState text="Sem faturação neste período." />
          ) : (
            <>
              <DailyBillingCalendar mesParam={mesParam} rows={faturacaoDiaria} />

              <div className="bg-white rounded-xl border border-[var(--color-border)] overflow-x-auto">
                <table className="w-full text-sm">
                  <thead>
                    <tr className="border-b border-[var(--color-border)]">
                      <Th>Data</Th>
                      <Th align="right">Serviços</Th>
                      <Th align="right">Subtotal</Th>
                      <Th align="right">IVA</Th>
                      <Th align="right">Total</Th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-[var(--color-border)]">
                    {faturacaoDiaria.map((r) => (
                      <tr key={r.date} className="hover:bg-[var(--color-background)]">
                        <Td>
                          {new Date(`${r.date}T00:00:00`).toLocaleDateString("pt-PT", {
                            weekday: "short", day: "2-digit", month: "2-digit",
                          })}
                        </Td>
                        <Td align="right">{r.servicos_count}</Td>
                        <Td align="right">{fmtEuros(r.subtotal)}</Td>
                        <Td align="right">{fmtEuros(r.iva)}</Td>
                        <Td align="right">
                          <span className="font-semibold text-green-700">{fmtEuros(r.total)}</span>
                        </Td>
                      </tr>
                    ))}
                  </tbody>
                  <tfoot>
                    <tr className="border-t-2 border-[var(--color-border)] bg-[var(--color-background)]">
                      <Td><span className="font-semibold">Total</span></Td>
                      <Td align="right">
                        <span className="font-semibold">{faturacaoDiaria.reduce((s, r) => s + r.servicos_count, 0)}</span>
                      </Td>
                      <Td align="right">
                        <span className="font-semibold">{fmtEuros(faturacaoDiaria.reduce((s, r) => s + r.subtotal, 0))}</span>
                      </Td>
                      <Td align="right">
                        <span className="font-semibold">{fmtEuros(faturacaoDiaria.reduce((s, r) => s + r.iva, 0))}</span>
                      </Td>
                      <Td align="right">
                        <span className="font-bold text-green-700">{fmtEuros(faturacaoDiaria.reduce((s, r) => s + r.total, 0))}</span>
                      </Td>
                    </tr>
                  </tfoot>
                </table>
              </div>
            </>
          )}
        </div>
      )}
    </div>
  );
}

// Vista de calendário do mês: cada dia mostra o total faturado nesse dia
// (inclui a fatia diária das avenças). Tom de verde proporcional ao valor —
// dá para ver de relance em que dias fechou mais.
function DailyBillingCalendar({ mesParam, rows }: { mesParam: string; rows: FaturacaoDiaRow[] }) {
  const [year, month] = mesParam.split("-").map(Number);
  const totalByDate = new Map(rows.map((r) => [r.date, r]));
  const daysInMonth = new Date(year, month, 0).getDate();
  const firstWeekday = (new Date(year, month - 1, 1).getDay() + 6) % 7; // 0 = Segunda
  const maxTotal = Math.max(1, ...rows.map((r) => r.total));
  const cells: (number | null)[] = [
    ...Array(firstWeekday).fill(null),
    ...Array.from({ length: daysInMonth }, (_, i) => i + 1),
  ];
  const WEEKDAYS = ["Seg", "Ter", "Qua", "Qui", "Sex", "Sáb", "Dom"];

  return (
    <div className="bg-white rounded-xl border border-[var(--color-border)] p-4">
      <div className="grid grid-cols-7 gap-1.5 mb-1.5">
        {WEEKDAYS.map((w) => (
          <div key={w} className="text-center text-[10px] font-semibold text-[var(--color-text-muted)] uppercase">
            {w}
          </div>
        ))}
      </div>
      <div className="grid grid-cols-7 gap-1.5">
        {cells.map((day, i) => {
          if (day == null) return <div key={`empty-${i}`} />;
          const dateStr = `${year}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
          const entry = totalByDate.get(dateStr);
          const intensity = entry ? Math.min(1, entry.total / maxTotal) : 0;
          return (
            <div
              key={dateStr}
              title={entry ? `${entry.servicos_count} serviço${entry.servicos_count !== 1 ? "s" : ""} · ${fmtEuros(entry.total)}` : "Sem faturação"}
              className="aspect-square rounded-lg border border-[var(--color-border)] flex flex-col items-center justify-center p-1"
              style={{ backgroundColor: entry ? `rgba(22, 163, 74, ${0.08 + intensity * 0.42})` : "transparent" }}
            >
              <span className="text-[11px] font-medium text-[var(--color-text-main)]">{day}</span>
              {entry && (
                <span className="text-[9px] font-semibold text-green-700 leading-tight">
                  {entry.total.toFixed(0)}€
                </span>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}

function Th({ children, align = "left" }: { children?: React.ReactNode; align?: "left" | "right" }) {
  return (
    <th className={`px-4 py-3 text-xs font-semibold text-[var(--color-text-muted)] uppercase tracking-wide text-${align}`}>
      {children}
    </th>
  );
}

function Td({ children, align = "left" }: { children?: React.ReactNode; align?: "left" | "right" }) {
  return (
    <td className={`px-4 py-3 text-[var(--color-text-main)] text-${align}`}>
      {children}
    </td>
  );
}

function EmptyState({ text }: { text: string }) {
  return (
    <div className="bg-white rounded-xl border border-[var(--color-border)] py-16 flex flex-col items-center gap-2 text-[var(--color-text-muted)]">
      <BarChart3 className="w-8 h-8 opacity-30" />
      <p className="text-sm">{text}</p>
    </div>
  );
}

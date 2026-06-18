"use client";

import { useState, useEffect, useMemo, useTransition } from "react";
import { useRouter } from "next/navigation";
import { format, parseISO } from "date-fns";
import { pt } from "date-fns/locale";
import { Pencil, ListFilter, FileDown, Loader2, AlertTriangle, CheckCircle2, X } from "lucide-react";
import { createClient } from "@/lib/supabase/client";
import { adminEditTimesheet, adminCreateTimesheet } from "@/app/actions/timesheets";
import {
  timesheetWorkedMinutes, hasOpenTimesheet, balanceMinutes, formatHM,
  type TimesheetLike,
} from "@/lib/ponto-calc";

export interface PontoRow {
  collaboratorId: string;
  collaboratorName: string;
  day: string; // YYYY-MM-DD
  contractedMin: number;
  prevServicesMin: number;
  absent: boolean;
  timesheets: (TimesheetLike & { id: string })[];
  candidateServiceId: string | null;
}

interface Props {
  rows: PontoRow[];
  collaborators: { id: string; full_name: string }[];
  companyId: string;
  from: string;
  to: string;
  collabFilter: string;
}

const INPUT_CLS =
  "px-3 py-2 rounded-lg border border-[var(--color-border)] text-sm text-[var(--color-text-main)] " +
  "focus:outline-none focus:ring-2 focus:ring-[var(--color-primary)] focus:border-transparent bg-white";

function dayLabel(day: string): string {
  const d = parseISO(`${day}T00:00:00`);
  return format(d, "dd EEE", { locale: pt });
}

function timeOnly(iso: string | null): string {
  return iso ? format(parseISO(iso), "HH:mm") : "";
}

export function RegistoPontoClient({ rows, collaborators, companyId, from, to, collabFilter }: Props) {
  const router = useRouter();

  // Filtros (formulário)
  const [fFrom, setFFrom] = useState(from);
  const [fTo, setFTo] = useState(to);
  const [fCollab, setFCollab] = useState(collabFilter);

  // Relógio para tempo decorrido de pontos em curso
  const [nowMs, setNowMs] = useState(() => Date.now());
  useEffect(() => {
    const id = setInterval(() => setNowMs(Date.now()), 60_000);
    return () => clearInterval(id);
  }, []);

  // Realtime: qualquer alteração em timesheets refaz os dados do servidor
  useEffect(() => {
    const supabase = createClient();
    const channel = supabase
      .channel(`timesheets-company-${companyId}`)
      .on(
        "postgres_changes",
        { event: "*", schema: "public", table: "timesheets", filter: `company_id=eq.${companyId}` },
        () => router.refresh(),
      )
      .subscribe();
    return () => { supabase.removeChannel(channel); };
  }, [companyId, router]);

  function applyFilters() {
    const params = new URLSearchParams();
    params.set("from", fFrom);
    params.set("to", fTo);
    if (fCollab) params.set("collab", fCollab);
    router.push(`/dashboard/registo-ponto?${params.toString()}`);
  }

  // Linhas calculadas
  const computed = useMemo(() => {
    return rows.map((r) => {
      const worked = timesheetWorkedMinutes(r.timesheets, nowMs);
      const open = hasOpenTimesheet(r.timesheets);
      const hasAny = r.timesheets.length > 0;
      const saldo = balanceMinutes(worked, r.contractedMin);
      const first = r.timesheets.find((t) => t.clock_in_at) ?? null;
      const lastOut = [...r.timesheets].reverse().find((t) => t.clock_out_at) ?? null;
      const missing = !hasAny && (r.prevServicesMin > 0 || r.contractedMin > 0) && !r.absent;
      return { row: r, worked, open, hasAny, saldo, first, lastOut, missing };
    });
  }, [rows, nowMs]);

  const totalRegistos = computed.filter((c) => c.hasAny).length;
  const totalFalta = computed.filter((c) => c.missing || c.open).length;

  // ── Edição ──────────────────────────────────────────────────────────────────
  const [editRow, setEditRow] = useState<PontoRow | null>(null);

  function exportCsv() {
    const header = ["Data", "Colaborador", "Inicio", "Fim", "Total", "Registado", "Prev. Servicos", "Contratado", "Saldo", "Absentismo"];
    const lines = computed.map(({ row, worked, saldo, first, lastOut }) => [
      row.day,
      row.collaboratorName,
      timeOnly(first?.clock_in_at ?? null),
      timeOnly(lastOut?.clock_out_at ?? null),
      formatHM(worked),
      formatHM(worked),
      row.prevServicesMin ? formatHM(row.prevServicesMin) : "",
      row.contractedMin ? formatHM(row.contractedMin) : "",
      formatHM(saldo, true),
      row.absent ? "Sim" : "",
    ]);
    const csv = [header, ...lines].map((r) => r.map((c) => `"${String(c).replace(/"/g, '""')}"`).join(";")).join("\n");
    const blob = new Blob(["﻿" + csv], { type: "text/csv;charset=utf-8;" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `registo-ponto-${from}_${to}.csv`;
    a.click();
    URL.revokeObjectURL(url);
  }

  return (
    <div className="space-y-4">
      {/* ── Filtros ──────────────────────────────────────────────────────────── */}
      <div className="bg-white rounded-xl border border-[var(--color-border)] p-4">
        <div className="flex flex-wrap items-end gap-3">
          <div>
            <label className="block text-xs font-medium text-[var(--color-text-muted)] uppercase tracking-wide mb-1">De</label>
            <input type="date" value={fFrom} onChange={(e) => setFFrom(e.target.value)} className={INPUT_CLS} />
          </div>
          <div>
            <label className="block text-xs font-medium text-[var(--color-text-muted)] uppercase tracking-wide mb-1">Até</label>
            <input type="date" value={fTo} onChange={(e) => setFTo(e.target.value)} className={INPUT_CLS} />
          </div>
          <div className="min-w-[200px]">
            <label className="block text-xs font-medium text-[var(--color-text-muted)] uppercase tracking-wide mb-1">Colaboradores</label>
            <select value={fCollab} onChange={(e) => setFCollab(e.target.value)} className={INPUT_CLS + " w-full"}>
              <option value="">Todos os colaboradores</option>
              {collaborators.map((c) => <option key={c.id} value={c.id}>{c.full_name}</option>)}
            </select>
          </div>
          <button
            onClick={applyFilters}
            className="flex items-center gap-2 px-4 py-2 rounded-lg bg-[var(--color-primary)] text-white text-sm font-semibold hover:bg-[var(--color-primary-hover)] transition-colors"
          >
            <ListFilter className="w-4 h-4" />
            Listar
          </button>
          <button
            onClick={exportCsv}
            className="flex items-center gap-2 px-4 py-2 rounded-lg border border-[var(--color-border)] text-sm font-medium text-[var(--color-text-sub)] hover:bg-[var(--color-background)] transition-colors ml-auto"
          >
            <FileDown className="w-4 h-4" />
            Exportar
          </button>
        </div>
      </div>

      {/* ── Contadores ───────────────────────────────────────────────────────── */}
      <div className="flex flex-wrap gap-3">
        <span className="flex items-center gap-2 px-3 py-2 rounded-lg border border-[var(--color-primary-muted)] bg-[var(--color-primary-light)] text-sm font-medium text-[var(--color-primary)]">
          <CheckCircle2 className="w-4 h-4" />
          {totalRegistos} Registo(s) de ponto
        </span>
        <span className="flex items-center gap-2 px-3 py-2 rounded-lg border border-red-200 bg-red-50 text-sm font-medium text-red-700">
          <AlertTriangle className="w-4 h-4" />
          {totalFalta} Registo(s) de ponto em falta
        </span>
      </div>

      {/* ── Tabela ───────────────────────────────────────────────────────────── */}
      <div className="bg-white rounded-xl border border-[var(--color-border)] overflow-x-auto">
        <table className="w-full">
          <thead>
            <tr className="bg-[var(--color-background)] border-b border-[var(--color-border)] text-xs font-medium text-[var(--color-text-muted)] uppercase tracking-wide">
              <th className="text-left px-3 py-3">Data</th>
              <th className="text-left px-3 py-3">Colaborador</th>
              <th className="text-left px-3 py-3">Início</th>
              <th className="text-left px-3 py-3">Fim</th>
              <th className="text-left px-3 py-3">Total</th>
              <th className="text-left px-3 py-3">Registado</th>
              <th className="text-left px-3 py-3">Prev. Serviços</th>
              <th className="text-left px-3 py-3">Contratado</th>
              <th className="text-left px-3 py-3">Saldo</th>
              <th className="text-left px-3 py-3">Absentismo</th>
              <th className="px-3 py-3" />
            </tr>
          </thead>
          <tbody className="divide-y divide-[var(--color-border)]">
            {computed.length === 0 ? (
              <tr><td colSpan={11} className="text-center py-12 text-sm text-[var(--color-text-muted)]">Sem registos no período selecionado.</td></tr>
            ) : computed.map(({ row, worked, open, saldo, first, lastOut, missing }) => (
              <tr key={`${row.collaboratorId}|${row.day}`} className="hover:bg-[var(--color-background)] transition-colors text-sm">
                <td className="px-3 py-2.5 text-[var(--color-text-sub)] whitespace-nowrap capitalize">{dayLabel(row.day)}</td>
                <td className="px-3 py-2.5 font-medium text-[var(--color-text-main)] whitespace-nowrap">{row.collaboratorName}</td>
                <td className="px-3 py-2.5 text-[var(--color-primary)] font-medium">{timeOnly(first?.clock_in_at ?? null) || "—"}</td>
                <td className="px-3 py-2.5">
                  {lastOut?.clock_out_at ? (
                    <span className="text-[var(--color-text-main)]">{timeOnly(lastOut.clock_out_at)}</span>
                  ) : open ? (
                    <span className="flex items-center gap-1 text-[var(--color-primary)]">
                      <span className="w-1.5 h-1.5 rounded-full bg-[var(--color-primary)] animate-pulse" /> em curso
                    </span>
                  ) : "—"}
                </td>
                <td className="px-3 py-2.5 tabular-nums">{worked > 0 ? `[ ${formatHM(worked)} ]` : ""}</td>
                <td className="px-3 py-2.5 tabular-nums">{worked > 0 ? `[ ${formatHM(worked)} ]` : ""}</td>
                <td className="px-3 py-2.5 tabular-nums text-[var(--color-text-sub)]">{row.prevServicesMin ? formatHM(row.prevServicesMin) : ""}</td>
                <td className="px-3 py-2.5 tabular-nums text-[var(--color-text-sub)]">{row.contractedMin ? formatHM(row.contractedMin) : ""}</td>
                <td className={`px-3 py-2.5 tabular-nums font-medium ${saldo < 0 ? "text-red-600" : "text-[var(--color-text-main)]"}`}>
                  {worked > 0 || row.contractedMin > 0 ? formatHM(saldo, true) : ""}
                </td>
                <td className="px-3 py-2.5">{row.absent ? <span className="text-xs font-medium text-amber-700 bg-amber-50 px-2 py-0.5 rounded-full">Ausente</span> : missing ? <span className="text-xs text-red-600">em falta</span> : ""}</td>
                <td className="px-3 py-2.5">
                  <button
                    onClick={() => setEditRow(row)}
                    className="p-1.5 rounded-lg text-[var(--color-text-muted)] hover:text-[var(--color-primary)] hover:bg-[var(--color-background)] transition-colors"
                    title="Editar registo"
                  >
                    <Pencil className="w-4 h-4" />
                  </button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      {editRow && (
        <EditModal
          row={editRow}
          onClose={() => setEditRow(null)}
          onSaved={() => { setEditRow(null); router.refresh(); }}
        />
      )}
    </div>
  );
}

// ─── Modal de edição ───────────────────────────────────────────────────────────

function EditModal({ row, onClose, onSaved }: { row: PontoRow; onClose: () => void; onSaved: () => void }) {
  const existing = row.timesheets.find((t) => t.clock_in_at) ?? row.timesheets[0] ?? null;
  const [inTime, setInTime] = useState(existing?.clock_in_at ? format(parseISO(existing.clock_in_at), "HH:mm") : "");
  const [outTime, setOutTime] = useState(existing?.clock_out_at ? format(parseISO(existing.clock_out_at), "HH:mm") : "");
  const [msg, setMsg] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();

  function toISO(time: string): string {
    return `${row.day}T${time}:00`;
  }

  function save() {
    setMsg(null);
    if (!inTime) { setMsg("Indica a hora de entrada."); return; }
    startTransition(async () => {
      const clockIn = toISO(inTime);
      const clockOut = outTime ? toISO(outTime) : null;
      let res: { ok: boolean; error?: string };
      if (existing) {
        res = await adminEditTimesheet(existing.id, { clock_in_at: clockIn, clock_out_at: clockOut });
      } else if (row.candidateServiceId) {
        res = await adminCreateTimesheet(row.candidateServiceId, row.collaboratorId, { clock_in_at: clockIn, clock_out_at: clockOut });
      } else {
        setMsg("Não há serviço associado a este dia para criar o registo.");
        return;
      }
      if (!res.ok) { setMsg(res.error ?? "Erro ao guardar."); return; }
      onSaved();
    });
  }

  return (
    <>
      <div className="fixed inset-0 bg-black/30 z-40" onClick={onClose} />
      <div className="fixed inset-0 z-50 flex items-center justify-center p-4 pointer-events-none">
        <div className="bg-white rounded-2xl shadow-xl w-full max-w-sm pointer-events-auto">
          <div className="flex items-center justify-between px-5 py-4 border-b border-[var(--color-border)]">
            <h3 className="text-sm font-semibold text-[var(--color-text-main)]">Editar registo de ponto</h3>
            <button onClick={onClose} className="p-1.5 rounded-lg text-[var(--color-text-muted)] hover:bg-[var(--color-background)]">
              <X className="w-5 h-5" />
            </button>
          </div>
          <div className="px-5 py-4 space-y-4">
            <p className="text-sm text-[var(--color-text-sub)]">
              <span className="font-medium text-[var(--color-text-main)]">{row.collaboratorName}</span>
              {" · "}
              <span className="capitalize">{dayLabel(row.day)}</span>
            </p>
            <div className="grid grid-cols-2 gap-3">
              <div>
                <label className="block text-xs font-medium text-[var(--color-text-muted)] mb-1">Entrada</label>
                <input type="time" value={inTime} onChange={(e) => setInTime(e.target.value)} className={INPUT_CLS + " w-full"} />
              </div>
              <div>
                <label className="block text-xs font-medium text-[var(--color-text-muted)] mb-1">Saída</label>
                <input type="time" value={outTime} onChange={(e) => setOutTime(e.target.value)} className={INPUT_CLS + " w-full"} />
              </div>
            </div>
            {!existing && !row.candidateServiceId && (
              <p className="text-xs text-amber-700 bg-amber-50 rounded-lg px-3 py-2">
                Este dia não tem serviço agendado para este colaborador — não é possível criar um registo manual.
              </p>
            )}
            {msg && <p className="text-sm text-red-600 bg-red-50 rounded-lg px-3 py-2">{msg}</p>}
          </div>
          <div className="px-5 py-4 border-t border-[var(--color-border)]">
            <button
              onClick={save}
              disabled={pending}
              className="w-full flex items-center justify-center gap-2 px-4 py-2.5 rounded-xl bg-[var(--color-primary)] text-white text-sm font-semibold hover:bg-[var(--color-primary-hover)] transition-colors disabled:opacity-50"
            >
              {pending && <Loader2 className="w-4 h-4 animate-spin" />}
              Guardar
            </button>
          </div>
        </div>
      </div>
    </>
  );
}

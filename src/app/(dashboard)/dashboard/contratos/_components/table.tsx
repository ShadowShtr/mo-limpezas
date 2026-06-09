"use client";

import { useState } from "react";
import { Search, MoreHorizontal, Calendar, MapPin } from "lucide-react";
import { ContratoSheet } from "./sheet";
import { usePagination, Pagination } from "@/components/ui/pagination";
import type { ContratosTableRow } from "../page";
import type { ScheduleDay } from "@/types/database";

const FREQUENCY_LABEL: Record<string, string> = {
  daily: "Diário",
  weekly: "Semanal",
  biweekly: "Quinzenal",
  monthly: "Mensal",
  custom: "Personalizado",
};

const WEEKDAY_SHORT = ["Dom", "Seg", "Ter", "Qua", "Qui", "Sex", "Sáb"];

const STATUS_STYLES: Record<string, string> = {
  ativo: "bg-[var(--color-primary-light)] text-[var(--color-primary)]",
  pausado: "bg-amber-50 text-amber-700",
  cancelado: "bg-red-50 text-red-600",
};

function formatDate(d: string) {
  return new Date(d + "T00:00:00").toLocaleDateString("pt-PT", {
    day: "2-digit", month: "short", year: "numeric",
  });
}

function nextOccurrence(contrato: ContratosTableRow): string {
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  const start = new Date(contrato.starts_on + "T00:00:00");
  const base = start > today ? start : today;

  if (contrato.frequency === "daily") {
    return base.toLocaleDateString("pt-PT", { day: "2-digit", month: "short" });
  }

  if (contrato.frequency === "weekly" || contrato.frequency === "biweekly") {
    const weekdays = contrato.weekdays ?? [];
    if (weekdays.length === 0) return "—";
    for (let i = 0; i < 14; i++) {
      const d = new Date(base);
      d.setDate(base.getDate() + i);
      if (weekdays.includes(d.getDay())) {
        return d.toLocaleDateString("pt-PT", { weekday: "short", day: "2-digit", month: "short" });
      }
    }
    return "—";
  }

  if (contrato.frequency === "monthly") {
    return base.toLocaleDateString("pt-PT", { day: "2-digit", month: "short" });
  }

  return "—";
}

interface Props {
  contratos: ContratosTableRow[];
  companyId: string;
  userId: string;
  clientes: { id: string; name: string }[];
  locais: { id: string; client_id: string; name: string; address: string; hourly_rate: number | null }[];
  equipas: { id: string; name: string; color: string }[];
}

export function ContratosTable({ contratos, companyId, userId, clientes, locais, equipas }: Props) {
  const [search, setSearch] = useState("");
  const [filterStatus, setFilterStatus] = useState("todos");
  const [filterFreq, setFilterFreq] = useState("todos");

  const filtered = contratos.filter((c) => {
    const haystack = [
      c.name ?? "",
      c.locations?.name ?? "",
      c.locations?.clients?.name ?? "",
      c.locations?.address ?? "",
    ].join(" ").toLowerCase();
    const matchSearch = search === "" || haystack.includes(search.toLowerCase());
    const matchStatus = filterStatus === "todos" || c.status === filterStatus;
    const matchFreq = filterFreq === "todos" || c.frequency === filterFreq;
    return matchSearch && matchStatus && matchFreq;
  });

  const pag = usePagination(filtered, 10);
  const paginated = pag.pageItems;

  return (
    <div className="bg-white rounded-xl border border-[var(--color-border)]">
      {/* Filtros */}
      <div className="flex flex-wrap items-center gap-3 p-4 border-b border-[var(--color-border)]">
        <div className="relative flex-1 min-w-48">
          <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-[var(--color-text-muted)]" />
          <input
            value={search}
            onChange={(e) => { setSearch(e.target.value); pag.setPage(1); }}
            placeholder="Pesquisar contrato, local, cliente..."
            className="w-full pl-9 pr-3 py-2 text-sm rounded-lg border border-[var(--color-border)] bg-white
                       text-[var(--color-text-main)] placeholder:text-[var(--color-text-muted)]
                       focus:outline-none focus:ring-2 focus:ring-[var(--color-primary)] focus:border-transparent"
          />
        </div>
        <select
          value={filterStatus}
          onChange={(e) => { setFilterStatus(e.target.value); pag.setPage(1); }}
          className="text-sm rounded-lg border border-[var(--color-border)] px-3 py-2 bg-white text-[var(--color-text-main)] focus:outline-none focus:ring-2 focus:ring-[var(--color-primary)]"
        >
          <option value="todos">Todos os estados</option>
          <option value="ativo">Ativo</option>
          <option value="pausado">Pausado</option>
          <option value="cancelado">Cancelado</option>
        </select>
        <select
          value={filterFreq}
          onChange={(e) => { setFilterFreq(e.target.value); pag.setPage(1); }}
          className="text-sm rounded-lg border border-[var(--color-border)] px-3 py-2 bg-white text-[var(--color-text-main)] focus:outline-none focus:ring-2 focus:ring-[var(--color-primary)]"
        >
          <option value="todos">Todas as frequências</option>
          <option value="daily">Diário</option>
          <option value="weekly">Semanal</option>
          <option value="biweekly">Quinzenal</option>
          <option value="monthly">Mensal</option>
          <option value="custom">Personalizado</option>
        </select>
      </div>

      <div className="overflow-x-auto">
        <table className="w-full">
          <thead>
            <tr className="bg-[var(--color-background)] border-b border-[var(--color-border)]">
              <th className="text-left px-4 py-3 text-xs font-medium text-[var(--color-text-muted)] uppercase tracking-wide">Contrato / Local</th>
              <th className="text-left px-4 py-3 text-xs font-medium text-[var(--color-text-muted)] uppercase tracking-wide">Frequência</th>
              <th className="text-left px-4 py-3 text-xs font-medium text-[var(--color-text-muted)] uppercase tracking-wide">Vigência</th>
              <th className="text-left px-4 py-3 text-xs font-medium text-[var(--color-text-muted)] uppercase tracking-wide">Próxima ocorrência</th>
              <th className="text-left px-4 py-3 text-xs font-medium text-[var(--color-text-muted)] uppercase tracking-wide">Estado</th>
              <th className="px-4 py-3" />
            </tr>
          </thead>
          <tbody className="divide-y divide-[var(--color-border)]">
            {paginated.length === 0 ? (
              <tr>
                <td colSpan={6} className="text-center py-12 text-sm text-[var(--color-text-muted)]">
                  {search ? "Nenhum contrato encontrado." : "Ainda não há contratos."}
                </td>
              </tr>
            ) : (
              paginated.map((c) => (
                <tr key={c.id} className="hover:bg-[var(--color-background)] transition-colors">
                  {/* Contrato / Local */}
                  <td className="px-4 py-3">
                    <div className="flex items-start gap-3">
                      <div className="w-9 h-9 rounded-lg bg-[var(--color-primary-light)] flex items-center justify-center shrink-0 mt-0.5">
                        <Calendar className="w-4 h-4 text-[var(--color-primary)]" />
                      </div>
                      <div>
                        <p className="text-sm font-medium text-[var(--color-text-main)]">
                          {c.name ?? c.locations?.name ?? "Contrato sem nome"}
                        </p>
                        <div className="flex items-center gap-1 mt-0.5">
                          <MapPin className="w-3 h-3 text-[var(--color-text-muted)]" />
                          <p className="text-xs text-[var(--color-text-muted)]">
                            {c.locations?.name ?? "—"}
                            {c.locations?.clients?.name ? ` · ${c.locations.clients.name}` : ""}
                          </p>
                        </div>
                        {/* Dias da semana para semanal */}
                        {(c.frequency === "weekly" || c.frequency === "biweekly") && (c.weekdays ?? []).length > 0 && (
                          <div className="flex gap-1 mt-1">
                            {(c.weekdays ?? []).sort().map((d) => (
                              <span key={d} className="text-[10px] font-medium px-1.5 py-0.5 rounded bg-[var(--color-background)] text-[var(--color-text-sub)]">
                                {WEEKDAY_SHORT[d]}
                              </span>
                            ))}
                          </div>
                        )}
                        {/* Equipas do schedule_days */}
                        <TeamsPreview scheduleDays={c.schedule_days} equipas={equipas} />
                      </div>
                    </div>
                  </td>

                  {/* Frequência */}
                  <td className="px-4 py-3">
                    <span className="text-sm text-[var(--color-text-main)]">
                      {FREQUENCY_LABEL[c.frequency] ?? c.frequency}
                    </span>
                  </td>

                  {/* Vigência */}
                  <td className="px-4 py-3">
                    <p className="text-sm text-[var(--color-text-main)]">{formatDate(c.starts_on)}</p>
                    {c.ends_on ? (
                      <p className="text-xs text-[var(--color-text-muted)]">até {formatDate(c.ends_on)}</p>
                    ) : (
                      <p className="text-xs text-[var(--color-text-muted)]">sem data de fim</p>
                    )}
                  </td>

                  {/* Próxima ocorrência */}
                  <td className="px-4 py-3">
                    {c.status === "ativo" ? (
                      <p className="text-sm text-[var(--color-text-main)]">{nextOccurrence(c)}</p>
                    ) : (
                      <p className="text-xs text-[var(--color-text-muted)]">—</p>
                    )}
                  </td>

                  {/* Estado */}
                  <td className="px-4 py-3">
                    <span className={`text-xs font-medium px-2.5 py-1 rounded-full capitalize ${STATUS_STYLES[c.status] ?? ""}`}>
                      {c.status}
                    </span>
                  </td>

                  {/* Ações */}
                  <td className="px-4 py-3">
                    <ContratoSheet
                      companyId={companyId}
                      userId={userId}
                      clientes={clientes}
                      locais={locais}
                      equipas={equipas}
                      contrato={c}
                      trigger={
                        <button className="p-1.5 rounded-lg text-[var(--color-text-muted)] hover:bg-[var(--color-background)] transition-colors">
                          <MoreHorizontal className="w-4 h-4" />
                        </button>
                      }
                    />
                  </td>
                </tr>
              ))
            )}
          </tbody>
        </table>
      </div>

      <Pagination {...pag} />
    </div>
  );
}

function TeamsPreview({ scheduleDays, equipas }: { scheduleDays: ScheduleDay[]; equipas: { id: string; name: string; color: string }[] }) {
  const uniqueTeamIds = [...new Set(scheduleDays.map((s) => s.team_id).filter(Boolean))];
  if (uniqueTeamIds.length === 0) return null;
  const teams = uniqueTeamIds.map((tid) => equipas.find((e) => e.id === tid)).filter(Boolean) as typeof equipas;
  return (
    <div className="flex gap-1 mt-1">
      {teams.map((t) => (
        <span key={t.id} className="text-[10px] font-medium px-1.5 py-0.5 rounded" style={{ backgroundColor: t.color + "22", color: t.color }}>
          {t.name}
        </span>
      ))}
    </div>
  );
}

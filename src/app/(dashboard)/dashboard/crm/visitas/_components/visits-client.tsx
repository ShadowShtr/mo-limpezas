"use client";

// ============================================================================
// A agenda de visitas
// ============================================================================
//
// Lista, e não calendário. Uma empresa deste tamanho faz poucas visitas por
// semana, e a pergunta real é «o que tenho para ver a seguir?» — a que uma
// lista ordenada por data responde melhor, e sem construir uma grelha nova.
//
// 🔴 Nada aqui toca no calendário operacional.
// ============================================================================

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import Link from "next/link";
import { CalendarPlus, MapPin, TriangleAlert, User } from "lucide-react";

import { useToast } from "@/components/ui/toast";
import { usePagination, Pagination } from "@/components/ui/pagination";
import {
  VISIT_STATUSES,
  VISIT_STATUS_LABELS,
  isVisitStatus,
  type VisitStatus,
} from "@/lib/crm/visits";
import { type VisitRow } from "@/app/actions/crm-visitas";
import type { LeadRow } from "@/app/actions/crm-leads";

import { VisitSheet } from "./visit-sheet";
import { VisitOutcomeSheet } from "./visit-outcome-sheet";

interface Props {
  visitas: VisitRow[] | null;
  erro: string | null;
  leads: LeadRow[];
  membros: { id: string; full_name: string }[];
}

const CORES: Record<VisitStatus, string> = {
  agendada: "bg-blue-50 text-blue-700",
  realizada: "bg-green-50 text-green-700",
  nao_compareceu: "bg-amber-50 text-amber-700",
  cancelada: "bg-slate-100 text-slate-600",
};

function fmtQuando(iso: string): string {
  // Fuso explícito: o processo corre em UTC na Vercel.
  return new Intl.DateTimeFormat("pt-PT", {
    dateStyle: "medium",
    timeStyle: "short",
    timeZone: "Europe/Lisbon",
  }).format(new Date(iso));
}

export function VisitsClient({ visitas, erro, leads, membros }: Props) {
  const router = useRouter();
  const { toast } = useToast();
  const [, startTransition] = useTransition();

  const [filtroEstado, setFiltroEstado] = useState<string>("agendada");
  const [aMarcar, setAMarcar] = useState(false);
  const [aFechar, setAFechar] = useState<VisitRow | null>(null);

  const lista = visitas ?? [];
  const filtradas = filtroEstado ? lista.filter((v) => v.status === filtroEstado) : lista;
  const paginacao = usePagination(filtradas, 10);

  if (erro) {
    return (
      <div
        className="rounded-xl border bg-white p-8 text-center"
        style={{ borderColor: "var(--color-border)" }}
      >
        <TriangleAlert className="mx-auto h-8 w-8 text-amber-500" />
        <p className="mt-3 text-sm font-medium">Não foi possível carregar as visitas.</p>
        <p className="mt-1 text-[13px]" style={{ color: "var(--color-text-muted)" }}>{erro}</p>
        <button
          onClick={() => startTransition(() => router.refresh())}
          className="mt-4 rounded-lg border px-3 py-1.5 text-[13px] font-medium"
          style={{ borderColor: "var(--color-border)" }}
        >
          Tentar de novo
        </button>
      </div>
    );
  }

  return (
    <div>
      <div className="mb-4 flex flex-wrap items-center gap-2">
        <button
          onClick={() => setAMarcar(true)}
          className="flex items-center gap-1.5 rounded-lg px-3 py-2 text-[13px] font-semibold text-white"
          style={{ background: "#16A34A" }}
        >
          <CalendarPlus className="h-4 w-4" />
          Marcar visita
        </button>

        <select
          value={filtroEstado}
          onChange={(e) => setFiltroEstado(e.target.value)}
          className="rounded-lg border px-3 py-2 text-[13px]"
          style={{ borderColor: "var(--color-border)" }}
          aria-label="Filtrar por estado"
        >
          <option value="">Todas</option>
          {VISIT_STATUSES.map((s) => (
            <option key={s} value={s}>{VISIT_STATUS_LABELS[s]}</option>
          ))}
        </select>

        <span className="ml-auto text-[13px]" style={{ color: "var(--color-text-muted)" }}>
          {filtradas.length} {filtradas.length === 1 ? "visita" : "visitas"}
        </span>
      </div>

      <div
        className="overflow-hidden rounded-xl border bg-white"
        style={{ borderColor: "var(--color-border)" }}
      >
        {filtradas.length === 0 ? (
          <p className="p-8 text-center text-[13px]" style={{ color: "var(--color-text-muted)" }}>
            {filtroEstado === "agendada"
              ? "Não há visitas por fazer."
              : "Não há visitas com este estado."}
          </p>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-left text-[13px]">
              <thead
                className="border-b text-[11.5px] uppercase tracking-wide"
                style={{ borderColor: "var(--color-border)", color: "var(--color-text-muted)" }}
              >
                <tr>
                  <th className="px-4 py-2.5 font-medium">Quando</th>
                  <th className="px-4 py-2.5 font-medium">Quem</th>
                  <th className="px-4 py-2.5 font-medium">Responsável</th>
                  <th className="px-4 py-2.5 font-medium">Estado</th>
                  <th className="px-4 py-2.5 font-medium" />
                </tr>
              </thead>
              <tbody>
                {paginacao.pageItems.map((v) => {
                  const estado = isVisitStatus(v.status) ? v.status : null;
                  return (
                    <tr
                      key={v.id}
                      className="border-b last:border-0"
                      style={{ borderColor: "var(--color-border)" }}
                    >
                      <td className="px-4 py-3 whitespace-nowrap">{fmtQuando(v.scheduled_start)}</td>
                      <td className="px-4 py-3">
                        {v.lead_id ? (
                          <Link
                            href={`/dashboard/crm/${v.lead_id}`}
                            className="font-medium"
                            style={{ color: "#16A34A" }}
                          >
                            {v.target_name}
                          </Link>
                        ) : (
                          <span className="font-medium">{v.target_name}</span>
                        )}
                        {v.address && (
                          <span
                            className="mt-0.5 flex items-center gap-1 text-[11.5px]"
                            style={{ color: "var(--color-text-muted)" }}
                          >
                            <MapPin className="h-3 w-3 shrink-0" />
                            {v.address}
                          </span>
                        )}
                      </td>
                      <td className="px-4 py-3">
                        <span
                          className="flex items-center gap-1"
                          style={{ color: v.assigned_name ? undefined : "var(--color-text-muted)" }}
                        >
                          <User className="h-3.5 w-3.5 shrink-0" />
                          {v.assigned_name ?? "Sem responsável"}
                        </span>
                      </td>
                      <td className="px-4 py-3">
                        <span
                          className={`rounded-full px-2 py-0.5 text-[11.5px] font-medium ${
                            estado ? CORES[estado] : "bg-slate-100 text-slate-600"
                          }`}
                        >
                          {estado ? VISIT_STATUS_LABELS[estado] : v.status}
                        </span>
                        {v.area_sqm != null && (
                          <span
                            className="ml-1.5 text-[11.5px]"
                            style={{ color: "var(--color-text-muted)" }}
                          >
                            {v.area_sqm} m²
                          </span>
                        )}
                      </td>
                      <td className="px-4 py-3 text-right whitespace-nowrap">
                        {estado === "agendada" ? (
                          <button
                            onClick={() => setAFechar(v)}
                            className="rounded-lg border px-2.5 py-1 text-[12.5px] font-medium"
                            style={{ borderColor: "var(--color-border)" }}
                          >
                            Registar resultado
                          </button>
                        ) : (
                          <button
                            onClick={() => setAFechar(v)}
                            className="text-[12.5px] font-medium"
                            style={{ color: "var(--color-text-muted)" }}
                          >
                            Ver
                          </button>
                        )}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </div>

      {filtradas.length > 0 && <Pagination {...paginacao} hideWhenSinglePage />}

      {aMarcar && (
        <VisitSheet
          leads={leads}
          membros={membros}
          onClose={() => setAMarcar(false)}
          onDone={() => {
            setAMarcar(false);
            toast("Visita marcada.", "success");
            router.refresh();
          }}
        />
      )}

      {aFechar && (
        <VisitOutcomeSheet
          visita={aFechar}
          onClose={() => setAFechar(null)}
          onDone={() => {
            setAFechar(null);
            toast("Resultado registado.", "success");
            router.refresh();
          }}
        />
      )}
    </div>
  );
}

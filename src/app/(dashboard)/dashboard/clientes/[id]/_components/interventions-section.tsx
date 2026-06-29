"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import Link from "next/link";
import { format, parseISO } from "date-fns";
import { pt } from "date-fns/locale";
import { CalendarClock, Copy, Edit2, Pause, Plus, Archive, CalendarPlus, Trash2 } from "lucide-react";
import { ContratoSheet } from "../../../contratos/_components/sheet";
import { ServiceCreateSheet } from "../../../calendario/_components/service-create-sheet";
import { duplicatePointService, setContractInterventionStatus } from "@/app/actions/intervencoes";
import { deleteContrato } from "@/app/actions/contratos";
import type { ContratosTableRow } from "../../../contratos/page";

type ClientRef = { id: string; name: string };
type LocalRef = {
  id: string;
  client_id: string;
  name: string;
  address: string;
  hourly_rate: number | null;
  access_code?: string | null;
  instructions?: string | null;
  has_key?: boolean | null;
  key_label?: string | null;
};
type TeamRef = { id: string; name: string; color: string; member_count?: number };
type PointService = {
  id: string;
  reference_number: string;
  location_id: string;
  location_name: string;
  scheduled_start: string;
  scheduled_end: string;
  status: string;
  team_name: string | null;
  team_color: string | null;
  notes: string | null;
};

const CONTRACT_STATUS: Record<string, { label: string; cls: string }> = {
  ativo: { label: "Ativa", cls: "bg-emerald-50 text-emerald-700" },
  pausado: { label: "Pausada", cls: "bg-amber-50 text-amber-700" },
  cancelado: { label: "Arquivada", cls: "bg-slate-100 text-slate-600" },
};

const SERVICE_STATUS: Record<string, string> = {
  agendado: "Agendado",
  em_curso: "Em curso",
  concluido: "Concluído",
  cancelado: "Cancelado",
  falta: "Falta",
};

const INTERVENTION_LABELS = {
  createTitle: "Nova intervenção recorrente",
  editTitle: "Editar intervenção",
  createButton: "Criar intervenção",
  editButton: "Guardar intervenção",
  nameLabel: "Nome da intervenção",
  namePlaceholder: "ex: Limpeza semanal escritório",
  createdMessage: "Intervenção criada.",
  updatedMessage: "Intervenção atualizada.",
};

function frequencyLabel(contract: ContratosTableRow) {
  if (contract.frequency === "daily") return "Diária";
  if (contract.frequency === "weekly") return "Semanal";
  if (contract.frequency === "biweekly") return "Quinzenal";
  if (contract.frequency === "monthly") return "Mensal";
  if (contract.frequency === "custom") return `A cada ${contract.interval_days ?? 1} dias`;
  return contract.frequency;
}

function ActionButton({
  children,
  onClick,
  title,
}: {
  children: React.ReactNode;
  onClick: () => Promise<void>;
  title: string;
}) {
  const [pending, startTransition] = useTransition();
  return (
    <button
      type="button"
      title={title}
      disabled={pending}
      onClick={() => startTransition(onClick)}
      className="inline-flex h-8 w-8 items-center justify-center rounded-lg border border-[var(--color-border)] text-[var(--color-text-sub)] hover:bg-[var(--color-background)] disabled:opacity-50"
    >
      {children}
    </button>
  );
}

export function InterventionsSection({
  companyId,
  userId,
  client,
  locais,
  equipas,
  contratos,
  pointServices,
}: {
  companyId: string;
  userId: string;
  client: ClientRef;
  locais: LocalRef[];
  equipas: TeamRef[];
  contratos: ContratosTableRow[];
  pointServices: PointService[];
}) {
  const router = useRouter();
  const [serviceOpen, setServiceOpen] = useState(false);
  const [serviceDate] = useState(() => new Date());
  const [message, setMessage] = useState<string | null>(null);
  const clientes = [client];

  async function refreshAfter(action: Promise<{ ok: true } | { ok: false; error: string }>) {
    setMessage(null);
    const res = await action;
    if (!res.ok) {
      setMessage(res.error);
      return;
    }
    router.refresh();
  }

  return (
    <section className="bg-white rounded-xl border border-[var(--color-border)] p-5">
      <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between mb-4">
        <h2 className="text-sm font-semibold text-[var(--color-text-main)] flex items-center gap-2">
          <CalendarClock className="w-4 h-4 text-[var(--color-primary)]" />
          Intervenções / Serviços
          <span className="text-[var(--color-text-muted)] font-normal">
            ({contratos.length + pointServices.length})
          </span>
        </h2>
        <div className="flex flex-wrap gap-2">
          <ContratoSheet
            companyId={companyId}
            userId={userId}
            clientes={clientes}
            locais={locais}
            equipas={equipas}
            fixedClientId={client.id}
            labels={INTERVENTION_LABELS}
            trigger={
              <button className="flex items-center gap-2 px-3 py-2 rounded-lg bg-[var(--color-primary)] text-white text-sm font-medium hover:bg-[var(--color-primary-hover)] transition-colors">
                <Plus className="w-4 h-4" />
                Criar intervenção
              </button>
            }
          />
          <button
            type="button"
            onClick={() => setServiceOpen(true)}
            className="flex items-center gap-2 px-3 py-2 rounded-lg border border-[var(--color-border)] text-[var(--color-text-sub)] text-sm font-medium hover:bg-[var(--color-background)] transition-colors"
          >
            <CalendarPlus className="w-4 h-4" />
            Serviço pontual
          </button>
        </div>
      </div>

      {message && (
        <div className="mb-3 rounded-lg border border-red-100 bg-red-50 px-3 py-2 text-sm text-red-700">
          {message}
        </div>
      )}

      <div className="space-y-4">
        <div>
          <p className="mb-2 text-xs font-semibold uppercase tracking-wide text-[var(--color-text-muted)]">
            Recorrentes
          </p>
          {contratos.length === 0 ? (
            <p className="rounded-lg border border-dashed border-[var(--color-border)] py-4 text-center text-sm text-[var(--color-text-muted)]">
              Nenhuma intervenção recorrente.
            </p>
          ) : (
            <div className="space-y-2">
              {contratos.map((contract) => {
                const status = CONTRACT_STATUS[contract.status] ?? CONTRACT_STATUS.ativo;
                return (
                  <div key={contract.id} className="flex items-center gap-3 rounded-lg border border-[var(--color-border)] px-3 py-2.5">
                    <div className="min-w-0 flex-1">
                      <div className="flex flex-wrap items-center gap-2">
                        <p className="truncate text-sm font-medium text-[var(--color-text-main)]">
                          {contract.name || contract.locations?.name || "Intervenção recorrente"}
                        </p>
                        <span className={`rounded-full px-2 py-0.5 text-xs font-semibold ${status.cls}`}>
                          {status.label}
                        </span>
                      </div>
                      <p className="mt-0.5 text-xs text-[var(--color-text-muted)]">
                        {contract.locations?.name ?? "Local sem nome"} · {frequencyLabel(contract)} · desde{" "}
                        {format(parseISO(contract.starts_on), "d MMM yyyy", { locale: pt })}
                      </p>
                    </div>
                    <ContratoSheet
                      companyId={companyId}
                      userId={userId}
                      clientes={clientes}
                      locais={locais}
                      equipas={equipas}
                      contrato={contract}
                      fixedClientId={client.id}
                      labels={INTERVENTION_LABELS}
                      trigger={
                        <button title="Editar" className="inline-flex h-8 w-8 items-center justify-center rounded-lg border border-[var(--color-border)] text-[var(--color-text-sub)] hover:bg-[var(--color-background)]">
                          <Edit2 className="w-4 h-4" />
                        </button>
                      }
                    />
                    <ContratoSheet
                      companyId={companyId}
                      userId={userId}
                      clientes={clientes}
                      locais={locais}
                      equipas={equipas}
                      copyFrom={contract}
                      fixedClientId={client.id}
                      labels={{ ...INTERVENTION_LABELS, createTitle: "Duplicar intervenção", createButton: "Criar cópia" }}
                      trigger={
                        <button title="Duplicar" className="inline-flex h-8 w-8 items-center justify-center rounded-lg border border-[var(--color-border)] text-[var(--color-text-sub)] hover:bg-[var(--color-background)]">
                          <Copy className="w-4 h-4" />
                        </button>
                      }
                    />
                    {contract.status === "ativo" && (
                      <ActionButton
                        title="Pausar"
                        onClick={() => refreshAfter(setContractInterventionStatus(contract.id, "pausado"))}
                      >
                        <Pause className="w-4 h-4" />
                      </ActionButton>
                    )}
                    {contract.status !== "cancelado" && (
                      <ActionButton
                        title="Arquivar"
                        onClick={() => refreshAfter(setContractInterventionStatus(contract.id, "cancelado"))}
                      >
                        <Archive className="w-4 h-4" />
                      </ActionButton>
                    )}
                    <ActionButton
                      title="Excluir intervenção"
                      onClick={async () => {
                        if (!window.confirm(
                          `Excluir "${contract.name || contract.locations?.name || "esta intervenção"}"?\n\nApaga a intervenção e os serviços futuros agendados. Não pode ser desfeito.`,
                        )) return;
                        await refreshAfter(deleteContrato(contract.id));
                      }}
                    >
                      <Trash2 className="w-4 h-4" />
                    </ActionButton>
                  </div>
                );
              })}
            </div>
          )}
        </div>

        <div>
          <p className="mb-2 text-xs font-semibold uppercase tracking-wide text-[var(--color-text-muted)]">
            Pontuais
          </p>
          {pointServices.length === 0 ? (
            <p className="rounded-lg border border-dashed border-[var(--color-border)] py-4 text-center text-sm text-[var(--color-text-muted)]">
              Nenhum serviço pontual recente.
            </p>
          ) : (
            <div className="space-y-2">
              {pointServices.map((service) => (
                <div key={service.id} className="flex items-center gap-3 rounded-lg border border-[var(--color-border)] px-3 py-2.5">
                  <div className="min-w-0 flex-1">
                    <div className="flex flex-wrap items-center gap-2">
                      <p className="truncate text-sm font-medium text-[var(--color-text-main)]">{service.location_name}</p>
                      <span className="rounded-full bg-slate-100 px-2 py-0.5 text-xs font-semibold text-slate-600">
                        {SERVICE_STATUS[service.status] ?? service.status}
                      </span>
                    </div>
                    <p className="mt-0.5 text-xs text-[var(--color-text-muted)]">
                      #{service.reference_number} · {format(parseISO(service.scheduled_start), "d MMM yyyy HH:mm", { locale: pt })}
                      {service.team_name ? ` · ${service.team_name}` : ""}
                    </p>
                  </div>
                  <Link
                    href={`/dashboard/calendario?date=${format(parseISO(service.scheduled_start), "yyyy-MM-dd")}`}
                    title="Editar no calendário"
                    className="inline-flex h-8 w-8 items-center justify-center rounded-lg border border-[var(--color-border)] text-[var(--color-text-sub)] hover:bg-[var(--color-background)]"
                  >
                    <Edit2 className="w-4 h-4" />
                  </Link>
                  <ActionButton
                    title="Duplicar para a próxima semana"
                    onClick={() => refreshAfter(duplicatePointService(service.id))}
                  >
                    <Copy className="w-4 h-4" />
                  </ActionButton>
                </div>
              ))}
            </div>
          )}
        </div>
      </div>

      <ServiceCreateSheet
        open={serviceOpen}
        onClose={() => setServiceOpen(false)}
        onCreated={() => router.refresh()}
        companyId={companyId}
        date={serviceDate}
        initialStartTime="09:00"
        initialTeamId=""
        clients={clientes}
        locations={locais}
        teams={equipas}
        fixedClientId={client.id}
        fixedLocationId={locais[0]?.id}
      />
    </section>
  );
}

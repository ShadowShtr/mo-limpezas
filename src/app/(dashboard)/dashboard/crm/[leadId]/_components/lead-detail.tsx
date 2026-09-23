"use client";

// ============================================================================
// A ficha da lead — dados, e o diário de contactos
// ============================================================================
//
// A timeline é a razão de esta página existir. Quem abre uma lead três semanas
// depois quer saber o que já foi dito e quando — e é isso que o quadro, por
// ser um quadro, não consegue mostrar.
//
// Os registos `sistema` (mudanças de estado) aparecem misturados com os
// manuais, de propósito: a história é uma só. O que os distingue é a marca
// visual, não uma lista separada.
// ============================================================================

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import {
  Archive,
  Mail,
  MessageSquare,
  Pencil,
  Phone,
  Plus,
  Settings2,
  Users,
} from "lucide-react";

import { useToast } from "@/components/ui/toast";
import { ConfirmDialog } from "@/components/ui/confirm-dialog";
import {
  LEAD_INTERACTION_KIND_LABELS,
  LEAD_LOST_REASON_LABELS,
  LEAD_SOURCE_LABELS,
  MANUAL_INTERACTION_KINDS,
  type LeadInteractionKind,
  type LeadLostReason,
  type LeadSource,
} from "@/lib/crm/sources";
import { LEAD_STAGE_LABELS, isLeadStage, type LeadStage } from "@/lib/crm/stages";
import {
  addLeadInteraction,
  archiveLead,
  type LeadInteractionRow,
  type LeadRow,
} from "@/app/actions/crm-leads";

import { LeadSheet } from "../../_components/lead-sheet";
import type { Membro } from "../../_components/pipeline-client";

interface Props {
  lead: LeadRow;
  interactions: LeadInteractionRow[];
  membros: Membro[];
}

const ICONE: Partial<Record<LeadInteractionKind, typeof Phone>> = {
  chamada: Phone,
  email: Mail,
  whatsapp: MessageSquare,
  reuniao: Users,
  sistema: Settings2,
};

function fmtEur(v: number | null): string {
  if (v == null) return "—";
  return new Intl.NumberFormat("pt-PT", { style: "currency", currency: "EUR" }).format(v);
}

function fmtQuando(iso: string): string {
  // `Intl` com fuso explícito: o processo corre em UTC na Vercel, e um
  // `toLocaleString` sem fuso mostraria a hora errada na primeira hora do dia.
  return new Intl.DateTimeFormat("pt-PT", {
    dateStyle: "short",
    timeStyle: "short",
    timeZone: "Europe/Lisbon",
  }).format(new Date(iso));
}

export function LeadDetail({ lead, interactions, membros }: Props) {
  const router = useRouter();
  const { toast } = useToast();
  const [pending, startTransition] = useTransition();

  const [aEditar, setAEditar] = useState(false);
  const [tipo, setTipo] = useState<string>("chamada");
  const [resumo, setResumo] = useState("");

  const estadoValido = isLeadStage(lead.stage);

  function registar(e: React.FormEvent) {
    e.preventDefault();
    if (!resumo.trim()) return;

    startTransition(async () => {
      const res = await addLeadInteraction(lead.id, { kind: tipo, summary: resumo });
      if (!res.ok) {
        toast(res.error.message, "error");
        return;
      }
      setResumo("");
      toast("Contacto registado.", "success");
      router.refresh();
    });
  }

  function arquivar() {
    startTransition(async () => {
      const res = await archiveLead(lead.id);
      if (!res.ok) {
        toast(res.error.message, "error");
        return;
      }
      toast("Lead arquivada.", "success");
      router.push("/dashboard/crm");
    });
  }

  return (
    <div className="grid gap-5 lg:grid-cols-[1fr_1.1fr]">
      {/* ── Dados ── */}
      <section
        className="rounded-xl border bg-white p-5"
        style={{ borderColor: "var(--color-border)" }}
      >
        <div className="flex items-start justify-between gap-3">
          <div>
            <span
              className="inline-block rounded-full bg-slate-100 px-2 py-0.5 text-[11px] font-semibold text-slate-700"
            >
              {/* A base garante o CHECK, mas `stage` chega aqui como `string`.
                  Sem a guarda, um valor inesperado indexaria o mapa e daria
                  `undefined` no ecrã — mostrar o valor cru é mais honesto. */}
              {estadoValido ? LEAD_STAGE_LABELS[lead.stage as LeadStage] : lead.stage}
            </span>
            <h2 className="mt-2 text-[16px] font-semibold">{lead.name}</h2>
            {lead.contact_name && (
              <p className="text-[13px]" style={{ color: "var(--color-text-muted)" }}>
                {lead.contact_name}
              </p>
            )}
          </div>
          <div className="flex shrink-0 gap-1.5">
            <button
              onClick={() => setAEditar(true)}
              className="flex items-center gap-1 rounded-lg border px-2.5 py-1.5 text-[12.5px] font-medium"
              style={{ borderColor: "var(--color-border)" }}
            >
              <Pencil className="h-3.5 w-3.5" />
              Editar
            </button>
            <ConfirmDialog
              trigger={
                <button
                  className="flex items-center gap-1 rounded-lg border px-2.5 py-1.5 text-[12.5px] font-medium"
                  style={{ borderColor: "var(--color-border)" }}
                >
                  <Archive className="h-3.5 w-3.5" />
                  Arquivar
                </button>
              }
              title="Arquivar esta lead?"
              description="Sai das listas mas não é apagada — o motivo da perda e o histórico continuam a contar nos relatórios."
              confirmLabel="Arquivar"
              onConfirm={arquivar}
            />
          </div>
        </div>

        <dl className="mt-4 grid grid-cols-2 gap-x-4 gap-y-3 text-[13px]">
          <Linha termo="Email" valor={lead.email} href={lead.email ? `mailto:${lead.email}` : null} />
          <Linha termo="Telefone" valor={lead.phone} href={lead.phone ? `tel:${lead.phone}` : null} />
          <Linha termo="NIF" valor={lead.nif} />
          <Linha termo="Responsável" valor={lead.owner_name} />
          <Linha
            termo="Morada"
            valor={lead.address}
            className="col-span-2"
          />
          <Linha
            termo="Valor estimado"
            valor={
              lead.estimated_value == null
                ? null
                : `${fmtEur(lead.estimated_value)}${lead.estimated_value_kind === "mensal" ? " / mês" : " (único)"}`
            }
          />
          <Linha
            termo="Origem"
            valor={
              lead.source
                ? [LEAD_SOURCE_LABELS[lead.source as LeadSource] ?? lead.source, lead.source_detail]
                    .filter(Boolean)
                    .join(" · ")
                : null
            }
          />
          <Linha termo="Tipo de serviço" valor={lead.service_type} />
          <Linha termo="Periodicidade" valor={lead.frequency_hint} />
          {lead.next_action_at && (
            <Linha
              termo="Próxima ação"
              valor={`${lead.next_action_note || "Por definir"} · ${lead.next_action_at}`}
              className="col-span-2"
            />
          )}
          {lead.lost_reason && (
            <Linha
              termo="Motivo da perda"
              valor={[
                LEAD_LOST_REASON_LABELS[lead.lost_reason as LeadLostReason] ?? lead.lost_reason,
                lead.lost_reason_notes,
              ]
                .filter(Boolean)
                .join(" · ")}
              className="col-span-2"
            />
          )}
          {/*
            🔴 A lead NÃO desaparece quando é convertida — passa a ser a
               história de como o cliente apareceu. Este link é o que torna
               essa história navegável: sem ele, a ficha diz «ganho» e não diz
               para onde.

               `converted_client_id` já vem em `LeadRow`; não é preciso
               schema novo nem sincronizar dados entre a lead e o cliente.
          */}
          {lead.converted_client_id && (
            <Linha
              termo="Cliente convertido"
              valor="Abrir cliente"
              href={`/dashboard/clientes/${lead.converted_client_id}`}
              className="col-span-2"
            />
          )}
        </dl>

        {lead.notes && (
          <div
            className="mt-4 rounded-lg border p-3 text-[13px] whitespace-pre-wrap"
            style={{ borderColor: "var(--color-border)", background: "var(--color-background)" }}
          >
            {lead.notes}
          </div>
        )}
      </section>

      {/* ── Diário de contactos ── */}
      <section
        className="rounded-xl border bg-white p-5"
        style={{ borderColor: "var(--color-border)" }}
      >
        <h2 className="text-[15px] font-semibold">Diário de contactos</h2>

        <form onSubmit={registar} className="mt-3 flex flex-col gap-2 sm:flex-row sm:items-start">
          <select
            value={tipo}
            onChange={(e) => setTipo(e.target.value)}
            className="rounded-lg border px-2.5 py-2 text-[13px] sm:w-[130px]"
            style={{ borderColor: "var(--color-border)" }}
            aria-label="Tipo de contacto"
          >
            {MANUAL_INTERACTION_KINDS.map((k) => (
              <option key={k} value={k}>
                {LEAD_INTERACTION_KIND_LABELS[k]}
              </option>
            ))}
          </select>
          <input
            value={resumo}
            onChange={(e) => setResumo(e.target.value)}
            maxLength={2000}
            placeholder="O que aconteceu"
            className="flex-1 rounded-lg border px-3 py-2 text-[13px]"
            style={{ borderColor: "var(--color-border)" }}
          />
          <button
            type="submit"
            disabled={pending || !resumo.trim()}
            className="flex items-center justify-center gap-1 rounded-lg px-3 py-2 text-[13px] font-semibold text-white disabled:opacity-50"
            style={{ background: "#16A34A" }}
          >
            <Plus className="h-4 w-4" />
            Registar
          </button>
        </form>

        <ol className="mt-4 space-y-3">
          {interactions.length === 0 && (
            <li className="text-[13px]" style={{ color: "var(--color-text-muted)" }}>
              Ainda não há contactos registados.
            </li>
          )}
          {interactions.map((i) => {
            const kind = i.kind as LeadInteractionKind;
            const Icone = ICONE[kind] ?? MessageSquare;
            const automatico = kind === "sistema";
            return (
              <li key={i.id} className="flex gap-3">
                <span
                  className={`mt-0.5 flex h-7 w-7 shrink-0 items-center justify-center rounded-full ${
                    automatico ? "bg-slate-100 text-slate-500" : "bg-green-50 text-green-700"
                  }`}
                >
                  <Icone className="h-3.5 w-3.5" />
                </span>
                <div className="min-w-0 flex-1">
                  <p className="text-[13px] leading-snug whitespace-pre-wrap">{i.summary}</p>
                  <p className="mt-0.5 text-[11.5px]" style={{ color: "var(--color-text-muted)" }}>
                    {LEAD_INTERACTION_KIND_LABELS[kind] ?? i.kind}
                    {" · "}
                    {fmtQuando(i.occurred_at)}
                    {i.author_name ? ` · ${i.author_name}` : ""}
                  </p>
                </div>
              </li>
            );
          })}
        </ol>
      </section>

      {aEditar && (
        <LeadSheet lead={lead} membros={membros} onClose={() => setAEditar(false)} />
      )}
    </div>
  );
}

function Linha({
  termo,
  valor,
  href,
  className = "",
}: {
  termo: string;
  valor: string | null;
  href?: string | null;
  className?: string;
}) {
  return (
    <div className={className}>
      <dt className="text-[11.5px] font-medium" style={{ color: "var(--color-text-muted)" }}>
        {termo}
      </dt>
      <dd className="mt-0.5 break-words">
        {valor ? (
          href ? (
            <a href={href} style={{ color: "#16A34A" }}>
              {valor}
            </a>
          ) : (
            valor
          )
        ) : (
          <span style={{ color: "var(--color-text-muted)" }}>—</span>
        )}
      </dd>
    </div>
  );
}

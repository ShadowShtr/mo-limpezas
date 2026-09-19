"use client";

// ============================================================================
// Marcar uma visita
// ============================================================================
//
// A data e a hora são escritas como data civil e convertidas com o fuso de
// Lisboa por `toLisbonTimestamp`. 🔴 `new Date("2026-09-16T10:00")` daria a
// hora do fuso do browser, e o servidor corre em UTC: uma visita marcada para
// as 10:00 ficaria gravada às 10:00 UTC, ou seja, às 11:00 em Lisboa no verão.
// ============================================================================

import { useEffect, useState, useTransition } from "react";
import { createPortal } from "react-dom";
import { X } from "lucide-react";

import { useToast } from "@/components/ui/toast";
import { toLisbonTimestamp, todayInLisbon } from "@/lib/lisbon-time";
import { VISIT_DEFAULT_DURATION_MIN } from "@/lib/crm/visits";
import { scheduleVisit } from "@/app/actions/crm-visitas";
import type { LeadRow } from "@/app/actions/crm-leads";

const CAMPO =
  "mt-1 w-full rounded-lg border px-3 py-2 text-[13px] font-normal bg-white border-[var(--color-border)]";

export interface ClienteOpcao {
  id: string;
  name: string;
}

interface Props {
  leads: LeadRow[];
  /**
   * 🔴 Os clientes existentes. A migration 102 aceita uma visita a uma lead
   *    OU a um cliente, e propor serviço novo a quem já é cliente é uma visita
   *    comercial na mesma. A primeira versão deste formulário só sabia marcar
   *    a leads e enviava `clientId: null` fixo — usava metade do modelo.
   */
  clientes: ClienteOpcao[];
  membros: { id: string; full_name: string }[];
  /** Quando a visita nasce da ficha de uma lead, já vem escolhida. */
  leadFixa?: LeadRow;
  onClose: () => void;
  onDone: () => void;
}

/** A visita é a uma lead ou a um cliente. Nunca aos dois, nunca a nenhum. */
type AlvoTipo = "lead" | "cliente";

/** Soma minutos a uma hora "HH:MM", sem passar por `Date`. */
function somarMinutos(hora: string, minutos: number): string {
  const [h, m] = hora.split(":").map(Number);
  const total = h * 60 + m + minutos;
  const hh = Math.floor((total % (24 * 60)) / 60);
  const mm = total % 60;
  return `${String(hh).padStart(2, "0")}:${String(mm).padStart(2, "0")}`;
}

export function VisitSheet({ leads, clientes, membros, leadFixa, onClose, onDone }: Props) {
  const { toast } = useToast();
  const [pending, startTransition] = useTransition();
  const [erros, setErros] = useState<Record<string, string[]>>({});

  // Com a lead já escolhida (visita nascida da ficha dela), o tipo fica fixo e
  // o selector de cliente nem aparece — não há nada a decidir.
  const [alvoTipo, setAlvoTipo] = useState<AlvoTipo>("lead");
  const [leadId, setLeadId] = useState(leadFixa?.id ?? "");
  const [clientId, setClientId] = useState("");
  const [data, setData] = useState(todayInLisbon());
  const [hora, setHora] = useState("10:00");
  const [duracao, setDuracao] = useState(String(VISIT_DEFAULT_DURATION_MIN));
  const [assignedTo, setAssignedTo] = useState("");
  const [address, setAddress] = useState(leadFixa?.address ?? "");

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape" && !pending) onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose, pending]);

  // A morada da lead escolhida entra por omissão — a visita é lá, quase sempre.
  function escolherLead(id: string) {
    setLeadId(id);
    const l = leads.find((x) => x.id === id);
    if (l?.address && !address) setAddress(l.address);
  }

  /** Trocar de tipo limpa o outro lado — nunca se enviam os dois. */
  function escolherTipo(tipo: AlvoTipo) {
    setAlvoTipo(tipo);
    if (tipo === "lead") setClientId("");
    else setLeadId("");
  }

  function escolherCliente(id: string) {
    setClientId(id);
  }

  const alvoEscolhido = alvoTipo === "lead" ? leadId : clientId;

  function submeter(e: React.FormEvent) {
    e.preventDefault();
    setErros({});

    const inicio = toLisbonTimestamp(data, hora);
    const fim = toLisbonTimestamp(data, somarMinutos(hora, Number(duracao)));

    startTransition(async () => {
      const res = await scheduleVisit({
        // Exactamente um dos dois vai preenchido. O outro vai `null`, e a
        // base recusaria na mesma se ambos viessem — o CHECK
        // `crm_visits_um_destinatario` é a última barreira.
        leadId: alvoTipo === "lead" ? leadId : null,
        clientId: alvoTipo === "cliente" ? clientId : null,
        scheduledStart: inicio,
        scheduledEnd: fim,
        assignedTo: assignedTo || null,
        address: address || null,
      });

      if (!res.ok) {
        if (res.error.fieldErrors) setErros(res.error.fieldErrors);
        toast(res.error.message, "error");
        return;
      }
      onDone();
    });
  }

  return createPortal(
    <div
      className="fixed inset-0 z-50 flex justify-end bg-black/40"
      role="dialog"
      aria-modal="true"
      aria-labelledby="titulo-visita"
      onClick={(e) => {
        if (e.target === e.currentTarget && !pending) onClose();
      }}
    >
      <form onSubmit={submeter} className="flex h-full w-full max-w-md flex-col bg-white shadow-xl">
        <div
          className="flex items-center justify-between border-b px-5 py-4"
          style={{ borderColor: "var(--color-border)" }}
        >
          <h2 id="titulo-visita" className="text-[15px] font-semibold">Marcar visita</h2>
          <button type="button" onClick={onClose} disabled={pending} aria-label="Fechar" className="rounded-lg p-1">
            <X className="h-4 w-4" />
          </button>
        </div>

        <div className="flex-1 space-y-4 overflow-y-auto px-5 py-4">
          {/* Com a lead fixa não há escolha a fazer: é a ela que se vai. */}
          {!leadFixa && (
            <fieldset>
              <legend className="text-[12.5px] font-medium">A quem se vai</legend>
              <div className="mt-2 flex gap-4">
                {([
                  ["lead", "Uma lead"],
                  ["cliente", "Um cliente"],
                ] as const).map(([valor, etiqueta]) => (
                  <label key={valor} className="flex items-center gap-2 text-[13px] font-normal">
                    <input
                      type="radio"
                      name="alvo"
                      value={valor}
                      checked={alvoTipo === valor}
                      onChange={() => escolherTipo(valor)}
                    />
                    {etiqueta}
                  </label>
                ))}
              </div>
            </fieldset>
          )}

          {alvoTipo === "lead" ? (
            <label className="block text-[12.5px] font-medium">
              Lead<span className="ml-0.5 text-red-500">*</span>
              <select
                value={leadId}
                onChange={(e) => escolherLead(e.target.value)}
                disabled={Boolean(leadFixa)}
                required
                className={CAMPO}
              >
                <option value="">Escolha a lead…</option>
                {leads.map((l) => (
                  <option key={l.id} value={l.id}>{l.name}</option>
                ))}
              </select>
              {erros.leadId?.[0] && (
                <span className="mt-0.5 block text-[11.5px] font-normal text-red-600">
                  {erros.leadId[0]}
                </span>
              )}
            </label>
          ) : (
            <label className="block text-[12.5px] font-medium">
              Cliente<span className="ml-0.5 text-red-500">*</span>
              <select
                value={clientId}
                onChange={(e) => escolherCliente(e.target.value)}
                required
                className={CAMPO}
              >
                <option value="">Escolha o cliente…</option>
                {clientes.map((c) => (
                  <option key={c.id} value={c.id}>{c.name}</option>
                ))}
              </select>
              {erros.clientId?.[0] && (
                <span className="mt-0.5 block text-[11.5px] font-normal text-red-600">
                  {erros.clientId[0]}
                </span>
              )}
            </label>
          )}

          <div className="grid grid-cols-3 gap-3">
            <label className="block text-[12.5px] font-medium">
              Dia
              <input
                type="date"
                value={data}
                onChange={(e) => {
                  // Ignora datas malformadas do input nativo — o ano com um
                  // dígito a mais já rebentou a ficha de um cliente real.
                  const v = e.target.value;
                  if (v === "" || /^\d{4}-\d{2}-\d{2}$/.test(v)) setData(v);
                }}
                required
                className={CAMPO}
              />
            </label>
            <label className="block text-[12.5px] font-medium">
              Hora
              <input
                type="time"
                value={hora}
                onChange={(e) => setHora(e.target.value)}
                required
                className={CAMPO}
              />
            </label>
            <label className="block text-[12.5px] font-medium">
              Duração
              <select value={duracao} onChange={(e) => setDuracao(e.target.value)} className={CAMPO}>
                <option value="30">30 min</option>
                <option value="60">1 hora</option>
                <option value="90">1h30</option>
                <option value="120">2 horas</option>
              </select>
            </label>
          </div>
          {erros.scheduledEnd?.[0] && (
            <p className="-mt-2 text-[11.5px] text-red-600">{erros.scheduledEnd[0]}</p>
          )}

          <label className="block text-[12.5px] font-medium">
            Quem vai
            <select value={assignedTo} onChange={(e) => setAssignedTo(e.target.value)} className={CAMPO}>
              <option value="">Ainda não definido</option>
              {membros.map((m) => (
                <option key={m.id} value={m.id}>{m.full_name}</option>
              ))}
            </select>
          </label>
          <p className="-mt-2 text-[11.5px]" style={{ color: "var(--color-text-muted)" }}>
            Quem for escolhido recebe um aviso.
          </p>

          <label className="block text-[12.5px] font-medium">
            Morada da visita
            <input
              value={address}
              onChange={(e) => setAddress(e.target.value)}
              placeholder="Se for diferente da morada da lead"
              className={CAMPO}
            />
          </label>

          <p
            className="rounded-lg border p-3 text-[11.5px]"
            style={{ borderColor: "var(--color-border)", background: "var(--color-background)" }}
          >
            Uma visita comercial não entra no calendário das equipas nem conta
            como serviço — é só para a parte comercial.
          </p>
        </div>

        <div
          className="flex justify-end gap-2 border-t px-5 py-4"
          style={{ borderColor: "var(--color-border)" }}
        >
          <button
            type="button"
            onClick={onClose}
            disabled={pending}
            className="rounded-lg border px-3 py-2 text-[13px] font-medium"
            style={{ borderColor: "var(--color-border)" }}
          >
            Cancelar
          </button>
          <button
            type="submit"
            disabled={pending || !alvoEscolhido}
            className="rounded-lg px-4 py-2 text-[13px] font-semibold text-white disabled:opacity-50"
            style={{ background: "#16A34A" }}
          >
            {pending ? "A marcar…" : "Marcar visita"}
          </button>
        </div>
      </form>
    </div>,
    document.body,
  );
}

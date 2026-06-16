"use client";

import { useState, useMemo } from "react";
import { X, Loader2, ChevronDown } from "lucide-react";
import { format } from "date-fns";
import { pt } from "date-fns/locale";
import { createClient } from "@/lib/supabase/client";
import { createService } from "../_actions/create-service";

type Client = { id: string; name: string };
type Location = { id: string; client_id: string; name: string; address: string; hourly_rate: number | null };
type Team = { id: string; name: string; color: string };

interface Props {
  open: boolean;
  onClose: () => void;
  onCreated: () => void;
  companyId: string;
  date: Date;
  initialStartTime: string; // "HH:MM"
  initialTeamId: string;
  clients: Client[];
  locations: Location[];
  teams: Team[];
}

const INPUT_CLS =
  "w-full px-3 py-2 rounded-lg border border-[var(--color-border)] text-sm text-[var(--color-text-main)] " +
  "focus:outline-none focus:ring-2 focus:ring-[var(--color-primary)] focus:border-transparent bg-white";

const SELECT_CLS =
  "w-full appearance-none px-3 py-2 pr-8 rounded-lg border border-[var(--color-border)] text-sm " +
  "text-[var(--color-text-main)] bg-white focus:outline-none focus:ring-2 focus:ring-[var(--color-primary)] focus:border-transparent";

function addMinutes(time: string, mins: number): string {
  const [h, m] = time.split(":").map(Number);
  const total = h * 60 + m + mins;
  const nh = Math.min(Math.floor(total / 60), 23);
  const nm = total % 60;
  return `${String(nh).padStart(2, "0")}:${String(nm).padStart(2, "0")}`;
}

function calcDuration(start: string, end: string): number {
  const [sh, sm] = start.split(":").map(Number);
  const [eh, em] = end.split(":").map(Number);
  return eh * 60 + em - (sh * 60 + sm);
}

export function ServiceCreateSheet({
  open, onClose, onCreated,
  companyId,
  date, initialStartTime, initialTeamId,
  clients, locations, teams,
}: Props) {
  const supabase = createClient();

  const [loading, setLoading] = useState(false);
  const [message, setMessage] = useState<string | null>(null);

  const [clientId, setClientId] = useState("");
  const [locationId, setLocationId] = useState("");
  const [teamId, setTeamId] = useState(initialTeamId);
  const [startTime, setStartTime] = useState(initialStartTime);
  const [endTime, setEndTime] = useState(addMinutes(initialStartTime, 120));
  const [notes, setNotes] = useState("");

  const filteredLocations = useMemo(
    () => (clientId ? locations.filter((l) => l.client_id === clientId) : locations),
    [clientId, locations],
  );

  const selectedLocation = useMemo(
    () => locations.find((l) => l.id === locationId) ?? null,
    [locationId, locations],
  );

  const durationMin = calcDuration(startTime, endTime);
  const calculatedValue =
    selectedLocation?.hourly_rate != null && durationMin > 0
      ? (durationMin / 60) * selectedLocation.hourly_rate
      : null;

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (!locationId) { setMessage("Seleciona um local."); return; }
    if (durationMin <= 0) { setMessage("A hora de fim deve ser posterior ao início."); return; }

    setLoading(true);
    setMessage(null);

    // Reference number: count + 1 (zero-padded to 4)
    const { count } = await supabase
      .from("services")
      .select("id", { count: "exact", head: true })
      .eq("company_id", companyId);

    const ref = String((count ?? 0) + 1).padStart(4, "0");

    const dateStr = format(date, "yyyy-MM-dd");
    const scheduledStart = `${dateStr}T${startTime}:00`;
    const scheduledEnd = `${dateStr}T${endTime}:00`;

    const res = await createService({
      companyId,
      locationId,
      teamId: teamId || null,
      referenceNumber: ref,
      scheduledStart,
      scheduledEnd,
      hourlyRate: selectedLocation?.hourly_rate ?? null,
      calculatedValue: calculatedValue ?? null,
      notes: notes || null,
    });

    setLoading(false);
    if (!res.ok) {
      setMessage("Erro ao criar: " + res.error);
    } else {
      onCreated();
      onClose();
    }
  }

  if (!open) return null;

  return (
    <>
      <div className="fixed inset-0 bg-black/30 z-40" onClick={onClose} />
      <div className="fixed right-0 top-0 h-full w-full max-w-lg bg-white shadow-xl z-50 flex flex-col">
        {/* Header */}
        <div className="flex items-center justify-between px-6 py-4 border-b border-[var(--color-border)]">
          <div>
            <h2 className="text-base font-semibold text-[var(--color-text-main)]">Novo serviço</h2>
            <p className="text-xs text-[var(--color-text-muted)] mt-0.5">
              {format(date, "EEEE, d 'de' MMMM yyyy", { locale: pt })} · {startTime}–{endTime}
            </p>
          </div>
          <button
            onClick={onClose}
            className="p-1.5 rounded-lg text-[var(--color-text-muted)] hover:bg-[var(--color-background)] transition-colors"
          >
            <X className="w-5 h-5" />
          </button>
        </div>

        {/* Body */}
        <form id="create-service-form" onSubmit={handleSubmit} className="flex-1 overflow-y-auto px-6 py-5 space-y-5">

          {/* Cliente → Local */}
          <div className="grid grid-cols-2 gap-3">
            <Field label="Cliente *">
              <div className="relative">
                <select
                  value={clientId}
                  onChange={(e) => { setClientId(e.target.value); setLocationId(""); }}
                  className={SELECT_CLS}
                >
                  <option value="">Selecionar...</option>
                  {clients.map((c) => (
                    <option key={c.id} value={c.id}>{c.name}</option>
                  ))}
                </select>
                <ChevronDown className="pointer-events-none absolute right-2 top-1/2 -translate-y-1/2 w-4 h-4 text-[var(--color-text-muted)]" />
              </div>
            </Field>
            <Field label="Local *">
              <div className="relative">
                <select
                  value={locationId}
                  onChange={(e) => setLocationId(e.target.value)}
                  disabled={!clientId}
                  className={SELECT_CLS + (clientId ? "" : " opacity-50 cursor-not-allowed")}
                >
                  <option value="">Selecionar...</option>
                  {filteredLocations.map((l) => (
                    <option key={l.id} value={l.id}>{l.name}</option>
                  ))}
                </select>
                <ChevronDown className="pointer-events-none absolute right-2 top-1/2 -translate-y-1/2 w-4 h-4 text-[var(--color-text-muted)]" />
              </div>
            </Field>
          </div>

          {/* Equipa */}
          <Field label="Equipa">
            <div className="relative">
              <select
                value={teamId}
                onChange={(e) => setTeamId(e.target.value)}
                className={SELECT_CLS}
              >
                <option value="">Sem equipa</option>
                {teams.map((t) => (
                  <option key={t.id} value={t.id}>{t.name}</option>
                ))}
              </select>
              <ChevronDown className="pointer-events-none absolute right-2 top-1/2 -translate-y-1/2 w-4 h-4 text-[var(--color-text-muted)]" />
            </div>
          </Field>

          {/* Horário */}
          <div className="grid grid-cols-2 gap-3">
            <Field label="Hora de início *">
              <input
                type="time"
                value={startTime}
                onChange={(e) => {
                  setStartTime(e.target.value);
                  setEndTime(addMinutes(e.target.value, 120));
                }}
                className={INPUT_CLS}
                required
              />
            </Field>
            <Field label="Hora de fim *">
              <input
                type="time"
                value={endTime}
                onChange={(e) => setEndTime(e.target.value)}
                className={INPUT_CLS}
                required
              />
            </Field>
          </div>

          {/* Previsão de valor */}
          {calculatedValue != null && (
            <div className="p-3 rounded-lg bg-[var(--color-primary-light)] border border-[var(--color-primary-muted)]">
              <p className="text-xs text-[var(--color-primary)] font-medium">
                Duração: {Math.floor(durationMin / 60)}h{durationMin % 60 > 0 ? `${durationMin % 60}min` : ""} ·{" "}
                Valor estimado: <strong>€{calculatedValue.toFixed(2)}</strong>
                {selectedLocation?.hourly_rate && (
                  <span className="font-normal opacity-80"> ({selectedLocation.hourly_rate}€/h)</span>
                )}
              </p>
            </div>
          )}

          {/* Notas */}
          <Field label="Notas (opcional)">
            <textarea
              value={notes}
              onChange={(e) => setNotes(e.target.value)}
              rows={3}
              placeholder="Instruções especiais, materiais necessários..."
              className={INPUT_CLS + " resize-none"}
            />
          </Field>

          {message && (
            <p className="text-sm px-3 py-2 rounded-lg bg-red-50 text-red-700 border border-red-100">
              {message}
            </p>
          )}
        </form>

        {/* Footer */}
        <div className="border-t border-[var(--color-border)] px-6 py-4">
          <button
            form="create-service-form"
            type="submit"
            disabled={loading}
            className="w-full flex items-center justify-center gap-2 px-4 py-2.5 rounded-lg bg-[var(--color-primary)] text-white text-sm font-semibold hover:bg-[var(--color-primary-hover)] transition-colors disabled:opacity-50"
          >
            {loading && <Loader2 className="w-4 h-4 animate-spin" />}
            Criar serviço
          </button>
        </div>
      </div>
    </>
  );
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div>
      <label className="block text-sm font-medium text-[var(--color-text-main)] mb-1.5">{label}</label>
      {children}
    </div>
  );
}

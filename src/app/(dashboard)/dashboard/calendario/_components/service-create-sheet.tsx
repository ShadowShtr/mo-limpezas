"use client";

import { useState, useMemo } from "react";
import { X, Loader2, ChevronDown, Plus, UserPlus, Building2, User, MapPin, AlertTriangle } from "lucide-react";
import { format, parseISO } from "date-fns";
import { pt } from "date-fns/locale";
import { createService } from "../_actions/create-service";
import type { ConflictInfo } from "../_actions/reschedule";
import { createClienteComLocal } from "@/app/actions/clientes";
import {
  CLEANING_TYPES,
  PAYMENT_STATUSES,
  UPHOLSTERY_TYPES,
  showsPaymentStatus,
  isUpholstery,
} from "@/lib/cleaning-types";

type Client = { id: string; name: string };
type Location = { id: string; client_id: string; name: string; address: string; hourly_rate: number | null };
type Team = { id: string; name: string; color: string };

interface Props {
  open: boolean;
  onClose: () => void;
  onCreated: () => void;
  companyId: string;
  date: Date;
  initialStartTime: string;
  initialTeamId: string;
  clients: Client[];
  locations: Location[];
  teams: Team[];
  fixedClientId?: string;
  fixedLocationId?: string;
}

const INPUT_CLS =
  "w-full px-3 py-2 rounded-lg border border-[var(--color-border)] text-sm text-[var(--color-text-main)] " +
  "focus:outline-none focus:ring-2 focus:ring-[var(--color-primary)] focus:border-transparent bg-white";

const SELECT_CLS =
  "w-full appearance-none px-3 py-2 pr-8 rounded-lg border border-[var(--color-border)] text-sm " +
  "text-[var(--color-text-main)] bg-white focus:outline-none focus:ring-2 focus:ring-[var(--color-primary)] focus:border-transparent";

const SERVICE_TYPE_LABELS: Record<string, string> = {
  limpeza_regular: "Limpeza regular",
  manutencao: "Manutenção",
  pos_obra: "Pós-obra",
  vidros: "Vidros",
  carpetes: "Carpetes",
  industrial: "Industrial",
  outro: "Outro",
};

function addMinutes(time: string, mins: number): string {
  const [h, m] = time.split(":").map(Number);
  const total = h * 60 + m + mins;
  return `${String(Math.min(Math.floor(total / 60), 23)).padStart(2, "0")}:${String(total % 60).padStart(2, "0")}`;
}

function calcDuration(start: string, end: string): number {
  const [sh, sm] = start.split(":").map(Number);
  const [eh, em] = end.split(":").map(Number);
  return eh * 60 + em - (sh * 60 + sm);
}

export function ServiceCreateSheet({
  open, onClose, onCreated,
  companyId, date, initialStartTime, initialTeamId,
  clients: initialClients, locations, teams,
  fixedClientId, fixedLocationId,
}: Props) {
  const [loading, setLoading] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [conflicts, setConflicts] = useState<ConflictInfo[]>([]);
  const [pendingForce, setPendingForce] = useState<object | null>(null);
  const [clientList, setClientList] = useState<Client[]>(initialClients);
  const [locationList, setLocationList] = useState<Location[]>(locations);

  // Serviço
  const [clientId, setClientId] = useState(fixedClientId ?? "");
  const [locationId, setLocationId] = useState(fixedLocationId ?? "");
  const [teamId, setTeamId] = useState(initialTeamId);
  const [startTime, setStartTime] = useState(initialStartTime);
  const [endTime, setEndTime] = useState(addMinutes(initialStartTime, 120));
  const [notes, setNotes] = useState("");
  const [cleaningType, setCleaningType] = useState("");
  const [paymentStatus, setPaymentStatus] = useState("nao_informado");
  const [upholsteryType, setUpholsteryType] = useState("");
  const [upholsteryNotes, setUpholsteryNotes] = useState("");
  const [upholsteryUnits, setUpholsteryUnits] = useState("");
  const [upholsteryUnitPrice, setUpholsteryUnitPrice] = useState("");

  const showPayment = showsPaymentStatus(cleaningType);
  const showUpholstery = isUpholstery(cleaningType);
  const showUnits = showUpholstery && upholsteryType !== "";
  const upholsteryTotal = showUnits
    ? Number(upholsteryUnits || 0) * Number((upholsteryUnitPrice || "0").replace(",", "."))
    : null;

  // Registo de novo cliente
  const [showNewClient, setShowNewClient] = useState(false);
  const [newClientType, setNewClientType] = useState<"individual" | "empresa">("individual");
  const [newClientName, setNewClientName] = useState("");
  const [newClientPhone, setNewClientPhone] = useState("");
  const [newClientEmail, setNewClientEmail] = useState("");
  const [newClientNif, setNewClientNif] = useState("");
  // Local do novo cliente
  const [newLocName, setNewLocName] = useState("");
  const [newLocAddress, setNewLocAddress] = useState("");
  const [newLocRate, setNewLocRate] = useState("");
  const [newLocServiceType, setNewLocServiceType] = useState("limpeza_regular");

  const [creatingClient, setCreatingClient] = useState(false);
  const [newClientError, setNewClientError] = useState<string | null>(null);

  const filteredLocations = useMemo(
    () => (clientId ? locationList.filter((l) => l.client_id === clientId) : locationList),
    [clientId, locationList],
  );

  const selectedLocation = useMemo(
    () => locationList.find((l) => l.id === locationId) ?? null,
    [locationId, locationList],
  );

  const durationMin = calcDuration(startTime, endTime);
  const calculatedValue =
    selectedLocation?.hourly_rate != null && durationMin > 0
      ? (durationMin / 60) * selectedLocation.hourly_rate
      : null;

  function resetNewClientForm() {
    setNewClientName(""); setNewClientPhone(""); setNewClientEmail(""); setNewClientNif("");
    setNewLocName(""); setNewLocAddress(""); setNewLocRate(""); setNewLocServiceType("limpeza_regular");
    setNewClientType("individual"); setNewClientError(null);
  }

  async function handleCreateClient() {
    if (!newClientName.trim()) { setNewClientError("O nome é obrigatório."); return; }
    if (!newLocName.trim()) { setNewClientError("O nome do local é obrigatório."); return; }
    if (!newLocAddress.trim()) { setNewClientError("A morada do local é obrigatória."); return; }
    setCreatingClient(true);
    setNewClientError(null);

    const res = await createClienteComLocal(companyId, {
      name: newClientName,
      type: newClientType,
      phone: newClientPhone || undefined,
      email: newClientEmail || undefined,
      nif: newClientNif || undefined,
      locationName: newLocName,
      address: newLocAddress,
      hourlyRate: newLocRate ? parseFloat(newLocRate) : null,
      serviceType: newLocServiceType,
    });

    setCreatingClient(false);
    if (!res.ok || !res.clientId || !res.locationId) {
      setNewClientError(res.error ?? "Erro ao criar.");
      return;
    }

    const newC: Client = { id: res.clientId, name: newClientName.trim() };
    const newL: Location = {
      id: res.locationId,
      client_id: res.clientId,
      name: newLocName.trim(),
      address: newLocAddress.trim(),
      hourly_rate: newLocRate ? parseFloat(newLocRate) : null,
    };
    setClientList((prev) => [...prev, newC].sort((a, b) => a.name.localeCompare(b.name, "pt")));
    setLocationList((prev) => [...prev, newL]);
    setClientId(res.clientId);
    setLocationId(res.locationId);
    setShowNewClient(false);
    resetNewClientForm();
  }

  async function doCreate(force = false) {
    setLoading(true);
    setMessage(null);
    setConflicts([]);
    setPendingForce(null);

    const dateStr = format(date, "yyyy-MM-dd");

    const res = await createService({
      companyId,
      locationId,
      teamId: teamId || null,
      scheduledStart: `${dateStr}T${startTime}:00`,
      scheduledEnd: `${dateStr}T${endTime}:00`,
      hourlyRate: selectedLocation?.hourly_rate ?? null,
      // Estofos por unidade: o total (qtd × preço) tem prioridade sobre o cálculo por hora.
      calculatedValue: upholsteryTotal != null && upholsteryTotal > 0
        ? upholsteryTotal
        : (calculatedValue ?? null),
      notes: notes || null,
      cleaningType: cleaningType || null,
      paymentStatus: showPayment ? paymentStatus : null,
      upholsteryType: showUpholstery ? (upholsteryType || null) : null,
      upholsteryNotes: showUpholstery ? (upholsteryNotes || null) : null,
      upholsteryUnits: showUnits && upholsteryUnits !== "" ? Number(upholsteryUnits) : null,
      upholsteryUnitPrice: showUnits && upholsteryUnitPrice !== ""
        ? Number(upholsteryUnitPrice.replace(",", ".")) : null,
      force,
    });

    setLoading(false);
    if (!res.ok) {
      if (res.canForce && res.conflicts && res.conflicts.length > 0) {
        setConflicts(res.conflicts);
        setPendingForce({});
      } else {
        setMessage("Erro ao criar: " + res.error);
      }
    } else {
      onCreated();
      onClose();
    }
  }

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (!locationId) { setMessage("Seleciona um local."); return; }
    if (durationMin <= 0) { setMessage("A hora de fim deve ser posterior ao início."); return; }
    if (showUpholstery && !upholsteryType) { setMessage("Seleciona o tipo de estofado."); return; }
    if (showUnits && (upholsteryUnits === "" || Number(upholsteryUnits) <= 0)) {
      setMessage("Indica o número de unidades do estofado.");
      return;
    }
    await doCreate(false);
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
          <button onClick={onClose} className="p-1.5 rounded-lg text-[var(--color-text-muted)] hover:bg-[var(--color-background)] transition-colors">
            <X className="w-5 h-5" />
          </button>
        </div>

        {/* Body */}
        <div className="flex-1 overflow-y-auto">
          <form id="create-service-form" onSubmit={handleSubmit} className="px-6 py-5 space-y-5">

            {/* Cliente + Local */}
            <div className="space-y-3">
              <div className="grid grid-cols-2 gap-3">
                <Field label="Cliente *">
                  <div className="relative">
                    <select
                      value={clientId}
                      onChange={(e) => { setClientId(e.target.value); setLocationId(""); }}
                      disabled={!!fixedClientId}
                      className={SELECT_CLS + (fixedClientId ? " opacity-70 cursor-not-allowed" : "")}
                    >
                      <option value="">Selecionar...</option>
                      {clientList.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
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
                      {filteredLocations.map((l) => <option key={l.id} value={l.id}>{l.name}</option>)}
                    </select>
                    <ChevronDown className="pointer-events-none absolute right-2 top-1/2 -translate-y-1/2 w-4 h-4 text-[var(--color-text-muted)]" />
                  </div>
                </Field>
              </div>

              {!fixedClientId && !showNewClient && (
                <button
                  type="button"
                  onClick={() => setShowNewClient(true)}
                  className="flex items-center gap-1.5 text-xs font-medium text-[var(--color-primary)] hover:underline"
                >
                  <Plus className="w-3.5 h-3.5" />
                  Registar novo cliente
                </button>
              )}
            </div>

            {/* ── Formulário de novo cliente ── */}
            {showNewClient && (
              <div className="rounded-xl border border-[var(--color-primary-muted)] bg-[var(--color-primary-light)] overflow-hidden">
                <div className="flex items-center justify-between px-4 py-3 border-b border-[var(--color-primary-muted)]">
                  <p className="text-sm font-semibold text-[var(--color-primary)] flex items-center gap-1.5">
                    <UserPlus className="w-4 h-4" />
                    Novo cliente
                  </p>
                  <button
                    type="button"
                    onClick={() => { setShowNewClient(false); resetNewClientForm(); }}
                    className="p-1 rounded text-[var(--color-primary)] hover:bg-[var(--color-primary-muted)]"
                  >
                    <X className="w-3.5 h-3.5" />
                  </button>
                </div>

                <div className="px-4 py-4 space-y-4">
                  {/* Tipo */}
                  <div className="grid grid-cols-2 gap-2">
                    {(["individual", "empresa"] as const).map((t) => (
                      <button
                        key={t}
                        type="button"
                        onClick={() => setNewClientType(t)}
                        className={`flex items-center gap-2 px-3 py-2 rounded-lg border text-sm font-medium transition-colors ${
                          newClientType === t
                            ? "bg-[var(--color-primary)] text-white border-[var(--color-primary)]"
                            : "bg-white text-[var(--color-text-main)] border-[var(--color-border)] hover:bg-[var(--color-background)]"
                        }`}
                      >
                        {t === "individual" ? <User className="w-3.5 h-3.5" /> : <Building2 className="w-3.5 h-3.5" />}
                        {t === "individual" ? "Particular" : "Empresa"}
                      </button>
                    ))}
                  </div>

                  {/* Dados do cliente */}
                  <div className="grid grid-cols-2 gap-3">
                    <div className="col-span-2">
                      <label className="block text-xs font-medium text-[var(--color-text-main)] mb-1">Nome *</label>
                      <input type="text" value={newClientName} onChange={(e) => setNewClientName(e.target.value)}
                        placeholder={newClientType === "empresa" ? "Nome da empresa" : "Nome completo"}
                        className={INPUT_CLS} autoFocus />
                    </div>
                    <div>
                      <label className="block text-xs font-medium text-[var(--color-text-main)] mb-1">Telefone</label>
                      <input type="tel" value={newClientPhone} onChange={(e) => setNewClientPhone(e.target.value)}
                        placeholder="9XXXXXXXX" className={INPUT_CLS} />
                    </div>
                    <div>
                      <label className="block text-xs font-medium text-[var(--color-text-main)] mb-1">Email</label>
                      <input type="email" value={newClientEmail} onChange={(e) => setNewClientEmail(e.target.value)}
                        placeholder="email@exemplo.com" className={INPUT_CLS} />
                    </div>
                    <div className="col-span-2">
                      <label className="block text-xs font-medium text-[var(--color-text-main)] mb-1">
                        {newClientType === "empresa" ? "NIF da empresa" : "NIF (opcional)"}
                      </label>
                      <input type="text" value={newClientNif} onChange={(e) => setNewClientNif(e.target.value)}
                        placeholder="5XXXXXXXX" className={INPUT_CLS} />
                    </div>
                  </div>

                  {/* Separador - Local */}
                  <div className="flex items-center gap-2 pt-1">
                    <div className="flex-1 h-px bg-[var(--color-primary-muted)]" />
                    <span className="text-xs font-semibold text-[var(--color-primary)] flex items-center gap-1">
                      <MapPin className="w-3 h-3" /> Local de serviço
                    </span>
                    <div className="flex-1 h-px bg-[var(--color-primary-muted)]" />
                  </div>

                  <div className="space-y-3">
                    <div>
                      <label className="block text-xs font-medium text-[var(--color-text-main)] mb-1">Nome do local *</label>
                      <input type="text" value={newLocName} onChange={(e) => setNewLocName(e.target.value)}
                        placeholder='Ex: "Casa", "Escritório Lisboa"' className={INPUT_CLS} />
                    </div>
                    <div>
                      <label className="block text-xs font-medium text-[var(--color-text-main)] mb-1">Morada *</label>
                      <input type="text" value={newLocAddress} onChange={(e) => setNewLocAddress(e.target.value)}
                        placeholder="Rua, número, código postal, cidade" className={INPUT_CLS} />
                    </div>
                    <div className="grid grid-cols-2 gap-3">
                      <div>
                        <label className="block text-xs font-medium text-[var(--color-text-main)] mb-1">Valor/hora (€)</label>
                        <input type="number" min="0" step="0.5" value={newLocRate} onChange={(e) => setNewLocRate(e.target.value)}
                          placeholder="Ex: 15.00" className={INPUT_CLS} />
                      </div>
                      <div>
                        <label className="block text-xs font-medium text-[var(--color-text-main)] mb-1">Tipo de serviço</label>
                        <div className="relative">
                          <select value={newLocServiceType} onChange={(e) => setNewLocServiceType(e.target.value)} className={SELECT_CLS}>
                            {Object.entries(SERVICE_TYPE_LABELS).map(([k, v]) => (
                              <option key={k} value={k}>{v}</option>
                            ))}
                          </select>
                          <ChevronDown className="pointer-events-none absolute right-2 top-1/2 -translate-y-1/2 w-4 h-4 text-[var(--color-text-muted)]" />
                        </div>
                      </div>
                    </div>
                  </div>

                  {newClientError && (
                    <p className="text-xs text-red-600 font-medium">{newClientError}</p>
                  )}

                  <button
                    type="button"
                    onClick={handleCreateClient}
                    disabled={creatingClient || !newClientName.trim() || !newLocName.trim() || !newLocAddress.trim()}
                    className="w-full flex items-center justify-center gap-1.5 px-3 py-2.5 rounded-lg bg-[var(--color-primary)] text-white text-sm font-semibold hover:bg-[var(--color-primary-hover)] transition-colors disabled:opacity-50"
                  >
                    {creatingClient ? <Loader2 className="w-4 h-4 animate-spin" /> : <Plus className="w-4 h-4" />}
                    Criar cliente e local
                  </button>
                </div>
              </div>
            )}

            {/* Equipa */}
            <Field label="Equipa">
              <div className="relative">
                <select value={teamId} onChange={(e) => setTeamId(e.target.value)} className={SELECT_CLS}>
                  <option value="">Sem equipa</option>
                  {teams.map((t) => <option key={t.id} value={t.id}>{t.name}</option>)}
                </select>
                <ChevronDown className="pointer-events-none absolute right-2 top-1/2 -translate-y-1/2 w-4 h-4 text-[var(--color-text-muted)]" />
              </div>
            </Field>

            {/* Tipo de limpeza */}
            <Field label="Tipo de limpeza">
              <div className="relative">
                <select value={cleaningType} onChange={(e) => setCleaningType(e.target.value)} className={SELECT_CLS}>
                  <option value="">Selecionar...</option>
                  {CLEANING_TYPES.map((t) => <option key={t.value} value={t.value}>{t.label}</option>)}
                </select>
                <ChevronDown className="pointer-events-none absolute right-2 top-1/2 -translate-y-1/2 w-4 h-4 text-[var(--color-text-muted)]" />
              </div>
            </Field>

            {/* Estado do pagamento — Geral / Pós-Obra */}
            {showPayment && (
              <Field label="Estado do pagamento">
                <div className="relative">
                  <select value={paymentStatus} onChange={(e) => setPaymentStatus(e.target.value)} className={SELECT_CLS}>
                    {PAYMENT_STATUSES.map((s) => <option key={s.value} value={s.value}>{s.label}</option>)}
                  </select>
                  <ChevronDown className="pointer-events-none absolute right-2 top-1/2 -translate-y-1/2 w-4 h-4 text-[var(--color-text-muted)]" />
                </div>
              </Field>
            )}

            {/* Estofos — tipo + especificação */}
            {showUpholstery && (
              <div className="space-y-3 rounded-lg border border-[var(--color-primary-muted)] bg-[var(--color-primary-light)] p-3">
                <Field label="Tipo de estofado">
                  <div className="relative">
                    <select value={upholsteryType} onChange={(e) => setUpholsteryType(e.target.value)} className={SELECT_CLS}>
                      <option value="">Selecionar...</option>
                      {UPHOLSTERY_TYPES.map((t) => <option key={t.value} value={t.value}>{t.label}</option>)}
                    </select>
                    <ChevronDown className="pointer-events-none absolute right-2 top-1/2 -translate-y-1/2 w-4 h-4 text-[var(--color-text-muted)]" />
                  </div>
                </Field>

                {showUnits && (
                  <div className="grid grid-cols-2 gap-3">
                    <Field label="Nº de unidades">
                      <input type="number" min="0" step="1" value={upholsteryUnits}
                        onChange={(e) => setUpholsteryUnits(e.target.value)} placeholder="ex: 3" className={INPUT_CLS} />
                    </Field>
                    <Field label="Preço por unidade (€)">
                      <input type="number" min="0" step="0.01" value={upholsteryUnitPrice}
                        onChange={(e) => setUpholsteryUnitPrice(e.target.value)} placeholder="ex: 25.00" className={INPUT_CLS} />
                    </Field>
                    <div className="col-span-2 rounded-lg border border-[var(--color-primary-muted)] bg-white px-3 py-2 text-sm font-semibold text-[var(--color-text-main)]">
                      Total: {upholsteryTotal == null || upholsteryTotal <= 0
                        ? "—"
                        : `${upholsteryTotal.toLocaleString("pt-PT", { minimumFractionDigits: 2, maximumFractionDigits: 2 })} €`}
                    </div>
                  </div>
                )}

                <Field label="Especificação do estofado">
                  <textarea value={upholsteryNotes} onChange={(e) => setUpholsteryNotes(e.target.value)} rows={2}
                    placeholder="Tamanho, quantidade, tipo de tecido, manchas, etc."
                    className={INPUT_CLS + " resize-none"} />
                </Field>
              </div>
            )}

            {/* Horário */}
            <div className="grid grid-cols-2 gap-3">
              <Field label="Hora de início *">
                <input type="time" value={startTime} onChange={(e) => { setStartTime(e.target.value); setEndTime(addMinutes(e.target.value, 120)); }}
                  className={INPUT_CLS} required />
              </Field>
              <Field label="Hora de fim *">
                <input type="time" value={endTime} onChange={(e) => setEndTime(e.target.value)} className={INPUT_CLS} required />
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
              <textarea value={notes} onChange={(e) => setNotes(e.target.value)} rows={3}
                placeholder="Instruções especiais, materiais necessários..."
                className={INPUT_CLS + " resize-none"} />
            </Field>

            {message && (
              <p className="text-sm px-3 py-2 rounded-lg bg-red-50 text-red-700 border border-red-100">{message}</p>
            )}
          </form>
        </div>

        {/* Conflito de horário */}
        {conflicts.length > 0 && pendingForce && (
          <div className="mx-6 mb-3 rounded-lg border border-amber-200 bg-amber-50 p-3 space-y-2">
            <div className="flex items-center gap-1.5 text-sm font-semibold text-amber-800">
              <AlertTriangle className="w-4 h-4 shrink-0" />
              Conflito de horário
            </div>
            <p className="text-xs text-amber-700">A equipa já tem {conflicts.length > 1 ? "serviços" : "um serviço"} neste horário:</p>
            <ul className="text-xs text-amber-800 space-y-0.5">
              {conflicts.map((c) => (
                <li key={c.id}>
                  #{c.reference_number} — {c.location_name} ({format(parseISO(c.scheduled_start), "HH:mm")}–{format(parseISO(c.scheduled_end), "HH:mm")})
                </li>
              ))}
            </ul>
            <div className="flex gap-2 pt-1">
              <button
                type="button"
                onClick={() => { setConflicts([]); setPendingForce(null); }}
                className="flex-1 py-1.5 rounded-lg border border-amber-300 text-xs font-medium text-amber-800 hover:bg-amber-100"
              >
                Cancelar
              </button>
              <button
                type="button"
                onClick={() => void doCreate(true)}
                disabled={loading}
                className="flex-1 py-1.5 rounded-lg bg-amber-600 text-xs font-semibold text-white hover:bg-amber-700 disabled:opacity-50"
              >
                {loading ? <Loader2 className="w-3 h-3 animate-spin mx-auto" /> : "Criar mesmo assim"}
              </button>
            </div>
          </div>
        )}

        {/* Footer */}
        <div className="border-t border-[var(--color-border)] px-6 py-4">
          <button
            form="create-service-form"
            type="submit"
            disabled={loading || conflicts.length > 0}
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

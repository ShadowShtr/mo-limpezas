"use client";

import { useState, useMemo, useEffect, useRef } from "react";
import { X, Loader2, ChevronDown, Plus, UserPlus, Building2, User, MapPin, AlertTriangle, Search, CheckCircle2 } from "lucide-react";
import { format, parseISO } from "date-fns";
import { pt } from "date-fns/locale";
import { createService } from "../_actions/create-service";
import { getCompanySettings } from "@/app/actions/settings";
import { createClient } from "@/lib/supabase/client";
import type { ConflictInfo } from "../_actions/reschedule";
import { createClienteComLocal } from "@/app/actions/clientes";
import { createContrato } from "@/app/actions/contratos";
import { safeFormat, isValidIsoDateString } from "@/lib/utils";
import type { ScheduleDay } from "@/types/database";
import {
  CLEANING_TYPES,
  PAYMENT_STATUSES,
  UPHOLSTERY_TYPES,
  showsPaymentStatus,
  isUpholstery,
} from "@/lib/cleaning-types";

type Client = { id: string; name: string };
type Location = { id: string; client_id: string; name: string; address: string; hourly_rate: number | null };

interface NominatimResult {
  place_id: number;
  display_name: string;
  lat: string;
  lon: string;
  address: {
    road?: string; pedestrian?: string; house_number?: string; postcode?: string;
    city?: string; town?: string; village?: string; municipality?: string; county?: string;
  };
}
type Team = { id: string; name: string; color: string; member_count?: number };

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

const REC_WEEKDAYS = [
  { value: 1, label: "Seg" }, { value: 2, label: "Ter" }, { value: 3, label: "Qua" },
  { value: 4, label: "Qui" }, { value: 5, label: "Sex" }, { value: 6, label: "Sáb" }, { value: 0, label: "Dom" },
];
const REC_DAY_KEY: Record<number, ScheduleDay["day"]> = {
  0: "sun", 1: "mon", 2: "tue", 3: "wed", 4: "thu", 5: "fri", 6: "sat",
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
  const [saved, setSaved] = useState(false);
  // Guard síncrono: impede que duplo-clique/reenvio crie dois serviços/contratos.
  const submittingRef = useRef(false);
  const [message, setMessage] = useState<string | null>(null);
  const [conflicts, setConflicts] = useState<ConflictInfo[]>([]);
  const [pendingForce, setPendingForce] = useState<object | null>(null);
  const [clientList, setClientList] = useState<Client[]>(initialClients);
  const [locationList, setLocationList] = useState<Location[]>(locations);

  // Serviço
  const [clientId, setClientId] = useState(fixedClientId ?? "");
  const [locationId, setLocationId] = useState(fixedLocationId ?? "");
  const [teamId, setTeamId] = useState(initialTeamId);
  // IVA: taxa da empresa + interruptor. Quando ligado (predefinição), o serviço
  // é faturado com IVA (apply_vat) e o total com IVA entra na fatura.
  const [vatRate, setVatRate] = useState(23);
  const [withVat, setWithVat] = useState(true);
  // Data do serviço (editável). Sincroniza quando o popup é reaberto noutra célula.
  const [serviceDate, setServiceDate] = useState(date);
  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setServiceDate(date);
  }, [date]);
  // Carrega a taxa de IVA da empresa ao abrir (para o total com IVA).
  useEffect(() => {
    if (!open) return;
    let cancelled = false;
    getCompanySettings()
      .then((s) => { if (!cancelled && s?.vat_rate != null) setVatRate(s.vat_rate); })
      .catch(() => {});
    return () => { cancelled = true; };
  }, [open]);
  const [startTime, setStartTime] = useState(initialStartTime);
  const [endTime, setEndTime] = useState(addMinutes(initialStartTime, 120));

  // Recorrência (gerar intervenção recorrente em vez de serviço pontual).
  const [recurring, setRecurring] = useState(false);
  const [recFrequency, setRecFrequency] = useState<"weekly" | "biweekly" | "daily" | "monthly">("weekly");
  const [recWeekdays, setRecWeekdays] = useState<number[]>([date.getDay()]);

  // Ao reabrir o popup noutra célula (hora/equipa), sincroniza os campos e limpa
  // o estado de "guardado". O componente fica montado, por isso é preciso reset.
  useEffect(() => {
    if (!open) return;
    /* eslint-disable react-hooks/set-state-in-effect */
    setStartTime(initialStartTime);
    setEndTime(addMinutes(initialStartTime, 120));
    setTeamId(initialTeamId);
    setRecWeekdays([date.getDay()]);
    setSaved(false);
    setMessage(null);
    /* eslint-enable react-hooks/set-state-in-effect */
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, initialStartTime, initialTeamId]);
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
  const [clientSearch, setClientSearch] = useState("");
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

  // Autocomplete de morada (Nominatim) para o local novo — igual aos Locais.
  const [addrRoad, setAddrRoad] = useState("");
  const [addrNumber, setAddrNumber] = useState("");
  const [addrComplement, setAddrComplement] = useState("");
  const [addrPostal, setAddrPostal] = useState("");
  const [addrCity, setAddrCity] = useState("");
  const [addrLat, setAddrLat] = useState<string>("");
  const [addrLng, setAddrLng] = useState<string>("");
  const [addrSuggestions, setAddrSuggestions] = useState<NominatimResult[]>([]);
  const [addrShow, setAddrShow] = useState(false);
  const [addrSearching, setAddrSearching] = useState(false);
  const [addrGeocoded, setAddrGeocoded] = useState(false);
  const addrDebounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const addrWrapRef = useRef<HTMLDivElement>(null);

  function composeNewAddress(): string {
    const parts: string[] = [];
    if (addrRoad) parts.push(`${addrRoad}${addrNumber ? " " + addrNumber : ""}`);
    if (addrComplement) parts.push(addrComplement);
    if (addrPostal || addrCity) parts.push(`${addrPostal}${addrPostal && addrCity ? " " : ""}${addrCity}`);
    return parts.join(", ") || newLocAddress.trim();
  }

  function handleAddrSearch(value: string) {
    setNewLocAddress(value);
    setAddrGeocoded(false);
    if (addrDebounceRef.current) clearTimeout(addrDebounceRef.current);
    if (value.trim().length < 4) { setAddrSuggestions([]); setAddrShow(false); return; }
    addrDebounceRef.current = setTimeout(async () => {
      setAddrSearching(true);
      try {
        const encoded = encodeURIComponent(value + (value.toLowerCase().includes("portugal") ? "" : ", Portugal"));
        const res = await fetch(
          `https://nominatim.openstreetmap.org/search?q=${encoded}&format=json&limit=5&addressdetails=1&countrycodes=pt`,
          { headers: { "Accept-Language": "pt" } },
        );
        const data: NominatimResult[] = await res.json();
        setAddrSuggestions(data);
        setAddrShow(data.length > 0);
      } catch {
        setAddrSuggestions([]);
      } finally {
        setAddrSearching(false);
      }
    }, 420);
  }

  function pickAddr(r: NominatimResult) {
    const a = r.address;
    const roadVal = a.road ?? a.pedestrian ?? "";
    const numVal = a.house_number ?? "";
    const pcVal = a.postcode ?? "";
    const cityVal = a.city ?? a.town ?? a.village ?? a.municipality ?? a.county ?? "";
    setAddrRoad(roadVal); setAddrNumber(numVal); setAddrPostal(pcVal); setAddrCity(cityVal);
    setAddrLat(r.lat); setAddrLng(r.lon); setAddrGeocoded(true);
    const display = [roadVal + (numVal ? " " + numVal : ""), pcVal + (pcVal && cityVal ? " " : "") + cityVal]
      .filter(Boolean).join(", ");
    setNewLocAddress(display);
    setAddrSuggestions([]); setAddrShow(false);
  }

  useEffect(() => {
    function onClickOutside(e: MouseEvent) {
      if (addrWrapRef.current && !addrWrapRef.current.contains(e.target as Node)) setAddrShow(false);
    }
    document.addEventListener("mousedown", onClickOutside);
    return () => document.removeEventListener("mousedown", onClickOutside);
  }, []);

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

  // Valor/hora do serviço: pré-preenchido com o do local, mas editável aqui.
  const [serviceRate, setServiceRate] = useState("");
  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setServiceRate(selectedLocation?.hourly_rate != null ? String(selectedLocation.hourly_rate) : "");
  }, [selectedLocation]);
  const effectiveRate = serviceRate.trim() === "" ? null : Number(serviceRate.replace(",", "."));

  // Mecânica de faturação deste serviço: "hourly" (por hora) ou "fixed" (valor fixo).
  const [billingMode, setBillingMode] = useState<"hourly" | "fixed">("hourly");
  const [fixedValue, setFixedValue] = useState("");
  const isFixed = billingMode === "fixed";
  const parsedFixed = fixedValue.trim() === "" ? null : Number(fixedValue.replace(",", "."));

  // Nº de pessoas: tamanho REAL da equipa selecionada (cada colaboradora conta
  // como uma hora). Busca direta a team_members (mesma fonte fiável do modal de
  // alocação) — não depende do member_count vindo da view, que chegou a vir 0.
  const selectedTeam = teams.find((t) => t.id === teamId) ?? null;
  const [fetchedTeamSize, setFetchedTeamSize] = useState<number | null>(null);
  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect
    if (!teamId) { setFetchedTeamSize(null); return; }
    let cancelled = false;
    const supabase = createClient();
    (async () => {
      const { count } = await supabase
        .from("team_members")
        .select("id", { count: "exact", head: true })
        .eq("team_id", teamId)
        .is("left_at", null);
      if (!cancelled) setFetchedTeamSize(count && count > 0 ? count : 1);
    })();
    return () => { cancelled = true; };
  }, [teamId]);

  const numPeople = !teamId
    ? 1
    : (fetchedTeamSize
        ?? (selectedTeam?.member_count && selectedTeam.member_count > 0 ? selectedTeam.member_count : 1));

  const durationMin = calcDuration(startTime, endTime);
  const hourlyCalc =
    effectiveRate != null && Number.isFinite(effectiveRate) && durationMin > 0
      ? (durationMin / 60) * effectiveRate * numPeople
      : null;
  // Valor efetivo do serviço: valor fixo quando nesse modo, senão o cálculo por hora.
  const calculatedValue = isFixed
    ? (parsedFixed != null && Number.isFinite(parsedFixed) ? parsedFixed : null)
    : hourlyCalc;

  function resetNewClientForm() {
    setNewClientName(""); setNewClientPhone(""); setNewClientEmail(""); setNewClientNif("");
    setNewLocName(""); setNewLocAddress(""); setNewLocRate(""); setNewLocServiceType("limpeza_regular");
    setNewClientType("individual"); setNewClientError(null);
    setAddrRoad(""); setAddrNumber(""); setAddrComplement(""); setAddrPostal(""); setAddrCity("");
    setAddrLat(""); setAddrLng(""); setAddrSuggestions([]); setAddrShow(false); setAddrGeocoded(false);
  }

  async function handleCreateClient() {
    const composedAddr = composeNewAddress();
    if (!newClientName.trim()) { setNewClientError("O nome é obrigatório."); return; }
    if (!newLocName.trim()) { setNewClientError("O nome do local é obrigatório."); return; }
    if (!composedAddr.trim()) { setNewClientError("A morada do local é obrigatória."); return; }
    setCreatingClient(true);
    setNewClientError(null);

    let res;
    try {
      res = await createClienteComLocal(companyId, {
        name: newClientName,
        type: newClientType,
        phone: newClientPhone || undefined,
        email: newClientEmail || undefined,
        nif: newClientNif || undefined,
        locationName: newLocName,
        address: composedAddr,
        hourlyRate: newLocRate ? parseFloat(newLocRate) : null,
        serviceType: newLocServiceType,
        lat: addrLat ? parseFloat(addrLat) : null,
        lng: addrLng ? parseFloat(addrLng) : null,
      });
    } catch (e) {
      // A server action rejeitou (rede/exceção): não deixa o botão preso a carregar.
      setNewClientError(e instanceof Error ? e.message : "Erro ao criar cliente. Tenta novamente.");
      return;
    } finally {
      setCreatingClient(false);
    }

    if (!res.ok || !res.clientId || !res.locationId) {
      setNewClientError(res.error ?? "Erro ao criar.");
      return;
    }

    const newC: Client = { id: res.clientId, name: newClientName.trim() };
    const newL: Location = {
      id: res.locationId,
      client_id: res.clientId,
      name: newLocName.trim(),
      address: composedAddr,
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
    // Single-flight: se já está a submeter, ignora cliques/reenvios extra.
    if (submittingRef.current) return;
    submittingRef.current = true;
    setLoading(true);
    setMessage(null);
    setConflicts([]);
    setPendingForce(null);

    const dateStr = format(serviceDate, "yyyy-MM-dd");

    // ── Modo recorrente: cria uma intervenção (contrato) em vez de pontual ──
    if (recurring) {
      const isWeekly = recFrequency === "weekly" || recFrequency === "biweekly";
      const days = isWeekly ? (recWeekdays.length ? recWeekdays : [serviceDate.getDay()]) : [];
      const scheduleDays: ScheduleDay[] = isWeekly
        ? days.map((d) => ({
            day: REC_DAY_KEY[d], start_time: startTime, duration_min: durationMin,
            team_id: teamId || null, num_people: teamId ? null : numPeople,
          }))
        : [{ day: "all", start_time: startTime, duration_min: durationMin, team_id: teamId || null, num_people: teamId ? null : numPeople }];

      const recRes = await createContrato({
        company_id: companyId,
        created_by: "", // ignorado no servidor (usa o utilizador autenticado)
        location_id: locationId,
        frequency: recFrequency,
        interval_days: 1,
        weekdays: isWeekly ? days : null,
        schedule_days: scheduleDays,
        starts_on: dateStr,
        status: "ativo",
        hourly_rate: effectiveRate,
        fixed_price: isFixed ? parsedFixed : null,
        // "Avença" numa intervenção recorrente = valor fixo MENSAL (o total é
        // dividido pelos serviços realizados no mês), não um valor por serviço.
        fixed_monthly: isFixed,
        apply_vat: withVat,
        num_people: null,
        cleaning_type: cleaningType || null,
        payment_status: showPayment ? paymentStatus : null,
        upholstery_type: showUpholstery ? (upholsteryType || null) : null,
        upholstery_notes: showUpholstery ? (upholsteryNotes || null) : null,
        upholstery_units: showUnits && upholsteryUnits !== "" ? Number(upholsteryUnits) : null,
        upholstery_unit_price: showUnits && upholsteryUnitPrice !== "" ? Number(upholsteryUnitPrice.replace(",", ".")) : null,
        unit_value: upholsteryTotal != null && upholsteryTotal > 0 ? upholsteryTotal : null,
        notes: notes || undefined,
      });
      setLoading(false);
      submittingRef.current = false;
      if (!recRes.ok) { setMessage("Erro ao criar intervenção: " + recRes.error); return; }
      setSaved(true);
      onCreated();
      return;
    }

    const res = await createService({
      companyId,
      locationId,
      teamId: teamId || null,
      scheduledStart: `${dateStr}T${startTime}:00`,
      scheduledEnd: `${dateStr}T${endTime}:00`,
      hourlyRate: isFixed ? null : effectiveRate,
      numPeople,
      applyVat: withVat,
      // Prioridade: estofos por unidade > valor fixo/cálculo por hora.
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
    submittingRef.current = false;
    if (!res.ok) {
      if (res.canForce && res.conflicts && res.conflicts.length > 0) {
        setConflicts(res.conflicts);
        setPendingForce({});
      } else {
        setMessage("Erro ao criar: " + res.error);
      }
    } else {
      setSaved(true);
      onCreated();
    }
  }

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setSaved(false);
    if (!locationId) { setMessage("Seleciona um local."); return; }
    if (durationMin <= 0) { setMessage("A hora de fim deve ser posterior ao início."); return; }
    if (isFixed && (parsedFixed == null || parsedFixed <= 0)) { setMessage("Indica o valor fixo do serviço."); return; }
    if (showUpholstery && !upholsteryType) { setMessage("Seleciona o tipo de estofado."); return; }
    if (showUnits && (upholsteryUnits === "" || Number(upholsteryUnits) <= 0)) {
      setMessage("Indica o número de unidades do estofado.");
      return;
    }
    await doCreate(false);
  }

  if (!open) return null;

  return (
    <div className="fixed inset-0 z-[9999] flex items-center justify-center p-4">
      {/* Fundo: NÃO fecha ao clicar (evita perder dados). Fecha pelo X. */}
      <div className="absolute inset-0 bg-black/40 backdrop-blur-sm" />
      <div className="relative bg-white rounded-2xl shadow-2xl w-full max-w-lg max-h-[90vh] z-10 flex flex-col">

        {/* Header */}
        <div className="flex items-center justify-between px-6 py-4 border-b border-[var(--color-border)]">
          <div>
            <h2 className="text-base font-semibold text-[var(--color-text-main)]">Novo serviço</h2>
            <p className="text-xs text-[var(--color-text-muted)] mt-0.5">
              {format(serviceDate, "EEEE, d 'de' MMMM yyyy", { locale: pt })} · {startTime}–{endTime}
            </p>
          </div>
          <button onClick={onClose} className="p-1.5 rounded-lg text-[var(--color-text-muted)] hover:bg-[var(--color-background)] transition-colors">
            <X className="w-5 h-5" />
          </button>
        </div>

        {/* Body */}
        <div className="flex-1 overflow-y-auto">
          <form id="create-service-form" onSubmit={handleSubmit} className="px-6 py-5 space-y-5">

            {/* Cliente (pesquisa) + Local */}
            <div className="space-y-3">
              {fixedClientId ? null : clientId ? (
                /* Cliente escolhido */
                <Field label="Cliente *">
                  <div className="flex items-center justify-between gap-2 rounded-lg border border-[var(--color-border)] px-3 py-2">
                    <span className="text-sm font-medium text-[var(--color-text-main)] truncate">
                      {clientList.find((c) => c.id === clientId)?.name ?? "—"}
                    </span>
                    <button
                      type="button"
                      onClick={() => { setClientId(""); setLocationId(""); setClientSearch(""); }}
                      className="text-xs font-medium text-[var(--color-primary)] hover:underline shrink-0"
                    >
                      Mudar
                    </button>
                  </div>
                </Field>
              ) : (
                /* Pesquisa de cliente */
                <Field label="Cliente *">
                  <div className="relative">
                    <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-[var(--color-text-muted)] pointer-events-none" />
                    <input
                      type="text"
                      value={clientSearch}
                      onChange={(e) => setClientSearch(e.target.value)}
                      placeholder="Pesquisar cliente pelo nome..."
                      className={INPUT_CLS + " pl-9"}
                    />
                  </div>
                  {!showNewClient && (() => {
                    const q = clientSearch.trim().toLowerCase();
                    const matches = q
                      ? clientList.filter((c) => c.name.toLowerCase().includes(q)).slice(0, 6)
                      : clientList.slice(0, 6);
                    return (
                      <div className="mt-1.5 rounded-lg border border-[var(--color-border)] overflow-hidden">
                        {matches.map((c) => (
                          <button
                            key={c.id}
                            type="button"
                            onClick={() => { setClientId(c.id); setLocationId(""); }}
                            className="w-full text-left px-3 py-2 text-sm text-[var(--color-text-main)] hover:bg-[var(--color-background)] border-b border-[var(--color-border)] last:border-0"
                          >
                            {c.name}
                          </button>
                        ))}
                        <button
                          type="button"
                          onClick={() => setShowNewClient(true)}
                          className="w-full flex items-center gap-1.5 px-3 py-2 text-sm font-medium text-[var(--color-primary)] hover:bg-[var(--color-primary-light)]"
                        >
                          <Plus className="w-4 h-4" />
                          {q && matches.length === 0 ? `Adicionar "${clientSearch.trim()}"` : "Adicionar novo cliente"}
                        </button>
                      </div>
                    );
                  })()}
                </Field>
              )}

              {/* Local — só depois de escolher o cliente */}
              {(clientId || fixedClientId) && !showNewClient && (
                <Field label="Local *">
                  <div className="relative">
                    <select
                      value={locationId}
                      onChange={(e) => setLocationId(e.target.value)}
                      className={SELECT_CLS}
                    >
                      <option value="">Selecionar...</option>
                      {filteredLocations.map((l) => <option key={l.id} value={l.id}>{l.name}</option>)}
                    </select>
                    <ChevronDown className="pointer-events-none absolute right-2 top-1/2 -translate-y-1/2 w-4 h-4 text-[var(--color-text-muted)]" />
                  </div>
                </Field>
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
                    {/* Pesquisa de morada (autocomplete Nominatim) */}
                    <div ref={addrWrapRef} className="relative">
                      <label className="block text-xs font-medium text-[var(--color-text-main)] mb-1">Morada *</label>
                      <div className="relative">
                        <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-[var(--color-text-muted)] pointer-events-none" />
                        <input
                          type="text"
                          value={newLocAddress}
                          onChange={(e) => handleAddrSearch(e.target.value)}
                          onFocus={() => addrSuggestions.length > 0 && setAddrShow(true)}
                          placeholder="Rua, número, cidade..."
                          className={INPUT_CLS + " pl-9 pr-9"}
                        />
                        {addrSearching && <Loader2 className="absolute right-3 top-1/2 -translate-y-1/2 w-4 h-4 animate-spin text-[var(--color-text-muted)]" />}
                        {addrGeocoded && !addrSearching && <CheckCircle2 className="absolute right-3 top-1/2 -translate-y-1/2 w-4 h-4 text-[var(--color-primary)]" />}
                      </div>
                      <p className="text-[11px] text-[var(--color-text-muted)] mt-1">
                        Clica numa sugestão para puxar a localização (GPS), ou preenche abaixo.
                      </p>
                      {addrShow && addrSuggestions.length > 0 && (
                        <div className="absolute top-full left-0 right-0 mt-1 bg-white border border-[var(--color-border)] rounded-lg shadow-lg z-50 overflow-hidden">
                          {addrSuggestions.map((s) => (
                            <button
                              key={s.place_id}
                              type="button"
                              onClick={() => pickAddr(s)}
                              className="w-full flex items-start gap-2.5 px-3 py-2.5 text-left hover:bg-[var(--color-background)] transition-colors border-b border-[var(--color-border)] last:border-0"
                            >
                              <MapPin className="w-3.5 h-3.5 mt-0.5 shrink-0 text-[var(--color-primary)]" />
                              <span className="text-xs text-[var(--color-text-main)] leading-relaxed line-clamp-2">{s.display_name}</span>
                            </button>
                          ))}
                        </div>
                      )}
                    </div>

                    {/* Campos estruturados (auto pela pesquisa ou manual) */}
                    <div className="grid grid-cols-3 gap-2">
                      <div className="col-span-2">
                        <label className="block text-xs font-medium text-[var(--color-text-muted)] mb-1">Rua / Avenida</label>
                        <input value={addrRoad} onChange={(e) => setAddrRoad(e.target.value)} placeholder="Rua das Flores" className={INPUT_CLS + " text-xs"} />
                      </div>
                      <div>
                        <label className="block text-xs font-medium text-[var(--color-text-muted)] mb-1">Nº / Lote</label>
                        <input value={addrNumber} onChange={(e) => setAddrNumber(e.target.value)} placeholder="10" className={INPUT_CLS + " text-xs"} />
                      </div>
                    </div>
                    <div>
                      <label className="block text-xs font-medium text-[var(--color-text-muted)] mb-1">Andar / Complemento</label>
                      <input value={addrComplement} onChange={(e) => setAddrComplement(e.target.value)} placeholder="2º Dto, Loja A..." className={INPUT_CLS + " text-xs"} />
                    </div>
                    <div className="grid grid-cols-2 gap-2">
                      <div>
                        <label className="block text-xs font-medium text-[var(--color-text-muted)] mb-1">Código Postal</label>
                        <input value={addrPostal} onChange={(e) => setAddrPostal(e.target.value)} placeholder="1150-007" className={INPUT_CLS + " text-xs"} />
                      </div>
                      <div>
                        <label className="block text-xs font-medium text-[var(--color-text-muted)] mb-1">Cidade</label>
                        <input value={addrCity} onChange={(e) => setAddrCity(e.target.value)} placeholder="Lisboa" className={INPUT_CLS + " text-xs"} />
                      </div>
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
                    disabled={creatingClient || !newClientName.trim() || !newLocName.trim() || !composeNewAddress().trim()}
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

            {/* Data */}
            <Field label="Data *">
              <input
                type="date"
                value={safeFormat(serviceDate, "yyyy-MM-dd")}
                onChange={(e) => { if (isValidIsoDateString(e.target.value)) setServiceDate(parseISO(e.target.value)); }}
                className={INPUT_CLS}
                required
              />
            </Field>

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

            {/* Recorrência */}
            <div className="rounded-xl border border-[var(--color-border)] p-3 space-y-3">
              <label className="flex items-center gap-2.5 cursor-pointer">
                <button
                  type="button"
                  onClick={() => setRecurring((r) => !r)}
                  className={`relative w-10 h-5 rounded-full transition-colors ${recurring ? "bg-[var(--color-primary)]" : "bg-[var(--color-border)]"}`}
                >
                  <span className={`absolute top-0.5 w-4 h-4 bg-white rounded-full shadow transition-all ${recurring ? "left-[22px]" : "left-0.5"}`} />
                </button>
                <span className="text-sm font-medium text-[var(--color-text-main)]">Repetir (intervenção recorrente)</span>
              </label>

              {recurring && (
                <div className="space-y-3">
                  <Field label="Frequência">
                    <div className="relative">
                      <select value={recFrequency} onChange={(e) => setRecFrequency(e.target.value as typeof recFrequency)} className={SELECT_CLS}>
                        <option value="weekly">Semanal</option>
                        <option value="biweekly">Quinzenal</option>
                        <option value="daily">Diária (dias úteis)</option>
                        <option value="monthly">Mensal</option>
                      </select>
                      <ChevronDown className="pointer-events-none absolute right-2 top-1/2 -translate-y-1/2 w-4 h-4 text-[var(--color-text-muted)]" />
                    </div>
                  </Field>
                  {(recFrequency === "weekly" || recFrequency === "biweekly") && (
                    <div>
                      <label className="block text-xs font-medium text-[var(--color-text-main)] mb-1.5">Dias da semana</label>
                      <div className="flex flex-wrap gap-1.5">
                        {REC_WEEKDAYS.map((w) => (
                          <button
                            key={w.value}
                            type="button"
                            onClick={() => setRecWeekdays((prev) => prev.includes(w.value) ? prev.filter((x) => x !== w.value) : [...prev, w.value].sort())}
                            className={`px-2.5 py-1 rounded-lg text-xs font-medium border transition-colors ${
                              recWeekdays.includes(w.value)
                                ? "bg-[var(--color-primary)] text-white border-[var(--color-primary)]"
                                : "bg-white text-[var(--color-text-sub)] border-[var(--color-border)]"
                            }`}
                          >
                            {w.label}
                          </button>
                        ))}
                      </div>
                    </div>
                  )}
                  <p className="text-xs text-[var(--color-text-muted)]">
                    A data acima é o início. As ocorrências são geradas automaticamente.
                  </p>
                </div>
              )}
            </div>

            {/* Mecânica de faturação: por hora ou valor fixo */}
            <Field label="Mecânica de faturação">
              <div className="grid grid-cols-2 gap-2">
                {[
                  { value: "hourly", label: "Por hora" },
                  { value: "fixed", label: "Avença" },
                ].map((m) => (
                  <button
                    type="button"
                    key={m.value}
                    onClick={() => setBillingMode(m.value as "hourly" | "fixed")}
                    className={`px-3 py-2 rounded-lg text-sm font-medium transition-colors border ${
                      billingMode === m.value
                        ? "bg-[var(--color-primary)] text-white border-[var(--color-primary)]"
                        : "bg-white text-[var(--color-text-sub)] border-[var(--color-border)] hover:border-[var(--color-primary)]"
                    }`}
                  >
                    {m.label}
                  </button>
                ))}
              </div>
            </Field>

            {/* Valor/hora (modo por hora) */}
            {!isFixed && (
              <Field label="Valor/hora (€)">
                <input
                  type="number"
                  min="0"
                  step="0.5"
                  value={serviceRate}
                  onChange={(e) => setServiceRate(e.target.value)}
                  placeholder="Ex: 15.00"
                  className={INPUT_CLS}
                />
                <p className="mt-1 text-xs text-[var(--color-text-muted)]">
                  Pré-preenchido com o valor do local. Podes ajustar só para este serviço.
                </p>
              </Field>
            )}

            {/* Valor fixo (modo valor fixo) */}
            {isFixed && (
              <Field label={recurring ? "Valor mensal da avença (€)" : "Valor fixo (€)"}>
                <input
                  type="number"
                  min="0"
                  step="0.01"
                  value={fixedValue}
                  onChange={(e) => setFixedValue(e.target.value)}
                  placeholder={recurring ? "Ex: 300.00" : "Ex: 50.00"}
                  className={INPUT_CLS}
                />
                <p className="mt-1 text-xs text-[var(--color-text-muted)]">
                  {recurring
                    ? "Valor total mensal desta avença. Nos relatórios é dividido pelos serviços realizados no mês (ex: €300 ÷ 3 serviços = €100 cada)."
                    : "Valor fixo deste serviço, independente da duração e do nº de pessoas."}
                </p>
              </Field>
            )}

            {/* Previsão de valor */}
            {calculatedValue != null && (
              <div className="p-3 rounded-lg bg-[var(--color-primary-light)] border border-[var(--color-primary-muted)] space-y-2">
                <p className="text-xs text-[var(--color-primary)] font-medium">
                  Duração: {Math.floor(durationMin / 60)}h{durationMin % 60 > 0 ? `${durationMin % 60}min` : ""} ·{" "}
                  {isFixed ? "Valor fixo" : "Valor estimado"}: <strong>€{calculatedValue.toFixed(2)}</strong>
                  {!isFixed && effectiveRate != null && (
                    <span className="font-normal opacity-80"> ({effectiveRate}€/h × {numPeople} pessoa{numPeople !== 1 ? "s" : ""})</span>
                  )}
                </p>

                {/* Interruptor: mostrar total com IVA */}
                <label className="flex items-center gap-2.5 cursor-pointer">
                  <button
                    type="button"
                    onClick={() => setWithVat((v) => !v)}
                    className={`relative w-10 h-5 rounded-full transition-colors shrink-0 ${withVat ? "bg-[var(--color-primary)]" : "bg-[var(--color-border)]"}`}
                  >
                    <span className={`absolute top-0.5 w-4 h-4 bg-white rounded-full shadow transition-all ${withVat ? "left-[22px]" : "left-0.5"}`} />
                  </button>
                  <span className="text-xs font-medium text-[var(--color-text-main)]">Faturar com IVA ({vatRate}%)</span>
                </label>

                {withVat ? (
                  <p className="text-sm text-[var(--color-primary)] font-semibold">
                    Total com IVA: €{(calculatedValue * (1 + vatRate / 100)).toFixed(2)}
                    <span className="font-normal text-xs opacity-80"> (IVA: €{(calculatedValue * vatRate / 100).toFixed(2)})</span>
                  </p>
                ) : (
                  <p className="text-xs text-[var(--color-text-muted)]">Este serviço será faturado <strong>sem IVA</strong>.</p>
                )}
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
          {saved ? (
            <div className="flex items-center justify-between gap-3">
              <span className="flex items-center gap-2 text-sm font-semibold text-[var(--color-primary)]">
                <CheckCircle2 className="w-5 h-5" /> Guardado
              </span>
              <button
                type="button"
                onClick={onClose}
                className="px-5 py-2.5 rounded-lg bg-[var(--color-primary)] text-white text-sm font-semibold hover:bg-[var(--color-primary-hover)] transition-colors"
              >
                Fechar
              </button>
            </div>
          ) : (
            <button
              form="create-service-form"
              type="submit"
              disabled={loading || conflicts.length > 0}
              className="w-full flex items-center justify-center gap-2 px-4 py-2.5 rounded-lg bg-[var(--color-primary)] text-white text-sm font-semibold hover:bg-[var(--color-primary-hover)] transition-colors disabled:opacity-50"
            >
              {loading && <Loader2 className="w-4 h-4 animate-spin" />}
              {recurring ? "Criar intervenção recorrente" : "Criar serviço"}
            </button>
          )}
        </div>
      </div>
    </div>
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

"use client";

import { useState, cloneElement, isValidElement, useRef, useEffect } from "react";
import { createPortal } from "react-dom";
import { useRouter } from "next/navigation";
import { X, Loader2, Search, MapPin, CheckCircle2 } from "lucide-react";
import { createClient } from "@/lib/supabase/client";

type Local = {
  id: string;
  name: string;
  address: string;
  lat: number | null;
  lng: number | null;
  hourly_rate: number | null;
  active: boolean;
  client_id: string;
  access_code: string | null;
  instructions: string | null;
};

type Cliente = { id: string; name: string };

interface Props {
  trigger: React.ReactElement;
  companyId: string;
  clientes: Cliente[];
  local?: Local;
}

interface NominatimResult {
  place_id: number;
  display_name: string;
  lat: string;
  lon: string;
  address: {
    road?: string;
    pedestrian?: string;
    house_number?: string;
    postcode?: string;
    city?: string;
    town?: string;
    village?: string;
    municipality?: string;
    county?: string;
  };
}

const INPUT_CLS =
  "w-full px-3 py-2 rounded-lg border border-[var(--color-border)] text-sm text-[var(--color-text-main)] " +
  "focus:outline-none focus:ring-2 focus:ring-[var(--color-primary)] focus:border-transparent bg-white";

export function LocalSheet({ trigger, companyId, clientes, local }: Props) {
  const router = useRouter();
  const supabase = createClient();

  const [open, setOpen]       = useState(false);
  const [loading, setLoading] = useState(false);
  const [message, setMessage] = useState<{ type: "error" | "success"; text: string } | null>(null);

  // Campos base
  const [name, setName]           = useState(local?.name ?? "");
  const [clientId, setClientId]   = useState(local?.client_id ?? (clientes[0]?.id ?? ""));
  const [hourlyRate, setHourlyRate] = useState(String(local?.hourly_rate ?? ""));
  const [accessCode, setAccessCode] = useState(local?.access_code ?? "");
  const [instructions, setInstructions] = useState(local?.instructions ?? "");
  const [active, setActive]       = useState(local?.active ?? true);

  // Endereço estruturado
  const [road, setRoad]           = useState("");
  const [houseNumber, setHouseNumber] = useState("");
  const [complement, setComplement] = useState("");
  const [postalCode, setPostalCode] = useState("");
  const [city, setCity]           = useState("");
  const [lat, setLat]             = useState<string>(String(local?.lat ?? ""));
  const [lng, setLng]             = useState<string>(String(local?.lng ?? ""));
  const [geocoded, setGeocoded]   = useState(false);

  // Pesquisa de morada
  const [searchQuery, setSearchQuery]     = useState(local?.address ?? "");
  const [suggestions, setSuggestions]     = useState<NominatimResult[]>([]);
  const [showSuggestions, setShowSuggestions] = useState(false);
  const [searching, setSearching]         = useState(false);
  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const searchWrapRef = useRef<HTMLDivElement>(null);

  const isEdit = !!local;

  // Compor endereço final a partir dos campos estruturados
  function composeAddress(): string {
    const parts: string[] = [];
    if (road) parts.push(`${road}${houseNumber ? " " + houseNumber : ""}`);
    if (complement) parts.push(complement);
    if (postalCode || city) parts.push(`${postalCode}${postalCode && city ? " " : ""}${city}`);
    return parts.join(", ");
  }

  // Pesquisa Nominatim com debounce
  function handleSearchInput(value: string) {
    setSearchQuery(value);
    setGeocoded(false);
    if (debounceRef.current) clearTimeout(debounceRef.current);
    if (value.trim().length < 4) { setSuggestions([]); setShowSuggestions(false); return; }

    debounceRef.current = setTimeout(async () => {
      setSearching(true);
      try {
        const encoded = encodeURIComponent(value + (value.toLowerCase().includes("portugal") ? "" : ", Portugal"));
        const res = await fetch(
          `https://nominatim.openstreetmap.org/search?q=${encoded}&format=json&limit=5&addressdetails=1&countrycodes=pt`,
          { headers: { "Accept-Language": "pt" } }
        );
        const data: NominatimResult[] = await res.json();
        setSuggestions(data);
        setShowSuggestions(data.length > 0);
      } catch {
        setSuggestions([]);
      } finally {
        setSearching(false);
      }
    }, 420);
  }

  // Selecionar sugestão → preencher campos estruturados
  function pickSuggestion(r: NominatimResult) {
    const a = r.address;
    const roadVal = a.road ?? a.pedestrian ?? "";
    const numVal  = a.house_number ?? "";
    const pcVal   = a.postcode ?? "";
    const cityVal = a.city ?? a.town ?? a.village ?? a.municipality ?? a.county ?? "";

    setRoad(roadVal);
    setHouseNumber(numVal);
    setPostalCode(pcVal);
    setCity(cityVal);
    setLat(r.lat);
    setLng(r.lon);
    setGeocoded(true);

    // Atualizar searchQuery com endereço formatado limpo
    const display = [
      roadVal + (numVal ? " " + numVal : ""),
      pcVal + (pcVal && cityVal ? " " : "") + cityVal,
    ].filter(Boolean).join(", ");
    setSearchQuery(display);
    setSuggestions([]);
    setShowSuggestions(false);
  }

  // Fechar dropdown ao clicar fora
  useEffect(() => {
    function handleClickOutside(e: MouseEvent) {
      if (searchWrapRef.current && !searchWrapRef.current.contains(e.target as Node)) {
        setShowSuggestions(false);
      }
    }
    document.addEventListener("mousedown", handleClickOutside);
    return () => document.removeEventListener("mousedown", handleClickOutside);
  }, []);

  async function handleSubmit(e: React.SyntheticEvent<HTMLFormElement>) {
    e.preventDefault();
    if (loading) return; // Prevenir double-submit

    const composedAddress = isEdit ? searchQuery : composeAddress();
    if (!composedAddress.trim()) {
      setMessage({ type: "error", text: "Preenche a morada completa." });
      return;
    }

    setLoading(true);
    setMessage(null);

    const updateData = {
      name,
      address: composedAddress.trim(),
      hourly_rate: hourlyRate ? parseFloat(hourlyRate) : null,
      access_code: accessCode || null,
      instructions: instructions || null,
      lat: lat ? parseFloat(lat) : null,
      lng: lng ? parseFloat(lng) : null,
      active,
    };

    const query = isEdit
      ? supabase.from("locations").update(updateData).eq("id", local.id)
      : supabase.from("locations").insert({ ...updateData, client_id: clientId, company_id: companyId });

    const { error } = await query;
    setLoading(false);

    if (error) {
      setMessage({ type: "error", text: "Erro ao guardar. Tenta novamente." });
      return;
    }

    // Fechar e refrescar imediatamente após sucesso
    setOpen(false);
    router.refresh();
  }

  const triggerWithOpen = isValidElement(trigger)
    ? cloneElement(trigger as React.ReactElement<{ onClick?: () => void }>, {
        onClick: () => {
          setMessage(null);
          setOpen(true);
        },
      })
    : trigger;

  const overlay = open ? createPortal(
    <>
      <div className="fixed inset-0 bg-black/30 z-[9998]" onClick={() => setOpen(false)} />
      <div className="fixed right-0 top-0 h-full w-full max-w-md bg-white shadow-xl z-[9999] flex flex-col">
            <div className="flex items-center justify-between px-6 py-4 border-b border-[var(--color-border)]">
              <h2 className="text-base font-semibold text-[var(--color-text-main)]">
                {isEdit ? "Editar local" : "Novo local"}
              </h2>
              <button
                onClick={() => setOpen(false)}
                className="p-1.5 rounded-lg text-[var(--color-text-muted)] hover:bg-[var(--color-background)] transition-colors"
              >
                <X className="w-5 h-5" />
              </button>
            </div>

            <form id="local-form" onSubmit={handleSubmit} className="flex-1 overflow-y-auto px-6 py-5 space-y-4">

              {/* Nome */}
              <div>
                <label className="block text-sm font-medium text-[var(--color-text-main)] mb-1.5">Nome do local *</label>
                <input
                  required
                  value={name}
                  onChange={(e) => setName(e.target.value)}
                  placeholder="ex: Escritório Lisboa Centro"
                  className={INPUT_CLS}
                />
              </div>

              {/* Cliente */}
              {!isEdit && (
                <div>
                  <label className="block text-sm font-medium text-[var(--color-text-main)] mb-1.5">Cliente *</label>
                  <select
                    required
                    value={clientId}
                    onChange={(e) => setClientId(e.target.value)}
                    className={INPUT_CLS}
                  >
                    {clientes.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
                  </select>
                </div>
              )}

              {/* Pesquisa de morada (autocomplete) */}
              <div ref={searchWrapRef} className="relative">
                <label className="block text-sm font-medium text-[var(--color-text-main)] mb-1.5">
                  Pesquisar morada
                </label>
                <div className="relative">
                  <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-[var(--color-text-muted)] pointer-events-none" />
                  <input
                    value={searchQuery}
                    onChange={(e) => handleSearchInput(e.target.value)}
                    onFocus={() => suggestions.length > 0 && setShowSuggestions(true)}
                    placeholder="Rua, número, cidade..."
                    className={INPUT_CLS + " pl-9 pr-9"}
                  />
                  {searching && (
                    <Loader2 className="absolute right-3 top-1/2 -translate-y-1/2 w-4 h-4 animate-spin text-[var(--color-text-muted)]" />
                  )}
                  {geocoded && !searching && (
                    <CheckCircle2 className="absolute right-3 top-1/2 -translate-y-1/2 w-4 h-4 text-[var(--color-primary)]" />
                  )}
                </div>

                {/* Dropdown de sugestões */}
                {showSuggestions && suggestions.length > 0 && (
                  <div className="absolute top-full left-0 right-0 mt-1 bg-white border border-[var(--color-border)] rounded-lg shadow-lg z-50 overflow-hidden">
                    {suggestions.map((s) => (
                      <button
                        key={s.place_id}
                        type="button"
                        onClick={() => pickSuggestion(s)}
                        className="w-full flex items-start gap-2.5 px-3 py-2.5 text-left hover:bg-[var(--color-background)] transition-colors border-b border-[var(--color-border)] last:border-0"
                      >
                        <MapPin className="w-3.5 h-3.5 mt-0.5 shrink-0 text-[var(--color-primary)]" />
                        <span className="text-xs text-[var(--color-text-main)] leading-relaxed line-clamp-2">
                          {s.display_name}
                        </span>
                      </button>
                    ))}
                  </div>
                )}
              </div>

              {/* Campos estruturados (preenchidos pela pesquisa ou manualmente) */}
              {!isEdit && (
                <div className="space-y-3 p-3 rounded-lg bg-[var(--color-background)] border border-[var(--color-border)]">
                  <p className="text-xs font-medium text-[var(--color-text-muted)]">
                    Detalhes da morada (preenchido automaticamente ou manualmente)
                  </p>

                  <div className="grid grid-cols-3 gap-2">
                    <div className="col-span-2">
                      <label className="block text-xs font-medium text-[var(--color-text-muted)] mb-1">Rua / Avenida *</label>
                      <input
                        value={road}
                        onChange={(e) => setRoad(e.target.value)}
                        placeholder="Rua das Flores"
                        className={INPUT_CLS + " text-xs"}
                      />
                    </div>
                    <div>
                      <label className="block text-xs font-medium text-[var(--color-text-muted)] mb-1">Nº / Lote</label>
                      <input
                        value={houseNumber}
                        onChange={(e) => setHouseNumber(e.target.value)}
                        placeholder="10"
                        className={INPUT_CLS + " text-xs"}
                      />
                    </div>
                  </div>

                  <div>
                    <label className="block text-xs font-medium text-[var(--color-text-muted)] mb-1">Andar / Complemento</label>
                    <input
                      value={complement}
                      onChange={(e) => setComplement(e.target.value)}
                      placeholder="2º Dto, Loja A, Escritório 3..."
                      className={INPUT_CLS + " text-xs"}
                    />
                  </div>

                  <div className="grid grid-cols-2 gap-2">
                    <div>
                      <label className="block text-xs font-medium text-[var(--color-text-muted)] mb-1">Código Postal *</label>
                      <input
                        value={postalCode}
                        onChange={(e) => setPostalCode(e.target.value)}
                        placeholder="1150-007"
                        className={INPUT_CLS + " text-xs"}
                      />
                    </div>
                    <div>
                      <label className="block text-xs font-medium text-[var(--color-text-muted)] mb-1">Cidade *</label>
                      <input
                        value={city}
                        onChange={(e) => setCity(e.target.value)}
                        placeholder="Lisboa"
                        className={INPUT_CLS + " text-xs"}
                      />
                    </div>
                  </div>
                </div>
              )}

              {/* Em modo edição: só mostra campo de morada simples */}
              {isEdit && (
                <p className="text-xs text-[var(--color-text-muted)] -mt-2">
                  Pesquisa uma nova morada acima para alterar, ou edita o campo directamente.
                </p>
              )}

              {/* €/hora + Código de acesso */}
              <div className="grid grid-cols-2 gap-3">
                <div>
                  <label className="block text-sm font-medium text-[var(--color-text-main)] mb-1.5">€/hora</label>
                  <input
                    type="number"
                    step="0.01"
                    min="0"
                    value={hourlyRate}
                    onChange={(e) => setHourlyRate(e.target.value)}
                    className={INPUT_CLS}
                  />
                </div>
                <div>
                  <label className="block text-sm font-medium text-[var(--color-text-main)] mb-1.5">Cód. acesso</label>
                  <input
                    value={accessCode}
                    onChange={(e) => setAccessCode(e.target.value)}
                    placeholder="1234#"
                    className={INPUT_CLS}
                  />
                </div>
              </div>

              {/* Instruções */}
              <div>
                <label className="block text-sm font-medium text-[var(--color-text-main)] mb-1.5">Instruções internas</label>
                <textarea
                  value={instructions}
                  onChange={(e) => setInstructions(e.target.value)}
                  rows={2}
                  className={INPUT_CLS + " resize-none"}
                  placeholder="Ex: Campainha 2B, estacionamento na rua de trás..."
                />
              </div>

              {/* Toggle ativo */}
              <div className="flex items-center gap-3">
                <button
                  type="button"
                  onClick={() => setActive((a) => !a)}
                  className={`relative w-10 h-5 rounded-full transition-colors ${active ? "bg-[var(--color-primary)]" : "bg-[var(--color-border)]"}`}
                >
                  <span
                    className={`absolute top-0.5 w-4 h-4 bg-white rounded-full shadow transition-all ${active ? "left-5.5" : "left-0.5"}`}
                  />
                </button>
                <span className="text-sm text-[var(--color-text-main)]">{active ? "Local ativo" : "Local inativo"}</span>
              </div>

              {message && (
                <div className={`text-sm px-3 py-2 rounded-lg border ${
                  message.type === "error"
                    ? "bg-red-50 text-[var(--color-danger)] border-red-100"
                    : "bg-[var(--color-primary-light)] text-[var(--color-primary)] border-[var(--color-primary-muted)]"
                }`}>
                  {message.text}
                </div>
              )}
            </form>

            <div className="border-t border-[var(--color-border)] px-6 py-4">
              <button
                form="local-form"
                type="submit"
                disabled={loading}
                className="w-full flex items-center justify-center gap-2 px-4 py-2 rounded-lg bg-[var(--color-primary)] text-white text-sm font-medium hover:bg-[var(--color-primary-hover)] transition-colors disabled:opacity-50"
              >
                {loading && <Loader2 className="w-4 h-4 animate-spin" />}
                {isEdit ? "Guardar alterações" : "Criar local"}
              </button>
            </div>
          </div>
    </>,
    document.body
  ) : null;

  return (
    <>
      {triggerWithOpen}
      {overlay}
    </>
  );
}

"use client";

import { useState, useRef, useEffect, useTransition } from "react";
import { createPortal } from "react-dom";
import { useRouter } from "next/navigation";
import { X, Loader2, Search, MapPin, CheckCircle2, Map as MapIcon } from "lucide-react";
import { createLocation, updateLocation } from "@/app/actions/locations";
import { PinPicker } from "@/components/map/pin-picker";
import {
  buildSearchUrl,
  composeAddress as composeAddressParts,
  parseAddress,
  type NominatimResult,
  type StructuredAddress,
} from "@/lib/geocoding";

type Local = {
  id: string;
  name: string;
  address: string;
  lat: number | null;
  lng: number | null;
  hourly_rate: number | null;
  fixed_price: number | null;
  pricing_type: "hourly" | "fixed";
  active: boolean;
  client_id: string;
  access_code: string | null;
  instructions: string | null;
  has_key: boolean;
  key_label: string | null;
};

type Cliente = { id: string; name: string };

interface Props {
  trigger: React.ReactElement;
  companyId: string;
  clientes: Cliente[];
  local?: Local;
  /** Quando definido, o local fica pré-associado a este cliente e o seletor é escondido. */
  fixedClientId?: string;
}

const INPUT_CLS =
  "w-full px-3 py-2 rounded-lg border border-[var(--color-border)] text-sm text-[var(--color-text-main)] " +
  "focus:outline-none focus:ring-2 focus:ring-[var(--color-primary)] focus:border-transparent bg-white";

export function LocalSheet({ trigger, companyId, clientes, local, fixedClientId }: Props) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();

  const [open, setOpen]       = useState(false);
  const [message, setMessage] = useState<{ type: "error" | "success"; text: string } | null>(null);

  const [name, setName]           = useState(local?.name ?? "");
  const [clientId, setClientId]   = useState(local?.client_id ?? fixedClientId ?? (clientes[0]?.id ?? ""));
  const [pricingType, setPricingType] = useState<"hourly" | "fixed">(local?.pricing_type ?? "hourly");
  const [hourlyRate, setHourlyRate] = useState(String(local?.hourly_rate ?? ""));
  const [fixedPrice, setFixedPrice] = useState(String(local?.fixed_price ?? ""));
  const [accessCode, setAccessCode] = useState(local?.access_code ?? "");
  const [hasKey, setHasKey]       = useState(local?.has_key ?? false);
  const [keyLabel, setKeyLabel]   = useState(local?.key_label ?? "");
  const [instructions, setInstructions] = useState(local?.instructions ?? "");
  const [active, setActive]       = useState(local?.active ?? true);

  const [road, setRoad]           = useState("");
  const [houseNumber, setHouseNumber] = useState("");
  const [complement, setComplement] = useState("");
  const [postalCode, setPostalCode] = useState("");
  const [city, setCity]           = useState("");
  const [lat, setLat]             = useState<string>(String(local?.lat ?? ""));
  const [lng, setLng]             = useState<string>(String(local?.lng ?? ""));
  const [geocoded, setGeocoded]   = useState(false);

  const [searchQuery, setSearchQuery]     = useState(local?.address ?? "");
  const [suggestions, setSuggestions]     = useState<NominatimResult[]>([]);
  const [showSuggestions, setShowSuggestions] = useState(false);
  const [searching, setSearching]         = useState(false);
  const [noResults, setNoResults]         = useState(false);
  // Melhor palpite da pesquisa: a primeira sugestão que o Nominatim devolveu,
  // ainda sem ninguém ter escolhido nada. Serve só para o mapa já estar na
  // zona certa enquanto a morada está a ser escrita — não marca ponto nenhum
  // nem preenche campo nenhum, porque ninguém confirmou que é ali.
  const [focus, setFocus] = useState<{ lat: number; lng: number } | null>(null);
  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const searchWrapRef = useRef<HTMLDivElement>(null);

  const isEdit = !!local;

  const latNum = lat ? parseFloat(lat) : NaN;
  const lngNum = lng ? parseFloat(lng) : NaN;
  const hasPin = Number.isFinite(latNum) && Number.isFinite(lngNum);

  // 🔴 O mapa NÃO pode nascer fechado atrás de um link pequeno.
  //
  //    Nasceu, e o resultado foi o previsível: quem tinha exatamente o
  //    problema que isto resolve — «a morada não aparece na pesquisa» — não
  //    encontrava a forma de marcar o ponto. Um caminho de saída que é preciso
  //    descobrir não é um caminho de saída.
  //
  //    Por omissão o mapa segue o estado do ponto: sem ponto marcado está
  //    aberto e à vista; com ponto marcado recolhe, porque aí já não há nada a
  //    resolver e o painel não precisa de ficar comprido. `showMapManual`
  //    guarda a vontade explícita de quem abriu ou fechou à mão, e essa ganha
  //    sempre a partir daí.
  const [showMapManual, setShowMapManual] = useState<boolean | null>(null);
  const showMap = showMapManual ?? !hasPin;

  function composeAddress(): string {
    return composeAddressParts({ road, houseNumber, complement, postalCode, city });
  }

  function handleSearchInput(value: string) {
    setSearchQuery(value);
    setGeocoded(false);
    setNoResults(false);
    if (debounceRef.current) clearTimeout(debounceRef.current);
    if (value.trim().length < 4) { setSuggestions([]); setShowSuggestions(false); return; }

    debounceRef.current = setTimeout(async () => {
      setSearching(true);
      try {
        const res = await fetch(buildSearchUrl(value), { headers: { "Accept-Language": "pt" } });
        const data: NominatimResult[] = await res.json();
        setSuggestions(data);
        setShowSuggestions(data.length > 0);
        setNoResults(data.length === 0);

        // Sem pedidos extra: aproveita o primeiro resultado desta mesma
        // resposta para levar o mapa à zona. Antes disto o mapa mostrava
        // Portugal inteiro e era preciso navegar à mão até à rua.
        const primeiro = data[0];
        if (primeiro) {
          const pLat = parseFloat(primeiro.lat);
          const pLng = parseFloat(primeiro.lon);
          if (Number.isFinite(pLat) && Number.isFinite(pLng)) setFocus({ lat: pLat, lng: pLng });
        }
      } catch {
        setSuggestions([]);
        // Falha de rede fica igual a "não encontrei": o caminho de saída é o
        // mesmo — marcar o ponto no mapa à mão.
        setNoResults(true);
      } finally {
        setSearching(false);
      }
    }, 420);
  }

  function applyStructured(a: StructuredAddress) {
    setRoad(a.road);
    setHouseNumber(a.houseNumber);
    setPostalCode(a.postalCode);
    setCity(a.city);
    setSearchQuery(
      composeAddressParts({ road: a.road, houseNumber: a.houseNumber, postalCode: a.postalCode, city: a.city }) ||
        searchQuery,
    );
  }

  function pickSuggestion(r: NominatimResult) {
    applyStructured(parseAddress(r.address));
    setLat(r.lat);
    setLng(r.lon);
    setGeocoded(true);
    setSuggestions([]);
    setShowSuggestions(false);
    setNoResults(false);
    // Não força o mapa a nada: a sugestão trouxe um ponto, e a regra por
    // omissão recolhe o mapa quando há ponto. Quem quiser confirmar o que o
    // OSM devolveu tem o "Ver / corrigir pin" mesmo ao lado.
  }

  function handlePinChange(nextLat: number, nextLng: number) {
    setLat(String(nextLat));
    setLng(String(nextLng));
    setGeocoded(true);
    setNoResults(false);
    // Este ponto veio de um toque no próprio mapa, logo o mapa está aberto e
    // tem de continuar aberto. Sem isto, a regra por omissão via "já há ponto"
    // e fechava o mapa debaixo da mão de quem o estava a usar.
    setShowMapManual(true);
  }

  useEffect(() => {
    function handleClickOutside(e: MouseEvent) {
      if (searchWrapRef.current && !searchWrapRef.current.contains(e.target as Node)) {
        setShowSuggestions(false);
      }
    }
    document.addEventListener("mousedown", handleClickOutside);
    return () => {
      document.removeEventListener("mousedown", handleClickOutside);
      // A pesquisa espera 420ms antes de ir à rede. Se o painel fechar nesse
      // intervalo, o pedido partia à mesma e voltava para escrever estado num
      // componente que já não existe.
      if (debounceRef.current) clearTimeout(debounceRef.current);
    };
  }, []);

  async function handleSubmit(e: React.SyntheticEvent<HTMLFormElement>) {
    e.preventDefault();
    setMessage(null);

    const composedAddress = isEdit ? searchQuery : (composeAddress() || searchQuery.trim());
    if (!composedAddress.trim()) {
      setMessage({
        type: "error",
        text: "Preenche a morada, pesquisa uma localização ou marca o ponto no mapa.",
      });
      return;
    }

    const payload = {
      name,
      address: composedAddress.trim(),
      pricing_type: pricingType,
      hourly_rate: pricingType === "hourly" ? (hourlyRate ? parseFloat(hourlyRate) : null) : null,
      fixed_price: pricingType === "fixed" ? (fixedPrice ? parseFloat(fixedPrice) : null) : null,
      access_code: accessCode || null,
      has_key: hasKey,
      key_label: hasKey ? (keyLabel || null) : null,
      instructions: instructions || null,
      lat: lat ? parseFloat(lat) : null,
      lng: lng ? parseFloat(lng) : null,
      active,
    };

    startTransition(async () => {
      const res = isEdit
        ? await updateLocation(local.id, payload)
        : await createLocation({ ...payload, client_id: clientId, company_id: companyId });

      if (!res.ok) {
        setMessage({ type: "error", text: res.error ?? "Erro ao guardar. Tenta novamente." });
        return;
      }

      setOpen(false);
      router.refresh();
    });
  }

  const overlay = open && typeof window !== "undefined" ? createPortal(
    <>
      <div
        className="fixed inset-0 z-[9998]"
        style={{
          background: "rgba(9,14,26,0.45)",
          backdropFilter: "blur(6px)",
          WebkitBackdropFilter: "blur(6px)",
        }}
        onClick={() => setOpen(false)}
      />
      <div
        className="fixed right-0 top-0 h-screen w-full max-w-md z-[9999] flex flex-col"
            style={{
              background: "rgba(255,255,255,0.97)",
              backdropFilter: "blur(24px)",
              WebkitBackdropFilter: "blur(24px)",
              boxShadow: "-8px 0 40px rgba(15,23,42,0.18), -1px 0 0 rgba(255,255,255,0.8)",
            }}
          >
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
              {!isEdit && !fixedClientId && (
                <div>
                  <label className="block text-sm font-medium text-[var(--color-text-main)] mb-1.5">Cliente *</label>
                  <select
                    required
                    value={clientId}
                    onChange={(e) => setClientId(e.target.value)}
                    className={INPUT_CLS}
                  >
                    {clientes.length === 0 && <option value="">Sem clientes disponíveis</option>}
                    {clientes.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
                  </select>
                </div>
              )}

              {/* Pesquisa de morada (autocomplete) */}
              <div ref={searchWrapRef} className="relative z-20">
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
                <p className="text-xs text-[var(--color-text-muted)] mt-1">
                  Clica numa sugestão para obter coordenadas GPS, ou marca o ponto no mapa.
                </p>

                {noResults && !searching && (
                  <div className="mt-2 flex items-start gap-2 p-2.5 rounded-lg bg-amber-50 border border-amber-200">
                    <MapIcon className="w-3.5 h-3.5 mt-0.5 shrink-0 text-amber-600" />
                    <div className="min-w-0">
                      <p className="text-xs text-amber-800 leading-relaxed">
                        Não encontrei esta morada. Marca o ponto exato no mapa — é isso que a equipa
                        vai seguir para chegar lá.
                      </p>
                      <button
                        type="button"
                        onClick={() => setShowMapManual(true)}
                        className="mt-1 text-xs font-semibold text-amber-900 hover:underline"
                      >
                        Abrir mapa
                      </button>
                    </div>
                  </div>
                )}

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

              {/* Ponto exato no mapa — a morada por si só não chega para quem
                  vai lá ter; o pin é o que abre no Google Maps na app.

                  `isolate` cria um contexto de empilhamento próprio: o mapa do
                  MapLibre desenha por cima de quase tudo, e sem isto a lista de
                  sugestões (que flutua a partir do campo acima) acabava por
                  baixo do mapa. Com o contexto isolado, a lista fica sempre
                  visível por cima. */}
              <div className="space-y-2 relative z-0 isolate">
                <div className="flex items-center justify-between gap-2">
                  <label className="block text-sm font-medium text-[var(--color-text-main)]">
                    Ponto exato no mapa
                  </label>
                  <button
                    type="button"
                    onClick={() => setShowMapManual(!showMap)}
                    className="inline-flex items-center gap-1.5 text-xs font-semibold text-[var(--color-primary)] hover:underline"
                  >
                    <MapIcon className="w-3.5 h-3.5" />
                    {showMap ? "Esconder mapa" : hasPin ? "Ver / corrigir pin" : "Marcar no mapa"}
                  </button>
                </div>

                {!showMap && (
                  <p className={`text-xs ${hasPin ? "text-[var(--color-primary)]" : "text-amber-700"}`}>
                    {hasPin
                      ? "Ponto marcado — a equipa vai ser levada exatamente aqui."
                      : "Sem ponto marcado. A equipa só recebe a morada escrita, e pode não encontrar."}
                  </p>
                )}

                {showMap && (
                  <PinPicker
                    lat={hasPin ? latNum : null}
                    lng={hasPin ? lngNum : null}
                    onChange={handlePinChange}
                    focus={focus}
                  />
                )}
              </div>

              {/* Campos estruturados */}
              {!isEdit && (
                <div className="space-y-3 p-3 rounded-lg bg-[var(--color-background)] border border-[var(--color-border)]">
                  <p className="text-xs font-medium text-[var(--color-text-muted)]">
                    Detalhes da morada (preenchido automaticamente pela pesquisa ou manualmente)
                  </p>

                  <div className="grid grid-cols-3 gap-2">
                    <div className="col-span-2">
                      <label className="block text-xs font-medium text-[var(--color-text-muted)] mb-1">Rua / Avenida</label>
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
                      placeholder="2º Dto, Loja A..."
                      className={INPUT_CLS + " text-xs"}
                    />
                  </div>

                  <div className="grid grid-cols-2 gap-2">
                    <div>
                      <label className="block text-xs font-medium text-[var(--color-text-muted)] mb-1">Código Postal</label>
                      <input
                        value={postalCode}
                        onChange={(e) => setPostalCode(e.target.value)}
                        placeholder="1150-007"
                        className={INPUT_CLS + " text-xs"}
                      />
                    </div>
                    <div>
                      <label className="block text-xs font-medium text-[var(--color-text-muted)] mb-1">Cidade</label>
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

              {isEdit && (
                <p className="text-xs text-[var(--color-text-muted)] -mt-2">
                  Pesquisa uma nova morada acima para alterar, ou edita o campo diretamente.
                </p>
              )}

              {/* Tipo de cobrança */}
              <div>
                <label className="block text-sm font-medium text-[var(--color-text-main)] mb-1.5">Tipo de cobrança</label>
                <div className="flex rounded-lg border border-[var(--color-border)] overflow-hidden">
                  <button
                    type="button"
                    onClick={() => setPricingType("hourly")}
                    className={`flex-1 py-2 text-sm font-medium transition-colors ${
                      pricingType === "hourly"
                        ? "bg-[var(--color-primary)] text-white"
                        : "text-[var(--color-text-sub)] hover:bg-[var(--color-background)]"
                    }`}
                  >
                    Por hora
                  </button>
                  <button
                    type="button"
                    onClick={() => setPricingType("fixed")}
                    className={`flex-1 py-2 text-sm font-medium transition-colors border-l border-[var(--color-border)] ${
                      pricingType === "fixed"
                        ? "bg-[var(--color-primary)] text-white"
                        : "text-[var(--color-text-sub)] hover:bg-[var(--color-background)]"
                    }`}
                  >
                    Preço fixo/mês
                  </button>
                </div>
              </div>

              {/* Valor + Código de acesso */}
              <div className="grid grid-cols-2 gap-3">
                <div>
                  {pricingType === "hourly" ? (
                    <>
                      <label className="block text-sm font-medium text-[var(--color-text-main)] mb-1.5">€/hora</label>
                      <input
                        type="number"
                        step="0.01"
                        min="0"
                        value={hourlyRate}
                        onChange={(e) => setHourlyRate(e.target.value)}
                        className={INPUT_CLS}
                      />
                    </>
                  ) : (
                    <>
                      <label className="block text-sm font-medium text-[var(--color-text-main)] mb-1.5">€/mês (fixo)</label>
                      <input
                        type="number"
                        step="0.01"
                        min="0"
                        value={fixedPrice}
                        onChange={(e) => setFixedPrice(e.target.value)}
                        placeholder="ex: 350.00"
                        className={INPUT_CLS}
                      />
                    </>
                  )}
                </div>
                <div>
                  <label className="block text-sm font-medium text-[var(--color-text-main)] mb-1.5">Código do prédio</label>
                  <input
                    value={accessCode}
                    onChange={(e) => setAccessCode(e.target.value)}
                    placeholder="1234#"
                    className={INPUT_CLS}
                  />
                </div>
              </div>

              {/* Chave física */}
              <div className="space-y-3 p-3 rounded-lg bg-[var(--color-background)] border border-[var(--color-border)]">
                <div className="flex items-center gap-3">
                  <button
                    type="button"
                    onClick={() => setHasKey((k) => !k)}
                    className={`relative w-10 h-5 rounded-full transition-colors ${hasKey ? "bg-[var(--color-primary)]" : "bg-[var(--color-border)]"}`}
                  >
                    <span
                      className={`absolute top-0.5 w-4 h-4 bg-white rounded-full shadow transition-all ${hasKey ? "left-[22px]" : "left-0.5"}`}
                    />
                  </button>
                  <span className="text-sm text-[var(--color-text-main)]">Tem chave física</span>
                </div>
                {hasKey && (
                  <div>
                    <label className="block text-sm font-medium text-[var(--color-text-main)] mb-1.5">Identificação da chave</label>
                    <input
                      value={keyLabel}
                      onChange={(e) => setKeyLabel(e.target.value)}
                      placeholder="ex: Chave nº 1974"
                      className={INPUT_CLS}
                    />
                  </div>
                )}
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
                    className={`absolute top-0.5 w-4 h-4 bg-white rounded-full shadow transition-all ${active ? "left-[22px]" : "left-0.5"}`}
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
                disabled={pending}
                className="w-full flex items-center justify-center gap-2 px-4 py-2.5 rounded-xl text-white text-sm font-semibold transition-all disabled:opacity-50"
                style={{
                  background: "linear-gradient(135deg, #22C55E 0%, #16A34A 100%)",
                  boxShadow: "0 4px 14px rgba(34,197,94,0.35)",
                }}
              >
                {pending && <Loader2 className="w-4 h-4 animate-spin" />}
                {isEdit ? "Guardar alterações" : "Criar local"}
              </button>
            </div>
          </div>
        </>
    , document.body) : null;

  return (
    <>
      <span
        onClick={() => { setMessage(null); setOpen(true); }}
        style={{ display: "contents", cursor: "pointer" }}
      >
        {trigger}
      </span>
      {overlay}
    </>
  );
}

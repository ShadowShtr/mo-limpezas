"use client";

import { useState, cloneElement, isValidElement } from "react";
import { X, Loader2, MapPin } from "lucide-react";
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
};

type Cliente = { id: string; name: string };

interface Props {
  trigger: React.ReactElement;
  companyId: string;
  clientes: Cliente[];
  local?: Local;
}

export function LocalSheet({ trigger, companyId, clientes, local }: Props) {
  const [open, setOpen] = useState(false);
  const [loading, setLoading] = useState(false);
  const [geocoding, setGeocoding] = useState(false);
  const [message, setMessage] = useState<{ type: "error" | "success"; text: string } | null>(null);

  const [name, setName] = useState(local?.name ?? "");
  const [address, setAddress] = useState(local?.address ?? "");
  const [clientId, setClientId] = useState(local?.client_id ?? (clientes[0]?.id ?? ""));
  const [hourlyRate, setHourlyRate] = useState(String(local?.hourly_rate ?? ""));
  const [accessCode, setAccessCode] = useState(local?.access_code ?? "");
  const [lat, setLat] = useState(String(local?.lat ?? ""));
  const [lng, setLng] = useState(String(local?.lng ?? ""));
  const [active, setActive] = useState(local?.active ?? true);

  const isEdit = !!local;
  const supabase = createClient();

  async function geocodeAddress() {
    if (!address) return;
    setGeocoding(true);
    try {
      const encoded = encodeURIComponent(address + ", Portugal");
      const res = await fetch(`https://nominatim.openstreetmap.org/search?q=${encoded}&format=json&limit=1`);
      const data = await res.json();
      if (data[0]) {
        setLat(data[0].lat);
        setLng(data[0].lon);
        setMessage({ type: "success", text: `GPS: ${parseFloat(data[0].lat).toFixed(5)}, ${parseFloat(data[0].lon).toFixed(5)}` });
      } else {
        setMessage({ type: "error", text: "Morada não encontrada. Introduz as coordenadas manualmente." });
      }
    } catch {
      setMessage({ type: "error", text: "Erro ao obter coordenadas." });
    }
    setGeocoding(false);
  }

  async function handleSubmit(e: React.SyntheticEvent<HTMLFormElement>) {
    e.preventDefault();
    setLoading(true);
    setMessage(null);

    const updateData = {
      name,
      address,
      hourly_rate: hourlyRate ? parseFloat(hourlyRate) : null,
      access_code: accessCode || null,
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
    } else {
      setMessage({ type: "success", text: isEdit ? "Local atualizado." : "Local criado com sucesso." });
    }
  }

  const triggerWithOpen = isValidElement(trigger)
    ? cloneElement(trigger as React.ReactElement<{ onClick?: () => void }>, { onClick: () => setOpen(true) })
    : trigger;

  return (
    <>
      {triggerWithOpen}
      {open && (
        <>
          <div className="fixed inset-0 bg-black/30 z-40" onClick={() => setOpen(false)} />
          <div className="fixed right-0 top-0 h-full w-full max-w-md bg-white shadow-xl z-50 flex flex-col">
            <div className="flex items-center justify-between px-6 py-4 border-b border-[var(--color-border)]">
              <h2 className="text-base font-semibold text-[var(--color-text-main)]">{isEdit ? "Editar local" : "Novo local"}</h2>
              <button onClick={() => setOpen(false)} className="p-1.5 rounded-lg text-[var(--color-text-muted)] hover:bg-[var(--color-background)] transition-colors">
                <X className="w-5 h-5" />
              </button>
            </div>

            <form id="local-form" onSubmit={handleSubmit} className="flex-1 overflow-y-auto px-6 py-5 space-y-4">
              <div>
                <label className="block text-sm font-medium text-[var(--color-text-main)] mb-1.5">Nome do local *</label>
                <input required value={name} onChange={(e) => setName(e.target.value)}
                  placeholder="ex: Escritório Lisboa Centro"
                  className="w-full px-3 py-2 rounded-lg border border-[var(--color-border)] text-sm text-[var(--color-text-main)] focus:outline-none focus:ring-2 focus:ring-[var(--color-primary)] focus:border-transparent" />
              </div>

              <div>
                <label className="block text-sm font-medium text-[var(--color-text-main)] mb-1.5">Cliente *</label>
                <select required value={clientId} onChange={(e) => setClientId(e.target.value)}
                  className="w-full px-3 py-2 rounded-lg border border-[var(--color-border)] text-sm text-[var(--color-text-main)] focus:outline-none focus:ring-2 focus:ring-[var(--color-primary)]">
                  {clientes.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
                </select>
              </div>

              <div>
                <label className="block text-sm font-medium text-[var(--color-text-main)] mb-1.5">Morada *</label>
                <div className="flex gap-2">
                  <input required value={address} onChange={(e) => setAddress(e.target.value)}
                    placeholder="Rua, número, cidade"
                    className="flex-1 px-3 py-2 rounded-lg border border-[var(--color-border)] text-sm text-[var(--color-text-main)] focus:outline-none focus:ring-2 focus:ring-[var(--color-primary)] focus:border-transparent" />
                  <button type="button" onClick={geocodeAddress} disabled={geocoding || !address}
                    title="Obter GPS da morada"
                    className="p-2 rounded-lg bg-[var(--color-primary-light)] text-[var(--color-primary)] hover:bg-[var(--color-primary-muted)] transition-colors disabled:opacity-50">
                    {geocoding ? <Loader2 className="w-4 h-4 animate-spin" /> : <MapPin className="w-4 h-4" />}
                  </button>
                </div>
              </div>

              <div className="grid grid-cols-2 gap-3">
                <div>
                  <label className="block text-sm font-medium text-[var(--color-text-main)] mb-1.5">Latitude</label>
                  <input type="number" step="any" value={lat} onChange={(e) => setLat(e.target.value)} placeholder="38.7169"
                    className="w-full px-3 py-2 rounded-lg border border-[var(--color-border)] text-sm text-[var(--color-text-main)] focus:outline-none focus:ring-2 focus:ring-[var(--color-primary)] focus:border-transparent" />
                </div>
                <div>
                  <label className="block text-sm font-medium text-[var(--color-text-main)] mb-1.5">Longitude</label>
                  <input type="number" step="any" value={lng} onChange={(e) => setLng(e.target.value)} placeholder="-9.1395"
                    className="w-full px-3 py-2 rounded-lg border border-[var(--color-border)] text-sm text-[var(--color-text-main)] focus:outline-none focus:ring-2 focus:ring-[var(--color-primary)] focus:border-transparent" />
                </div>
              </div>

              <div className="grid grid-cols-2 gap-3">
                <div>
                  <label className="block text-sm font-medium text-[var(--color-text-main)] mb-1.5">€/hora</label>
                  <input type="number" step="0.01" min="0" value={hourlyRate} onChange={(e) => setHourlyRate(e.target.value)}
                    className="w-full px-3 py-2 rounded-lg border border-[var(--color-border)] text-sm text-[var(--color-text-main)] focus:outline-none focus:ring-2 focus:ring-[var(--color-primary)] focus:border-transparent" />
                </div>
                <div>
                  <label className="block text-sm font-medium text-[var(--color-text-main)] mb-1.5">Código de acesso</label>
                  <input value={accessCode} onChange={(e) => setAccessCode(e.target.value)} placeholder="1234#"
                    className="w-full px-3 py-2 rounded-lg border border-[var(--color-border)] text-sm text-[var(--color-text-main)] focus:outline-none focus:ring-2 focus:ring-[var(--color-primary)] focus:border-transparent" />
                </div>
              </div>

              <div className="flex items-center gap-3">
                <button type="button" onClick={() => setActive((a) => !a)}
                  className={`relative w-10 h-5 rounded-full transition-colors ${active ? "bg-[var(--color-primary)]" : "bg-[var(--color-border)]"}`}>
                  <span className={`absolute top-0.5 w-4 h-4 bg-white rounded-full shadow transition-all ${active ? "left-5.5" : "left-0.5"}`} />
                </button>
                <span className="text-sm text-[var(--color-text-main)]">{active ? "Local ativo" : "Local inativo"}</span>
              </div>

              {message && (
                <div className={`text-sm px-3 py-2 rounded-lg ${message.type === "error" ? "bg-red-50 text-[var(--color-danger)] border border-red-100" : "bg-[var(--color-primary-light)] text-[var(--color-primary)] border border-[var(--color-primary-muted)]"}`}>
                  {message.text}
                </div>
              )}
            </form>

            <div className="border-t border-[var(--color-border)] px-6 py-4">
              <button form="local-form" type="submit" disabled={loading}
                className="w-full flex items-center justify-center gap-2 px-4 py-2 rounded-lg bg-[var(--color-primary)] text-white text-sm font-medium hover:bg-[var(--color-primary-hover)] transition-colors disabled:opacity-50">
                {loading && <Loader2 className="w-4 h-4 animate-spin" />}
                {isEdit ? "Guardar alterações" : "Criar local"}
              </button>
            </div>
          </div>
        </>
      )}
    </>
  );
}

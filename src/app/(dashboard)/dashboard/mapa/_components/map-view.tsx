"use client";

import { useEffect, useRef, useState, useCallback } from "react";
import mapboxgl from "mapbox-gl";
import "mapbox-gl/dist/mapbox-gl.css";
import { format, parseISO } from "date-fns";
import { pt } from "date-fns/locale";
import { MapPin, Navigation, X, Filter, Clock } from "lucide-react";
import { getMapServices, type MapService, type MapTeam } from "@/app/actions/map";

const MAPBOX_TOKEN = process.env.NEXT_PUBLIC_MAPBOX_TOKEN ?? "";

const STATUS_LABELS: Record<string, string> = {
  agendado: "Agendado",
  em_curso: "Em curso",
  concluido: "Concluído",
  falta: "Falta",
};

const STATUS_COLORS: Record<string, string> = {
  agendado: "#6B7280",
  em_curso: "#F59E0B",
  concluido: "#16A34A",
  falta: "#EF4444",
};

interface RouteResult {
  teamId: string;
  teamName: string;
  teamColor: string;
  durationMin: number;
  distanceKm: number;
}

interface Props {
  initialServices: MapService[];
  initialTeams: MapTeam[];
  initialDate: string;
}

export function MapView({ initialServices, initialTeams, initialDate }: Props) {
  const mapContainer = useRef<HTMLDivElement>(null);
  const map = useRef<mapboxgl.Map | null>(null);
  const markersRef = useRef<mapboxgl.Marker[]>([]);
  const routeLayersRef = useRef<string[]>([]);

  const [date, setDate] = useState(initialDate);
  const [services, setServices] = useState<MapService[]>(initialServices);
  const [teams] = useState<MapTeam[]>(initialTeams);
  const [selectedTeam, setSelectedTeam] = useState<string>("");
  const [selectedStatus, setSelectedStatus] = useState<string>("");
  const [selectedService, setSelectedService] = useState<MapService | null>(null);
  const [routes, setRoutes] = useState<RouteResult[]>([]);
  const [loadingRoutes, setLoadingRoutes] = useState(false);
  const [loadingServices, setLoadingServices] = useState(false);
  const [mapReady, setMapReady] = useState(false);

  // Init map once
  useEffect(() => {
    if (!mapContainer.current || map.current) return;
    if (!MAPBOX_TOKEN) return;

    mapboxgl.accessToken = MAPBOX_TOKEN;

    map.current = new mapboxgl.Map({
      container: mapContainer.current,
      style: "mapbox://styles/mapbox/light-v11",
      center: [-8.6291, 41.1579], // Porto, Portugal
      zoom: 11,
    });

    map.current.addControl(new mapboxgl.NavigationControl(), "top-right");
    map.current.addControl(new mapboxgl.ScaleControl({ unit: "metric" }), "bottom-left");

    map.current.on("load", () => setMapReady(true));

    return () => {
      map.current?.remove();
      map.current = null;
    };
  }, []);

  const filteredServices = services.filter((s) => {
    if (selectedTeam && s.team_id !== selectedTeam) return false;
    if (selectedStatus && s.status !== selectedStatus) return false;
    return true;
  });

  // Render markers when filtered services or map changes
  useEffect(() => {
    if (!map.current || !mapReady) return;

    // Clear existing markers
    markersRef.current.forEach((m) => m.remove());
    markersRef.current = [];

    if (filteredServices.length === 0) return;

    const bounds = new mapboxgl.LngLatBounds();

    filteredServices.forEach((svc) => {
      const color = svc.team_color ?? "#6B7280";
      const statusColor = STATUS_COLORS[svc.status] ?? "#6B7280";

      // Custom HTML marker
      const el = document.createElement("div");
      el.style.cssText = `
        width: 32px; height: 32px;
        background: ${color};
        border: 3px solid ${statusColor};
        border-radius: 50% 50% 50% 0;
        transform: rotate(-45deg);
        cursor: pointer;
        box-shadow: 0 2px 6px rgba(0,0,0,0.3);
        transition: transform 0.15s ease;
      `;
      el.addEventListener("mouseenter", () => {
        el.style.transform = "rotate(-45deg) scale(1.2)";
      });
      el.addEventListener("mouseleave", () => {
        el.style.transform = "rotate(-45deg) scale(1)";
      });

      const marker = new mapboxgl.Marker({ element: el })
        .setLngLat([svc.lng, svc.lat])
        .addTo(map.current!);

      el.addEventListener("click", () => setSelectedService(svc));

      markersRef.current.push(marker);
      bounds.extend([svc.lng, svc.lat]);
    });

    if (!bounds.isEmpty()) {
      map.current.fitBounds(bounds, { padding: 80, maxZoom: 14 });
    }
  }, [filteredServices, mapReady]);

  // Fetch services when date changes
  const fetchServices = useCallback(async (newDate: string) => {
    setLoadingServices(true);
    setRoutes([]);
    clearRoutes();
    const { services: s } = await getMapServices(newDate);
    setServices(s);
    setLoadingServices(false);
  }, []);

  function clearRoutes() {
    if (!map.current) return;
    routeLayersRef.current.forEach((id) => {
      if (map.current!.getLayer(id)) map.current!.removeLayer(id);
      if (map.current!.getSource(id)) map.current!.removeSource(id);
    });
    routeLayersRef.current = [];
  }

  async function calculateRoutes() {
    if (!map.current || !mapReady) return;
    setLoadingRoutes(true);
    clearRoutes();

    const results: RouteResult[] = [];

    const servicesByTeam = new Map<string, MapService[]>();
    filteredServices.forEach((s) => {
      if (!s.team_id) return;
      const list = servicesByTeam.get(s.team_id) ?? [];
      list.push(s);
      servicesByTeam.set(s.team_id, list);
    });

    for (const [teamId, teamServices] of servicesByTeam.entries()) {
      if (teamServices.length < 2) continue;

      const team = teams.find((t) => t.id === teamId);
      if (!team) continue;

      // Sort services by scheduled time
      const sorted = [...teamServices].sort(
        (a, b) => new Date(a.scheduled_start).getTime() - new Date(b.scheduled_start).getTime()
      );

      const coords = sorted.map((s) => `${s.lng},${s.lat}`).join(";");
      const url = `https://api.mapbox.com/directions/v5/mapbox/driving/${coords}?geometries=geojson&overview=full&access_token=${MAPBOX_TOKEN}`;

      try {
        const res = await fetch(url);
        const data = await res.json();
        if (!data.routes?.[0]) continue;

        const route = data.routes[0];
        const geojson = route.geometry;
        const durationMin = Math.round(route.duration / 60);
        const distanceKm = Math.round(route.distance / 1000);

        const sourceId = `route-${teamId}`;
        const layerId = `route-layer-${teamId}`;

        if (map.current.getSource(sourceId)) {
          map.current.removeLayer(layerId);
          map.current.removeSource(sourceId);
        }

        map.current.addSource(sourceId, {
          type: "geojson",
          data: { type: "Feature", properties: {}, geometry: geojson },
        });

        map.current.addLayer({
          id: layerId,
          type: "line",
          source: sourceId,
          layout: { "line-join": "round", "line-cap": "round" },
          paint: {
            "line-color": team.color,
            "line-width": 4,
            "line-opacity": 0.8,
          },
        });

        routeLayersRef.current.push(layerId, sourceId);

        results.push({
          teamId,
          teamName: team.name,
          teamColor: team.color,
          durationMin,
          distanceKm,
        });
      } catch {
        // skip team on error
      }
    }

    setRoutes(results);
    setLoadingRoutes(false);
  }

  return (
    <div className="flex h-[calc(100vh-64px)]">
      {/* Sidebar */}
      <div className="w-72 shrink-0 flex flex-col bg-white border-r border-[var(--color-border)] overflow-hidden">
        {/* Filtros */}
        <div className="p-4 border-b border-[var(--color-border)] space-y-3">
          <div className="flex items-center gap-2 text-sm font-medium text-[var(--color-text-main)]">
            <Filter className="w-4 h-4 text-[var(--color-primary)]" />
            Filtros
          </div>
          <div>
            <label className="block text-xs text-[var(--color-text-muted)] mb-1">Data</label>
            <input
              type="date"
              value={date}
              onChange={(e) => {
                setDate(e.target.value);
                fetchServices(e.target.value);
              }}
              className="w-full px-3 py-1.5 rounded-lg border border-[var(--color-border)] text-sm text-[var(--color-text-main)] focus:outline-none focus:ring-2 focus:ring-[var(--color-primary)]"
            />
          </div>
          <div>
            <label className="block text-xs text-[var(--color-text-muted)] mb-1">Equipa</label>
            <select
              value={selectedTeam}
              onChange={(e) => setSelectedTeam(e.target.value)}
              className="w-full px-3 py-1.5 rounded-lg border border-[var(--color-border)] text-sm text-[var(--color-text-main)] focus:outline-none focus:ring-2 focus:ring-[var(--color-primary)]"
            >
              <option value="">Todas</option>
              {teams.map((t) => (
                <option key={t.id} value={t.id}>{t.name}</option>
              ))}
            </select>
          </div>
          <div>
            <label className="block text-xs text-[var(--color-text-muted)] mb-1">Estado</label>
            <select
              value={selectedStatus}
              onChange={(e) => setSelectedStatus(e.target.value)}
              className="w-full px-3 py-1.5 rounded-lg border border-[var(--color-border)] text-sm text-[var(--color-text-main)] focus:outline-none focus:ring-2 focus:ring-[var(--color-primary)]"
            >
              <option value="">Todos</option>
              {Object.entries(STATUS_LABELS).map(([k, v]) => (
                <option key={k} value={k}>{v}</option>
              ))}
            </select>
          </div>
          <button
            onClick={calculateRoutes}
            disabled={loadingRoutes || filteredServices.length < 2 || !MAPBOX_TOKEN}
            className="w-full flex items-center justify-center gap-2 px-3 py-2 rounded-lg bg-[var(--color-primary)] text-white text-sm font-medium hover:bg-[var(--color-primary-hover)] transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
          >
            <Navigation className="w-4 h-4" />
            {loadingRoutes ? "A calcular…" : "Calcular Rotas"}
          </button>
        </div>

        {/* Lista de serviços */}
        <div className="flex-1 overflow-y-auto">
          {loadingServices ? (
            <div className="p-4 text-sm text-[var(--color-text-muted)] text-center">A carregar…</div>
          ) : filteredServices.length === 0 ? (
            <div className="p-4 text-sm text-[var(--color-text-muted)] text-center">
              Sem serviços para este dia
            </div>
          ) : (
            <div className="divide-y divide-[var(--color-border)]">
              {filteredServices.map((svc) => (
                <button
                  key={svc.id}
                  onClick={() => {
                    setSelectedService(svc);
                    map.current?.flyTo({ center: [svc.lng, svc.lat], zoom: 15 });
                  }}
                  className="w-full text-left px-4 py-3 hover:bg-[var(--color-background)] transition-colors"
                >
                  <div className="flex items-start gap-2">
                    <div
                      className="w-2.5 h-2.5 rounded-full shrink-0 mt-1"
                      style={{ backgroundColor: svc.team_color ?? "#6B7280" }}
                    />
                    <div className="min-w-0">
                      <p className="text-sm font-medium text-[var(--color-text-main)] truncate">
                        {svc.client_name}
                      </p>
                      <p className="text-xs text-[var(--color-text-muted)] truncate">
                        {svc.location_name}
                      </p>
                      <div className="flex items-center gap-1 mt-0.5">
                        <Clock className="w-3 h-3 text-[var(--color-text-muted)]" />
                        <span className="text-xs text-[var(--color-text-muted)]">
                          {format(parseISO(svc.scheduled_start), "HH:mm")}–{format(parseISO(svc.scheduled_end), "HH:mm")}
                        </span>
                      </div>
                    </div>
                    <span
                      className="ml-auto shrink-0 text-xs px-1.5 py-0.5 rounded-full font-medium"
                      style={{
                        backgroundColor: STATUS_COLORS[svc.status] + "20",
                        color: STATUS_COLORS[svc.status],
                      }}
                    >
                      {STATUS_LABELS[svc.status]}
                    </span>
                  </div>
                </button>
              ))}
            </div>
          )}
        </div>

        {/* Resumo de rotas */}
        {routes.length > 0 && (
          <div className="border-t border-[var(--color-border)] p-4 space-y-2">
            <p className="text-xs font-semibold text-[var(--color-text-muted)] uppercase tracking-wide">
              Rotas calculadas
            </p>
            {routes.map((r) => (
              <div key={r.teamId} className="flex items-center gap-2">
                <div className="w-2.5 h-2.5 rounded-full shrink-0" style={{ backgroundColor: r.teamColor }} />
                <div className="flex-1 min-w-0">
                  <p className="text-xs font-medium text-[var(--color-text-main)] truncate">{r.teamName}</p>
                  <p className="text-xs text-[var(--color-text-muted)]">{r.durationMin} min · {r.distanceKm} km</p>
                </div>
              </div>
            ))}
          </div>
        )}
      </div>

      {/* Map */}
      <div className="relative flex-1">
        {!MAPBOX_TOKEN && (
          <div className="absolute inset-0 flex items-center justify-center bg-gray-50 z-10">
            <div className="text-center p-6 max-w-sm">
              <MapPin className="w-10 h-10 text-[var(--color-primary)] mx-auto mb-3" />
              <p className="text-sm font-medium text-[var(--color-text-main)] mb-1">
                Token Mapbox não configurado
              </p>
              <p className="text-xs text-[var(--color-text-muted)]">
                Adiciona <code className="bg-gray-100 px-1 rounded">NEXT_PUBLIC_MAPBOX_TOKEN</code> ao <code className="bg-gray-100 px-1 rounded">.env.local</code>
              </p>
            </div>
          </div>
        )}
        <div ref={mapContainer} className="absolute inset-0" />

        {/* Popup de detalhe do serviço */}
        {selectedService && (
          <div className="absolute top-4 right-4 w-72 bg-white rounded-xl shadow-lg border border-[var(--color-border)] p-4 z-10">
            <div className="flex items-start justify-between gap-2 mb-3">
              <div>
                <p className="text-sm font-semibold text-[var(--color-text-main)]">
                  {selectedService.client_name}
                </p>
                <p className="text-xs text-[var(--color-text-muted)]">
                  {selectedService.location_name}
                </p>
              </div>
              <button
                onClick={() => setSelectedService(null)}
                className="text-[var(--color-text-muted)] hover:text-[var(--color-text-main)] transition-colors"
              >
                <X className="w-4 h-4" />
              </button>
            </div>
            <div className="space-y-2 text-xs text-[var(--color-text-sub)]">
              <div className="flex items-center gap-2">
                <Clock className="w-3.5 h-3.5 shrink-0" />
                <span>
                  {format(parseISO(selectedService.scheduled_start), "HH:mm", { locale: pt })}
                  {" "}–{" "}
                  {format(parseISO(selectedService.scheduled_end), "HH:mm", { locale: pt })}
                </span>
              </div>
              <div className="flex items-start gap-2">
                <MapPin className="w-3.5 h-3.5 shrink-0 mt-0.5" />
                <span>{selectedService.location_address}</span>
              </div>
              {selectedService.team_name && (
                <div className="flex items-center gap-2">
                  <div
                    className="w-3.5 h-3.5 rounded-full shrink-0"
                    style={{ backgroundColor: selectedService.team_color ?? "#6B7280" }}
                  />
                  <span>{selectedService.team_name}</span>
                </div>
              )}
              <div className="flex items-center gap-2">
                <span
                  className="px-2 py-0.5 rounded-full font-medium"
                  style={{
                    backgroundColor: (STATUS_COLORS[selectedService.status] ?? "#6B7280") + "20",
                    color: STATUS_COLORS[selectedService.status] ?? "#6B7280",
                  }}
                >
                  {STATUS_LABELS[selectedService.status] ?? selectedService.status}
                </span>
              </div>
              {selectedService.notes && (
                <p className="text-[var(--color-text-muted)] italic">{selectedService.notes}</p>
              )}
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

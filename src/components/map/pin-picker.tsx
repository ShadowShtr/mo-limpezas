"use client";

import "maplibre-gl/dist/maplibre-gl.css";
import { useCallback, useEffect, useRef, useState } from "react";
import MapGL, { Marker, NavigationControl, type MapRef, type MapLayerMouseEvent } from "react-map-gl/maplibre";
import { Crosshair, Loader2, MapPin, Undo2 } from "lucide-react";
import { isValidCoord } from "@/lib/calculations";
import { PORTUGAL_CENTER, formatCoord, roundCoord } from "@/lib/geocoding";
import { getMapStyle } from "@/lib/map-style";

// Calculado uma vez: o token é inlined na compilação, e um objeto novo a cada
// render faria o MapLibre reaplicar o estilo sem necessidade.
const MAP_STYLE = getMapStyle();

interface Props {
  lat: number | null;
  lng: number | null;
  /** Chamado sempre que o pin passa a estar noutro sítio. */
  onChange: (lat: number, lng: number) => void;
  /** Sítio para onde levar o mapa **sem** marcar nada — o melhor palpite da
   *  pesquisa enquanto a morada está a ser escrita. Serve para o mapa já estar
   *  na zona certa quando chega a hora de tocar nele, em vez de mostrar o país
   *  inteiro. Nunca mexe no mapa depois de haver pin: aí o ponto que interessa
   *  é o que está marcado, não o palpite. */
  focus?: { lat: number; lng: number } | null;
  heightClass?: string;
}

/**
 * Marcação manual do ponto de um local.
 *
 * 🔴 Deliberadamente **sem geocodificação inversa**. A primeira versão pedia
 *    ao Nominatim público a morada de cada ponto largado e oferecia-a para
 *    preencher os campos. Duas razões para não o fazer:
 *
 *    · o Nominatim público limita-se a 1 pedido/segundo somados TODOS os
 *      utilizadores da aplicação, e um pedido por cada clique/arrasto é carga
 *      automática nova sobre um serviço gratuito de terceiros;
 *    · duas respostas em voo podiam chegar trocadas — o pin ficava no ponto B
 *      com a morada de A oferecida por baixo, e bastava carregar em "usar"
 *      para gravar texto de A com coordenadas de B.
 *
 *    Nada disto é preciso para o problema que este componente resolve: quando
 *    a pesquisa de morada não encontra o sítio, quem sabe onde ele é marca-o
 *    à mão. A morada continua a ser escrita por quem sabe.
 */
export function PinPicker({ lat, lng, onChange, focus, heightClass = "h-64" }: Props) {
  const mapRef = useRef<MapRef>(null);
  const hasPin = lat != null && lng != null && isValidCoord(lat, lng);

  const [viewState, setViewState] = useState({
    latitude: hasPin ? (lat as number) : PORTUGAL_CENTER.lat,
    longitude: hasPin ? (lng as number) : PORTUGAL_CENTER.lng,
    zoom: hasPin ? 17 : PORTUGAL_CENTER.zoom,
  });

  const [locating, setLocating] = useState(false);
  const [hint, setHint] = useState<string | null>(null);
  const [previous, setPrevious] = useState<{ lat: number; lng: number } | null>(null);

  // Só centra automaticamente quando o pin vem de fora (pesquisa de morada),
  // nunca a cada arrasto do próprio utilizador — senão o mapa "salta" debaixo
  // do dedo enquanto ele afina a posição.
  const lastExternal = useRef<string | null>(null);

  /** Leva o mapa até um ponto.
   *
   *  Existe porque nem toda a coordenada nova vem de um gesto sobre o mapa. Se
   *  veio (clique, arrasto), o ponto já está debaixo do dedo e mexer a câmara
   *  seria o mapa a fugir. Se NÃO veio — GPS, "repor pin anterior", sugestão da
   *  pesquisa —, o ponto pode estar fora do ecrã e sem isto o pin muda-se sem
   *  ninguém ver para onde.
   *
   *  O `Math.max` preserva a aproximação de quem já tinha ampliado: nunca
   *  afasta, e garante o nível de rua (~17) quando estava mais longe. */
  const centrarEm = useCallback((cLat: number, cLng: number) => {
    const map = mapRef.current;
    if (map) map.flyTo({ center: [cLng, cLat], zoom: Math.max(map.getZoom(), 17), duration: 700 });
    else setViewState((v) => ({ ...v, latitude: cLat, longitude: cLng, zoom: 17 }));
  }, []);

  // Coordenada vinda de fora (a pesquisa de morada escolheu uma sugestão).
  // `lastExternal` guarda o que este componente acabou de emitir, para o
  // efeito não reagir ao eco do próprio gesto do utilizador.
  useEffect(() => {
    if (lat == null || lng == null || !isValidCoord(lat, lng)) return;
    const key = `${lat},${lng}`;
    if (lastExternal.current === key) return;
    lastExternal.current = key;
    centrarEm(lat, lng);
  }, [lat, lng, centrarEm]);

  // Palpite da pesquisa: leva o mapa para a zona, sem marcar nada. Só enquanto
  // não há pin — depois de haver ponto marcado, arrastar a câmara para um
  // palpite seria tirar de vista aquilo que a pessoa acabou de decidir.
  const focusLat = focus?.lat ?? null;
  const focusLng = focus?.lng ?? null;
  useEffect(() => {
    if (hasPin) return;
    if (focusLat == null || focusLng == null || !isValidCoord(focusLat, focusLng)) return;
    centrarEm(focusLat, focusLng);
  }, [focusLat, focusLng, hasPin, centrarEm]);

  /** Marca o pin e devolve a coordenada já arredondada — quem chama precisa
   *  dela para decidir se centra o mapa (ver `centrarEm`). */
  const placePin = useCallback(
    (nextLat: number, nextLng: number): { lat: number; lng: number } | null => {
      if (!isValidCoord(nextLat, nextLng)) return null;
      if (lat != null && lng != null && isValidCoord(lat, lng)) setPrevious({ lat, lng });
      const rLat = roundCoord(nextLat);
      const rLng = roundCoord(nextLng);
      lastExternal.current = `${rLat},${rLng}`;
      setHint(null);
      onChange(rLat, rLng);
      return { lat: rLat, lng: rLng };
    },
    [lat, lng, onChange],
  );

  function handleMapClick(e: MapLayerMouseEvent) {
    placePin(e.lngLat.lat, e.lngLat.lng);
  }

  function handleLocateMe() {
    if (typeof navigator === "undefined" || !navigator.geolocation) {
      setHint("Este dispositivo não permite obter a localização atual. Marca o ponto no mapa com o dedo.");
      return;
    }
    setLocating(true);
    setHint(null);
    navigator.geolocation.getCurrentPosition(
      (pos) => {
        setLocating(false);
        // 🔴 O recentrar é explícito e não pode ser deixado ao efeito acima.
        //    `placePin` regista a coordenada em `lastExternal` antes de a
        //    emitir — é isso que impede o mapa de saltar a cada clique/arrasto
        //    —, e por isso o efeito vê a mesma chave e sai sem mexer a câmara.
        //    Sem esta linha, carregar em "Estou aqui agora" trocava as
        //    coordenadas e deixava o mapa parado no sítio anterior: o pin ia
        //    parar fora do ecrã e ninguém via para onde tinha ido.
        const marcado = placePin(pos.coords.latitude, pos.coords.longitude);
        if (marcado) centrarEm(marcado.lat, marcado.lng);
      },
      () => {
        // Recusar a localização nunca pode fechar o caminho manual — é
        // precisamente esse o caminho que este componente existe para dar.
        setLocating(false);
        setHint("Não foi possível obter a localização. Marca o ponto no mapa com o dedo.");
      },
      { enableHighAccuracy: true, timeout: 10000, maximumAge: 0 },
    );
  }

  function handleUndo() {
    if (!previous) return;
    const { lat: pLat, lng: pLng } = previous;
    setPrevious(null);
    lastExternal.current = `${pLat},${pLng}`;
    onChange(pLat, pLng);
    // Mesma razão do GPS: o ponto anterior pode estar fora do ecrã.
    centrarEm(pLat, pLng);
  }

  return (
    <div className="space-y-2">
      <div className={`relative w-full ${heightClass} rounded-lg overflow-hidden border border-[var(--color-border)]`}>
        <MapGL
          ref={mapRef}
          {...viewState}
          onMove={(e) => setViewState(e.viewState)}
          onClick={handleMapClick}
          mapStyle={MAP_STYLE}
          style={{ width: "100%", height: "100%" }}
          cursor="crosshair"
        >
          <NavigationControl position="top-right" showCompass={false} />
          {hasPin && (
            <Marker
              latitude={lat as number}
              longitude={lng as number}
              draggable
              anchor="bottom"
              onDragEnd={(e) => placePin(e.lngLat.lat, e.lngLat.lng)}
            >
              <MapPin className="w-8 h-8 text-[var(--color-primary)] drop-shadow" fill="#16A34A" strokeWidth={1.5} />
            </Marker>
          )}
        </MapGL>

        {!hasPin && (
          <div className="absolute inset-x-0 top-0 px-3 py-2 text-[11px] text-white bg-black/55 pointer-events-none">
            Toca no mapa para marcar exatamente onde é a entrada do local.
          </div>
        )}
      </div>

      <div className="flex flex-wrap items-center gap-2">
        <button
          type="button"
          onClick={handleLocateMe}
          disabled={locating}
          className="inline-flex items-center gap-1.5 px-2.5 py-1.5 rounded-lg border border-[var(--color-border)] text-xs font-medium text-[var(--color-text-sub)] hover:bg-[var(--color-background)] transition-colors disabled:opacity-50"
        >
          {locating ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Crosshair className="w-3.5 h-3.5" />}
          Estou aqui agora
        </button>

        {previous && (
          <button
            type="button"
            onClick={handleUndo}
            className="inline-flex items-center gap-1.5 px-2.5 py-1.5 rounded-lg border border-[var(--color-border)] text-xs font-medium text-[var(--color-text-sub)] hover:bg-[var(--color-background)] transition-colors"
          >
            <Undo2 className="w-3.5 h-3.5" />
            Repor pin anterior
          </button>
        )}

        {hasPin && (
          <span className="text-[11px] text-[var(--color-text-muted)] font-mono">
            {formatCoord(lat as number, lng as number)}
          </span>
        )}
      </div>

      {hint && <p className="text-xs text-[var(--color-danger)]">{hint}</p>}
    </div>
  );
}

// @vitest-environment jsdom
// ============================================================================
// PIN PICKER — o mapa tem de ir atrás do pin quando o pin não veio do mapa
// ============================================================================
// 🔴 O defeito que este ficheiro fecha:
//
//    `placePin` grava a coordenada em `lastExternal` ANTES de a emitir. Isso
//    é deliberado e serve os gestos sobre o mapa: sem isso, cada clique e cada
//    arrasto faria o efeito de recentragem disparar e o mapa fugia debaixo do
//    dedo de quem está a afinar o ponto.
//
//    Só que "Estou aqui agora" passa pelo mesmo `placePin` — e aí a coordenada
//    NÃO veio de um gesto sobre o mapa. O efeito via a chave que o próprio
//    componente acabara de escrever, saía sem mexer a câmara, e o resultado
//    era o pior dos dois mundos: as coordenadas mudavam para o GPS e o mapa
//    continuava parado no sítio anterior, com o pin fora do ecrã. Quem
//    carregasse no botão via o mapa quieto e concluía que não tinha funcionado.
//
// O `react-map-gl/maplibre` é substituído por um duplo: o mapa real precisa de
// WebGL, que o jsdom não tem. O duplo expõe `flyTo`/`getZoom` como espias — é
// exatamente o contrato que interessa provar aqui, e não o desenho dos tiles.
// ============================================================================

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { act, forwardRef, useImperativeHandle, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { PinPicker } from "@/components/map/pin-picker";

const flyTo = vi.fn();
const getZoom = vi.fn(() => 6);

vi.mock("maplibre-gl/dist/maplibre-gl.css", () => ({}));

vi.mock("react-map-gl/maplibre", () => {
  const MapGL = forwardRef<unknown, { children?: ReactNode; onClick?: (e: unknown) => void }>(
    function MapGL({ children }, ref) {
      useImperativeHandle(ref, () => ({ flyTo, getZoom }), []);
      return <div data-testid="mapa">{children}</div>;
    },
  );
  return {
    __esModule: true,
    default: MapGL,
    Marker: ({ children }: { children?: ReactNode }) => <div data-testid="pin">{children}</div>,
    NavigationControl: () => null,
  };
});

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const GPS = { latitude: 38.7369123456, longitude: -9.1420987654 };
const ANTERIOR = { lat: 41.15, lng: -8.61 };

let container: HTMLDivElement;
let root: Root;
const onChange = vi.fn();

/** Duplo do `navigator.geolocation`. `modo` decide se a leitura corre bem. */
function instalarGeolocation(modo: "ok" | "recusado" | "ausente") {
  if (modo === "ausente") {
    Object.defineProperty(navigator, "geolocation", { value: undefined, configurable: true });
    return;
  }
  const getCurrentPosition = vi.fn(
    (
      sucesso: (p: { coords: { latitude: number; longitude: number } }) => void,
      erro: (e: { code: number }) => void,
    ) => {
      if (modo === "ok") sucesso({ coords: GPS });
      else erro({ code: 1 });
    },
  );
  Object.defineProperty(navigator, "geolocation", {
    value: { getCurrentPosition },
    configurable: true,
  });
}

async function montar(lat: number | null, lng: number | null) {
  await act(async () => {
    root.render(<PinPicker lat={lat} lng={lng} onChange={onChange} />);
  });
}

function botao(texto: string): HTMLButtonElement {
  const b = Array.from(container.querySelectorAll("button")).find((el) =>
    el.textContent?.includes(texto),
  );
  if (!b) throw new Error(`botão "${texto}" não encontrado`);
  return b as HTMLButtonElement;
}

function textoVisivel(): string {
  return container.textContent ?? "";
}

beforeEach(() => {
  vi.clearAllMocks();
  getZoom.mockReturnValue(6);
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
});

describe("GPS_SUCCESS — 'Estou aqui agora' com leitura boa", () => {
  beforeEach(() => instalarGeolocation("ok"));

  it("🔴 emite as coordenadas do GPS, arredondadas a 6 casas", async () => {
    await montar(null, null);
    await act(async () => { botao("Estou aqui agora").click(); });

    expect(onChange).toHaveBeenCalledTimes(1);
    expect(onChange).toHaveBeenCalledWith(38.736912, -9.142099);
  });

  it("🔴 centra o mapa no ponto do GPS — o pin não pode mudar sem o mapa ir atrás", async () => {
    await montar(null, null);
    await act(async () => { botao("Estou aqui agora").click(); });

    expect(flyTo, "sem isto o pin ia para fora do ecrã e o mapa ficava parado").toHaveBeenCalledTimes(1);
    const [args] = flyTo.mock.calls[0] as [{ center: [number, number]; zoom: number }];
    expect(args.center).toEqual([-9.142099, 38.736912]);
  });

  it("aproxima até ao nível de rua quando o mapa estava afastado", async () => {
    getZoom.mockReturnValue(6);
    await montar(null, null);
    await act(async () => { botao("Estou aqui agora").click(); });

    const [args] = flyTo.mock.calls[0] as [{ zoom: number }];
    expect(args.zoom).toBe(17);
  });

  it("não afasta quem já tinha ampliado mais do que isso", async () => {
    getZoom.mockReturnValue(19);
    await montar(null, null);
    await act(async () => { botao("Estou aqui agora").click(); });

    const [args] = flyTo.mock.calls[0] as [{ zoom: number }];
    expect(args.zoom).toBe(19);
  });
});

describe("GPS_DENIED — leitura recusada ou indisponível", () => {
  it("🔴 não mexe nas coordenadas e mantém o caminho manual aberto", async () => {
    instalarGeolocation("recusado");
    await montar(ANTERIOR.lat, ANTERIOR.lng);
    onChange.mockClear();

    await act(async () => { botao("Estou aqui agora").click(); });

    expect(onChange, "recusar a localização não pode alterar o ponto").not.toHaveBeenCalled();
    expect(textoVisivel()).toContain("Marca o ponto no mapa com o dedo");
    expect(container.querySelector('[data-testid="mapa"]'), "o mapa continua lá para marcar à mão").toBeTruthy();
  });

  it("diz o que fazer quando o dispositivo nem tem localização", async () => {
    instalarGeolocation("ausente");
    await montar(null, null);

    await act(async () => { botao("Estou aqui agora").click(); });

    expect(onChange).not.toHaveBeenCalled();
    expect(textoVisivel()).toContain("Marca o ponto no mapa com o dedo");
  });
});

describe("UNDO_AFTER_GPS — desfazer depois de o GPS mover o pin", () => {
  beforeEach(() => instalarGeolocation("ok"));

  it("🔴 repõe exatamente o ponto que lá estava antes", async () => {
    await montar(ANTERIOR.lat, ANTERIOR.lng);

    await act(async () => { botao("Estou aqui agora").click(); });
    expect(onChange).toHaveBeenLastCalledWith(38.736912, -9.142099);

    await act(async () => { botao("Repor pin anterior").click(); });
    expect(onChange).toHaveBeenLastCalledWith(ANTERIOR.lat, ANTERIOR.lng);
  });

  it("leva o mapa de volta ao ponto reposto", async () => {
    await montar(ANTERIOR.lat, ANTERIOR.lng);
    await act(async () => { botao("Estou aqui agora").click(); });
    flyTo.mockClear();

    await act(async () => { botao("Repor pin anterior").click(); });

    const [args] = flyTo.mock.calls[0] as [{ center: [number, number] }];
    expect(args.center).toEqual([ANTERIOR.lng, ANTERIOR.lat]);
  });

  it("não oferece desfazer quando não havia ponto anterior nenhum", async () => {
    await montar(null, null);
    expect(
      Array.from(container.querySelectorAll("button")).some((b) =>
        b.textContent?.includes("Repor pin anterior"),
      ),
    ).toBe(false);
  });
});

describe("FOCUS — o mapa acompanha a morada que está a ser escrita", () => {
  // 🔴 Origem: «preciso que quando eu coloque o endereço já apareça na
  //    proximidade». O mapa abria em Portugal inteiro e era preciso navegar à
  //    mão até à rua antes de conseguir marcar o que quer que fosse.
  beforeEach(() => instalarGeolocation("ok"));

  it("🔴 leva o mapa para o palpite da pesquisa, sem marcar ponto nenhum", async () => {
    await montar(null, null);
    flyTo.mockClear();

    await act(async () => {
      root.render(
        <PinPicker lat={null} lng={null} onChange={onChange} focus={{ lat: 39.02, lng: -9.01 }} />,
      );
    });

    const [args] = flyTo.mock.calls[0] as [{ center: [number, number] }];
    expect(args.center).toEqual([-9.01, 39.02]);
    expect(onChange, "um palpite não é uma decisão — não pode gravar coordenadas").not.toHaveBeenCalled();
  });

  it("🔴 não arrasta a câmara para longe do ponto que já está marcado", async () => {
    await montar(ANTERIOR.lat, ANTERIOR.lng);
    flyTo.mockClear();

    await act(async () => {
      root.render(
        <PinPicker
          lat={ANTERIOR.lat}
          lng={ANTERIOR.lng}
          onChange={onChange}
          focus={{ lat: 39.02, lng: -9.01 }}
        />,
      );
    });

    expect(flyTo, "com pin marcado, o palpite da pesquisa não manda no mapa").not.toHaveBeenCalled();
  });

  it("ignora um palpite inválido em vez de mandar o mapa para lado nenhum", async () => {
    await montar(null, null);
    flyTo.mockClear();

    await act(async () => {
      root.render(
        <PinPicker lat={null} lng={null} onChange={onChange} focus={{ lat: 999, lng: -9.01 }} />,
      );
    });

    expect(flyTo).not.toHaveBeenCalled();
  });
});

describe("clique e arrasto continuam sem fazer o mapa saltar", () => {
  beforeEach(() => instalarGeolocation("ok"));

  it("🔴 uma coordenada emitida pelo próprio gesto não recentra a câmara", async () => {
    // O componente monta com o ponto que ele próprio acabou de emitir — é o
    // eco de um clique no mapa. Se isto recentrasse, o mapa fugia debaixo do
    // dedo a cada arrasto do pin.
    await montar(null, null);
    await act(async () => { botao("Estou aqui agora").click(); });
    flyTo.mockClear();

    // O pai devolve a mesma coordenada, como faz depois de `onChange`.
    await act(async () => {
      root.render(<PinPicker lat={38.736912} lng={-9.142099} onChange={onChange} />);
    });

    expect(flyTo).not.toHaveBeenCalled();
  });
});

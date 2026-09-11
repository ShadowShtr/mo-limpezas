// @vitest-environment jsdom
// ============================================================================
// ATRIBUIÇÃO DO MAPA — o crédito segue quem serviu os tiles
// ============================================================================
// As duas superfícies de mapa passam `attributionControl={false}` e desenham
// este componente no lugar do controlo do MapLibre. Isso só é legítimo por ser
// uma substituição COMPLETA: o controlo do MapLibre desenha a string
// `attribution` da fonte e nada mais, e os tiles do Mapbox exigem também o
// logótipo oficial e um link "Improve this map".
//
// 🔴 O erro que estes ensaios impedem é o branding e a fonte discordarem:
//    mostrar o logótipo do Mapbox quando os tiles vieram do OpenStreetMap
//    seria creditar quem não serviu o mapa — e o contrário deixaria o Mapbox
//    sem o crédito que a licença exige.
// ============================================================================

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { MapAttribution } from "@/components/map/map-attribution";

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let container: HTMLDivElement;
let root: Root;

beforeEach(() => {
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
  vi.unstubAllEnvs();
});

async function montar(provider?: "mapbox" | "osm") {
  await act(async () => { root.render(<MapAttribution provider={provider} />); });
}

function links(): { href: string; texto: string }[] {
  return Array.from(container.querySelectorAll("a")).map((a) => ({
    href: a.getAttribute("href") ?? "",
    texto: a.textContent ?? "",
  }));
}

describe("tiles do Mapbox", () => {
  beforeEach(() => montar("mapbox"));

  it("🔴 mostra o logótipo do Mapbox", () => {
    const logo = container.querySelector('svg[role="img"][aria-label="Mapbox"]');
    expect(logo).toBeTruthy();
    // O asset oficial tem esta proporção; um logótipo redesenhado à mão não a
    // teria, e redesenhar branding de terceiros não é permitido.
    expect(logo?.getAttribute("viewBox")).toBe("0 0 88 23");
  });

  it("🔴 tem link para o Mapbox", () => {
    expect(links().some((l) => l.href.includes("mapbox.com"))).toBe(true);
    expect(links().some((l) => l.texto.includes("© Mapbox"))).toBe(true);
  });

  it("🔴 tem link para o OpenStreetMap", () => {
    expect(links().some((l) => l.href.includes("openstreetmap.org"))).toBe(true);
    expect(links().some((l) => l.texto.includes("© OpenStreetMap"))).toBe(true);
  });

  it('🔴 tem "Improve this map"', () => {
    const melhorar = links().find((l) => l.texto.includes("Improve this map"));
    expect(melhorar).toBeTruthy();
    expect(melhorar?.href).toContain("apps.mapbox.com/feedback");
  });

  it("os links são reais e abrem fora, sem passar referrer", () => {
    const ancoras = Array.from(container.querySelectorAll("a"));
    expect(ancoras.length).toBeGreaterThan(0);
    for (const a of ancoras) {
      expect(a.getAttribute("href")).toMatch(/^https:\/\//);
      expect(a.getAttribute("target")).toBe("_blank");
      expect(a.getAttribute("rel")).toContain("noopener");
    }
  });

  it("declara a fonte para quem inspeciona a página", () => {
    expect(
      container.querySelector('[data-testid="map-attribution"]')?.getAttribute("data-provider"),
    ).toBe("mapbox");
  });
});

describe("tiles do OpenStreetMap (sem token utilizável)", () => {
  beforeEach(() => montar("osm"));

  it("🔴 credita os contribuidores do OpenStreetMap, com link de copyright", () => {
    const osm = links().find((l) => l.texto.includes("OpenStreetMap contributors"));
    expect(osm).toBeTruthy();
    expect(osm?.href).toContain("openstreetmap.org/copyright");
  });

  it("🔴 não mostra o logótipo do Mapbox — não foi o Mapbox que serviu o mapa", () => {
    expect(container.querySelector('svg[aria-label="Mapbox"]')).toBeFalsy();
  });

  it("🔴 não mostra links do Mapbox nem o Improve this map", () => {
    expect(links().some((l) => l.href.includes("mapbox.com"))).toBe(false);
    expect(links().some((l) => l.texto.includes("Improve this map"))).toBe(false);
  });
});

describe("sem provider explícito, segue a mesma regra que escolhe os tiles", () => {
  it("token público válido → branding Mapbox", async () => {
    vi.stubEnv(
      "NEXT_PUBLIC_MAPBOX_TOKEN",
      "pk.eyJ1IjoiZW5zYWlvIiwiYSI6ImVuc2Fpby1zZW0tdmFsb3ItcmVhbCJ9",
    );
    await montar();
    expect(
      container.querySelector('[data-testid="map-attribution"]')?.getAttribute("data-provider"),
    ).toBe("mapbox");
  });

  it("🔴 token secreto → branding OSM, porque os tiles também são do OSM", async () => {
    vi.stubEnv(
      "NEXT_PUBLIC_MAPBOX_TOKEN",
      "sk.eyJ1IjoiZW5zYWlvIiwiYSI6InNlZ3JlZG8tcXVlLW5hby1wb2RlLXNhaXIifQ",
    );
    await montar();
    expect(
      container.querySelector('[data-testid="map-attribution"]')?.getAttribute("data-provider"),
    ).toBe("osm");
    expect(container.querySelector('svg[aria-label="Mapbox"]')).toBeFalsy();
  });
});

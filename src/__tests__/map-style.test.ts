// ============================================================================
// ESTILO DO MAPA — os tiles têm de vir de uma fonte que não carimbe por cima
// ============================================================================
// 🔴 Origem (2026-09-10): a dona abriu a ficha de um local e o mapa apareceu
//    com "API KEY REQUIRED" carimbado por cima dos tiles. A CARTO passou a
//    exigir chave para os `basemaps.cartocdn.com`, que o projeto usava sem
//    chave desde o início — e afetava ao mesmo tempo o mapa operacional e a
//    marcação do ponto de um local.
//
//    O que torna isto perigoso não é a avaria, é o silêncio dela: o pedido
//    continua a devolver HTTP 200 com uma imagem válida de ~3 KB. Nenhum
//    `onError` dispara, nenhum log aparece. Só se vê a olho.
//
//    Por isso estes ensaios olham para o URL dos tiles: é a única parte
//    verificável sem um browser, e é exatamente onde o defeito estava.
// ============================================================================

import { describe, it, expect, vi, afterEach } from "vitest";
import { getMapStyle, hasDetailedTiles } from "@/lib/map-style";

function urlDosTiles(style: ReturnType<typeof getMapStyle>): string {
  const fonte = Object.values(style.sources)[0] as { tiles?: string[] };
  return fonte.tiles?.[0] ?? "";
}

function atribuicao(style: ReturnType<typeof getMapStyle>): string {
  const fonte = Object.values(style.sources)[0] as { attribution?: string };
  return fonte.attribution ?? "";
}

afterEach(() => vi.unstubAllEnvs());

describe("com token do Mapbox configurado", () => {
  it("🔴 não serve tiles da CARTO — foi de lá que veio o carimbo", () => {
    vi.stubEnv("NEXT_PUBLIC_MAPBOX_TOKEN", "pk.token-de-ensaio");
    expect(urlDosTiles(getMapStyle())).not.toContain("cartocdn");
  });

  it("pede o estilo de ruas, que é o que traz nomes de rua e números de porta", () => {
    vi.stubEnv("NEXT_PUBLIC_MAPBOX_TOKEN", "pk.token-de-ensaio");
    const url = urlDosTiles(getMapStyle());
    expect(url).toContain("api.mapbox.com");
    expect(url).toContain("streets-v12");
    expect(url).toContain("access_token=pk.token-de-ensaio");
  });

  it("usa tiles raster: o MapLibre não resolve URLs mapbox://", () => {
    vi.stubEnv("NEXT_PUBLIC_MAPBOX_TOKEN", "pk.token-de-ensaio");
    const style = getMapStyle();
    const fonte = Object.values(style.sources)[0] as { type: string };
    expect(fonte.type).toBe("raster");
    expect(urlDosTiles(style)).not.toContain("mapbox://");
  });

  it("🔴 credita o Mapbox e o OpenStreetMap — é exigido pelas licenças", () => {
    vi.stubEnv("NEXT_PUBLIC_MAPBOX_TOKEN", "pk.token-de-ensaio");
    const texto = atribuicao(getMapStyle());
    expect(texto).toContain("Mapbox");
    expect(texto).toContain("OpenStreetMap");
  });

  it("assume detalhe ao nível do número de porta", () => {
    vi.stubEnv("NEXT_PUBLIC_MAPBOX_TOKEN", "pk.token-de-ensaio");
    expect(hasDetailedTiles()).toBe(true);
  });
});

describe("sem token configurado", () => {
  it("🔴 degrada para o OpenStreetMap em vez de ficar sem mapa", () => {
    vi.stubEnv("NEXT_PUBLIC_MAPBOX_TOKEN", "");
    const url = urlDosTiles(getMapStyle());
    expect(url).toContain("tile.openstreetmap.org");
    expect(url).not.toContain("cartocdn");
  });

  it("continua a creditar quem serve os tiles", () => {
    vi.stubEnv("NEXT_PUBLIC_MAPBOX_TOKEN", "");
    expect(atribuicao(getMapStyle())).toContain("OpenStreetMap");
  });

  it("não promete detalhe que a base de mapa não dá", () => {
    vi.stubEnv("NEXT_PUBLIC_MAPBOX_TOKEN", "");
    expect(hasDetailedTiles()).toBe(false);
  });

  it("nunca deixa o estilo sem camadas — um mapa vazio é pior que um mapa feio", () => {
    vi.stubEnv("NEXT_PUBLIC_MAPBOX_TOKEN", "");
    const style = getMapStyle();
    expect(style.layers.length).toBeGreaterThan(0);
    expect(Object.keys(style.sources).length).toBeGreaterThan(0);
  });
});

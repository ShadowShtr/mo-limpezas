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
import { getMapStyle, hasDetailedTiles, getMapProvider, isUsablePublicMapboxToken } from "@/lib/map-style";

function urlDosTiles(style: ReturnType<typeof getMapStyle>): string {
  const fonte = Object.values(style.sources)[0] as { tiles?: string[] };
  return fonte.tiles?.[0] ?? "";
}

function atribuicao(style: ReturnType<typeof getMapStyle>): string {
  const fonte = Object.values(style.sources)[0] as { attribution?: string };
  return fonte.attribution ?? "";
}

afterEach(() => vi.unstubAllEnvs());

const PK = "pk.eyJ1IjoiZW5zYWlvIiwiYSI6ImVuc2Fpby1zZW0tdmFsb3ItcmVhbCJ9";
const SK = "sk.eyJ1IjoiZW5zYWlvIiwiYSI6InNlZ3JlZG8tcXVlLW5hby1wb2RlLXNhaXIifQ";
const TK = "tk.eyJ1IjoiZW5zYWlvIiwiYSI6InRlbXBvcmFyaW8tbmFvLWNpcmN1bGEifQ";

describe("com token do Mapbox configurado", () => {
  it("🔴 não serve tiles da CARTO — foi de lá que veio o carimbo", () => {
    vi.stubEnv("NEXT_PUBLIC_MAPBOX_TOKEN", PK);
    expect(urlDosTiles(getMapStyle())).not.toContain("cartocdn");
  });

  it("pede o estilo de ruas, que é o que traz nomes de rua e números de porta", () => {
    vi.stubEnv("NEXT_PUBLIC_MAPBOX_TOKEN", PK);
    const url = urlDosTiles(getMapStyle());
    expect(url).toContain("api.mapbox.com");
    expect(url).toContain("streets-v12");
    expect(url).toContain(`access_token=${PK}`);
  });

  it("usa tiles raster: o MapLibre não resolve URLs mapbox://", () => {
    vi.stubEnv("NEXT_PUBLIC_MAPBOX_TOKEN", PK);
    const style = getMapStyle();
    const fonte = Object.values(style.sources)[0] as { type: string };
    expect(fonte.type).toBe("raster");
    expect(urlDosTiles(style)).not.toContain("mapbox://");
  });

  it("🔴 credita o Mapbox e o OpenStreetMap — é exigido pelas licenças", () => {
    vi.stubEnv("NEXT_PUBLIC_MAPBOX_TOKEN", PK);
    const texto = atribuicao(getMapStyle());
    expect(texto).toContain("Mapbox");
    expect(texto).toContain("OpenStreetMap");
  });

  it("assume detalhe ao nível do número de porta", () => {
    vi.stubEnv("NEXT_PUBLIC_MAPBOX_TOKEN", PK);
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

  it("com a variável em falta comporta-se como sem token", () => {
    vi.stubEnv("NEXT_PUBLIC_MAPBOX_TOKEN", undefined as unknown as string);
    expect(getMapProvider()).toBe("osm");
    expect(urlDosTiles(getMapStyle())).toContain("tile.openstreetmap.org");
  });
});

// ============================================================================
// 🔴 A prova que mais importa neste ficheiro
// ============================================================================
// A versão anterior aceitava QUALQUER string truthy e punha-a no URL dos
// tiles — um URL que o browser pede em claro e que qualquer pessoa vê nas
// ferramentas de rede. Um token `sk.` é secreto e dá acesso à conta Mapbox;
// um `tk.` é temporário e não deve circular. Bastava alguém pôr o token
// errado na variável de ambiente para publicar uma credencial.
//
// Na dúvida, OSM. Um mapa mais pobre é sempre melhor do que um segredo
// publicado.
// ============================================================================
describe("tokens que NÃO podem chegar ao browser", () => {
  const proibidos: ReadonlyArray<readonly [string, string]> = [
    ["sk. — token secreto, dá acesso à conta", SK],
    ["tk. — token temporário, não circula", TK],
    ["pk. truncado, sem corpo nenhum", "pk."],
    ["pk. curto de mais para ser real", "pk.abc"],
    ["marcador de posição por preencher", "COLOCAR_TOKEN_AQUI"],
    ["espaços em branco", "   "],
    ["um sim qualquer, de um .env mal copiado", "true"],
  ];

  it.each(proibidos)("%s → OSM", (_descricao, token) => {
    vi.stubEnv("NEXT_PUBLIC_MAPBOX_TOKEN", token);
    expect(isUsablePublicMapboxToken(token)).toBe(false);
    expect(getMapProvider()).toBe("osm");
    expect(hasDetailedTiles()).toBe(false);
    expect(urlDosTiles(getMapStyle())).toContain("tile.openstreetmap.org");
  });

  it("🔴 o valor secreto não aparece em lado nenhum do estilo", () => {
    vi.stubEnv("NEXT_PUBLIC_MAPBOX_TOKEN", SK);
    const serializado = JSON.stringify(getMapStyle());
    expect(serializado).not.toContain(SK);
    expect(serializado).not.toContain("sk.");
    expect(serializado).not.toContain("access_token");
  });

  it("🔴 o mesmo para um token temporário", () => {
    vi.stubEnv("NEXT_PUBLIC_MAPBOX_TOKEN", TK);
    const serializado = JSON.stringify(getMapStyle());
    expect(serializado).not.toContain(TK);
    expect(serializado).not.toContain("tk.");
  });

  it("aceita um pk. real com espaços à volta — é o erro de cópia mais comum", () => {
    vi.stubEnv("NEXT_PUBLIC_MAPBOX_TOKEN", `  ${PK}  `);
    expect(getMapProvider()).toBe("mapbox");
    expect(urlDosTiles(getMapStyle())).toContain(`access_token=${PK}`);
  });
});

describe("uma só decisão, em vez de condições parecidas espalhadas", () => {
  // Duas condições em sítios diferentes acabariam por divergir, e a que
  // divergisse seria a que põe o token no URL.
  it.each([
    ["pk. válido", PK, "mapbox", true],
    ["sk. secreto", SK, "osm", false],
    ["vazio", "", "osm", false],
  ] as ReadonlyArray<readonly [string, string, string, boolean]>)(
    "%s: provider, estilo e hasDetailedTiles dizem todos o mesmo",
    (_d, token, provider, detalhado) => {
      vi.stubEnv("NEXT_PUBLIC_MAPBOX_TOKEN", token);
      const usaMapbox = urlDosTiles(getMapStyle()).includes("api.mapbox.com");
      expect(getMapProvider()).toBe(provider);
      expect(hasDetailedTiles()).toBe(detalhado);
      expect(usaMapbox).toBe(provider === "mapbox");
    },
  );
});

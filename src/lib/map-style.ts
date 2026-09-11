import type { StyleSpecification } from "maplibre-gl";

/**
 * Estilo do mapa, num sítio só, para as duas superfícies que desenham mapas:
 * o mapa operacional (`/dashboard/mapa`) e a marcação do ponto de um local.
 *
 * 🔴 Porque é que isto deixou de ser os tiles da CARTO
 *
 *    Os `basemaps.cartocdn.com/light_all` eram usados sem chave desde o início
 *    do projeto. A CARTO passou a exigir chave e os tiles começaram a chegar
 *    com "API KEY REQUIRED" carimbado por cima — reportado com o ecrã à frente
 *    a 2026-09-10, a afetar **as duas** superfícies em produção ao mesmo tempo.
 *    O pedido continua a devolver HTTP 200 com uma imagem de 3 KB, e é por isso
 *    que nada no código dava erro: só se via a olho.
 *
 *    O `NEXT_PUBLIC_MAPBOX_TOKEN` já estava configurado em produção há meses e
 *    nenhum código o usava. Passa a ser a fonte dos tiles.
 *
 * 🔴 Porque raster e não o estilo vetorial do Mapbox
 *
 *    O MapLibre deixou de resolver URLs `mapbox://`, e é isso que o style JSON
 *    do Mapbox usa nas suas fontes. A API de tiles raster devolve o mesmo
 *    estilo já desenhado — com nomes de rua e números de porta — em PNG que o
 *    MapLibre consome como qualquer outra fonte raster.
 */

/** Sem token não há tiles do Mapbox. Cai para os tiles do próprio
 *  OpenStreetMap: menos bonitos, sem retina, mas com nomes de rua e sem
 *  carimbo por cima. É degradação, não avaria — o mapa continua a servir para
 *  marcar um ponto, que é o que importa. */
const OSM_FALLBACK: StyleSpecification = {
  version: 8,
  sources: {
    osm: {
      type: "raster",
      tiles: ["https://tile.openstreetmap.org/{z}/{x}/{y}.png"],
      tileSize: 256,
      maxzoom: 19,
      attribution: "© OpenStreetMap",
    },
  },
  layers: [{ id: "osm", type: "raster", source: "osm" }],
};

function mapboxStyle(token: string): StyleSpecification {
  return {
    version: 8,
    sources: {
      mapbox: {
        type: "raster",
        // `@2x` em tiles de 512 dá o detalhe que se vê num telemóvel; é neste
        // nível que aparecem os números de porta.
        tiles: [
          `https://api.mapbox.com/styles/v1/mapbox/streets-v12/tiles/512/{z}/{x}/{y}@2x?access_token=${token}`,
        ],
        tileSize: 512,
        maxzoom: 20,
        // Exigido pelas licenças de ambos. É desenhado pelo `AttributionControl`
        // que o MapLibre monta por omissão — nenhuma superfície pode passar
        // `attributionControl={false}`.
        attribution: "© Mapbox © OpenStreetMap",
      },
    },
    layers: [{ id: "mapbox", type: "raster", source: "mapbox" }],
  };
}

export type MapProvider = "mapbox" | "osm";

/**
 * 🔴 A ÚNICA regra que decide se o Mapbox é usado. Tudo o resto neste módulo
 *    deriva daqui — duas condições parecidas em sítios diferentes acabariam
 *    por divergir, e a que divergisse seria a que põe o token no URL.
 *
 *    O token entra num URL que o browser pede em claro. Um token `pk.` é
 *    público por desenho e é assim que o Mapbox espera que seja usado. Um
 *    `sk.` é secreto e dá acesso à conta; um `tk.` é temporário e não deve
 *    circular. Qualquer um deles num URL do browser é uma fuga de credencial,
 *    e a versão anterior deste ficheiro punha lá **qualquer string** que
 *    estivesse na variável de ambiente.
 *
 *    Na dúvida, OSM: um mapa mais pobre é sempre melhor do que um segredo
 *    publicado. Fail-closed.
 */
export function isUsablePublicMapboxToken(token: string | null | undefined): boolean {
  if (typeof token !== "string") return false;
  const limpo = token.trim();
  // `pk.` e mais nada: nem `sk.`, nem `tk.`, nem um `pk.` truncado ou com
  // caracteres que não pertencem a um token. O comprimento mínimo rejeita
  // marcadores de posição como "pk." ou "pk.xxx".
  return /^pk\.[A-Za-z0-9._-]{20,}$/.test(limpo);
}

/** Qual a fonte de tiles em uso. A UI usa isto para o branding não dizer
 *  "Mapbox" quando os tiles vieram do OpenStreetMap. */
export function getMapProvider(): MapProvider {
  return isUsablePublicMapboxToken(process.env.NEXT_PUBLIC_MAPBOX_TOKEN) ? "mapbox" : "osm";
}

export function getMapStyle(): StyleSpecification {
  const token = process.env.NEXT_PUBLIC_MAPBOX_TOKEN;
  return isUsablePublicMapboxToken(token) ? mapboxStyle((token as string).trim()) : OSM_FALLBACK;
}

/** Verdadeiro quando há tiles com detalhe de número de porta. Serve para a UI
 *  não prometer o que a base de mapa não mostra. */
export function hasDetailedTiles(): boolean {
  return getMapProvider() === "mapbox";
}

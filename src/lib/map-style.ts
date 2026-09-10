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

/** O token é `NEXT_PUBLIC_*`, portanto está no bundle do browser — é assim que
 *  o Mapbox espera que um token público de leitura seja usado. */
export function getMapStyle(): StyleSpecification {
  const token = process.env.NEXT_PUBLIC_MAPBOX_TOKEN;
  return token ? mapboxStyle(token) : OSM_FALLBACK;
}

/** Verdadeiro quando há tiles com detalhe de número de porta. Serve para a UI
 *  não prometer o que a base de mapa não mostra. */
export function hasDetailedTiles(): boolean {
  return Boolean(process.env.NEXT_PUBLIC_MAPBOX_TOKEN);
}

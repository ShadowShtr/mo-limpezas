/** Helpers puros de geocodificação (Nominatim/OSM).
 *
 *  Vivem fora dos componentes para poderem ser testados sem DOM e para que a
 *  pesquisa de morada e a marcação de pin no mapa partilhem exatamente a mesma
 *  interpretação da resposta do Nominatim.
 *
 *  🔴 Só existe pesquisa (`buildSearchUrl`). Não há geocodificação inversa:
 *     o Nominatim público limita-se a 1 pedido/segundo somados todos os
 *     utilizadores da aplicação, e pedir a morada de cada ponto largado no
 *     mapa seria carga automática nova sobre um serviço gratuito de
 *     terceiros. A dívida do autocomplete já existente está registada em
 *     GEOCODING-PROVIDER-01, para ser resolvida de uma vez (pesquisa,
 *     autocomplete e inversa) com provider próprio ou endpoint do servidor
 *     com cache e limite de ritmo — não improvisada aqui.
 */

export interface NominatimAddress {
  road?: string;
  pedestrian?: string;
  footway?: string;
  residential?: string;
  house_number?: string;
  postcode?: string;
  city?: string;
  town?: string;
  village?: string;
  suburb?: string;
  municipality?: string;
  county?: string;
}

export interface NominatimResult {
  place_id: number;
  display_name: string;
  lat: string;
  lon: string;
  address: NominatimAddress;
}

/** Morada em campos separados, como a UI a mostra. */
export interface StructuredAddress {
  road: string;
  houseNumber: string;
  postalCode: string;
  city: string;
}

const NOMINATIM = "https://nominatim.openstreetmap.org";

/** Centro aproximado de Portugal continental — ponto de partida do mapa quando
 *  ainda não há nada marcado nem pesquisado. */
export const PORTUGAL_CENTER = { lat: 39.5, lng: -8.0, zoom: 6 };

export function buildSearchUrl(query: string, limit = 5): string {
  const withCountry = query.toLowerCase().includes("portugal") ? query : `${query}, Portugal`;
  return `${NOMINATIM}/search?q=${encodeURIComponent(withCountry)}&format=json&limit=${limit}&addressdetails=1&countrycodes=pt`;
}

/** Extrai os campos estruturados de um resultado do Nominatim.
 *  Nunca lança: um resultado incompleto dá strings vazias, não `undefined`. */
export function parseAddress(address: NominatimAddress | null | undefined): StructuredAddress {
  const a = address ?? {};
  return {
    road: a.road ?? a.pedestrian ?? a.footway ?? a.residential ?? "",
    houseNumber: a.house_number ?? "",
    postalCode: a.postcode ?? "",
    city: a.city ?? a.town ?? a.village ?? a.suburb ?? a.municipality ?? a.county ?? "",
  };
}

/** Junta os campos numa morada legível de uma linha. */
export function composeAddress(parts: {
  road: string;
  houseNumber: string;
  complement?: string;
  postalCode: string;
  city: string;
}): string {
  const out: string[] = [];
  const road = parts.road.trim();
  const num = parts.houseNumber.trim();
  const complement = (parts.complement ?? "").trim();
  const pc = parts.postalCode.trim();
  const city = parts.city.trim();

  if (road) out.push(num ? `${road} ${num}` : road);
  if (complement) out.push(complement);
  if (pc || city) out.push([pc, city].filter(Boolean).join(" "));
  return out.join(", ");
}

/** Coordenada arredondada para gravar/mostrar. 6 casas ≈ 11 cm — mais do que
 *  suficiente para uma porta, e evita ruído infinito ao arrastar o pin. */
export function roundCoord(value: number): number {
  return Math.round(value * 1e6) / 1e6;
}

/** Formata para mostrar ao utilizador (ex: "38,712345, -9,139876" em PT). */
export function formatCoord(lat: number, lng: number): string {
  return `${roundCoord(lat).toFixed(6)}, ${roundCoord(lng).toFixed(6)}`;
}

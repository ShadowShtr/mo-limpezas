// ============================================================
// Geocodificação de locais — Mó Limpezas
// Ver docs/MIGRACAO_DADOS_REAIS.md
//
// Preenche lat/lng dos `locations` sem coordenadas, via Mapbox Geocoding API v6.
// Idempotente: só processa locais com lat IS NULL.
//
// Uso:  node scripts/geocode-locations.mjs
// Requer .env.local: NEXT_PUBLIC_SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, NEXT_PUBLIC_MAPBOX_TOKEN
//
// Custo: dentro do free tier do Mapbox (100.000 pedidos/mês).
// ============================================================
import { createClient } from "@supabase/supabase-js";
import { config } from "dotenv";

config({ path: "./.env.local" });
const sb = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY, {
  auth: { autoRefreshToken: false, persistSession: false },
});
const TOKEN = process.env.NEXT_PUBLIC_MAPBOX_TOKEN;
const PROXIMITY = "-8.97,39.02"; // zona Carregado/Alenquer — viés para moradas ambíguas
const CONCURRENCY = 8;

// Remove ruído que confunde o geocoder (cauda administrativa, URLs).
function clean(a) {
  if (!a) return "";
  return a.split(/https?:\/\//i)[0].split(/Uni[ãa]o das freguesias/i)[0]
    .replace(/\s+/g, " ").trim().replace(/[,\s]+$/, "");
}

async function geocode(q) {
  const url = `https://api.mapbox.com/search/geocode/v6/forward?q=${encodeURIComponent(q)}&country=pt&limit=1&proximity=${PROXIMITY}&access_token=${TOKEN}`;
  const r = await fetch(url);
  if (!r.ok) throw new Error("HTTP " + r.status);
  const f = (await r.json()).features?.[0];
  return f ? { lng: f.geometry.coordinates[0], lat: f.geometry.coordinates[1] } : null;
}

// Para os que falham na morada completa, tenta só o código postal.
async function withFallback(address) {
  const tries = [clean(address)];
  const pc = (address.match(/\d{4}-\d{3}/) || address.match(/\d{4}/) || [])[0];
  if (pc) tries.push(pc + " Portugal");
  for (const q of tries) { if (!q) continue; const g = await geocode(q); if (g) return g; }
  return null;
}

const locs = [];
for (let from = 0; ; from += 1000) {
  const { data } = await sb.from("locations").select("id,address").is("lat", null).range(from, from + 999);
  if (!data?.length) break; locs.push(...data); if (data.length < 1000) break;
}
console.log("locais a geocodificar:", locs.length);

let ok = 0, fail = 0, idx = 0;
async function worker() {
  while (idx < locs.length) {
    const L = locs[idx++];
    try {
      const g = await withFallback(L.address || "");
      if (!g) { fail++; continue; }
      const { error } = await sb.from("locations").update({ lat: g.lat, lng: g.lng }).eq("id", L.id);
      if (error) fail++; else ok++;
    } catch { fail++; }
    if ((ok + fail) % 100 === 0) console.log(`  ${ok + fail}/${locs.length} (ok=${ok} fail=${fail})`);
  }
}
await Promise.all(Array.from({ length: CONCURRENCY }, worker));
const { count } = await sb.from("locations").select("*", { count: "exact", head: true }).not("lat", "is", null);
console.log(`CONCLUÍDO. atualizados=${ok} falhas=${fail} | locais com coordenadas=${count}`);

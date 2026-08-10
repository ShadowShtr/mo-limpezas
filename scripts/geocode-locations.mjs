// ============================================================
// Geocodificação de locais — Mó Limpezas
// Ver docs/MIGRACAO_DADOS_REAIS.md
//
// Preenche lat/lng dos `locations` sem coordenadas, via Mapbox Geocoding API v6.
// Idempotente: só processa locais com lat IS NULL.
//
// Uso:
//   node scripts/geocode-locations.mjs --project-ref <ref> --company-id <uuid>
//   node scripts/geocode-locations.mjs --project-ref <ref> --company-id <uuid> --apply
//
// Requer .env.local: NEXT_PUBLIC_SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, NEXT_PUBLIC_MAPBOX_TOKEN
// Guardas comuns em scripts/lib/admin-db.mjs (T17-B2).
//
// Custo: dentro do free tier do Mapbox (100.000 pedidos/mês).
// ============================================================
import { openAdminDb, loadEnvFile } from "./lib/admin-db.mjs";

const db = await openAdminDb({
  script: "geocode-locations.mjs",
  purpose: "preencher lat/lng dos locais sem coordenadas, via Mapbox",
  writes: true,
});
const sb = db.sb;

const TOKEN = loadEnvFile().NEXT_PUBLIC_MAPBOX_TOKEN ?? process.env.NEXT_PUBLIC_MAPBOX_TOKEN;
if (!TOKEN) {
  console.error("Falta NEXT_PUBLIC_MAPBOX_TOKEN.");
  process.exit(1);
}
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
  const { data, error } = await sb.from("locations")
    .select("id,address")
    .eq("company_id", db.companyId)
    .is("lat", null)
    .range(from, from + 999);
  // Uma página falhada em silêncio pararia o laço e o script diria
  // "0 locais a geocodificar" — sucesso aparente sem ter feito nada.
  if (error) throw new Error(`locations (offset ${from}): ${error.message}`);
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
      const r = await db.write(
        "locations",
        (t) => t.update({ lat: g.lat, lng: g.lng }).eq("id", L.id).eq("company_id", db.companyId),
        `local ${L.id}`,
      );
      if (r.ok) ok++; else fail++;
    } catch (e) {
      // O motivo era engolido: uma chave Mapbox inválida dava 100% de "falhas"
      // sem uma única linha a dizer porquê.
      fail++;
      console.error(`  ⚠️  ${L.id}: ${e instanceof Error ? e.message : String(e)}`);
    }
    if ((ok + fail) % 100 === 0) console.log(`  ${ok + fail}/${locs.length} (ok=${ok} fail=${fail})`);
  }
}
await Promise.all(Array.from({ length: CONCURRENCY }, worker));

const { count, error: countError } = await sb.from("locations")
  .select("id", { count: "exact", head: true })
  .eq("company_id", db.companyId)
  .not("lat", "is", null);
if (countError) console.error(`contagem final indisponível: ${countError.message}`);
console.log(`CONCLUÍDO. processados=${ok} falhas=${fail} | locais com coordenadas=${count ?? "?"}`);
db.summary();

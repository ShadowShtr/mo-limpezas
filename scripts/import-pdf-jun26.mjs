// ============================================================
// Importa "trabalhos" (contracts) + "intervenções" (services) a partir do
// PDF de fichas de cliente (WhatsApp 2026-06-23), páginas 1–47. Página 48
// (Miguel Fonseca) ignorada a pedido.
//
// Uso:  node scripts/import-pdf-jun26.mjs [--dry]
//
// Idempotente:
//   - contratos: marcador `import:pdf-jun26 plan:N` em notes; reaproveita
//     contrato existente no mesmo local com o mesmo nome (cobre import-contratos-5).
//   - intervenções: salta reference_number já existente.
//
// Resolve clientes/locais/equipas por NOME em runtime (sem UUIDs fixos).
// Requer .env.local com SUPABASE_SERVICE_ROLE_KEY. Escreve em PRODUÇÃO.
// ============================================================
import { createClient } from "@supabase/supabase-js";
import { config } from "dotenv";
config({ path: "./.env.local" });
const sb = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY, { auth: { autoRefreshToken: false, persistSession: false } });

const C = "00000000-0000-0000-0000-000000000001";
const BY = "03def8bb-f7ae-4963-9a7d-78292b867d73"; // Vitor Medina (admin)
const TZ = "+01:00"; // Lisboa (horário de verão Jun/Jul/Ago)
const dry = process.argv.includes("--dry");

const ST = { Agendada: "agendado", Executada: "concluido", Cancelada: "cancelado", Iniciada: "em_curso" };
const DAYW = ["sun", "mon", "tue", "wed", "thu", "fri", "sat"]; // getUTCDay -> string
const isoWeekday = (d) => { const n = new Date(d + "T12:00:00Z").getUTCDay(); return n === 0 ? 7 : n; }; // 1=seg..7=dom
const dayStr = (d) => DAYW[new Date(d + "T12:00:00Z").getUTCDay()];
const durMin = (ini, fim) => { const [a, b] = ini.split(":").map(Number); const [c2, d2] = fim.split(":").map(Number); return (c2 * 60 + d2) - (a * 60 + b); };

// freq a partir do nome do plano
const freqOf = (name) => /Semanal/i.test(name) ? "weekly" : /Quinzenal/i.test(name) ? "biweekly" : "custom";
const isPontual = (name) => /Pontual/i.test(name);

// --------- TRABALHOS (planos de serviço visíveis em SERVIÇOS) ----------
// { plan, client, name, starts(DataInicio dd/mm/aaaa->iso), rate(€/h/c)|null, avenca(€)|null }
const PLANS = [
  { plan: 552, client: "Lavanderia 9", name: "Limpezas-Específicos-Semanal", starts: "2025-08-13", avenca: 118.55 },
  { plan: 22, client: "Daniela Ramos", name: "Limpezas-Manutenção-Pontual", starts: "2025-03-18", rate: 10.0 },
  { plan: 102, client: "Engenharia e Construção", name: "Limpezas-Manutenção-Quinzenal", starts: "2025-03-24", avenca: 89.61 },
  { plan: 705, client: "Cristina Vfx", name: "Limpezas-Manutenção-Semanal", starts: "2025-10-13", rate: 10.25 },
  { plan: 387, client: "Cristiana (diana)", name: "Limpezas-Manutenção-Semanal", starts: "2025-06-12", rate: 10.5 },
  { plan: 20, client: "Cristina Gavetenho", name: "Limpezas-Manutenção-Quinzenal", starts: "2025-03-18", rate: 9.5 },
  { plan: 660, client: "Cidalia", name: "Limpezas-Manutenção-Quinzenal", starts: "2025-09-12", rate: 10.5 },
  { plan: 729, client: "Claudia Castanheira", name: "Limpezas-Manutenção-Semanal", starts: "2025-10-30", rate: 10.5 },
  { plan: 893, client: "Catarina Canto", name: "Limpezas-Manutenção-Pontual", starts: "2026-03-31", rate: 11.0 },
  { plan: 883, client: "Catarina Canto", name: "Limpezas-Manutenção-Pontual", starts: "2026-03-23", rate: 11.0 },
  { plan: 18, client: "Carlos Garces", name: "Limpezas-Manutenção-Quinzenal", starts: "2025-03-14", rate: 9.5 },
  { plan: 778, client: "Carla Roque", name: "Limpezas-Manutenção-Quinzenal", starts: "2025-12-10", rate: 10.5 },
  { plan: 17, client: "Carla Santos", name: "Limpezas-Manutenção-Pontual", starts: "2025-03-17", rate: 10.0 },
  { plan: 879, client: "Carla Diniz", name: "Limpezas-Manutenção-Pontual", starts: "2026-03-20", rate: 11.0 },
  { plan: 837, client: "Carla Olhalvo", name: "Limpezas-Específicos-Pontual", starts: "2026-01-20", rate: 11.0 },
  { plan: 840, client: "Carina VFX", name: "Limpezas-Manutenção-Quinzenal", starts: "2026-01-29", rate: 11.0 },
  { plan: 833, client: "Carina VFX", name: "Limpezas-Profunda-Pontual", starts: "2026-01-14", rate: 11.0 },
  { plan: 115, client: "Antonio Garcia", name: "Limpezas-Manutenção-Pontual", starts: "2025-03-25", rate: 10.0 },
  { plan: 114, client: "Bruna D. Ofelia", name: "Limpezas-Manutenção-Pontual", starts: "2025-03-25", rate: 9.5 },
  { plan: 15, client: "Antônia Pascoa", name: "Limpezas-Manutenção-Quinzenal", starts: "2025-05-05", rate: 9.5 },
  { plan: 838, client: "André Martins- Escritorio", name: "Limpezas-Manutenção-Semanal", starts: "2026-01-20", avenca: 95.33 },
  { plan: 449, client: "Andreia Martins", name: "Limpezas-Manutenção-Quinzenal", starts: "2025-07-21", rate: 10.0 },
  { plan: 191, client: "Anderson Ramalho", name: "Limpezas-Manutenção-Semanal", starts: "2025-04-10", rate: 9.5 },
  { plan: 788, client: "Anatilde Teixeira", name: "Limpezas-Manutenção-Quinzenal", starts: "2025-12-22", rate: 9.0 },
  { plan: 7, client: "Anatilde Teixeira", name: "Limpezas-Manutenção-Pontual", starts: "2025-03-14", rate: 9.0 },
  { plan: 392, client: "Anette", name: "Limpezas-Manutenção-Semanal", starts: "2025-06-13", rate: 10.5 },
  { plan: 522, client: "Ana Sousa - Abrigada", name: "Limpezas-Profunda-Pontual", starts: "2025-08-11", rate: 10.0 },
  { plan: 314, client: "Ana Sousa - sofá", name: "Limpezas-Específicos-Pontual", starts: "2025-05-12", interv: 45.0 },
  { plan: 807, client: "Ana Martins", name: "Limpezas-Manutenção-Quinzenal", starts: "2026-01-05", rate: 10.0 },
  { plan: 780, client: "Ana Martins", name: "Limpezas-Manutenção-Pontual", starts: "2025-12-12", rate: 10.0 },
  { plan: 853, client: "Ana Ribeiro", name: "Limpezas-Manutenção-Semanal", starts: "2026-02-16", rate: 11.0 },
  { plan: 810, client: "Ana Oliveira", name: "Limpezas-Manutenção-Quinzenal", starts: "2026-01-07", rate: 11.0 },
  { plan: 4, client: "Ana Gomes", name: "Limpezas-Manutenção-Quinzenal", starts: "2025-03-25", rate: 10.0 },
  { plan: 3, client: "Ana Cristina Nobre", name: "Limpezas-Manutenção-Quinzenal", starts: "2025-03-12", rate: 9.5 },
  { plan: 279, client: "Ana Diogo Valente", name: "Limpezas-Manutenção-Pontual", starts: "2025-05-05", rate: 8.0 },
  { plan: 119, client: "Anabela Gomes", name: "Limpezas-Manutenção-Pontual", starts: "2025-03-25", rate: 9.5 },
  { plan: 882, client: "Ana Custódio", name: "Limpezas-Manutenção-Quinzenal", starts: "2026-03-23", rate: 12.0 },
  { plan: 866, client: "Ana Custódio", name: "Limpezas-Manutenção-Pontual", starts: "2026-03-03", rate: 12.0 },
  { plan: 201, client: "Alexandra Rocha", name: "Limpezas-Manutenção-Quinzenal", starts: "2025-04-12", rate: 10.0 },
  { plan: 607, client: "Alina Horzov", name: "Limpezas-Manutenção-Pontual", starts: "2025-08-18", rate: 10.5 },
  { plan: 397, client: "Albertina Madureira", name: "Limpezas-Profunda-Pontual", starts: "2025-06-17", rate: 10.0 },
  { plan: 539, client: "Alemão 15", name: "Limpezas-Específicos-Semanal", starts: "2025-08-13", avenca: 63.08 },
  { plan: 416, client: "Alateia Lost Wind", name: "Estofos-Específicos-Pontual", starts: "2025-06-30", interv: 55.0 },
  { plan: 301, client: "Afonso Ilep", name: "Limpezas-Manutenção-Semanal", starts: "2025-05-07", avenca: 357.05 },
  { plan: 122, client: "Agito", name: "Limpezas-Manutenção-Semanal", starts: "2025-03-26", avenca: 1188.35 },
  { plan: 83, client: "Agito Apartamento", name: "Limpezas-Manutenção-Pontual", starts: "2025-03-24", interv: 76.0 },
  { plan: 313, client: "Adriana Tavares - mãe", name: "Limpezas-Vidros-Pontual", starts: "2025-05-12", rate: 10.0 },
  { plan: 914, client: "Abmn", name: "Limpezas-Manutenção-Quinzenal", starts: "2026-04-27", rate: 11.0 },
  { plan: 311, client: "Adriana Tavares", name: "Limpezas-Vidros-Pontual", starts: "2025-05-12", rate: 10.0 },
  { plan: 566, client: "Prédio Álvares Cabral 9", name: "Limpezas-Específicos-Semanal", starts: "2025-08-14", avenca: 145.37 },
  { plan: 145, client: "Prédio Sintra 84", name: "Limpezas-Específicos-Semanal", starts: "2025-03-31", avenca: 77.38 },
];

// --------- INTERVENÇÕES (linhas visíveis em INTERVENÇÕES) ----------
// { plan, ref, date, ini, fim, estado, team, valor|null }
const INTERV = [
  // 552 Lavanderia 9 (avença, valor --)
  { plan: 552, ref: "152592", date: "2026-06-25", ini: "09:20", fim: "10:00", estado: "Agendada", team: "Equipa 9.01 - Alenquer" },
  { plan: 552, ref: "157261", date: "2026-07-02", ini: "09:20", fim: "10:00", estado: "Agendada", team: "Equipa 9.01 - Alenquer" },
  { plan: 552, ref: "159658", date: "2026-07-09", ini: "09:20", fim: "10:00", estado: "Agendada", team: "Equipa 9.01 - Alenquer" },
  // 22 Daniela Ramos
  { plan: 22, ref: "181690", date: "2026-07-10", ini: "09:00", fim: "12:30", estado: "Agendada", team: "Equipa 2", valor: 70.0 },
  { plan: 22, ref: "181691", date: "2026-07-24", ini: "09:00", fim: "12:30", estado: "Agendada", team: "Equipa 2", valor: 70.0 },
  { plan: 22, ref: "181692", date: "2026-07-31", ini: "09:00", fim: "12:30", estado: "Agendada", team: "Equipa 2", valor: 70.0 },
  // 102 Engenharia e Construção (avença)
  { plan: 102, ref: "157490", date: "2026-06-26", ini: "14:30", fim: "16:30", estado: "Agendada", team: "Equipa 2" },
  { plan: 102, ref: "162112", date: "2026-07-10", ini: "14:00", fim: "16:00", estado: "Agendada", team: "Equipa 4" },
  { plan: 102, ref: "166606", date: "2026-07-24", ini: "14:30", fim: "16:30", estado: "Agendada", team: "Equipa 8" },
  // 705 Cristina Vfx
  { plan: 705, ref: "152325", date: "2026-06-24", ini: "14:30", fim: "16:30", estado: "Cancelada", team: "Equipa 7", valor: 41.0 },
  { plan: 705, ref: "156707", date: "2026-07-01", ini: "13:30", fim: "15:30", estado: "Agendada", team: "Equipa 4", valor: 41.0 },
  { plan: 705, ref: "159406", date: "2026-07-08", ini: "14:30", fim: "16:30", estado: "Agendada", team: "Equipa 7", valor: 41.0 },
  // 387 Cristiana (diana)
  { plan: 387, ref: "153454", date: "2026-06-26", ini: "08:30", fim: "09:30", estado: "Agendada", team: "Equipa 6", valor: 31.5 },
  { plan: 387, ref: "157566", date: "2026-07-03", ini: "09:45", fim: "10:45", estado: "Agendada", team: "Equipa 1", valor: 31.5 },
  { plan: 387, ref: "159951", date: "2026-07-10", ini: "12:00", fim: "13:00", estado: "Agendada", team: "Equipa 4", valor: 31.5 },
  // 20 Cristina Gavetenho
  { plan: 20, ref: "177927", date: "2026-07-01", ini: "08:30", fim: "10:30", estado: "Agendada", team: "Equipa 6", valor: 38.0 },
  { plan: 20, ref: "177928", date: "2026-07-15", ini: "08:30", fim: "10:30", estado: "Agendada", team: "Equipa 6", valor: 38.0 },
  { plan: 20, ref: "177929", date: "2026-07-29", ini: "08:30", fim: "10:30", estado: "Agendada", team: "Equipa 6", valor: 38.0 },
  // 660 Cidalia
  { plan: 660, ref: "156329", date: "2026-06-23", ini: "13:00", fim: "16:00", estado: "Iniciada", team: "Equipa 1", valor: 63.0 },
  { plan: 660, ref: "161128", date: "2026-07-07", ini: "13:00", fim: "16:00", estado: "Agendada", team: "Equipa 1", valor: 63.0 },
  { plan: 660, ref: "165729", date: "2026-07-21", ini: "13:00", fim: "16:00", estado: "Agendada", team: "Equipa 1", valor: 63.0 },
  // 729 Claudia Castanheira
  { plan: 729, ref: "154556", date: "2026-06-29", ini: "08:45", fim: "10:15", estado: "Agendada", team: "Equipa 5", valor: 47.25 },
  { plan: 729, ref: "158711", date: "2026-07-06", ini: "08:30", fim: "10:00", estado: "Agendada", team: "Equipa 5", valor: 47.25 },
  { plan: 729, ref: "160752", date: "2026-07-13", ini: "08:30", fim: "10:00", estado: "Agendada", team: "Equipa 6", valor: 47.25 },
  // 18 Carlos Garces
  { plan: 18, ref: "157440", date: "2026-06-26", ini: "14:30", fim: "16:30", estado: "Agendada", team: "Equipa 5", valor: 57.0 },
  { plan: 18, ref: "162061", date: "2026-07-10", ini: "14:30", fim: "16:30", estado: "Agendada", team: "Equipa 5", valor: 38.0 },
  { plan: 18, ref: "166558", date: "2026-07-24", ini: "14:30", fim: "16:30", estado: "Agendada", team: "Equipa 5", valor: 38.0 },
  // 778 Carla Roque
  { plan: 778, ref: "179301", date: "2026-07-06", ini: "08:30", fim: "10:30", estado: "Agendada", team: "Equipa 7", valor: 42.0 },
  { plan: 778, ref: "179302", date: "2026-07-20", ini: "08:30", fim: "10:30", estado: "Agendada", team: "Equipa 7", valor: 42.0 },
  { plan: 778, ref: "179303", date: "2026-08-03", ini: "08:30", fim: "10:30", estado: "Agendada", team: "Equipa 7", valor: 42.0 },
  // 15 Antônia Pascoa
  { plan: 15, ref: "170497", date: "2026-07-06", ini: "14:30", fim: "16:30", estado: "Agendada", team: "Equipa 2", valor: 38.0 },
  { plan: 15, ref: "170498", date: "2026-07-20", ini: "14:30", fim: "16:30", estado: "Agendada", team: "Equipa 2", valor: 38.0 },
  { plan: 15, ref: "170499", date: "2026-08-03", ini: "14:30", fim: "16:30", estado: "Agendada", team: "Equipa 2", valor: 38.0 },
  // 838 André Martins- Escritorio (avença)
  { plan: 838, ref: "152372", date: "2026-06-24", ini: "08:30", fim: "09:30", estado: "Agendada", team: "Equipa 8" },
  { plan: 838, ref: "156754", date: "2026-07-01", ini: "08:30", fim: "09:30", estado: "Agendada", team: "Equipa 8" },
  { plan: 838, ref: "159451", date: "2026-07-08", ini: "08:30", fim: "09:30", estado: "Agendada", team: "Equipa 8" },
  // 449 Andreia Martins
  { plan: 449, ref: "164474", date: "2026-07-01", ini: "09:45", fim: "11:45", estado: "Agendada", team: "Equipa 8", valor: 40.0 },
  { plan: 449, ref: "164475", date: "2026-07-15", ini: "10:00", fim: "12:00", estado: "Agendada", team: "Equipa 8", valor: 40.0 },
  { plan: 449, ref: "168293", date: "2026-07-29", ini: "10:00", fim: "12:00", estado: "Agendada", team: "Equipa 8", valor: 40.0 },
  // 191 Anderson Ramalho
  { plan: 191, ref: "151466", date: "2026-06-23", ini: "08:30", fim: "10:30", estado: "Executada", team: "Equipa 5", valor: 38.0 },
  { plan: 191, ref: "156154", date: "2026-06-30", ini: "08:15", fim: "10:15", estado: "Agendada", team: "Equipa 5", valor: 38.0 },
  { plan: 191, ref: "158870", date: "2026-07-07", ini: "08:30", fim: "10:30", estado: "Agendada", team: "Equipa 6", valor: 38.0 },
  // 788 Anatilde Teixeira
  { plan: 788, ref: "160123", date: "2026-07-03", ini: "13:30", fim: "16:30", estado: "Agendada", team: "Equipa 5", valor: 81.0 },
  { plan: 788, ref: "164781", date: "2026-07-17", ini: "13:30", fim: "16:30", estado: "Agendada", team: "Equipa 5", valor: 54.0 },
  { plan: 788, ref: "169168", date: "2026-07-31", ini: "13:00", fim: "16:00", estado: "Agendada", team: "Equipa 4", valor: 54.0 },
  // 392 Anette
  { plan: 392, ref: "151494", date: "2026-06-23", ini: "09:00", fim: "11:00", estado: "Executada", team: "Equipa 8", valor: 42.0 },
  { plan: 392, ref: "156181", date: "2026-06-30", ini: "09:00", fim: "11:00", estado: "Agendada", team: "Equipa 8", valor: 42.0 },
  { plan: 392, ref: "158898", date: "2026-07-07", ini: "09:00", fim: "11:00", estado: "Agendada", team: "Equipa 7", valor: 42.0 },
  // 807 Ana Martins
  { plan: 807, ref: "154572", date: "2026-06-25", ini: "09:30", fim: "11:30", estado: "Agendada", team: "Equipa 8", valor: 20.0 },
  { plan: 807, ref: "160765", date: "2026-07-06", ini: "14:00", fim: "16:00", estado: "Agendada", team: "Equipa 9", valor: 40.0 },
  { plan: 807, ref: "165424", date: "2026-07-20", ini: "14:00", fim: "16:00", estado: "Agendada", team: "Equipa 9", valor: 40.0 },
  // 853 Ana Ribeiro
  { plan: 853, ref: "164105", date: "2026-06-24", ini: "12:00", fim: "14:00", estado: "Cancelada", team: "Equipa 2", valor: 22.0 },
  { plan: 853, ref: "182655", date: "2026-06-25", ini: "08:30", fim: "10:30", estado: "Agendada", team: "Equipa 3", valor: 44.0 },
  { plan: 853, ref: "164106", date: "2026-07-01", ini: "10:30", fim: "12:30", estado: "Agendada", team: "Equipa 1", valor: 22.0 },
  // 810 Ana Oliveira
  { plan: 810, ref: "159778", date: "2026-07-02", ini: "07:45", fim: "09:45", estado: "Agendada", team: "Equipa 1", valor: 44.0 },
  { plan: 810, ref: "164417", date: "2026-07-16", ini: "07:45", fim: "09:45", estado: "Agendada", team: "Equipa 1", valor: 44.0 },
  { plan: 810, ref: "168823", date: "2026-07-30", ini: "07:45", fim: "09:45", estado: "Agendada", team: "Equipa 1", valor: 44.0 },
  // 4 Ana Gomes
  { plan: 4, ref: "158775", date: "2026-06-30", ini: "08:30", fim: "16:30", estado: "Agendada", team: "Equipa 2", valor: 80.0 },
  { plan: 4, ref: "163351", date: "2026-07-14", ini: "08:30", fim: "16:30", estado: "Agendada", team: "Equipa 2", valor: 80.0 },
  { plan: 4, ref: "167814", date: "2026-07-28", ini: "08:30", fim: "16:30", estado: "Agendada", team: "Equipa 2", valor: 160.0 },
  // 3 Ana Cristina Nobre
  { plan: 3, ref: "175981", date: "2026-07-01", ini: "10:45", fim: "12:45", estado: "Agendada", team: "Equipa 6", valor: 19.0 },
  { plan: 3, ref: "175982", date: "2026-07-15", ini: "14:30", fim: "16:30", estado: "Agendada", team: "Equipa 8", valor: 19.0 },
  { plan: 3, ref: "175983", date: "2026-07-29", ini: "14:30", fim: "16:30", estado: "Agendada", team: "Equipa 8", valor: 19.0 },
  // 882 Ana Custódio
  { plan: 882, ref: "158756", date: "2026-06-29", ini: "09:00", fim: "12:30", estado: "Agendada", team: "Equipa 8", valor: 84.0 },
  { plan: 882, ref: "163335", date: "2026-07-13", ini: "09:00", fim: "12:30", estado: "Agendada", team: "Equipa 8", valor: 84.0 },
  { plan: 882, ref: "167801", date: "2026-07-27", ini: "09:00", fim: "12:30", estado: "Agendada", team: "Equipa 8", valor: 84.0 },
  // 201 Alexandra Rocha
  { plan: 201, ref: "180679", date: "2026-06-23", ini: "10:30", fim: "12:30", estado: "Executada", team: "Equipa 4", valor: 40.0 },
  { plan: 201, ref: "180680", date: "2026-07-07", ini: "12:30", fim: "14:30", estado: "Agendada", team: "Equipa 3", valor: 40.0 },
  { plan: 201, ref: "180681", date: "2026-07-21", ini: "12:30", fim: "14:30", estado: "Agendada", team: "Equipa 3", valor: 40.0 },
  // 539 Alemão 15 (avença)
  { plan: 539, ref: "152578", date: "2026-06-25", ini: "11:00", fim: "11:30", estado: "Agendada", team: "Equipa 9.2 - Alverca" },
  { plan: 539, ref: "157246", date: "2026-07-02", ini: "11:00", fim: "11:30", estado: "Agendada", team: "Equipa 9.2 - Alverca" },
  { plan: 539, ref: "159644", date: "2026-07-09", ini: "11:00", fim: "11:30", estado: "Agendada", team: "Equipa 9.2 - Alverca" },
  // 301 Afonso Ilep (avença)
  { plan: 301, ref: "154369", date: "2026-06-29", ini: "08:30", fim: "12:30", estado: "Agendada", team: "Equipa 4" },
  { plan: 301, ref: "158534", date: "2026-07-06", ini: "08:30", fim: "12:30", estado: "Agendada", team: "Equipa 4" },
  { plan: 301, ref: "160566", date: "2026-07-13", ini: "08:30", fim: "12:30", estado: "Agendada", team: "Equipa 4" },
  // 122 Agito (avença, vários dias)
  { plan: 122, ref: "176790", date: "2026-06-23", ini: "08:30", fim: "12:30", estado: "Agendada", team: "Equipa 9.4-Elza" },
  { plan: 122, ref: "176803", date: "2026-06-24", ini: "08:30", fim: "12:30", estado: "Agendada", team: "Equipa 9.4-Elza" },
  { plan: 122, ref: "176816", date: "2026-06-25", ini: "08:30", fim: "12:30", estado: "Agendada", team: "Equipa 9.4-Elza" },
  // 914 Abmn
  { plan: 914, ref: "173956", date: "2026-07-03", ini: "15:30", fim: "16:30", estado: "Agendada", team: "Equipa 3", valor: 22.0 },
  { plan: 914, ref: "173957", date: "2026-07-17", ini: "15:30", fim: "16:30", estado: "Agendada", team: "Equipa 3", valor: 22.0 },
  { plan: 914, ref: "173958", date: "2026-07-31", ini: "16:15", fim: "17:15", estado: "Agendada", team: "Equipa 2", valor: 22.0 },
  // 566 Prédio Álvares Cabral 9 (avença)
  { plan: 566, ref: "153530", date: "2026-06-26", ini: "08:30", fim: "09:00", estado: "Agendada", team: "Equipa 9.1 - Carregado" },
  { plan: 566, ref: "157643", date: "2026-07-03", ini: "08:30", fim: "09:00", estado: "Agendada", team: "Equipa 9.1 - Carregado" },
  { plan: 566, ref: "160027", date: "2026-07-10", ini: "08:30", fim: "09:00", estado: "Agendada", team: "Equipa 9.1 - Carregado" },
  // 145 Prédio Sintra 84 (avença)
  { plan: 145, ref: "152113", date: "2026-06-24", ini: "09:00", fim: "09:30", estado: "Agendada", team: "Equipa 9.1 - Carregado" },
  { plan: 145, ref: "156493", date: "2026-07-01", ini: "09:00", fim: "09:30", estado: "Agendada", team: "Equipa 9.1 - Carregado" },
  { plan: 145, ref: "159194", date: "2026-07-08", ini: "09:00", fim: "09:30", estado: "Agendada", team: "Equipa 9.1 - Carregado" },
];

// ---------------- resolução de equipas ----------------
const { data: teamRows } = await sb.from("teams").select("id,name").eq("company_id", C);
const teamByName = new Map(teamRows.map((t) => [t.name.trim(), t.id]));
const teamByNorm = new Map(teamRows.map((t) => [t.name.toLowerCase().replace(/[^a-z0-9]/g, ""), t.id]));
function resolveTeam(name) {
  if (!name) return null;
  // Equipas "9.x - Localidade" (avenças) ficam sem equipa, a pedido — atribuir depois.
  if (/^Equipa 9\.\d/i.test(name.trim())) return null;
  if (teamByName.has(name.trim())) return teamByName.get(name.trim());
  const norm = name.toLowerCase().replace(/[^a-z0-9]/g, "");
  if (teamByNorm.has(norm)) return teamByNorm.get(norm);
  return undefined; // undefined = não resolvido (avisa)
}

// ---------------- resolução de cliente/local ----------------
const locCache = new Map(); // client name -> { client_id, location_id }
async function resolveLoc(clientName) {
  if (locCache.has(clientName)) return locCache.get(clientName);
  const { data: cls } = await sb.from("clients").select("id,address").eq("company_id", C).ilike("name", clientName);
  if (!cls?.length) { locCache.set(clientName, null); return null; }
  const client_id = cls[0].id;
  let { data: locs } = await sb.from("locations").select("id,active").eq("client_id", client_id).order("active", { ascending: false });
  let location_id = locs?.[0]?.id;
  if (!location_id) {
    if (dry) { location_id = "(novo local a criar)"; }
    else {
      const { data: nl, error } = await sb.from("locations").insert({ company_id: C, client_id, name: "Morada principal", address: cls[0].address || clientName, service_type: "limpeza_regular", active: true }).select("id").single();
      if (error) { console.error("  ERRO local", clientName, error.message); locCache.set(clientName, null); return null; }
      location_id = nl.id;
    }
  }
  const r = { client_id, location_id };
  locCache.set(clientName, r);
  return r;
}

// ---------------- run ----------------
console.log(`== import-pdf-jun26 ${dry ? "(DRY)" : "(ESCRITA REAL)"} ==`);
console.log(`Planos: ${PLANS.length} | Intervenções: ${INTERV.length}`);

// pré-validação: clientes e equipas
const missingClients = [];
for (const p of PLANS) { const r = await resolveLoc(p.client); if (!r) missingClients.push(p.client); }
const teamWarn = new Set();
for (const i of INTERV) { if (resolveTeam(i.team) === undefined) teamWarn.add(i.team); }
if (missingClients.length) console.log("⚠ clientes NÃO encontrados:", [...new Set(missingClients)].join(" | "));
if (teamWarn.size) console.log("⚠ equipas NÃO resolvidas:", [...teamWarn].join(" | "));

// refs já existentes
const refs = INTERV.map((i) => i.ref);
const taken = new Set();
for (let i = 0; i < refs.length; i += 200) {
  const { data } = await sb.from("services").select("reference_number").in("reference_number", refs.slice(i, i + 200));
  (data || []).forEach((r) => taken.add(r.reference_number));
}
console.log(`Refs já existentes (serão saltadas): ${taken.size} → ${[...taken].join(",") || "nenhuma"}`);

// agrupa intervenções por plano para derivar agenda do contrato
const intervByPlan = {};
for (const i of INTERV) (intervByPlan[i.plan] ??= []).push(i);

// 1) contratos
const contractIdByPlan = {};
let contractsNew = 0, contractsReused = 0;
for (const p of PLANS) {
  const loc = await resolveLoc(p.client);
  if (!loc) { console.log(`  SALTADO contrato plan:${p.plan} (cliente ${p.client} inexistente)`); continue; }
  const freq = freqOf(p.name);
  const items = intervByPlan[p.plan] || [];
  // agenda: dias/horas distintos das intervenções (só para recorrentes)
  let schedule_days = [], weekdays = null;
  if (!isPontual(p.name) && items.length) {
    const seen = new Set();
    for (const it of items) {
      const ds = dayStr(it.date);
      if (seen.has(ds)) continue; seen.add(ds);
      schedule_days.push({ day: ds, start_time: it.ini, duration_min: durMin(it.ini, it.fim), team_id: resolveTeam(it.team) || null });
    }
    weekdays = [...new Set(items.map((it) => isoWeekday(it.date)))].sort();
  }
  const marker = `import:pdf-jun26 plan:${p.plan}`;
  if (dry) {
    console.log(`  [DRY] contrato plan:${p.plan} ${p.name} | ${freq} | dias ${schedule_days.map((s) => s.day).join(",") || "—"} | ${p.avenca ? "avença " + p.avenca + "€" : p.interv ? p.interv + "€/interv" : (p.rate ?? "?") + "€/h"} | loc ${loc.location_id}`);
    contractIdByPlan[p.plan] = `(dry-${p.plan})`;
    continue;
  }
  // reaproveita contrato existente: mesmo marcador OU mesmo local+nome
  let { data: exMarker } = await sb.from("contracts").select("id").eq("company_id", C).like("notes", `%${marker}%`).limit(1);
  let exId = exMarker?.[0]?.id;
  if (!exId) {
    const { data: exLoc } = await sb.from("contracts").select("id").eq("company_id", C).eq("location_id", loc.location_id).eq("name", p.name).limit(1);
    exId = exLoc?.[0]?.id;
  }
  if (exId) { contractIdByPlan[p.plan] = exId; contractsReused++; continue; }
  const row = {
    company_id: C, location_id: loc.location_id, name: p.name, frequency: freq,
    weekdays, interval_days: freq === "custom" ? 30 : 1, schedule_days,
    starts_on: p.starts, status: "ativo",
    notes: `${marker}${isPontual(p.name) ? " | Pontual (a pedido)" : ""}${p.avenca ? ` | Avença ${p.avenca}€/mês` : ""}`,
    created_by: BY,
  };
  const { data, error } = await sb.from("contracts").insert(row).select("id").single();
  if (error) { console.error(`  ERRO contrato plan:${p.plan}`, error.message); continue; }
  contractIdByPlan[p.plan] = data.id; contractsNew++;
}

// 2) intervenções
let insInterv = 0, skipInterv = 0;
for (const i of INTERV) {
  if (taken.has(i.ref)) { skipInterv++; continue; }
  const plan = PLANS.find((p) => p.plan === i.plan);
  const loc = await resolveLoc(plan.client);
  if (!loc) { console.log(`  SALTADA interv ${i.ref} (cliente inexistente)`); continue; }
  const team_id = resolveTeam(i.team) || null;
  const rate = plan.rate ?? null;
  const row = {
    company_id: C, location_id: loc.location_id, team_id, contract_id: dry ? null : (contractIdByPlan[i.plan] || null),
    reference_number: String(i.ref),
    scheduled_start: `${i.date}T${i.ini}:00${TZ}`, scheduled_end: `${i.date}T${i.fim}:00${TZ}`,
    hourly_rate: rate, manual_value: i.valor ?? null, discount_pct: 0, status: ST[i.estado],
    notes: "import:pdf-jun26", created_by: BY,
    ...(i.estado === "Executada" ? { actual_start: `${i.date}T${i.ini}:00${TZ}`, actual_end: `${i.date}T${i.fim}:00${TZ}` } : {}),
    ...(i.estado === "Iniciada" ? { actual_start: `${i.date}T${i.ini}:00${TZ}` } : {}),
    ...(i.estado === "Cancelada" ? { cancelled_at: `${i.date}T${i.ini}:00${TZ}`, cancel_reason: "Importado como cancelado (origem)" } : {}),
  };
  if (dry) { insInterv++; continue; }
  const { error } = await sb.from("services").insert(row);
  if (error) { console.error(`  ERRO interv ${i.ref}`, error.message); continue; }
  insInterv++;
}

console.log(`\n== ${dry ? "DRY (nada escrito)" : "CONCLUÍDO"} ==`);
console.log(`Contratos: ${dry ? PLANS.length + " a processar" : `${contractsNew} novos, ${contractsReused} reaproveitados`}`);
console.log(`Intervenções: ${insInterv} ${dry ? "a inserir" : "inseridas"} | ${skipInterv} saltadas (ref existente)`);

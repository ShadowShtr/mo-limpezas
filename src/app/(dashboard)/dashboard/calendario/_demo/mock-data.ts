/**
 * Dados de demonstração para o calendário — usados quando a BD está vazia.
 * Remove este ficheiro quando houver dados reais.
 */

import { addDays, startOfWeek, format } from "date-fns";
import type { Database } from "@/types/database";

type ServiceFull = Database["public"]["Views"]["services_full"]["Row"];

export const DEMO_TEAMS = [
  { id: "demo-team-1", name: "Equipa 1", color: "#16A34A" },
  { id: "demo-team-2", name: "Equipa 2", color: "#2563EB" },
  { id: "demo-team-3", name: "Equipa 3", color: "#9333EA" },
];

function svc(
  id: string,
  ref: string,
  teamIdx: number,
  dayOffset: number,
  startH: number,
  startM: number,
  durationMin: number,
  locationName: string,
  address: string,
  clientName: string,
  status: string,
  value: number,
  notes: string | null = null,
  accessCode: string | null = null,
): ServiceFull {
  const weekStart = startOfWeek(new Date(), { weekStartsOn: 1 });
  const day = addDays(weekStart, dayOffset);
  const dateStr = format(day, "yyyy-MM-dd");
  const start = `${dateStr}T${String(startH).padStart(2, "0")}:${String(startM).padStart(2, "0")}:00`;
  const endMs = new Date(start).getTime() + durationMin * 60_000;
  const end = new Date(endMs).toISOString().replace(/\.\d{3}Z$/, "");
  const team = DEMO_TEAMS[teamIdx];

  return {
    id,
    company_id: "demo-company",
    reference_number: ref,
    scheduled_start: start,
    scheduled_end: end,
    actual_start: status === "concluido" ? start : null,
    actual_end: status === "concluido" ? end : null,
    status,
    notes,
    calculated_value: value,
    manual_value: null,
    contract_id: null,
    is_exception: false,
    location_id: `loc-${id}`,
    location_name: locationName,
    location_address: address,
    location_lat: null,
    location_lng: null,
    location_access_code: accessCode,
    location_instructions: null,
    location_has_key: false,
    location_key_label: null,
    client_id: `cli-${id}`,
    client_name: clientName,
    client_email: null,
    client_phone: null,
    team_id: team.id,
    team_name: team.name,
    team_color: team.color,
    payment_status: null,
    apply_vat: true,
  };
}

export function getDemoServices(): ServiceFull[] {
  return [
    // Segunda-feira
    svc("d01","0001", 0, 0, 8,  0, 240, "Escritórios Central",    "Av. da Liberdade, 110, Lisboa",           "TechCorp Lda",       "concluido", 96,  "Limpeza semanal. Incluir casas de banho.", "4521"),
    svc("d02","0002", 1, 0, 9,  0, 120, "Boutique Alma",           "Rua Augusta, 23, Lisboa",                 "Alma Fashion",       "concluido", 48),
    svc("d03","0003", 2, 0, 10, 0, 180, "Condomínio Verde",        "Rua do Carmo, 45, Lisboa",                "Cond. Verde",        "concluido", 72,  null, "8834"),

    // Terça-feira
    svc("d04","0004", 0, 1, 8,  0, 180, "Clínica Saúde Total",    "Av. António Augusto Aguiar, 5, Lisboa",   "Saúde Total Lda",    "concluido", 72,  "Atenção às salas de espera."),
    svc("d05","0005", 1, 1, 8, 30, 150, "Restaurante Mar e Terra", "Rua dos Bacalhoeiros, 12, Lisboa",        "Mar e Terra SA",     "concluido", 60),
    svc("d06","0006", 2, 1, 14, 0, 120, "Ginásio Força Total",    "Av. Almirante Reis, 200, Lisboa",          "Força Total Gym",    "agendado",  48),

    // Quarta-feira
    svc("d07","0007", 0, 2, 8,  0, 240, "Sede BancoPrime",        "Av. da República, 77, Lisboa",            "BancoPrime SA",      "concluido", 96,  "Usar produtos aprovados pelo cliente."),
    svc("d08","0008", 1, 2, 9,  0, 120, "Loja Decoração Mundo",   "Rua do Ouro, 88, Lisboa",                 "Decoração Mundo",    "concluido", 48),
    svc("d09","0009", 2, 2, 10, 0, 180, "Apartamentos Sol",       "Rua Castilho, 14, Lisboa",                "Gestão Sol Lda",     "concluido", 72,  null, "1234*#"),

    // Quinta-feira
    svc("d10","0010", 0, 3, 8,  0, 180, "Escritórios NovaTech",   "Parque das Nações, Ed. A, Lisboa",        "NovaTech Portugal",  "concluido", 72),
    svc("d11","0011", 1, 3, 9, 30, 120, "Farmácia Central",       "Rua de Belém, 3, Lisboa",                 "Farmácia Central",   "concluido", 48),
    svc("d12","0012", 2, 3, 13, 0, 240, "Hotel Vista Mar",        "Av. de Ceuta, 1, Lisboa",                 "Vista Mar Hotel SA", "agendado",  96,  "Quartos 201-220 + Lobby"),

    // Sexta-feira
    svc("d13","0013", 0, 4, 8,  0, 240, "Centro Empresarial",     "Av. José Malhoa, 16, Lisboa",             "CE Lisboa SA",       "em_curso",  96),
    svc("d14","0014", 1, 4, 9,  0, 180, "Escola Futuro Brilhante","Rua Actor Taborda, 32, Lisboa",           "EB Futuro Brilhante","em_curso",  72,  "Salas de aula + ginásio"),
    svc("d15","0015", 2, 4, 10, 0, 120, "Armazém LogiPrime",      "Zona Industrial de Sacavém, Lote 5",      "LogiPrime SA",       "agendado",  48),
    svc("d16","0016", 0, 4, 14, 0, 180, "Boutique Renova",        "Rua Garrett, 55, Lisboa",                 "Renova Fashion",     "agendado",  72,  null, "7788"),

    // Sábado (mais leve)
    svc("d17","0017", 0, 5, 9,  0, 180, "Residencial Jardins",    "Av. Visconde de Valmor, 70, Lisboa",      "Condomínio Jardins", "agendado",  72),
    svc("d18","0018", 1, 5, 10, 0, 120, "Café Tradição",          "Rua 1 de Dezembro, 8, Lisboa",            "Café Tradição Lda",  "agendado",  48),
  ];
}

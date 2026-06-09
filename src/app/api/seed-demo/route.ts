import { type NextRequest, NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { createAdminClient } from "@/lib/supabase/admin";

// POST /api/seed-demo
// Popula dados fictícios para testes. Protegido por autenticação (admin/gestor).
export async function POST(_req: NextRequest) {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const admin = createAdminClient() as any;
  const supabase = await createClient();

  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "Não autenticado." }, { status: 401 });

  const { data: profile } = await admin
    .from("profiles")
    .select("company_id, role")
    .eq("id", user.id)
    .single();

  if (!profile || !["admin", "gestor"].includes(profile.role)) {
    return NextResponse.json({ error: "Sem permissão." }, { status: 403 });
  }

  const companyId: string = profile.company_id;
  const now = new Date();

  // ── 1. COLABORADORES (60) ────────────────────────────────────────────────────
  const COLABORADORES = [
    { name: "Ana Silva",          skills: ["Vidros", "Escritórios"],       h: 168, rate: 7.5 },
    { name: "Bruno Costa",        skills: ["Industrial", "Alta pressão"],  h: 168, rate: 7.5 },
    { name: "Carla Rodrigues",    skills: ["Carpetes", "Cozinhas"],        h: 120, rate: 7.5 },
    { name: "Diana Ferreira",     skills: ["Hospitalar", "Exterior"],      h: 168, rate: 8.0 },
    { name: "Eduardo Santos",     skills: ["Vidros", "Encerador"],         h: 80,  rate: 7.5 },
    { name: "Filipa Mendes",      skills: ["Casas de banho", "Carpetes"],  h: 168, rate: 8.0 },
    { name: "Gabriel Oliveira",   skills: ["Industrial", "Exterior"],      h: 168, rate: 7.5 },
    { name: "Helena Sousa",       skills: ["Hospitalar", "Cozinhas"],      h: 168, rate: 8.0 },
    { name: "Ivo Martins",        skills: ["Alta pressão", "Encerador"],   h: 168, rate: 7.5 },
    { name: "Joana Pereira",      skills: ["Vidros", "Escritórios"],       h: 120, rate: 7.5 },
    { name: "Kevin Alves",        skills: ["Carpetes", "Industrial"],      h: 168, rate: 7.5 },
    { name: "Lúcia Nunes",        skills: ["Exterior", "Escritórios"],     h: 168, rate: 8.0 },
    { name: "Mário Carvalho",     skills: ["Cozinhas", "Alta pressão"],    h: 168, rate: 7.5 },
    { name: "Nádia Freitas",      skills: ["Hospitalar", "Carpetes"],      h: 80,  rate: 8.0 },
    { name: "Osvaldo Pinto",      skills: ["Industrial", "Vidros"],        h: 168, rate: 7.5 },
    { name: "Paula Ribeiro",      skills: ["Escritórios", "Encerador"],    h: 168, rate: 8.0 },
    { name: "Quim Figueiredo",    skills: ["Exterior", "Alta pressão"],    h: 120, rate: 7.5 },
    { name: "Rosa Cardoso",       skills: ["Carpetes", "Cozinhas"],        h: 168, rate: 7.5 },
    { name: "Sérgio Teixeira",    skills: ["Vidros", "Hospitalar"],        h: 168, rate: 8.0 },
    { name: "Teresa Moreira",     skills: ["Escritórios", "Industrial"],   h: 168, rate: 7.5 },
    { name: "Ulisses Barros",     skills: ["Alta pressão", "Exterior"],    h: 168, rate: 7.5 },
    { name: "Vera Lopes",         skills: ["Cozinhas", "Carpetes"],        h: 80,  rate: 8.0 },
    { name: "Walter Gomes",       skills: ["Industrial", "Encerador"],     h: 168, rate: 7.5 },
    { name: "Xana Ferreira",      skills: ["Hospitalar", "Escritórios"],   h: 168, rate: 8.0 },
    { name: "Yuri Branco",        skills: ["Vidros", "Alta pressão"],      h: 120, rate: 7.5 },
    { name: "Zara Costa",         skills: ["Exterior", "Cozinhas"],        h: 168, rate: 8.0 },
    { name: "André Monteiro",     skills: ["Carpetes", "Industrial"],      h: 168, rate: 7.5 },
    { name: "Beatriz Azevedo",    skills: ["Escritórios", "Vidros"],       h: 168, rate: 7.5 },
    { name: "Carlos Duarte",      skills: ["Alta pressão", "Hospitalar"],  h: 168, rate: 8.0 },
    { name: "Daniela Santos",     skills: ["Cozinhas", "Encerador"],       h: 80,  rate: 7.5 },
    { name: "Emanuel Coelho",     skills: ["Exterior", "Carpetes"],        h: 168, rate: 7.5 },
    { name: "Francisca Lima",     skills: ["Escritórios", "Hospitalar"],   h: 168, rate: 8.0 },
    { name: "Gonçalo Matos",      skills: ["Industrial", "Vidros"],        h: 120, rate: 7.5 },
    { name: "Helena Cruz",        skills: ["Alta pressão", "Cozinhas"],    h: 168, rate: 8.0 },
    { name: "Igor Henriques",     skills: ["Carpetes", "Exterior"],        h: 168, rate: 7.5 },
    { name: "Joana Valente",      skills: ["Encerador", "Escritórios"],    h: 168, rate: 7.5 },
    { name: "Luís Pacheco",       skills: ["Hospitalar", "Industrial"],    h: 168, rate: 8.0 },
    { name: "Maria Brito",        skills: ["Vidros", "Cozinhas"],          h: 80,  rate: 7.5 },
    { name: "Nuno Correia",       skills: ["Alta pressão", "Carpetes"],    h: 168, rate: 7.5 },
    { name: "Olga Nascimento",    skills: ["Exterior", "Escritórios"],     h: 168, rate: 8.0 },
    { name: "Paulo Esteves",      skills: ["Industrial", "Encerador"],     h: 120, rate: 7.5 },
    { name: "Rute Simões",        skills: ["Hospitalar", "Vidros"],        h: 168, rate: 8.0 },
    { name: "Samuel Ramos",       skills: ["Cozinhas", "Alta pressão"],    h: 168, rate: 7.5 },
    { name: "Tânia Leite",        skills: ["Escritórios", "Carpetes"],     h: 168, rate: 7.5 },
    { name: "Uriel Vieira",       skills: ["Exterior", "Industrial"],      h: 168, rate: 8.0 },
    { name: "Vanessa Castro",     skills: ["Encerador", "Cozinhas"],       h: 80,  rate: 7.5 },
    { name: "Wilson Lourenço",    skills: ["Alta pressão", "Hospitalar"],  h: 168, rate: 7.5 },
    { name: "Xínia Pires",        skills: ["Vidros", "Carpetes"],          h: 168, rate: 8.0 },
    { name: "Yolanda Faria",      skills: ["Escritórios", "Exterior"],     h: 120, rate: 7.5 },
    { name: "Zé Antunes",         skills: ["Industrial", "Alta pressão"],  h: 168, rate: 7.5 },
    { name: "Alberto Cunha",      skills: ["Hospitalar", "Cozinhas"],      h: 168, rate: 8.0 },
    { name: "Bárbara Ferreira",   skills: ["Carpetes", "Escritórios"],     h: 168, rate: 7.5 },
    { name: "César Mendonça",     skills: ["Vidros", "Industrial"],        h: 168, rate: 7.5 },
    { name: "Dora Magalhães",     skills: ["Alta pressão", "Exterior"],    h: 80,  rate: 8.0 },
    { name: "Ernesto Vasquez",    skills: ["Encerador", "Carpetes"],       h: 168, rate: 7.5 },
    { name: "Fátima Andrade",     skills: ["Hospitalar", "Escritórios"],   h: 168, rate: 8.0 },
    { name: "Gustavo Borges",     skills: ["Industrial", "Cozinhas"],      h: 120, rate: 7.5 },
    { name: "Inês Marques",       skills: ["Vidros", "Alta pressão"],      h: 168, rate: 8.0 },
    { name: "Jacinto Rocha",      skills: ["Exterior", "Hospitalar"],      h: 168, rate: 7.5 },
    { name: "Katarina Soares",    skills: ["Cozinhas", "Carpetes"],        h: 168, rate: 7.5 },
  ];

  const colaboradorIds: string[] = [];

  for (const c of COLABORADORES) {
    const email = `${c.name.toLowerCase().normalize("NFD").replace(/[̀-ͯ]/g, "").replace(/\s+/g, ".")}.demo@placeholder.escala`;

    const { data: existing } = await admin
      .from("profiles")
      .select("id")
      .eq("email", email)
      .eq("company_id", companyId)
      .single();

    if (existing) { colaboradorIds.push(existing.id); continue; }

    const { data: authUser, error: authErr } = await admin.auth.admin.createUser({
      email,
      email_confirm: true,
      user_metadata: { company_id: companyId, role: "colaborador", full_name: c.name },
    });
    if (authErr || !authUser?.user) { colaboradorIds.push(""); continue; }

    // Aguardar trigger criar perfil (até 3 tentativas)
    let profileId: string | null = null;
    for (let attempt = 0; attempt < 3; attempt++) {
      await new Promise((r) => setTimeout(r, 600));
      const { data: p } = await admin.from("profiles").select("id").eq("id", authUser.user.id).single();
      if (p) { profileId = p.id; break; }
    }

    if (!profileId) {
      // Criar manualmente se o trigger falhou
      await admin.from("profiles").upsert({
        id: authUser.user.id,
        full_name: c.name,
        email,
        company_id: companyId,
        role: "colaborador",
        status: "ativo",
        contracted_hours_month: c.h,
        hourly_rate: c.rate,
        skills: c.skills,
      });
      colaboradorIds.push(authUser.user.id);
    } else {
      await admin.from("profiles").update({
        full_name: c.name,
        email,
        company_id: companyId,
        status: "ativo",
        contracted_hours_month: c.h,
        hourly_rate: c.rate,
        skills: c.skills,
      }).eq("id", profileId);
      colaboradorIds.push(profileId);
    }
  }

  const validColabIds = colaboradorIds.filter(Boolean);

  // ── 2. EQUIPAS (20) ──────────────────────────────────────────────────────────
  const TEAM_COLORS = [
    "#16A34A","#0EA5E9","#DC2626","#7C3AED","#EA580C",
    "#0891B2","#65A30D","#DB2777","#D97706","#4F46E5",
    "#059669","#BE123C","#1D4ED8","#B45309","#7E22CE",
    "#0F766E","#C2410C","#1E40AF","#15803D","#6D28D9",
  ];
  const TEAM_NAMES = [
    "Equipa Alpha","Equipa Beta","Equipa Gama","Equipa Delta","Equipa Épsilon",
    "Equipa Zeta","Equipa Eta","Equipa Theta","Equipa Iota","Equipa Kappa",
    "Equipa Lambda","Equipa Mi","Equipa Ni","Equipa Xi","Equipa Ómicron",
    "Equipa Pi","Equipa Rho","Equipa Sigma","Equipa Tau","Equipa Upsilon",
  ];

  const equipaIds: string[] = [];
  const membersPerTeam = 3;

  for (let ti = 0; ti < 20; ti++) {
    const name = TEAM_NAMES[ti];
    const { data: existing } = await admin
      .from("teams")
      .select("id")
      .eq("name", name)
      .eq("company_id", companyId)
      .single();

    if (existing) { equipaIds.push(existing.id); continue; }

    const startIdx = (ti * membersPerTeam) % validColabIds.length;
    const leaderId = validColabIds[startIdx] ?? null;

    const { data: team } = await admin.from("teams").insert({
      company_id: companyId,
      name,
      color: TEAM_COLORS[ti % TEAM_COLORS.length],
      active: true,
      leader_id: leaderId,
    }).select("id").single();

    if (!team) continue;
    equipaIds.push(team.id);

    const memberIds = Array.from({ length: membersPerTeam }, (_, k) =>
      validColabIds[(startIdx + k) % validColabIds.length],
    ).filter(Boolean);

    if (memberIds.length > 0) {
      await admin.from("team_members").insert(
        memberIds.map((cid: string) => ({ team_id: team.id, collaborator_id: cid }))
      );
    }
  }

  // ── 3. CLIENTES (52) + LOCAIS ────────────────────────────────────────────────
  const CLIENTES = [
    // Lisboa
    { name: "Edifício Marquês",         nif: "501234567", email: "geral@marques.pt",        phone: "213 456 789", city: "Lisboa",   locs: [{ n: "Piso 1 — Escritórios",    addr: "Av. Marquês de Pombal 1, Lisboa",       lat: 38.7252, lng: -9.1497, area: 450, rate: 18 }, { n: "Piso 2 — Reunião",       addr: "Av. Marquês de Pombal 1, Lisboa",       lat: 38.7252, lng: -9.1497, area: 200, rate: 18 }] },
    { name: "Clínica Saúde Total",       nif: "509876543", email: "admin@saudetotal.pt",     phone: "214 567 890", city: "Lisboa",   locs: [{ n: "Recepção e Espera",          addr: "Rua Augusta 120, Lisboa",               lat: 38.7099, lng: -9.1378, area: 180, rate: 22 }, { n: "Consultórios",           addr: "Rua Augusta 120, Lisboa",               lat: 38.7099, lng: -9.1378, area: 300, rate: 22 }] },
    { name: "Hotel Bela Vista",          nif: "508765432", email: "manutencao@belavista.pt", phone: "213 789 012", city: "Lisboa",   locs: [{ n: "Quartos Piso 1-3",           addr: "Av. da Liberdade 200, Lisboa",          lat: 38.7183, lng: -9.1470, area: 1200, rate: 20 }, { n: "Restaurante e Bar",      addr: "Av. da Liberdade 200, Lisboa",          lat: 38.7183, lng: -9.1470, area: 400, rate: 20 }] },
    { name: "Torre Empresarial Oriente", nif: "502345678", email: "facility@torreaoriente.pt",phone: "218 900 100",city: "Lisboa",   locs: [{ n: "Pisos 1-5",                  addr: "Av. D. João II 30, Lisboa",             lat: 38.7634, lng: -9.0948, area: 2800, rate: 16 }, { n: "Pisos 6-10",             addr: "Av. D. João II 30, Lisboa",             lat: 38.7634, lng: -9.0948, area: 2800, rate: 16 }] },
    { name: "Centro Comercial Vasco",    nif: "504567890", email: "ops@ccvasco.pt",           phone: "218 923 400", city: "Lisboa",   locs: [{ n: "Zona Alimentar",             addr: "Av. D. João II 40, Lisboa",             lat: 38.7601, lng: -9.0929, area: 600, rate: 19 }, { n: "WCs e Zonas Comuns",     addr: "Av. D. João II 40, Lisboa",             lat: 38.7601, lng: -9.0929, area: 350, rate: 19 }] },
    { name: "Ginásio FitLife",           nif: "503678901", email: "geral@fitlife.pt",         phone: "213 456 111", city: "Lisboa",   locs: [{ n: "Sala Musculação",            addr: "Rua Braamcamp 9, Lisboa",               lat: 38.7226, lng: -9.1492, area: 350, rate: 17 }] },
    { name: "Escola Colombo",            nif: "505789012", email: "adm@escolacolombo.pt",    phone: "217 123 456", city: "Lisboa",   locs: [{ n: "Salas de Aula (1-20)",       addr: "Rua de Entrecampos 4, Lisboa",          lat: 38.7461, lng: -9.1490, area: 800, rate: 15 }, { n: "Refeitório e Pátio",     addr: "Rua de Entrecampos 4, Lisboa",          lat: 38.7461, lng: -9.1490, area: 400, rate: 14 }] },
    { name: "Banco Capital Lisboa",      nif: "506890123", email: "facilities@bancocap.pt",  phone: "210 500 000", city: "Lisboa",   locs: [{ n: "Sede — Pisos 1-8",           addr: "Rua Castilho 20, Lisboa",               lat: 38.7237, lng: -9.1543, area: 3200, rate: 22 }] },
    // Porto
    { name: "Supermercado Freitas",      nif: "503456789", email: "geral@freitas.pt",        phone: "265 123 456", city: "Porto",    locs: [{ n: "Loja Almada",               addr: "Av. 25 de Abril 45, Almada",           lat: 38.6764, lng: -9.1659, area: 800, rate: 15 }, { n: "Loja Setúbal",           addr: "Rua do Comércio 8, Setúbal",           lat: 38.5243, lng: -8.8941, area: 650, rate: 15 }] },
    { name: "Porto Business Hub",        nif: "507123456", email: "ops@pbhub.pt",            phone: "222 345 678", city: "Porto",    locs: [{ n: "Escritórios A",              addr: "Av. dos Aliados 50, Porto",             lat: 41.1482, lng: -8.6096, area: 1200, rate: 17 }, { n: "Escritórios B",          addr: "Av. dos Aliados 50, Porto",             lat: 41.1482, lng: -8.6096, area: 1000, rate: 17 }] },
    { name: "Clínica NovaSaúde Porto",   nif: "508234567", email: "admin@novasaude.pt",      phone: "222 567 890", city: "Porto",    locs: [{ n: "Clínica Principal",          addr: "Rua de Santa Catarina 10, Porto",       lat: 41.1499, lng: -8.6096, area: 500, rate: 23 }] },
    { name: "Hotel Maravilha Porto",     nif: "509345678", email: "facility@maravilha.pt",   phone: "222 789 000", city: "Porto",    locs: [{ n: "Quartos 1-50",               addr: "Rua do Infante D. Henrique 1, Porto",   lat: 41.1407, lng: -8.6144, area: 1500, rate: 21 }, { n: "Spa e Piscina",          addr: "Rua do Infante D. Henrique 1, Porto",   lat: 41.1407, lng: -8.6144, area: 400, rate: 21 }] },
    { name: "Faculdade Norte",           nif: "501456789", email: "manut@facnorte.pt",       phone: "225 082 000", city: "Porto",    locs: [{ n: "Pavilhão A",                 addr: "Via Panorâmica s/n, Porto",             lat: 41.1740, lng: -8.5944, area: 2000, rate: 13 }, { n: "Biblioteca",             addr: "Via Panorâmica s/n, Porto",             lat: 41.1740, lng: -8.5944, area: 600, rate: 13 }] },
    { name: "Centro Saúde Bonfim",       nif: "502567890", email: "cs@bonfim.minsaude.pt",  phone: "222 005 600", city: "Porto",    locs: [{ n: "Consultas e Urgência",       addr: "Rua de Costa Cabral 100, Porto",        lat: 41.1531, lng: -8.5962, area: 700, rate: 20 }] },
    // Braga
    { name: "Shopping Braga Parque",     nif: "503567890", email: "ops@bragaparque.pt",      phone: "253 300 100", city: "Braga",    locs: [{ n: "Piso 0 — Hipermercado",      addr: "Rua 31 de Janeiro, Braga",              lat: 41.5460, lng: -8.4268, area: 3000, rate: 14 }, { n: "Piso 1 — Lojas",         addr: "Rua 31 de Janeiro, Braga",              lat: 41.5460, lng: -8.4268, area: 2000, rate: 14 }] },
    { name: "Hospital Privado Braga",    nif: "504678901", email: "facilities@hpbraga.pt",   phone: "253 604 000", city: "Braga",    locs: [{ n: "Urgência e Internamento",    addr: "Rua dos Frieiros, Braga",               lat: 41.5320, lng: -8.4220, area: 2500, rate: 24 }, { n: "Bloco Operatório",       addr: "Rua dos Frieiros, Braga",               lat: 41.5320, lng: -8.4220, area: 800, rate: 26 }] },
    { name: "Escola Primária Braga",     nif: "505789013", email: "adm@epbraga.edu.pt",      phone: "253 200 300", city: "Braga",    locs: [{ n: "Salas de Aula",              addr: "Av. Central 5, Braga",                  lat: 41.5507, lng: -8.4279, area: 600, rate: 14 }] },
    { name: "Braga Towers",              nif: "506890124", email: "condominio@bragatowers.pt",phone: "253 450 000",city: "Braga",    locs: [{ n: "Torre A — Pisos 1-15",       addr: "Av. da Liberdade 100, Braga",           lat: 41.5495, lng: -8.4264, area: 4000, rate: 16 }, { n: "Torre B — Pisos 1-15",   addr: "Av. da Liberdade 100, Braga",           lat: 41.5495, lng: -8.4264, area: 4000, rate: 16 }] },
    // Coimbra
    { name: "Universidade Coimbra Labs", nif: "507901235", email: "manut@uc.pt",             phone: "239 800 000", city: "Coimbra",  locs: [{ n: "Laboratórios Dep. Física",   addr: "R. Larga, Coimbra",                     lat: 40.2088, lng: -8.4285, area: 900, rate: 16 }, { n: "Biblioteca Geral",       addr: "R. Larga, Coimbra",                     lat: 40.2088, lng: -8.4285, area: 1200, rate: 14 }] },
    { name: "Hospital UC",               nif: "508012346", email: "facility@huc.pt",         phone: "239 400 400", city: "Coimbra",  locs: [{ n: "Enfermarias 1-4",            addr: "Praceta Mota Pinto, Coimbra",           lat: 40.1878, lng: -8.4134, area: 3000, rate: 22 }] },
    { name: "Coimbra Business Center",   nif: "509123457", email: "ops@cbcenter.pt",         phone: "239 850 200", city: "Coimbra",  locs: [{ n: "Escritórios (2 pisos)",      addr: "Av. Emídio Navarro 1, Coimbra",         lat: 40.2051, lng: -8.4175, area: 1400, rate: 17 }] },
    // Algarve
    { name: "Hotel Sol Algarve",         nif: "501234568", email: "ops@solalgarve.pt",       phone: "289 400 100", city: "Faro",     locs: [{ n: "Quartos (120 unid.)",        addr: "Av. dos Descobrimentos 22, Portimão",   lat: 37.1363, lng: -8.5369, area: 2400, rate: 21 }, { n: "Piscinas e Exterior",    addr: "Av. dos Descobrimentos 22, Portimão",   lat: 37.1363, lng: -8.5369, area: 1800, rate: 18 }] },
    { name: "Quinta do Lago Resort",     nif: "502345679", email: "manut@quintalago.pt",     phone: "289 390 700", city: "Faro",     locs: [{ n: "Villas A-F",                 addr: "Quinta do Lago, Almancil",              lat: 37.0639, lng: -8.0124, area: 3000, rate: 25 }] },
    { name: "Marina de Vilamoura",       nif: "503456780", email: "facility@vilamoura.pt",   phone: "289 300 000", city: "Faro",     locs: [{ n: "Escritórios da Marina",      addr: "Marina de Vilamoura, Loulé",            lat: 37.0716, lng: -8.1220, area: 500, rate: 20 }] },
    { name: "Clínica Faro Saúde",        nif: "504567891", email: "admin@farosaude.pt",      phone: "289 898 900", city: "Faro",     locs: [{ n: "Clínica Principal",          addr: "Rua Dr. Justino Cúmano 1, Faro",        lat: 37.0147, lng: -7.9328, area: 600, rate: 22 }] },
    { name: "Aeroporto Faro Facilities", nif: "505678902", email: "ops@fao.pt",              phone: "289 800 800", city: "Faro",     locs: [{ n: "Terminal Principal",         addr: "Aeroporto de Faro, Faro",               lat: 37.0144, lng: -7.9659, area: 8000, rate: 19 }] },
    // Setúbal / Almada
    { name: "NovaMed Setúbal",           nif: "506789013", email: "geral@novamed.pt",        phone: "265 525 000", city: "Setúbal",  locs: [{ n: "Clínica",                    addr: "Av. 22 de Dezembro 1, Setúbal",         lat: 38.5240, lng: -8.8938, area: 700, rate: 21 }] },
    { name: "Almada Forum Operations",   nif: "507890124", email: "ops@almadaforum.pt",      phone: "212 757 700", city: "Almada",   locs: [{ n: "Piso 0 + 1",                 addr: "Av. 25 de Abril, Almada",               lat: 38.6825, lng: -9.1701, area: 4000, rate: 16 }] },
    { name: "Palmela Logística SA",      nif: "508901235", email: "manut@palmelalog.pt",     phone: "265 990 000", city: "Palmela",  locs: [{ n: "Armazém Principal",          addr: "Zona Ind. Palmela, Palmela",            lat: 38.5618, lng: -8.8999, area: 5000, rate: 13 }] },
    // Cascais / Sintra
    { name: "Cascais Marina Club",       nif: "509012346", email: "facility@cascaismarina.pt",phone: "214 826 000",city: "Cascais",  locs: [{ n: "Clube e Restaurante",        addr: "Marina de Cascais, Cascais",            lat: 38.6957, lng: -9.4221, area: 1200, rate: 22 }] },
    { name: "Palácio Seteais",           nif: "501123457", email: "ops@seteais.pt",          phone: "219 233 200", city: "Sintra",   locs: [{ n: "Instalações Principais",     addr: "Rua Barbosa du Bocage 8, Sintra",       lat: 38.7944, lng: -9.3945, area: 2500, rate: 25 }] },
    { name: "Cascais Business Park",     nif: "502234568", email: "facility@cbpark.pt",      phone: "214 800 300", city: "Cascais",  locs: [{ n: "Edifício A",                 addr: "Rua do Clube dos Galitos, Cascais",     lat: 38.6971, lng: -9.4261, area: 1600, rate: 18 }] },
    // Aveiro / Viseu
    { name: "Fórum Aveiro",              nif: "503345679", email: "ops@forumaveiro.pt",      phone: "234 400 300", city: "Aveiro",   locs: [{ n: "Piso 0",                     addr: "R. Batalhão Caçadores 10, Aveiro",      lat: 40.6443, lng: -8.6455, area: 3500, rate: 15 }] },
    { name: "Hospital Aveiro",           nif: "504456780", email: "manut@haveiro.pt",        phone: "234 378 300", city: "Aveiro",   locs: [{ n: "Internamento e Urgência",    addr: "Av. Artur Ravara, Aveiro",              lat: 40.6454, lng: -8.6530, area: 4000, rate: 23 }] },
    { name: "Viseu Faz Bem",             nif: "505567891", email: "geral@viseufb.pt",        phone: "232 484 000", city: "Viseu",    locs: [{ n: "Loja Principal",             addr: "Av. António José de Almeida, Viseu",    lat: 40.6547, lng: -7.9139, area: 900, rate: 16 }] },
    // Évora / Alentejo
    { name: "Herdade do Freixo",         nif: "506678902", email: "ops@hfreixo.pt",          phone: "266 700 100", city: "Évora",    locs: [{ n: "Instalações Agroindustriais",addr: "Estrada Nacional 114, Évora",           lat: 38.5718, lng: -8.0008, area: 3000, rate: 14 }] },
    { name: "Évora Hotel Arts",          nif: "507789013", email: "facility@ehotelarts.pt",  phone: "266 748 000", city: "Évora",    locs: [{ n: "Hotel Completo",             addr: "Largo Conde Vila Flor, Évora",          lat: 38.5712, lng: -7.9075, area: 2000, rate: 22 }] },
    // Leiria / Caldas
    { name: "Leiria Shopping",           nif: "508890124", email: "ops@leiriopping.pt",      phone: "244 839 200", city: "Leiria",   locs: [{ n: "Todo o Espaço",              addr: "Rua Mestre de Avis, Leiria",            lat: 39.7432, lng: -8.8071, area: 5000, rate: 15 }] },
    { name: "Caldas Termal",             nif: "509901235", email: "manut@caldastermal.pt",   phone: "262 830 000", city: "Caldas",   locs: [{ n: "Termas e Balneários",        addr: "Praça da República, Caldas da Rainha",  lat: 39.4072, lng: -9.1352, area: 1500, rate: 18 }] },
    // Santarém / Tomar
    { name: "Auchan Santarém",           nif: "501234570", email: "ops@auchansan.pt",        phone: "243 300 100", city: "Santarém", locs: [{ n: "Hipermercado",               addr: "Av. Bernardo Santareno, Santarém",      lat: 39.2362, lng: -8.6849, area: 6000, rate: 14 }] },
    { name: "Hotel dos Templários",      nif: "502345681", email: "facility@templar.pt",     phone: "249 321 730", city: "Tomar",    locs: [{ n: "Hotel (100 quartos)",        addr: "Largo Cândido dos Reis 1, Tomar",       lat: 39.6044, lng: -8.4124, area: 2200, rate: 20 }] },
    // Viana / Guimarães
    { name: "Viana Hotel Axis",          nif: "503456792", email: "ops@axisvc.pt",           phone: "258 800 900", city: "Viana",    locs: [{ n: "Hotel Completo",             addr: "Av. Corgo 14, Viana do Castelo",        lat: 41.6973, lng: -8.8289, area: 1800, rate: 20 }] },
    { name: "Guimarães Tech Park",       nif: "504567903", email: "facility@gtechpark.pt",   phone: "253 510 200", city: "Guimarães",locs: [{ n: "Edifícios 1-3",             addr: "Rua de S. Gualter, Guimarães",          lat: 41.4425, lng: -8.2951, area: 2400, rate: 16 }] },
    { name: "Braga Norte Logistics",     nif: "505679014", email: "manut@bnlog.pt",          phone: "253 600 700", city: "Braga",    locs: [{ n: "Armazém A",                  addr: "Parque Ind. Celeirós, Braga",           lat: 41.5887, lng: -8.3951, area: 4500, rate: 13 }] },
    // Mais Lisboa/Porto
    { name: "Data Center TechCity",      nif: "506790125", email: "ops@techcity.pt",         phone: "210 100 200", city: "Lisboa",   locs: [{ n: "Sala Servidores + Corredores", addr: "Rua Alfredo da Silva, Barreiro",       lat: 38.6653, lng: -9.0714, area: 2000, rate: 20 }] },
    { name: "Museu Nacional Lisboa",     nif: "507801236", email: "manut@mnlisboa.pt",       phone: "213 420 000", city: "Lisboa",   locs: [{ n: "Galerias + Reservas",        addr: "Rua das Janelas Verdes, Lisboa",        lat: 38.7040, lng: -9.1614, area: 3500, rate: 17 }] },
    { name: "Estádio Nacional",          nif: "508912347", email: "facility@estadionac.pt",  phone: "214 267 000", city: "Lisboa",   locs: [{ n: "Camarotes + Vestiários",     addr: "Av. Pierre de Coubertin, Oeiras",       lat: 38.7268, lng: -9.2434, area: 5000, rate: 16 }] },
    { name: "Porto Convention Centre",   nif: "509023458", email: "ops@pcc.pt",              phone: "220 102 500", city: "Porto",    locs: [{ n: "Salas A-F + Halls",          addr: "Rua de Diu 50, Porto",                  lat: 41.1862, lng: -8.6923, area: 6000, rate: 18 }] },
    { name: "Farmácias Nova Era",        nif: "501234569", email: "geral@novaera.pt",        phone: "211 500 100", city: "Lisboa",   locs: [{ n: "Central de Distribuição",    addr: "Zona Ind. Alverca, Alverca",            lat: 38.9002, lng: -9.0299, area: 3000, rate: 15 }] },
    { name: "Logística Ibérica SA",      nif: "502346790", email: "ops@logiberia.pt",        phone: "219 360 000", city: "Lisboa",   locs: [{ n: "Hub Lisboa",                 addr: "Parque Ind. Linhó, Sintra",             lat: 38.7891, lng: -9.3591, area: 8000, rate: 13 }] },
    { name: "Clínica Cascais Premium",   nif: "503458901", email: "admin@ccpremium.pt",      phone: "214 845 200", city: "Cascais",  locs: [{ n: "Clínica",                    addr: "Rua Padre Moisés da Silva 1, Cascais",  lat: 38.6977, lng: -9.4227, area: 700, rate: 24 }] },
    { name: "Resort Comporta Villas",    nif: "504560012", email: "ops@comportavillas.pt",   phone: "269 497 000", city: "Setúbal",  locs: [{ n: "Villas + Piscinas",          addr: "Herdade da Comporta, Alcácer do Sal",   lat: 38.3832, lng: -8.7742, area: 4000, rate: 26 }] },
    { name: "Academia Sporting Alcochete",nif:"505672123", email: "facility@sporting.pt",   phone: "212 600 600", city: "Alcochete",locs: [{ n: "Balneários e Relvado",        addr: "Academia Sporting, Alcochete",          lat: 38.7455, lng: -8.9632, area: 6000, rate: 18 }] },
    { name: "Autoestradas Norte",        nif: "506784234", email: "ops@autonorte.pt",        phone: "225 190 400", city: "Porto",    locs: [{ n: "Área de Serviço Norte",      addr: "A1 Km 295, Porto",                      lat: 41.3603, lng: -8.7490, area: 800, rate: 16 }] },
    { name: "InovFarm Biotec",           nif: "507896345", email: "manut@inovfarm.pt",       phone: "239 499 800", city: "Coimbra",  locs: [{ n: "Laboratórios Biotec",        addr: "Parque Tecnológico de Cantanhede",       lat: 40.3425, lng: -8.6005, area: 1200, rate: 21 }] },
  ];

  const locationIds: string[] = [];
  const clientIds: string[] = [];
  const clientRates: number[] = [];

  for (const cl of CLIENTES) {
    let clientId: string;
    const { data: existing } = await admin
      .from("clients")
      .select("id")
      .eq("name", cl.name)
      .eq("company_id", companyId)
      .single();

    if (existing) {
      clientId = existing.id;
    } else {
      const { data: nc } = await admin.from("clients").insert({
        company_id: companyId,
        name: cl.name, nif: cl.nif, email: cl.email, phone: cl.phone,
        status: "ativo", type: "empresa",
      }).select("id").single();
      if (!nc) continue;
      clientId = nc.id;
    }
    clientIds.push(clientId);

    for (const loc of cl.locs) {
      clientRates.push(loc.rate);
      const { data: el } = await admin.from("locations").select("id").eq("name", loc.n).eq("client_id", clientId).single();
      if (el) { locationIds.push(el.id); continue; }

      const { data: nl } = await admin.from("locations").insert({
        company_id: companyId,
        client_id: clientId,
        name: loc.n, address: loc.addr, lat: loc.lat, lng: loc.lng,
        area_sqm: loc.area, hourly_rate: loc.rate, active: true,
      }).select("id").single();
      if (nl) locationIds.push(nl.id);
    }
  }

  // ── 4. CONTRATOS (30) ────────────────────────────────────────────────────────
  const contractsInserted: number[] = [];
  for (let li = 0; li < Math.min(locationIds.length, 30); li++) {
    const locId = locationIds[li];
    if (!locId) continue;
    const freq = li % 3 === 0 ? "weekly" : li % 3 === 1 ? "biweekly" : "monthly";
    const weekdays = freq === "monthly" ? null : (li % 2 === 0 ? [1, 4] : [2, 5]);
    const name = `Contrato ${li + 1}`;
    const { data: ec } = await admin.from("contracts").select("id").eq("name", name).eq("company_id", companyId).single();
    if (ec) { contractsInserted.push(li); continue; }
    await admin.from("contracts").insert({
      company_id: companyId,
      location_id: locId,
      name,
      frequency: freq,
      weekdays,
      interval_days: freq === "weekly" ? 7 : freq === "biweekly" ? 14 : 30,
      schedule_days: [{ day: "mon", start: "08:00", end: "11:00" }],
      starts_on: offsetDate(now, -90),
      ends_on: null,
      status: "ativo",
      created_by: user.id,
    });
    contractsInserted.push(li);
  }

  // ── 5. SERVIÇOS (90 dias × 3-5 serviços/dia) ─────────────────────────────────
  let serviceRef = 1000;
  let servicesCreated = 0;
  const serviceIds: string[] = [];

  for (let daysAgo = 88; daysAgo >= -7; daysAgo--) {
    const serviceDate = new Date(now);
    serviceDate.setDate(serviceDate.getDate() - daysAgo);
    const dayOfWeek = serviceDate.getDay();
    if (dayOfWeek === 0) continue;
    const numServices = dayOfWeek === 6 ? 2 : 4 + (serviceRef % 2);

    for (let si = 0; si < numServices; si++) {
      const teamId = equipaIds[si % equipaIds.length];
      const locIdx = (servicesCreated + si * 7) % locationIds.length;
      const locId = locationIds[locIdx];
      if (!teamId || !locId) continue;

      const startHour = 7 + (si % 4) * 3;
      const start = new Date(serviceDate);
      start.setHours(startHour, 0, 0, 0);
      const end = new Date(start);
      end.setHours(startHour + 2, 30, 0, 0);

      const isPast = daysAgo > 0;
      const isFuture = daysAgo < 0;
      const rand = Math.random();
      let status = "agendado";
      if (isPast) status = rand < 0.80 ? "concluido" : rand < 0.91 ? "cancelado" : "falta";
      if (isFuture) status = "agendado";

      const actualStart = status === "concluido"
        ? new Date(start.getTime() + Math.floor(Math.random() * 10) * 60000)
        : null;
      const actualEnd = status === "concluido"
        ? new Date(end.getTime() + Math.floor((Math.random() - 0.4) * 20) * 60000)
        : null;

      const rate = clientRates[locIdx] ?? 16;

      const { data: svc } = await admin.from("services").insert({
        company_id: companyId,
        location_id: locId,
        team_id: teamId,
        reference_number: `#${String(serviceRef++).padStart(5, "0")}`,
        scheduled_start: start.toISOString(),
        scheduled_end: end.toISOString(),
        hourly_rate: rate,
        calculated_value: Math.round(rate * 2.5 * 100) / 100,
        status,
        actual_start: actualStart?.toISOString() ?? null,
        actual_end:   actualEnd?.toISOString()   ?? null,
      }).select("id").single();

      if (svc) {
        serviceIds.push(svc.id);
        if (status === "concluido" && validColabIds.length > 0) {
          const cIdx = (si * 5 + servicesCreated) % validColabIds.length;
          const dur = actualEnd && actualStart
            ? Math.round((actualEnd.getTime() - actualStart.getTime()) / 60000)
            : 150;
          await admin.from("timesheets").upsert({
            company_id: companyId,
            service_id: svc.id,
            collaborator_id: validColabIds[cIdx],
            clock_in_at: actualStart?.toISOString(),
            clock_out_at: actualEnd?.toISOString(),
            duration_minutes: dur,
          }, { onConflict: "service_id,collaborator_id" });
        }
      }
      servicesCreated++;
    }
  }

  // ── 6. FATURAS (últimos 3 meses, todos clientes) ─────────────────────────────
  const year = now.getFullYear();
  const month = now.getMonth() + 1;
  const invoiceMonths = [
    { y: month >= 3 ? year : year - 1, m: month >= 3 ? month - 2 : 10 + month, status: "pago" as const },
    { y: month >= 2 ? year : year - 1, m: month >= 2 ? month - 1 : 11 + month, status: "pago" as const },
    { y: year, m: month, status: "pendente" as const },
  ];

  for (const period of invoiceMonths) {
    for (let ci = 0; ci < clientIds.length; ci++) {
      const clientId = clientIds[ci];
      if (!clientId) continue;
      const invoiceNum = `F${period.y}/${String(ci * 10 + period.m).padStart(4, "0")}`;
      const { data: ei } = await admin.from("invoices").select("id").eq("invoice_number", invoiceNum).eq("company_id", companyId).single();
      if (ei) continue;
      const subtotal = 800 + ci * 80 + Math.floor(Math.random() * 400);
      const vatAmount = Math.round(subtotal * 0.23);
      const total = subtotal + vatAmount;
      const paidAt = period.status === "pago"
        ? new Date(period.y, period.m, 5).toISOString()
        : null;
      const { data: inv } = await admin.from("invoices").insert({
        company_id: companyId,
        client_id: clientId,
        invoice_number: invoiceNum,
        invoice_date: `${period.y}-${String(period.m).padStart(2, "0")}-01`,
        due_date: new Date(period.y, period.m, 0).toISOString().split("T")[0],
        period_start: `${period.y}-${String(period.m).padStart(2, "0")}-01`,
        period_end: new Date(period.y, period.m, 0).toISOString().split("T")[0],
        subtotal, vat_rate: 23, vat_amount: vatAmount, total,
        status: period.status, paid_at: paidAt,
        payment_method: paidAt ? "transferencia" : null, notes: null,
      }).select("id").single();
      if (inv) {
        await admin.from("invoice_items").insert([
          { invoice_id: inv.id, service_id: null, description: "Serviços de limpeza — mão de obra", quantity: 1, unit_price: Math.round(subtotal * 0.7), total: Math.round(subtotal * 0.7), sort_order: 1 },
          { invoice_id: inv.id, service_id: null, description: "Produtos e consumíveis", quantity: 1, unit_price: Math.round(subtotal * 0.2), total: Math.round(subtotal * 0.2), sort_order: 2 },
          { invoice_id: inv.id, service_id: null, description: "Deslocações", quantity: 1, unit_price: Math.round(subtotal * 0.1), total: Math.round(subtotal * 0.1), sort_order: 3 },
        ]);
      }
    }
  }

  // ── 7. FOLHA DE PAGAMENTO (2 meses) ──────────────────────────────────────────
  const payrollMonths = [
    { y: month >= 3 ? year : year - 1, m: month >= 3 ? month - 2 : 10 + month, status: "pago" as const },
    { y: month >= 2 ? year : year - 1, m: month >= 2 ? month - 1 : 11 + month, status: "aprovado" as const },
  ];
  for (const period of payrollMonths) {
    for (let ci = 0; ci < Math.min(COLABORADORES.length, validColabIds.length); ci++) {
      const collabId = validColabIds[ci];
      if (!collabId) continue;
      const { data: ep } = await admin.from("payroll_records").select("id").eq("collaborator_id", collabId).eq("period_year", period.y).eq("period_month", period.m).single();
      if (ep) continue;
      const contracted = COLABORADORES[ci]?.h ?? 168;
      const rate = COLABORADORES[ci]?.rate ?? 7.5;
      const worked = Math.max(contracted - Math.floor(Math.random() * 10), contracted - 16);
      const overtime = Math.floor(Math.random() * 12);
      const absence = Math.floor(Math.random() * 8);
      const daysWorked = Math.floor(worked / 8);
      const gross = Math.round((worked * rate + overtime * rate * 1.25) * 100) / 100;
      const meal = daysWorked * 5.2;
      const net = Math.round((gross + meal) * 100) / 100;
      await admin.from("payroll_records").insert({
        company_id: companyId, collaborator_id: collabId,
        period_year: period.y, period_month: period.m,
        contracted_hours: contracted, worked_hours: worked,
        overtime_hours: overtime, absence_hours: absence,
        days_worked: daysWorked, hourly_rate: rate,
        gross_salary: gross, meal_allowance: meal,
        overtime_bonus: Math.round(overtime * rate * 0.25 * 100) / 100,
        absence_deductions: 0, other_deductions: 0, other_additions: 0,
        net_salary: net, notes: null,
        status: period.status,
        paid_at: period.status === "pago" ? new Date(period.y, period.m, 8).toISOString() : null,
      });
    }
  }

  // ── 8. CASH FLOW ─────────────────────────────────────────────────────────────
  const cashFlow = [
    { desc: "Fornecedor LimpPro — Fev",     amount: 2400,  type: "saida",   cat: "fornecedor", date: offsetDate(now, -55) },
    { desc: "Combustíveis — Fevereiro",     amount: 1200,  type: "saida",   cat: "despesa",    date: offsetDate(now, -50) },
    { desc: "Seguros Frota 2024",           amount: 3800,  type: "saida",   cat: "despesa",    date: offsetDate(now, -48) },
    { desc: "Aluguer Equipamentos",         amount: 1600,  type: "saida",   cat: "despesa",    date: offsetDate(now, -45) },
    { desc: "Pagamentos Clientes — Fev",    amount: 42000, type: "entrada", cat: "faturacao",  date: offsetDate(now, -40) },
    { desc: "Fornecedor LimpPro — Mar",     amount: 2350,  type: "saida",   cat: "fornecedor", date: offsetDate(now, -25) },
    { desc: "Combustíveis — Março",         amount: 1180,  type: "saida",   cat: "despesa",    date: offsetDate(now, -20) },
    { desc: "Manutenção Viaturas",          amount: 1400,  type: "saida",   cat: "despesa",    date: offsetDate(now, -18) },
    { desc: "Material EPI (Abril)",         amount: 680,   type: "saida",   cat: "fornecedor", date: offsetDate(now, -15) },
    { desc: "Pagamentos Clientes — Mar",    amount: 47500, type: "entrada", cat: "faturacao",  date: offsetDate(now, -10) },
    { desc: "Salários Março",               amount: 38000, type: "saida",   cat: "salario",    date: offsetDate(now, -8)  },
    { desc: "Fornecedor CleanMax — Abr",    amount: 2100,  type: "saida",   cat: "fornecedor", date: offsetDate(now, -5)  },
    { desc: "Combustíveis — Abril",         amount: 1250,  type: "saida",   cat: "despesa",    date: offsetDate(now, -3)  },
    { desc: "Rendimento extra — Formações", amount: 1800,  type: "entrada", cat: "outro",      date: offsetDate(now, -2)  },
  ];

  for (const e of cashFlow) {
    const { data: ex } = await admin.from("cash_flow_entries").select("id").eq("description", e.desc).eq("company_id", companyId).single();
    if (ex) continue;
    await admin.from("cash_flow_entries").insert({
      company_id: companyId,
      type: e.type, amount: e.amount, description: e.desc,
      category: e.cat, status: "confirmado", date: e.date, created_by: user.id,
    });
  }

  // ── 9. TAREFAS KANBAN (20) ───────────────────────────────────────────────────
  const tarefas = [
    { title: "Renovar contrato Hotel Bela Vista",          body: "Contrato termina em Agosto. Agendar reunião com o responsável.",               status: "pendente",  priority: "urgente", daysAgo: 2  },
    { title: "Contratar 5 colaboradores para a época alta", body: "Verão: reforço para Algarve e Lisboa (Junho–Setembro).",                      status: "pendente",  priority: "urgente", daysAgo: 1  },
    { title: "Auditoria de qualidade Clínica Saúde Total",  body: "Cliente pediu relatório de qualidade mensal dos serviços.",                   status: "pendente",  priority: "normal",  daysAgo: 4  },
    { title: "Comprar 10 aspiradores industriais",          body: "Substituir os equipamentos com mais de 3 anos. Orçamento máximo: 8.000€.",    status: "pendente",  priority: "normal",  daysAgo: 5  },
    { title: "Formação de Segurança e Higiene",             body: "Obrigatória para todos. Marcar para o final do mês.",                        status: "em_curso",  priority: "normal",  daysAgo: 3  },
    { title: "Actualizar fichas de EPI de 12 colaboradores",body: null,                                                                          status: "em_curso",  priority: "normal",  daysAgo: 2  },
    { title: "Renegociar preço fornecedor LimpPro",         body: "Orçamento vencido. Pedir desconto de volume — volume anual +40%.",            status: "em_curso",  priority: "urgente", daysAgo: 6  },
    { title: "Verificar certificados das 3 viaturas",       body: "IPO e seguros vencem no próximo mês.",                                        status: "em_curso",  priority: "urgente", daysAgo: 5  },
    { title: "Criar folha de rota semanal Equipa Alpha",    body: null,                                                                          status: "em_curso",  priority: "normal",  daysAgo: 1  },
    { title: "Instalar QR Code check-in nas 5 clínicas",   body: "Testar na Clínica Saúde Total antes de replicar.",                            status: "em_curso",  priority: "normal",  daysAgo: 7  },
    { title: "Enviar relatório anual a todos os clientes",  body: "Resumo de serviços prestados, horas, e satisfação. Prazo: fim do mês.",       status: "pendente",  priority: "urgente", daysAgo: 0  },
    { title: "Implementar app de registo de ponto",         body: "Avaliar soluções: Clockify, Factorial, ou desenvolvimento próprio.",          status: "pendente",  priority: "normal",  daysAgo: 3  },
    { title: "Renovar seguro de responsabilidade civil",    body: "Apólice vence no dia 30. Contactar corretor.",                               status: "pendente",  priority: "urgente", daysAgo: 1  },
    { title: "Rever distribuição de equipas por zona",      body: "Com 20 equipas, redistribuir por Lisboa Norte, Sul, Porto, e Braga.",         status: "pendente",  priority: "normal",  daysAgo: 2  },
    { title: "Preparar apresentação para novo cliente",     body: "Porto Convention Centre — reunião na próxima semana.",                        status: "pendente",  priority: "normal",  daysAgo: 0  },
    { title: "Relatório de qualidade Q1 2024",              body: "Compilar dados de satisfação e KPIs do 1º trimestre.",                       status: "concluido", priority: "normal",  daysAgo: 15 },
    { title: "Criação de folha de rota Q1",                 body: "Concluído e distribuído a todas as equipas.",                                status: "concluido", priority: "normal",  daysAgo: 20 },
    { title: "Renovação contrato Supermercado Freitas",     body: "Assinado com aumento de 5% e cobertura 2 novas lojas.",                      status: "concluido", priority: "urgente", daysAgo: 12 },
    { title: "Formação de produtos químicos",               body: "Formação concluída para 22 colaboradores.",                                  status: "concluido", priority: "normal",  daysAgo: 25 },
    { title: "Implementar sistema GPS nas viaturas",        body: "GPS instalado nas 3 viaturas. Monitorização activa.",                        status: "concluido", priority: "normal",  daysAgo: 30 },
  ];

  for (const t of tarefas) {
    const { data: et } = await admin.from("management_tasks").select("id").eq("title", t.title).eq("company_id", companyId).single();
    if (et) continue;
    const createdAt = new Date(now);
    createdAt.setDate(createdAt.getDate() - t.daysAgo);
    await admin.from("management_tasks").insert({
      company_id: companyId,
      title: t.title, body: t.body, status: t.status, priority: t.priority,
      assigned_to: validColabIds[Math.floor(Math.random() * Math.min(validColabIds.length, 5))] ?? null,
      due_date: t.status !== "concluido" ? offsetDate(now, 7 + Math.floor(Math.random() * 21)) : null,
      created_by: user.id,
      completed_at: t.status === "concluido" ? createdAt.toISOString() : null,
      created_at: createdAt.toISOString(),
    });
  }

  // ── 10. VIATURAS (5) ─────────────────────────────────────────────────────────
  const VIATURAS = [
    { model: "Renault Trafic 2022",  plate: "AA-11-BB", status: "ativo"      },
    { model: "Fiat Doblo 2021",      plate: "CC-22-DD", status: "ativo"      },
    { model: "Renault Kangoo 2020",  plate: "EE-33-FF", status: "manutencao" },
    { model: "Ford Transit 2023",    plate: "GG-44-HH", status: "ativo"      },
    { model: "Mercedes Sprinter 2022",plate:"II-55-JJ", status: "ativo"      },
  ];

  const viaturaIds: string[] = [];
  for (const v of VIATURAS) {
    const { data: ev } = await admin.from("vehicles").select("id").eq("plate", v.plate).eq("company_id", companyId).single();
    if (ev) { viaturaIds.push(ev.id); continue; }
    const { data: veh } = await admin.from("vehicles").insert({
      company_id: companyId, model: v.model, plate: v.plate, status: v.status,
      notes: v.status === "manutencao" ? "Revisão de 40.000 km agendada" : null,
    }).select("id").single();
    if (veh) viaturaIds.push(veh.id);
  }

  // Alocações de viaturas (7 dias centrado em hoje)
  if (viaturaIds.length > 0 && equipaIds.length > 0) {
    for (let d = -3; d <= 3; d++) {
      const date = offsetDate(now, d);
      for (let vi = 0; vi < Math.min(viaturaIds.length, equipaIds.length); vi++) {
        const vid = viaturaIds[vi]; const eid = equipaIds[vi];
        if (!vid || !eid) continue;
        const { data: ea } = await admin.from("vehicle_allocations").select("id").eq("vehicle_id", vid).eq("date", date).single();
        if (ea) continue;
        await admin.from("vehicle_allocations").insert({ vehicle_id: vid, team_id: eid, driver_id: validColabIds[vi * 3] ?? null, date });
      }
    }
  }

  // ── 11. FALTAS (15 registos) ──────────────────────────────────────────────────
  if (validColabIds.length >= 8) {
    const absences = [
      { i: 1,  type: "doenca_sem_baixa",    s: offsetDate(now, -30), e: offsetDate(now, -28) },
      { i: 3,  type: "ferias",              s: offsetDate(now, -25), e: offsetDate(now, -18) },
      { i: 0,  type: "pessoal_justificado", s: offsetDate(now, -10), e: offsetDate(now, -10) },
      { i: 5,  type: "ferias",              s: offsetDate(now, -8),  e: offsetDate(now, -2)  },
      { i: 7,  type: "doenca_com_baixa",    s: offsetDate(now, -5),  e: offsetDate(now, 2)   },
      { i: 2,  type: "ferias",              s: offsetDate(now, 5),   e: offsetDate(now, 12)  },
      { i: 4,  type: "formacao",            s: offsetDate(now, 3),   e: offsetDate(now, 4)   },
      { i: 6,  type: "pessoal_justificado", s: offsetDate(now, 1),   e: offsetDate(now, 1)   },
      { i: 9,  type: "doenca_sem_baixa",    s: offsetDate(now, -15), e: offsetDate(now, -14) },
      { i: 11, type: "ferias",              s: offsetDate(now, 14),  e: offsetDate(now, 21)  },
      { i: 12, type: "doenca_com_baixa",    s: offsetDate(now, -20), e: offsetDate(now, -10) },
      { i: 14, type: "pessoal_justificado", s: offsetDate(now, -3),  e: offsetDate(now, -3)  },
      { i: 16, type: "formacao",            s: offsetDate(now, 7),   e: offsetDate(now, 8)   },
      { i: 18, type: "ferias",              s: offsetDate(now, -45), e: offsetDate(now, -38) },
      { i: 20, type: "doenca_sem_baixa",    s: offsetDate(now, -7),  e: offsetDate(now, -6)  },
    ];
    for (const a of absences) {
      const collabId = validColabIds[a.i % validColabIds.length];
      if (!collabId) continue;
      const { data: ea } = await admin.from("absences").select("id").eq("collaborator_id", collabId).eq("starts_on", a.s).single();
      if (ea) continue;
      await admin.from("absences").insert({
        company_id: companyId, collaborator_id: collabId,
        absence_type: a.type, starts_on: a.s, ends_on: a.e, created_by: user.id,
      });
    }
  }

  return NextResponse.json({
    ok: true,
    summary: {
      colaboradores: validColabIds.length,
      equipas: equipaIds.length,
      clientes: clientIds.length,
      locais: locationIds.length,
      servicos: servicesCreated,
      viaturas: viaturaIds.length,
      tarefas: tarefas.length,
    },
  });
}

function offsetDate(base: Date, days: number): string {
  const d = new Date(base);
  d.setDate(d.getDate() + days);
  return d.toISOString().split("T")[0];
}

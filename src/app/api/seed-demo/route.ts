import { NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { createAdminClient } from "@/lib/supabase/admin";

// POST /api/seed-demo — popula dados fictícios para testes (apenas em dev)
export async function POST() {
  if (process.env.NODE_ENV === "production") {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }
  const supabase = await createClient();
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const admin = createAdminClient() as any;

  // Verificar auth
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "Não autenticado." }, { status: 401 });

  const { data: profile } = await admin.from("profiles").select("company_id, role").eq("id", user.id).single();
  if (!profile || !["admin", "gestor"].includes(profile.role)) {
    return NextResponse.json({ error: "Sem permissão." }, { status: 403 });
  }

  const companyId: string = profile.company_id;

  // ── 1. COLABORADORES ────────────────────────────────────────────────────────
  const colaboradoresData = [
    { full_name: "Ana Silva",       skills: ["Vidros", "Escritórios"],     hours: 168 },
    { full_name: "Bruno Costa",     skills: ["Industrial", "Alta pressão"], hours: 168 },
    { full_name: "Carla Rodrigues", skills: ["Carpetes", "Cozinhas"],      hours: 120 },
    { full_name: "Diana Ferreira",  skills: ["Hospitalar", "Exterior"],    hours: 168 },
    { full_name: "Eduardo Santos",  skills: ["Vidros", "Encerador"],       hours: 80  },
    { full_name: "Filipa Mendes",   skills: ["Casas de banho", "Carpetes"], hours: 168 },
  ];

  const colaboradorIds: string[] = [];

  for (const c of colaboradoresData) {
    const email = `${c.full_name.toLowerCase().replace(/\s+/g, ".")}.demo@placeholder.escala`;

    // Verificar se já existe
    const { data: existing } = await admin.from("profiles").select("id").eq("email", email).eq("company_id", companyId).single();
    if (existing) { colaboradorIds.push(existing.id); continue; }

    const { data: authUser, error: authErr } = await admin.auth.admin.createUser({
      email,
      email_confirm: true,
      user_metadata: { company_id: companyId, role: "colaborador", full_name: c.full_name },
    });

    if (authErr || !authUser.user) continue;

    await admin.from("profiles").update({
      full_name: c.full_name,
      email,
      status: "ativo",
      contracted_hours_month: c.hours,
      skills: c.skills,
    }).eq("id", authUser.user.id);

    colaboradorIds.push(authUser.user.id);
  }

  // ── 2. EQUIPAS ──────────────────────────────────────────────────────────────
  const equipasData = [
    { name: "Equipa A", color: "#16A34A", memberIdxs: [0, 1, 2] },
    { name: "Equipa B", color: "#0EA5E9", memberIdxs: [3, 4, 5] },
  ];

  const equipaIds: string[] = [];

  for (const eq of equipasData) {
    const { data: existing } = await admin.from("teams").select("id").eq("name", eq.name).eq("company_id", companyId).single();
    if (existing) { equipaIds.push(existing.id); continue; }

    const { data: team } = await admin.from("teams").insert({
      company_id: companyId,
      name: eq.name,
      color: eq.color,
      active: true,
      leader_id: colaboradorIds[eq.memberIdxs[0]] ?? null,
    }).select("id").single();

    if (!team) continue;
    equipaIds.push(team.id);

    const members = eq.memberIdxs.map((i) => colaboradorIds[i]).filter(Boolean);
    if (members.length > 0) {
      await admin.from("team_members").insert(
        members.map((cid) => ({ team_id: team.id, collaborator_id: cid }))
      );
    }
  }

  // ── 3. CLIENTES + LOCAIS ────────────────────────────────────────────────────
  const clientesData = [
    {
      name: "Edifício Marquês",    nif: "501234567", email: "geral@marques.pt",
      locations: [
        { name: "Piso 1 — Escritórios", address: "Av. Marquês de Pombal 1, Lisboa", lat: 38.7252, lng: -9.1497, area: 450, rate: 18 },
        { name: "Piso 2 — Salas Reunião", address: "Av. Marquês de Pombal 1, Lisboa", lat: 38.7252, lng: -9.1497, area: 200, rate: 18 },
      ],
    },
    {
      name: "Clínica Saúde Total",  nif: "509876543", email: "admin@saudetotal.pt",
      locations: [
        { name: "Recepção e Espera", address: "Rua Augusta 120, Lisboa", lat: 38.7099, lng: -9.1378, area: 180, rate: 22 },
        { name: "Consultórios",      address: "Rua Augusta 120, Lisboa", lat: 38.7099, lng: -9.1378, area: 300, rate: 22 },
      ],
    },
    {
      name: "Supermercado Freitas", nif: "503456789", email: "geral@freitas.pt",
      locations: [
        { name: "Loja Almada",  address: "Av. 25 de Abril 45, Almada",  lat: 38.6764, lng: -9.1659, area: 800, rate: 15 },
        { name: "Loja Setúbal", address: "Rua do Comércio 8, Setúbal",  lat: 38.5243, lng: -8.8941, area: 650, rate: 15 },
      ],
    },
  ];

  const locationIds: string[] = [];

  for (const cl of clientesData) {
    let clientId: string;
    const { data: existing } = await admin.from("clients").select("id").eq("name", cl.name).eq("company_id", companyId).single();

    if (existing) {
      clientId = existing.id;
    } else {
      const { data: newClient } = await admin.from("clients").insert({
        company_id: companyId, name: cl.name, nif: cl.nif, email: cl.email,
        status: "ativo", type: "empresa",
      }).select("id").single();
      if (!newClient) continue;
      clientId = newClient.id;
    }

    for (const loc of cl.locations) {
      const { data: existingLoc } = await admin.from("locations").select("id").eq("name", loc.name).eq("client_id", clientId).single();
      if (existingLoc) { locationIds.push(existingLoc.id); continue; }

      const { data: newLoc } = await admin.from("locations").insert({
        company_id: companyId, client_id: clientId,
        name: loc.name, address: loc.address, lat: loc.lat, lng: loc.lng,
        area_sqm: loc.area, hourly_rate: loc.rate, active: true,
      }).select("id").single();
      if (newLoc) locationIds.push(newLoc.id);
    }
  }

  // ── 4. SERVIÇOS (últimos 2 meses) ───────────────────────────────────────────
  const now = new Date();
  let serviceRef = 100;
  let servicesCreated = 0;

  for (let daysAgo = 55; daysAgo >= 0; daysAgo--) {
    if (daysAgo % 2 !== 0) continue; // dias alternados

    const serviceDate = new Date(now);
    serviceDate.setDate(serviceDate.getDate() - daysAgo);
    const dayOfWeek = serviceDate.getDay(); // 0=dom, 6=sab
    if (dayOfWeek === 0) continue; // sem domingo

    // 1-2 serviços por dia
    const numServices = dayOfWeek === 6 ? 1 : 2;

    for (let si = 0; si < numServices; si++) {
      const teamId = equipaIds[si % equipaIds.length];
      const locId = locationIds[(servicesCreated) % locationIds.length];
      if (!teamId || !locId) continue;

      const startHour = si === 0 ? 8 : 13;
      const start = new Date(serviceDate);
      start.setHours(startHour, 0, 0, 0);
      const end = new Date(start);
      end.setHours(startHour + 2, 30, 0, 0);

      const isPast = daysAgo > 0;
      const status = isPast ? (Math.random() < 0.85 ? "concluido" : (Math.random() < 0.5 ? "cancelado" : "falta")) : "agendado";

      const actualStart = status === "concluido" ? new Date(start.getTime() + (Math.random() < 0.3 ? 5 * 60000 : 0)) : null;
      const actualEnd = status === "concluido" ? new Date(end.getTime() + Math.floor((Math.random() - 0.5) * 20) * 60000) : null;

      const { data: service } = await admin.from("services").insert({
        company_id: companyId,
        location_id: locId,
        team_id: teamId,
        reference_number: `#${String(serviceRef++).padStart(4, "0")}`,
        scheduled_start: start.toISOString(),
        scheduled_end: end.toISOString(),
        hourly_rate: 18,
        calculated_value: 18 * 2.5,
        status,
        actual_start: actualStart?.toISOString() ?? null,
        actual_end: actualEnd?.toISOString() ?? null,
      }).select("id").single();

      if (service && status === "concluido" && colaboradorIds.length > 0) {
        const memberIdx = (si * 3) % colaboradorIds.length;
        const duration = actualEnd && actualStart
          ? Math.round((actualEnd.getTime() - actualStart.getTime()) / 60000)
          : 150;

        await admin.from("timesheets").upsert({
          company_id: companyId,
          service_id: service.id,
          collaborator_id: colaboradorIds[memberIdx],
          clock_in_at: actualStart?.toISOString(),
          clock_out_at: actualEnd?.toISOString(),
          duration_minutes: duration,
        }, { onConflict: "service_id,collaborator_id" });
      }

      servicesCreated++;
    }
  }

  // ── 5. ALGUMAS FALTAS ───────────────────────────────────────────────────────
  if (colaboradorIds.length >= 2) {
    const absences = [
      { cid: colaboradorIds[1], type: "doenca_sem_baixa", starts: offsetDate(now, -20), ends: offsetDate(now, -19) },
      { cid: colaboradorIds[3], type: "ferias",           starts: offsetDate(now, -10), ends: offsetDate(now, -6)  },
      { cid: colaboradorIds[0], type: "pessoal_justificado", starts: offsetDate(now, -3), ends: offsetDate(now, -3) },
    ];
    for (const a of absences) {
      await admin.from("absences").insert({
        company_id: companyId, collaborator_id: a.cid,
        absence_type: a.type, starts_on: a.starts, ends_on: a.ends,
        created_by: user.id,
      }).then(() => {});
    }
  }

  return NextResponse.json({
    ok: true,
    summary: {
      colaboradores: colaboradorIds.length,
      equipas: equipaIds.length,
      locais: locationIds.length,
      servicos: servicesCreated,
    },
  });
}

function offsetDate(base: Date, days: number): string {
  const d = new Date(base);
  d.setDate(d.getDate() + days);
  return d.toISOString().split("T")[0];
}

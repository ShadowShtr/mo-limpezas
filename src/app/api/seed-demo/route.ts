import { NextRequest, NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { createAdminClient } from "@/lib/supabase/admin";

// POST /api/seed-demo?secret=<SEED_SECRET>
// Popula dados fictícios para testes. Em produção requer o header secret.
export async function POST(req: NextRequest) {
  const secret = req.nextUrl.searchParams.get("secret");
  const envSecret = process.env.SEED_SECRET;

  const isAllowed =
    process.env.NODE_ENV !== "production" ||
    (envSecret && secret === envSecret);

  if (!isAllowed) {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }

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

  // ── 1. COLABORADORES ────────────────────────────────────────────────────────
  const colaboradoresData = [
    { full_name: "Ana Silva",       skills: ["Vidros", "Escritórios"],      hours: 168, rate: 7.5 },
    { full_name: "Bruno Costa",     skills: ["Industrial", "Alta pressão"], hours: 168, rate: 7.5 },
    { full_name: "Carla Rodrigues", skills: ["Carpetes", "Cozinhas"],       hours: 120, rate: 7.5 },
    { full_name: "Diana Ferreira",  skills: ["Hospitalar", "Exterior"],     hours: 168, rate: 8.0 },
    { full_name: "Eduardo Santos",  skills: ["Vidros", "Encerador"],        hours: 80,  rate: 7.5 },
    { full_name: "Filipa Mendes",   skills: ["Casas de banho", "Carpetes"], hours: 168, rate: 8.0 },
  ];

  const colaboradorIds: string[] = [];

  for (const c of colaboradoresData) {
    const email = `${c.full_name.toLowerCase().replace(/\s+/g, ".")}.demo@placeholder.escala`;
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
      user_metadata: { company_id: companyId, role: "colaborador", full_name: c.full_name },
    });
    if (authErr || !authUser.user) continue;

    await admin.from("profiles").update({
      full_name: c.full_name,
      email,
      status: "ativo",
      contracted_hours_month: c.hours,
      hourly_rate: c.rate,
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
    const { data: existing } = await admin
      .from("teams")
      .select("id")
      .eq("name", eq.name)
      .eq("company_id", companyId)
      .single();

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
        members.map((cid: string) => ({ team_id: team.id, collaborator_id: cid }))
      );
    }
  }

  // ── 3. CLIENTES + LOCAIS ────────────────────────────────────────────────────
  const clientesData = [
    {
      name: "Edifício Marquês",
      nif: "501234567", email: "geral@marques.pt", phone: "213 456 789",
      locations: [
        { name: "Piso 1 — Escritórios",   address: "Av. Marquês de Pombal 1, Lisboa",  lat: 38.7252, lng: -9.1497, area: 450, rate: 18 },
        { name: "Piso 2 — Salas Reunião", address: "Av. Marquês de Pombal 1, Lisboa",  lat: 38.7252, lng: -9.1497, area: 200, rate: 18 },
      ],
    },
    {
      name: "Clínica Saúde Total",
      nif: "509876543", email: "admin@saudetotal.pt", phone: "214 567 890",
      locations: [
        { name: "Recepção e Espera", address: "Rua Augusta 120, Lisboa",    lat: 38.7099, lng: -9.1378, area: 180, rate: 22 },
        { name: "Consultórios",      address: "Rua Augusta 120, Lisboa",    lat: 38.7099, lng: -9.1378, area: 300, rate: 22 },
      ],
    },
    {
      name: "Supermercado Freitas",
      nif: "503456789", email: "geral@freitas.pt", phone: "265 123 456",
      locations: [
        { name: "Loja Almada",  address: "Av. 25 de Abril 45, Almada",  lat: 38.6764, lng: -9.1659, area: 800, rate: 15 },
        { name: "Loja Setúbal", address: "Rua do Comércio 8, Setúbal",  lat: 38.5243, lng: -8.8941, area: 650, rate: 15 },
      ],
    },
    {
      name: "Hotel Bela Vista",
      nif: "508765432", email: "manutencao@belavista.pt", phone: "282 765 432",
      locations: [
        { name: "Quartos (Piso 1-3)",  address: "Av. dos Descobrimentos 22, Portimão", lat: 37.1363, lng: -8.5369, area: 1200, rate: 20 },
        { name: "Restaurante e Bar",   address: "Av. dos Descobrimentos 22, Portimão", lat: 37.1363, lng: -8.5369, area: 400,  rate: 20 },
      ],
    },
  ];

  const locationIds: string[] = [];
  const clientIds: string[] = [];

  for (const cl of clientesData) {
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
      const { data: newClient } = await admin.from("clients").insert({
        company_id: companyId,
        name: cl.name, nif: cl.nif, email: cl.email, phone: cl.phone,
        status: "ativo", type: "empresa",
      }).select("id").single();
      if (!newClient) continue;
      clientId = newClient.id;
    }
    clientIds.push(clientId);

    for (const loc of cl.locations) {
      const { data: existingLoc } = await admin
        .from("locations")
        .select("id")
        .eq("name", loc.name)
        .eq("client_id", clientId)
        .single();

      if (existingLoc) { locationIds.push(existingLoc.id); continue; }

      const { data: newLoc } = await admin.from("locations").insert({
        company_id: companyId, client_id: clientId,
        name: loc.name, address: loc.address, lat: loc.lat, lng: loc.lng,
        area_sqm: loc.area, hourly_rate: loc.rate, active: true,
      }).select("id").single();
      if (newLoc) locationIds.push(newLoc.id);
    }
  }

  // ── 4. CONTRATOS ────────────────────────────────────────────────────────────
  const contratosData = [
    {
      locIdx: 0, name: "Limpeza Semanal Marquês P1",
      frequency: "weekly", weekdays: [1, 4], interval_days: 7,
      schedule_days: [{ day: "mon", start: "08:00", end: "11:00" }, { day: "thu", start: "08:00", end: "11:00" }],
      starts_on: offsetDate(now, -90), ends_on: offsetDate(now, 275),
    },
    {
      locIdx: 1, name: "Limpeza Quinzenal Marquês P2",
      frequency: "biweekly", weekdays: [3], interval_days: 14,
      schedule_days: [{ day: "wed", start: "09:00", end: "11:00" }],
      starts_on: offsetDate(now, -60), ends_on: null,
    },
    {
      locIdx: 2, name: "Limpeza Diária Clínica Recepção",
      frequency: "weekly", weekdays: [1, 2, 3, 4, 5], interval_days: 1,
      schedule_days: [
        { day: "mon", start: "07:00", end: "08:30" },
        { day: "tue", start: "07:00", end: "08:30" },
        { day: "wed", start: "07:00", end: "08:30" },
        { day: "thu", start: "07:00", end: "08:30" },
        { day: "fri", start: "07:00", end: "08:30" },
      ],
      starts_on: offsetDate(now, -120), ends_on: null,
    },
    {
      locIdx: 4, name: "Limpeza Semanal Freitas Almada",
      frequency: "weekly", weekdays: [0], interval_days: 7,
      schedule_days: [{ day: "sun", start: "06:00", end: "10:00" }],
      starts_on: offsetDate(now, -45), ends_on: null,
    },
    {
      locIdx: 6, name: "Limpeza Hotel Quartos",
      frequency: "weekly", weekdays: [1, 2, 3, 4, 5, 6], interval_days: 1,
      schedule_days: [
        { day: "mon", start: "10:00", end: "14:00" },
        { day: "tue", start: "10:00", end: "14:00" },
        { day: "wed", start: "10:00", end: "14:00" },
        { day: "thu", start: "10:00", end: "14:00" },
        { day: "fri", start: "10:00", end: "14:00" },
        { day: "sat", start: "10:00", end: "14:00" },
      ],
      starts_on: offsetDate(now, -30), ends_on: null,
    },
  ];

  for (const ct of contratosData) {
    const locId = locationIds[ct.locIdx];
    if (!locId) continue;
    const { data: existing } = await admin
      .from("contracts")
      .select("id")
      .eq("name", ct.name)
      .eq("company_id", companyId)
      .single();
    if (existing) continue;

    await admin.from("contracts").insert({
      company_id: companyId,
      location_id: locId,
      name: ct.name,
      frequency: ct.frequency,
      weekdays: ct.weekdays,
      interval_days: ct.interval_days,
      schedule_days: ct.schedule_days,
      starts_on: ct.starts_on,
      ends_on: ct.ends_on,
      status: "ativo",
      created_by: user.id,
    });
  }

  // ── 5. SERVIÇOS (últimos 2 meses + hoje) ────────────────────────────────────
  let serviceRef = 100;
  let servicesCreated = 0;
  const serviceIds: string[] = [];

  for (let daysAgo = 55; daysAgo >= 0; daysAgo--) {
    if (daysAgo % 2 !== 0) continue;

    const serviceDate = new Date(now);
    serviceDate.setDate(serviceDate.getDate() - daysAgo);
    const dayOfWeek = serviceDate.getDay();
    if (dayOfWeek === 0) continue;

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
      const rand = Math.random();
      const status = isPast
        ? (rand < 0.82 ? "concluido" : rand < 0.92 ? "cancelado" : "falta")
        : "agendado";

      const actualStart = status === "concluido"
        ? new Date(start.getTime() + Math.floor(Math.random() * 8) * 60000)
        : null;
      const actualEnd = status === "concluido"
        ? new Date(end.getTime() + Math.floor((Math.random() - 0.4) * 15) * 60000)
        : null;

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
        actual_end:   actualEnd?.toISOString()   ?? null,
      }).select("id").single();

      if (service) {
        serviceIds.push(service.id);

        if (status === "concluido" && colaboradorIds.length > 0) {
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
      }

      servicesCreated++;
    }
  }

  // ── 6. FATURAS (cobranças) ───────────────────────────────────────────────────
  const year = now.getFullYear();
  const month = now.getMonth() + 1; // 1-based

  const invoiceMonths = [
    { y: month >= 3 ? year : year - 1, m: month >= 3 ? month - 2 : 10 + month, status: "pago" as const },
    { y: month >= 2 ? year : year - 1, m: month >= 2 ? month - 1 : 11 + month, status: "pago" as const },
    { y: year, m: month, status: "pendente" as const },
  ];

  for (const period of invoiceMonths) {
    for (let ci = 0; ci < clientIds.length; ci++) {
      const clientId = clientIds[ci];
      if (!clientId) continue;

      const invoiceDate = new Date(period.y, period.m - 1, 1);
      const dueDate = new Date(period.y, period.m - 1, 30);
      const subtotal = 1200 + ci * 350 + Math.floor(Math.random() * 200);
      const vatRate = 23;
      const vatAmount = Math.round(subtotal * vatRate) / 100;
      const total = subtotal + vatAmount;
      const invoiceNum = `F${period.y}/${String((ci + 1) * 10 + period.m).padStart(3, "0")}`;

      const { data: existing } = await admin
        .from("invoices")
        .select("id")
        .eq("invoice_number", invoiceNum)
        .eq("company_id", companyId)
        .single();
      if (existing) continue;

      const paidAt = period.status === "pago"
        ? new Date(dueDate.getTime() - Math.floor(Math.random() * 5) * 86400000).toISOString()
        : null;

      const { data: inv } = await admin.from("invoices").insert({
        company_id: companyId,
        client_id: clientId,
        invoice_number: invoiceNum,
        invoice_date: invoiceDate.toISOString().split("T")[0],
        due_date: dueDate.toISOString().split("T")[0],
        period_start: `${period.y}-${String(period.m).padStart(2, "0")}-01`,
        period_end: new Date(period.y, period.m, 0).toISOString().split("T")[0],
        subtotal,
        vat_rate: vatRate,
        vat_amount: vatAmount,
        total,
        status: period.status,
        paid_at: paidAt,
        payment_method: paidAt ? "transferencia" : null,
        notes: null,
      }).select("id").single();

      if (inv) {
        await admin.from("invoice_items").insert([
          {
            invoice_id: inv.id,
            service_id: null,
            description: "Serviços de limpeza — mão de obra",
            quantity: 1,
            unit_price: Math.round(subtotal * 0.7),
            total: Math.round(subtotal * 0.7),
            sort_order: 1,
          },
          {
            invoice_id: inv.id,
            service_id: null,
            description: "Produtos e consumíveis",
            quantity: 1,
            unit_price: Math.round(subtotal * 0.2),
            total: Math.round(subtotal * 0.2),
            sort_order: 2,
          },
          {
            invoice_id: inv.id,
            service_id: null,
            description: "Deslocações e transportes",
            quantity: 1,
            unit_price: Math.round(subtotal * 0.1),
            total: Math.round(subtotal * 0.1),
            sort_order: 3,
          },
        ]);
      }
    }
  }

  // ── 7. FOLHA DE PAGAMENTO ────────────────────────────────────────────────────
  const payrollMonths = [
    { y: month >= 3 ? year : year - 1, m: month >= 3 ? month - 2 : 10 + month, status: "pago" as const },
    { y: month >= 2 ? year : year - 1, m: month >= 2 ? month - 1 : 11 + month, status: "aprovado" as const },
  ];

  for (const period of payrollMonths) {
    for (let ci = 0; ci < colaboradorIds.length; ci++) {
      const collabId = colaboradorIds[ci];
      if (!collabId) continue;

      const { data: existing } = await admin
        .from("payroll_records")
        .select("id")
        .eq("collaborator_id", collabId)
        .eq("period_year", period.y)
        .eq("period_month", period.m)
        .single();
      if (existing) continue;

      const contracted = colaboradoresData[ci]?.hours ?? 168;
      const rate = colaboradoresData[ci]?.rate ?? 7.5;
      const worked = Math.min(contracted, contracted - Math.floor(Math.random() * 8));
      const overtime = Math.max(0, worked - contracted + Math.floor(Math.random() * 10));
      const absenceHours = Math.floor(Math.random() * 8);
      const daysWorked = Math.floor(worked / 8);
      const gross = Math.round((worked * rate + overtime * rate * 1.25) * 100) / 100;
      const meal = daysWorked * 5.2;
      const net = Math.round((gross + meal) * 100) / 100;
      const paidAt = period.status === "pago"
        ? new Date(period.y, period.m, 8).toISOString()
        : null;

      await admin.from("payroll_records").insert({
        company_id: companyId,
        collaborator_id: collabId,
        period_year: period.y,
        period_month: period.m,
        contracted_hours: contracted,
        worked_hours: worked,
        overtime_hours: overtime,
        absence_hours: absenceHours,
        days_worked: daysWorked,
        hourly_rate: rate,
        gross_salary: gross,
        meal_allowance: meal,
        overtime_bonus: Math.round(overtime * rate * 0.25 * 100) / 100,
        absence_deductions: 0,
        other_deductions: 0,
        other_additions: 0,
        net_salary: net,
        notes: null,
        status: period.status,
        paid_at: paidAt,
      });
    }
  }

  // ── 8. CASH FLOW (despesas dos últimos 3 meses) ──────────────────────────────
  const despesas = [
    { desc: "Fornecedor Produtos Limpeza — Fev",  amount: 820,  cat: "material",     date: offsetDate(now, -50) },
    { desc: "Combustível — Fevereiro",            amount: 340,  cat: "transporte",   date: offsetDate(now, -45) },
    { desc: "Aluguer de equipamentos",            amount: 600,  cat: "equipamento",  date: offsetDate(now, -40) },
    { desc: "Seguro de responsabilidade civil",   amount: 250,  cat: "seguro",       date: offsetDate(now, -35) },
    { desc: "Fornecedor Produtos Limpeza — Mar",  amount: 760,  cat: "material",     date: offsetDate(now, -20) },
    { desc: "Combustível — Março",                amount: 310,  cat: "transporte",   date: offsetDate(now, -15) },
    { desc: "Manutenção da carrinha",             amount: 480,  cat: "manutencao",   date: offsetDate(now, -12) },
    { desc: "Material EPI (luvas, fardas)",       amount: 190,  cat: "material",     date: offsetDate(now, -8)  },
    { desc: "Fornecedor Produtos Limpeza — Abr",  amount: 790,  cat: "material",     date: offsetDate(now, -5)  },
    { desc: "Combustível — Abril",                amount: 320,  cat: "transporte",   date: offsetDate(now, -2)  },
  ];

  for (const d of despesas) {
    const { data: existing } = await admin
      .from("cash_flow_entries")
      .select("id")
      .eq("description", d.desc)
      .eq("company_id", companyId)
      .single();
    if (existing) continue;

    await admin.from("cash_flow_entries").insert({
      company_id: companyId,
      type: "saida",
      amount: d.amount,
      description: d.desc,
      category: d.cat,
      date: d.date,
      created_by: user.id,
    });
  }

  // ── 9. TAREFAS KANBAN ────────────────────────────────────────────────────────
  const tarefas = [
    { title: "Renovar contrato Hotel Bela Vista",         body: "Contrato termina em Agosto. Agendar reunião com o responsável.",             status: "pendente",  priority: "urgente", daysAgo: 2  },
    { title: "Comprar aspiradores industriais novos",     body: "Os dois aspiradores da Equipa B estão com avaria recorrente.",               status: "pendente",  priority: "normal",  daysAgo: 5  },
    { title: "Formação de segurança e higiene",           body: "Obrigatória para todos os colaboradores. Marcar para final do mês.",         status: "em_curso",  priority: "normal",  daysAgo: 3  },
    { title: "Actualizar ficha de EPI da Carla",          body: null,                                                                          status: "em_curso",  priority: "normal",  daysAgo: 1  },
    { title: "Enviar relatório de qualidade a Clínica",   body: "Cliente pediu relatório mensal de qualidade dos serviços prestados.",        status: "concluido", priority: "urgente", daysAgo: 8  },
    { title: "Renegociar preço com fornecedor Limpex",    body: "Orçamento vencido. Pedir nova proposta com desconto de volume.",             status: "pendente",  priority: "normal",  daysAgo: 4  },
    { title: "Criar folha de rota semanal Equipa A",      body: null,                                                                          status: "concluido", priority: "normal",  daysAgo: 10 },
    { title: "Verificar certificados da viatura",         body: "IPO e seguro da carrinha branca vencem no próximo mês.",                     status: "em_curso",  priority: "urgente", daysAgo: 6  },
    { title: "Contratar colaborador extra para Verão",    body: "Alta estação no Algarve — prever reforço de 2 pessoas de Junho a Setembro.", status: "pendente",  priority: "normal",  daysAgo: 1  },
    { title: "Instalar sistema de check-in QR Code",      body: "Testar QR codes na clínica antes de replicar para todos os locais.",        status: "concluido", priority: "normal",  daysAgo: 14 },
  ];

  for (const t of tarefas) {
    const { data: existing } = await admin
      .from("management_tasks")
      .select("id")
      .eq("title", t.title)
      .eq("company_id", companyId)
      .single();
    if (existing) continue;

    const createdAt = new Date(now);
    createdAt.setDate(createdAt.getDate() - t.daysAgo);

    await admin.from("management_tasks").insert({
      company_id: companyId,
      title: t.title,
      body: t.body,
      status: t.status,
      priority: t.priority,
      assigned_to: colaboradorIds[Math.floor(Math.random() * Math.min(colaboradorIds.length, 3))] ?? null,
      due_date: t.status !== "concluido" ? offsetDate(now, 7 + Math.floor(Math.random() * 14)) : null,
      created_by: user.id,
      completed_at: t.status === "concluido" ? createdAt.toISOString() : null,
      created_at: createdAt.toISOString(),
    });
  }

  // ── 10. VIATURAS ─────────────────────────────────────────────────────────────
  const viaturas = [
    { model: "Renault Trafic 2021", plate: "AA-01-BB", status: "ativo" },
    { model: "Fiat Doblo 2020",     plate: "CC-22-DD", status: "ativo" },
    { model: "Renault Kangoo 2019", plate: "EE-33-FF", status: "manutencao" },
  ];

  const viaturaIds: string[] = [];
  for (const v of viaturas) {
    const { data: existing } = await admin
      .from("vehicles")
      .select("id")
      .eq("plate", v.plate)
      .eq("company_id", companyId)
      .single();

    if (existing) { viaturaIds.push(existing.id); continue; }

    const { data: veh } = await admin.from("vehicles").insert({
      company_id: companyId,
      model: v.model,
      plate: v.plate,
      status: v.status,
      notes: v.status === "manutencao" ? "Revisão de 40.000 km agendada" : null,
    }).select("id").single();
    if (veh) viaturaIds.push(veh.id);
  }

  // Alocações recentes de viaturas
  if (viaturaIds.length > 0 && equipaIds.length > 0) {
    for (let d = 0; d < 7; d++) {
      const date = offsetDate(now, d - 3);
      for (let ei = 0; ei < Math.min(equipaIds.length, viaturaIds.length); ei++) {
        const { data: existing } = await admin
          .from("vehicle_allocations")
          .select("id")
          .eq("vehicle_id", viaturaIds[ei])
          .eq("date", date)
          .single();
        if (existing) continue;

        await admin.from("vehicle_allocations").insert({
          vehicle_id: viaturaIds[ei],
          team_id: equipaIds[ei],
          driver_id: colaboradorIds[ei * 3] ?? null,
          date,
        });
      }
    }
  }

  // ── 11. FALTAS ───────────────────────────────────────────────────────────────
  if (colaboradorIds.length >= 4) {
    const absences = [
      { cid: colaboradorIds[1], type: "doenca_sem_baixa",   starts: offsetDate(now, -20), ends: offsetDate(now, -19) },
      { cid: colaboradorIds[3], type: "ferias",             starts: offsetDate(now, -10), ends: offsetDate(now, -6)  },
      { cid: colaboradorIds[0], type: "pessoal_justificado",starts: offsetDate(now, -3),  ends: offsetDate(now, -3)  },
      { cid: colaboradorIds[2], type: "ferias",             starts: offsetDate(now, 5),   ends: offsetDate(now, 12)  },
    ];
    for (const a of absences) {
      const { data: existing } = await admin
        .from("absences")
        .select("id")
        .eq("collaborator_id", a.cid)
        .eq("starts_on", a.starts)
        .single();
      if (existing) continue;

      await admin.from("absences").insert({
        company_id: companyId,
        collaborator_id: a.cid,
        absence_type: a.type,
        starts_on: a.starts,
        ends_on: a.ends,
        created_by: user.id,
      });
    }
  }

  return NextResponse.json({
    ok: true,
    summary: {
      colaboradores: colaboradorIds.length,
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

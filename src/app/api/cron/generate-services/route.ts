import { NextRequest, NextResponse } from "next/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { checkCronAuth } from "@/lib/cron-auth";
import { CONTRACT_FINANCIAL_FIELDS } from "@/lib/contrato-sheet-fields";
import type { ScheduleDay } from "@/types/database";

// Permite até 60s na Vercel Pro (TASK 14/16); mesmo assim corre em lotes.
export const maxDuration = 60;

// TASK 14 — limites por execução: processa contratos em lotes, com orçamento de
// tempo e auto-continuação. Evita timeout na geração mensal quando crescer.
const BATCH_SIZE = 25;          // contratos por lote
const TIME_BUDGET_MS = 40_000;  // para antes do limite serverless e retoma depois

// ─── Tipos ───────────────────────────────────────────────────────────────────

interface ContractRow {
  id: string;
  company_id: string;
  location_id: string;
  frequency: string;
  weekdays: number[] | null;
  interval_days: number;
  schedule_days: ScheduleDay[];
  starts_on: string;
  ends_on: string | null;
  num_people: number | null;
  fixed_price: number | null;
  fixed_monthly: boolean | null;
  apply_vat: boolean | null;
  excluded_dates: string[] | null;
  locations: { hourly_rate: number | null } | null;
}

interface ConflictRow {
  company_id: string;
  team_id: string;
  service1_id: string;
  service2_id: string;
  service1_start: string;
  service1_end: string;
  service2_start: string;
  service2_end: string;
}

const DOW_TO_KEY: Record<number, ScheduleDay["day"]> = {
  0: "sun", 1: "mon", 2: "tue", 3: "wed", 4: "thu", 5: "fri", 6: "sat",
};

// ─── Timezone Europe/Lisbon ────────────────────────────────────────────────────

const LISBON_TZ = "Europe/Lisbon";

/** Retorna "now" decomposto em partes de data/hora no fuso de Lisboa. */
function nowInLisbon(): { year: number; month: number; day: number } {
  const parts = new Intl.DateTimeFormat("en-GB", {
    timeZone: LISBON_TZ,
    year: "numeric", month: "2-digit", day: "2-digit",
  }).formatToParts(new Date());
  const get = (type: string) => parseInt(parts.find((p) => p.type === type)?.value ?? "0", 10);
  return { year: get("year"), month: get("month") - 1, day: get("day") };
}

/**
 * Constrói um timestamp ISO com o offset de Lisboa para a data+hora dadas.
 * Evita guardar datetimes "naivos" que o PostgreSQL interpreta como UTC.
 */
function toLisbonTimestamp(dateStr: string, timeStr: string): string {
  // Aproximação: usa a meia do dia UTC para calcular o offset de Lisboa nessa data.
  // Em dias de transição DST o desvio pode ser de ±1h — aceitável para agendamento.
  const midday = new Date(`${dateStr}T12:00:00Z`);
  const tzParts = new Intl.DateTimeFormat("en-GB", {
    timeZone: LISBON_TZ,
    timeZoneName: "shortOffset",
  }).formatToParts(midday);
  const tzName = tzParts.find((p) => p.type === "timeZoneName")?.value ?? "GMT";
  let offset = "+00:00";
  const m = tzName.match(/GMT([+-])(\d+)(?::(\d+))?/);
  if (m) {
    const sign = m[1];
    const h = m[2].padStart(2, "0");
    const min = (m[3] ?? "00").padStart(2, "0");
    offset = `${sign}${h}:${min}`;
  }
  return `${dateStr}T${timeStr}:00${offset}`;
}

// ─── Gerar ocorrências para um contrato num dado mês ─────────────────────────

function getOccurrences(
  contract: ContractRow,
  monthStart: Date,
  monthEnd: Date,
): Array<{ date: Date; schedule: ScheduleDay }> {
  const results: Array<{ date: Date; schedule: ScheduleDay }> = [];
  const defaultSchedule = contract.schedule_days?.[0];
  if (!defaultSchedule) return [];

  const contractStart = new Date(contract.starts_on + "T00:00:00");
  const contractEnd = contract.ends_on
    ? new Date(contract.ends_on + "T23:59:59")
    : null;
  // Datas excluídas manualmente (apagadas do calendário) — nunca são recriadas.
  const excluded = new Set(contract.excluded_dates ?? []);

  function inRange(d: Date): boolean {
    return (
      d >= monthStart &&
      d <= monthEnd &&
      d >= contractStart &&
      (!contractEnd || d <= contractEnd) &&
      !excluded.has(toDateStr(d))
    );
  }

  if (contract.frequency === "daily") {
    const cursor = new Date(monthStart);
    while (cursor <= monthEnd) {
      if (inRange(cursor)) {
        results.push({ date: new Date(cursor), schedule: defaultSchedule });
      }
      cursor.setDate(cursor.getDate() + 1);
    }
  } else if (
    contract.frequency === "weekly" ||
    contract.frequency === "biweekly"
  ) {
    const weekdays = contract.weekdays ?? [];
    const startWeekNum = Math.floor(
      contractStart.getTime() / (7 * 24 * 3600 * 1000),
    );
    const cursor = new Date(monthStart);
    while (cursor <= monthEnd) {
      const dow = cursor.getDay();
      if (weekdays.includes(dow)) {
        if (contract.frequency === "biweekly") {
          const thisWeekNum = Math.floor(
            cursor.getTime() / (7 * 24 * 3600 * 1000),
          );
          if ((thisWeekNum - startWeekNum) % 2 !== 0) {
            cursor.setDate(cursor.getDate() + 1);
            continue;
          }
        }
        if (inRange(cursor)) {
          const dayKey = DOW_TO_KEY[dow];
          const schedule =
            contract.schedule_days.find((s) => s.day === dayKey) ??
            defaultSchedule;
          results.push({ date: new Date(cursor), schedule });
        }
      }
      cursor.setDate(cursor.getDate() + 1);
    }
  } else if (contract.frequency === "monthly") {
    const dayOfMonth = contractStart.getDate();
    const target = new Date(
      monthStart.getFullYear(),
      monthStart.getMonth(),
      dayOfMonth,
    );
    if (inRange(target)) {
      results.push({ date: target, schedule: defaultSchedule });
    }
  } else if (contract.frequency === "custom") {
    const step = Math.max(1, contract.interval_days ?? 1);
    const cursor = new Date(contractStart);
    while (cursor <= monthEnd) {
      if (inRange(cursor)) {
        results.push({ date: new Date(cursor), schedule: defaultSchedule });
      }
      cursor.setDate(cursor.getDate() + step);
    }
  }

  return results;
}

function toDateStr(d: Date): string {
  return d.toISOString().split("T")[0];
}

function addMinutesToTime(time: string, mins: number): string {
  const [h, m] = time.split(":").map(Number);
  const total = h * 60 + m + mins;
  const endH = Math.floor(total / 60);
  const endM = total % 60;
  return `${String(endH).padStart(2, "0")}:${String(endM).padStart(2, "0")}`;
}

// ─── Handler ──────────────────────────────────────────────────────────────────

export async function GET(req: NextRequest) {
  // Autenticação central: Bearer (Vercel Cron) ou x-cron-secret; ?secret= só em dev.
  const auth = checkCronAuth(req);
  if (!auth.ok) return NextResponse.json({ error: auth.error }, { status: auth.status });
  const cronSecret = process.env.CRON_SECRET!;

  const supabase = createAdminClient();

  // Determinar o mês alvo: por defeito o próximo mês
  const targetMonthParam = req.nextUrl.searchParams.get("month"); // "YYYY-MM" p/ testes
  let monthStart: Date;
  let monthEnd: Date;

  if (targetMonthParam) {
    const [y, mo] = targetMonthParam.split("-").map(Number);
    monthStart = new Date(y, mo - 1, 1);
    monthEnd = new Date(y, mo, 0, 23, 59, 59);
  } else {
    // Usar a data atual em Lisboa (não UTC) para determinar o próximo mês correto.
    const { year, month } = nowInLisbon();
    monthStart = new Date(year, month + 1, 1);
    monthEnd = new Date(year, month + 2, 0, 23, 59, 59);
  }

  const monthStartStr = toDateStr(monthStart);
  const monthEndStr = toDateStr(monthEnd);

  // Buscar contratos ativos que se sobrepõem ao mês alvo
  const { data: contracts, error: contractsError } = await supabase
    .from("contracts")
    .select(
      `id, company_id, location_id, frequency, weekdays, interval_days, schedule_days, starts_on, ends_on, num_people, ${CONTRACT_FINANCIAL_FIELDS}, excluded_dates, locations(hourly_rate)`,
    )
    .eq("status", "ativo")
    .lte("starts_on", monthEndStr)
    .or(`ends_on.is.null,ends_on.gte.${monthStartStr}`);

  if (contractsError) {
    return NextResponse.json(
      { error: contractsError.message },
      { status: 500 },
    );
  }

  const allContracts = (contracts ?? []) as unknown as ContractRow[];

  // ── Job de progresso (criar ou retomar) ──────────────────────────────────────
  const jobParam = req.nextUrl.searchParams.get("job");
  let jobId = jobParam;
  let cursor = 0;
  let totalCreated = 0;
  let totalSkipped = 0;
  let totalFailed = 0;

  const monthKey = monthStartStr.slice(0, 7); // "YYYY-MM"

  if (jobId) {
    const { data: job } = await supabase
      .from("background_jobs").select("cursor, processed, failed, meta").eq("id", jobId).single();
    if (job) {
      cursor = job.cursor ?? 0;
      totalCreated = job.processed ?? 0;
      totalFailed = job.failed ?? 0;
    }
  } else {
    // job_key único por (type, job_key) enquanto status='running' —
    // se dois Vercel workers arrancarem ao mesmo tempo, um deles recebe 23505 e sai.
    const { data: created, error: jobErr } = await supabase
      .from("background_jobs")
      .insert({
        type: "generate_services",
        status: "running",
        total: allContracts.length,
        job_key: monthKey,
        meta: { month: monthStartStr },
      })
      .select("id")
      .single();
    if (jobErr) {
      if (jobErr.code === "23505") {
        return NextResponse.json({ ok: true, skipped: true, reason: "job already running for this month" });
      }
      return NextResponse.json({ error: jobErr.message }, { status: 500 });
    }
    jobId = created?.id ?? null;
  }

  // Contadores de referência por empresa (evita query por serviço)
  const companyCounts: Record<string, number> = {};
  // Cache de tamanho de equipa (membros ativos), preenchido sob procura.
  const teamSizes: Record<string, number> = {};
  async function getTeamSize(teamId: string | null): Promise<number> {
    if (!teamId) return 1;
    if (teamId in teamSizes) return teamSizes[teamId];
    const { count } = await supabase
      .from("team_members")
      .select("id", { count: "exact", head: true })
      .eq("team_id", teamId)
      .is("left_at", null);
    teamSizes[teamId] = count && count > 0 ? count : 1;
    return teamSizes[teamId];
  }
  const insertErrors: string[] = [];
  const startedAt = Date.now();
  let stoppedEarly = false;

  // ── Processar contratos em lotes a partir do cursor ──────────────────────────
  for (let i = cursor; i < allContracts.length; i += BATCH_SIZE) {
    if (Date.now() - startedAt > TIME_BUDGET_MS) { stoppedEarly = true; cursor = i; break; }

    const batch = allContracts.slice(i, i + BATCH_SIZE);

    // Pré-carregar serviços já existentes deste lote no mês (1 query, não N).
    const batchIds = batch.map((c) => c.id);
    const nextMonthStartStr = toDateStr(new Date(monthStart.getFullYear(), monthStart.getMonth() + 1, 1));
    const { data: existingRows } = await supabase
      .from("services")
      .select("contract_id, scheduled_start")
      .in("contract_id", batchIds)
      .gte("scheduled_start", toLisbonTimestamp(monthStartStr, "00:00"))
      .lt("scheduled_start", toLisbonTimestamp(nextMonthStartStr, "00:00"));

    const existingSet = new Set(
      (existingRows ?? []).map((r) => `${r.contract_id}|${(r.scheduled_start as string).slice(0, 10)}`),
    );

    // Garantir contador de referência para cada empresa presente no lote.
    for (const c of batch) {
      if (!(c.company_id in companyCounts)) {
        // Baseia o contador no MÁXIMO de referência existente (não count(*), que
        // colide com buracos deixados por serviços apagados/cancelados).
        const { data: recent } = await supabase
          .from("services").select("reference_number")
          .eq("company_id", c.company_id)
          .order("created_at", { ascending: false }).limit(500);
        let maxRef = 0;
        for (const r of recent ?? []) {
          const n = parseInt(r.reference_number as string, 10);
          if (Number.isFinite(n) && n > maxRef) maxRef = n;
        }
        companyCounts[c.company_id] = maxRef;
      }
    }

    type ServiceInsert = {
      company_id: string; location_id: string; team_id: string | null; contract_id: string;
      reference_number: string; scheduled_start: string; scheduled_end: string;
      hourly_rate: number | null; calculated_value: number | null; apply_vat: boolean;
      num_people: number; status: string;
    };
    const rows: ServiceInsert[] = [];

    for (const contract of batch) {
      const occurrences = getOccurrences(contract, monthStart, monthEnd);
      for (const { date, schedule } of occurrences) {
        const dateStr = toDateStr(date);
        const key = `${contract.id}|${dateStr}`;
        if (existingSet.has(key)) { totalSkipped++; continue; }
        existingSet.add(key); // evita duplicado dentro do próprio lote

        const endTime = addMinutesToTime(schedule.start_time, schedule.duration_min);
        companyCounts[contract.company_id]++;
        const ref = String(companyCounts[contract.company_id]).padStart(4, "0");
        const monthly = contract.fixed_monthly === true;
        const fixedPrice = contract.fixed_price != null && contract.fixed_price > 0
          ? parseFloat(contract.fixed_price.toFixed(2)) : null;
        const hourlyRate = contract.locations?.hourly_rate ?? null;
        // Nº de pessoas: com equipa → tamanho da equipa; sem equipa → num_people do dia.
        const people = schedule.team_id
          ? await getTeamSize(schedule.team_id)
          : (schedule.num_people != null && schedule.num_people >= 1 ? Math.floor(schedule.num_people) : 1);
        // Prioridade do valor: mensal (avença) → 0 (fatura 1x/mês) > valor fixo
        // por-serviço > por hora.
        const calculatedValue =
          monthly
            ? 0
            : fixedPrice != null
            ? fixedPrice
            : hourlyRate != null
            ? parseFloat(((schedule.duration_min / 60) * hourlyRate * people).toFixed(2))
            : null;

        rows.push({
          company_id: contract.company_id,
          location_id: contract.location_id,
          team_id: schedule.team_id || null,
          contract_id: contract.id,
          reference_number: ref,
          scheduled_start: toLisbonTimestamp(dateStr, schedule.start_time),
          scheduled_end: toLisbonTimestamp(dateStr, endTime),
          hourly_rate: monthly || fixedPrice != null ? null : hourlyRate,
          calculated_value: calculatedValue,
          apply_vat: contract.apply_vat ?? false,
          num_people: people,
          status: "agendado",
        });
      }
    }

    // Inserção em massa (1 query por lote).
    if (rows.length > 0) {
      const { error: insertError } = await supabase.from("services").insert(rows);
      if (insertError) {
        totalFailed += rows.length;
        insertErrors.push(`batch@${i}: ${insertError.message}`);
      } else {
        totalCreated += rows.length;
      }
    }

    cursor = Math.min(i + BATCH_SIZE, allContracts.length);

    // Atualizar progresso do job (visibilidade).
    if (jobId) {
      await supabase.from("background_jobs").update({
        cursor, processed: totalCreated, failed: totalFailed,
        last_error: insertErrors.at(-1) ?? null, updated_at: new Date().toISOString(),
      }).eq("id", jobId);
    }
  }

  // ── Parou por orçamento de tempo: retomar noutra invocação ───────────────────
  if (stoppedEarly) {
    const appUrl = process.env.NEXT_PUBLIC_APP_URL;
    if (appUrl && jobId) {
      const monthQs = targetMonthParam ? `&month=${targetMonthParam}` : "";
      // Fire-and-forget: continua de onde parou (mesmo job → mesmo cursor).
      void fetch(`${appUrl}/api/cron/generate-services?job=${jobId}${monthQs}`, {
        headers: { "x-cron-secret": cronSecret },
      }).catch(() => {});
    }
    return NextResponse.json({
      ok: true, status: "in_progress", job_id: jobId,
      period: `${monthStartStr} → ${monthEndStr}`,
      created: totalCreated, skipped: totalSkipped, failed: totalFailed,
      cursor, total: allContracts.length,
    });
  }

  // ── Terminou: deteção de conflitos só no fim ─────────────────────────────────
  // Detetar conflitos: mesma equipa, horários sobrepostos, no mês gerado
  const { data: rawConflicts } = await supabase.rpc("detect_schedule_conflicts", {
    p_start: monthStartStr,
    p_end: monthEndStr,
  });
  const conflicts = Array.isArray(rawConflicts)
    ? (rawConflicts as ConflictRow[])
    : [];

  // Notificar gestores/admins de cada empresa com conflitos
  if (conflicts.length > 0) {
    const byCompany: Record<string, typeof conflicts> = {};
    for (const c of conflicts) {
      if (!byCompany[c.company_id]) byCompany[c.company_id] = [];
      byCompany[c.company_id].push(c);
    }

    const monthLabel = monthStart.toLocaleString("pt-PT", {
      month: "long",
      year: "numeric",
    });

    for (const [companyId, companyConflicts] of Object.entries(byCompany)) {
      const { data: managers } = await supabase
        .from("profiles")
        .select("id")
        .eq("company_id", companyId)
        .in("role", ["admin", "gestor"]);

      const managerIds = (managers ?? []).map((m) => m.id);

      if (managerIds.length > 0) {
        // Anti-duplicação: remove avisos de conflito NÃO LIDOS do mesmo mês antes
        // de inserir o atual. Cada execução da geração reconta os mesmos conflitos,
        // por isso sem isto acumulava uma notificação por execução.
        await supabase
          .from("notifications")
          .delete()
          .eq("company_id", companyId)
          .eq("type", "generation_conflict")
          .is("read_at", null)
          .filter("data->>month", "eq", monthStartStr);

        const notifications = managerIds.map((id) => ({
          company_id: companyId,
          user_id: id,
          type: "generation_conflict",
          title: "Conflitos na geração automática",
          body: `${companyConflicts.length} conflito(s) de horário para ${monthLabel}. Verifique o calendário.`,
          data: {
            month: monthStartStr,
            conflict_count: companyConflicts.length,
            sample_conflicts: companyConflicts.slice(0, 3),
          },
        }));

        await supabase.from("notifications").insert(notifications);
      }
    }
  }

  // Marcar job como concluído.
  if (jobId) {
    await supabase.from("background_jobs").update({
      status: totalFailed > 0 ? "failed" : "completed",
      cursor: allContracts.length,
      processed: totalCreated,
      failed: totalFailed,
      last_error: insertErrors.at(-1) ?? null,
      finished_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    }).eq("id", jobId);
  }

  return NextResponse.json({
    ok: true,
    status: "completed",
    job_id: jobId,
    period: `${monthStartStr} → ${monthEndStr}`,
    created: totalCreated,
    skipped: totalSkipped,
    failed: totalFailed,
    conflicts: conflicts?.length ?? 0,
    errors: insertErrors.length > 0 ? insertErrors : undefined,
  });
}

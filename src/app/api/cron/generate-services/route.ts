import { NextRequest, NextResponse } from "next/server";
import { createAdminClient } from "@/lib/supabase/admin";
import type { ScheduleDay } from "@/types/database";

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

  function inRange(d: Date): boolean {
    return (
      d >= monthStart &&
      d <= monthEnd &&
      d >= contractStart &&
      (!contractEnd || d <= contractEnd)
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
  // Autenticação: header ou query param (para testes manuais)
  const cronSecret = process.env.CRON_SECRET;
  if (!cronSecret) {
    return NextResponse.json({ error: "Cron secret not configured" }, { status: 500 });
  }
  const secret =
    req.headers.get("x-cron-secret") ??
    req.nextUrl.searchParams.get("secret");
  if (!secret || secret !== cronSecret) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

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
    const now = new Date();
    monthStart = new Date(now.getFullYear(), now.getMonth() + 1, 1);
    monthEnd = new Date(now.getFullYear(), now.getMonth() + 2, 0, 23, 59, 59);
  }

  const monthStartStr = toDateStr(monthStart);
  const monthEndStr = toDateStr(monthEnd);

  // Buscar contratos ativos que se sobrepõem ao mês alvo
  const { data: contracts, error: contractsError } = await supabase
    .from("contracts")
    .select(
      "id, company_id, location_id, frequency, weekdays, interval_days, schedule_days, starts_on, ends_on, locations(hourly_rate)",
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

  // Contadores de referência por empresa (evita query por serviço)
  const companyCounts: Record<string, number> = {};
  let totalCreated = 0;
  let totalSkipped = 0;
  const insertErrors: string[] = [];

  for (const contract of contracts ?? []) {
    const occurrences = getOccurrences(
      contract as unknown as ContractRow,
      monthStart,
      monthEnd,
    );
    if (occurrences.length === 0) continue;

    // Inicializar contador de referências para esta empresa
    if (!(contract.company_id in companyCounts)) {
      const { count } = await supabase
        .from("services")
        .select("id", { count: "exact", head: true })
        .eq("company_id", contract.company_id);
      companyCounts[contract.company_id] = count ?? 0;
    }

    for (const { date, schedule } of occurrences) {
      const dateStr = toDateStr(date);

      // Verificar se já existe um serviço para este contrato nesta data
      const { data: existing } = await supabase
        .from("services")
        .select("id")
        .eq("contract_id", contract.id)
        .gte("scheduled_start", `${dateStr}T00:00:00`)
        .lte("scheduled_start", `${dateStr}T23:59:59`)
        .maybeSingle();

      if (existing) {
        totalSkipped++;
        continue;
      }

      // Construir timestamps
      const endTime = addMinutesToTime(schedule.start_time, schedule.duration_min);
      const scheduledStart = `${dateStr}T${schedule.start_time}:00`;
      const scheduledEnd = `${dateStr}T${endTime}:00`;

      // Número de referência sequencial por empresa
      companyCounts[contract.company_id]++;
      const ref = String(companyCounts[contract.company_id]).padStart(4, "0");

      // Calcular valor
      const hourlyRate =
        (contract.locations as unknown as { hourly_rate: number | null } | null)
          ?.hourly_rate ?? null;
      const calculatedValue =
        hourlyRate != null
          ? parseFloat(((schedule.duration_min / 60) * hourlyRate).toFixed(2))
          : null;

      const { error: insertError } = await supabase.from("services").insert({
        company_id: contract.company_id,
        location_id: contract.location_id,
        team_id: schedule.team_id || null,
        contract_id: contract.id,
        reference_number: ref,
        scheduled_start: scheduledStart,
        scheduled_end: scheduledEnd,
        hourly_rate: hourlyRate,
        calculated_value: calculatedValue,
        status: "agendado",
      });

      if (insertError) {
        insertErrors.push(
          `contract=${contract.id} date=${dateStr}: ${insertError.message}`,
        );
      } else {
        totalCreated++;
      }
    }
  }

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

      const notifications = (managers ?? []).map((m) => ({
        company_id: companyId,
        user_id: m.id,
        type: "generation_conflict",
        title: "Conflitos na geração automática",
        body: `${companyConflicts.length} conflito(s) de horário para ${monthLabel}. Verifique o calendário.`,
        data: {
          month: monthStartStr,
          conflict_count: companyConflicts.length,
          sample_conflicts: companyConflicts.slice(0, 3),
        },
      }));

      if (notifications.length > 0) {
        await supabase.from("notifications").insert(notifications);
      }
    }
  }

  return NextResponse.json({
    ok: true,
    period: `${monthStartStr} → ${monthEndStr}`,
    created: totalCreated,
    skipped: totalSkipped,
    conflicts: conflicts?.length ?? 0,
    errors: insertErrors.length > 0 ? insertErrors : undefined,
  });
}

"use server";

import { createAdminClient } from "@/lib/supabase/admin";
import { createClient } from "@/lib/supabase/server";
import { auditLog } from "@/lib/audit";

export type ConflictInfo = {
  id: string;
  reference_number: string;
  location_name: string;
  scheduled_start: string;
  scheduled_end: string;
};

export type RescheduleResult =
  | { ok: true; conflicts: ConflictInfo[] }
  | { ok: false; error: string; conflicts?: ConflictInfo[]; canForce?: boolean }

export async function rescheduleService(
  serviceId: string,
  newStart: string,
  newEnd: string,
  newTeamId: string | null,
  options?: { force?: boolean; reason?: string },
): Promise<RescheduleResult> {
  const supabase = await createClient();
  const admin = createAdminClient();

  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return { ok: false, error: "Nao autenticado." };

  const { data: profile } = await admin
    .from("profiles")
    .select("company_id, role")
    .eq("id", user.id)
    .single();

  if (!profile || !["admin", "gestor"].includes(profile.role)) {
    return { ok: false, error: "Sem permissao." };
  }

  const { data: service } = await admin
    .from("services")
    .select("id, company_id, team_id, status, scheduled_start, scheduled_end")
    .eq("id", serviceId)
    .eq("company_id", profile.company_id)
    .single();

  if (!service) return { ok: false, error: "Servico invalido." };
  if (["concluido", "cancelado", "falta"].includes(service.status)) {
    return { ok: false, error: "Este servico ja esta fechado e nao pode ser movido por drag." };
  }
  if (service.status === "em_curso" && !options?.force) {
    return { ok: false, error: "Servico em curso. Confirme antes de mover.", canForce: true };
  }

  if (newTeamId) {
    const { data: team } = await admin
      .from("teams")
      .select("id")
      .eq("id", newTeamId)
      .eq("company_id", profile.company_id)
      .eq("active", true)
      .single();
    if (!team) return { ok: false, error: "Equipa destino invalida ou inativa." };
  }

  const conflicts = await getConflicts(admin, profile.company_id, serviceId, newStart, newEnd, newTeamId);
  if (conflicts.length > 0 && !options?.force) {
    return {
      ok: false,
      error: "A equipa destino tem conflito neste horario.",
      conflicts,
      canForce: true,
    };
  }

  const { error } = await admin
    .from("services")
    .update({ scheduled_start: newStart, scheduled_end: newEnd, team_id: newTeamId })
    .eq("id", serviceId)
    .eq("company_id", profile.company_id);

  if (error) return { ok: false, error: error.message };

  // Notificar colaboradoras da nova equipa quando a equipa foi alterada
  const teamChanged = newTeamId !== null && newTeamId !== service.team_id;
  if (teamChanged) {
    await notifyNewTeam(admin, profile.company_id, newTeamId!, serviceId).catch(() => void 0);
  }

  await auditLog({
    companyId: profile.company_id,
    actorId: user.id,
    action: "service_rescheduled_drag_drop",
    entityType: "service",
    entityId: serviceId,
    before: {
      team_id: service.team_id,
      scheduled_start: service.scheduled_start,
      scheduled_end: service.scheduled_end,
    },
    after: {
      team_id: newTeamId,
      scheduled_start: newStart,
      scheduled_end: newEnd,
    },
    meta: {
      source: "calendar_drag_drop",
      forced: !!options?.force,
      reason: options?.reason ?? null,
      conflicts_ignored: conflicts.length,
    },
  }, admin);

  return { ok: true, conflicts };
}

async function notifyNewTeam(
  admin: ReturnType<typeof createAdminClient>,
  companyId: string,
  teamId: string,
  serviceId: string,
) {
  const { data: svc } = await admin
    .from("services")
    .select("scheduled_start, location_id")
    .eq("id", serviceId)
    .single();

  const { data: loc } = svc?.location_id
    ? await admin.from("locations").select("name").eq("id", svc.location_id).single()
    : { data: null };

  const date = svc?.scheduled_start
    ? new Date(svc.scheduled_start).toLocaleDateString("pt-PT", { weekday: "short", day: "numeric", month: "short" })
    : "";

  const { data: members } = await admin
    .from("team_members")
    .select("collaborator_id")
    .eq("team_id", teamId)
    .is("left_at", null);

  if (!members?.length) return;

  const memberIds = members.map((m) => m.collaborator_id);

  const { data: subs } = await admin
    .from("push_subscriptions")
    .select("endpoint, p256dh, auth_key")
    .in("user_id", memberIds)
    .eq("company_id", companyId);

  if (!subs?.length) return;

  const vapidPublic  = process.env.NEXT_PUBLIC_VAPID_PUBLIC_KEY;
  const vapidPrivate = process.env.VAPID_PRIVATE_KEY;
  if (!vapidPublic || !vapidPrivate) return;

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const webpush = ((await import("web-push")) as any).default ?? (await import("web-push"));
  webpush.setVapidDetails("mailto:admin@molimpezas.pt", vapidPublic, vapidPrivate);

  const payload = JSON.stringify({
    title: "📋 Novo trabalho atribuído",
    body: `${loc?.name ?? "Serviço"} — ${date}`,
    url: `/app/servico/${serviceId}`,
  });

  await Promise.allSettled(
    subs.map((s: { endpoint: string; p256dh: string; auth_key: string }) =>
      webpush.sendNotification(
        { endpoint: s.endpoint, keys: { p256dh: s.p256dh, auth: s.auth_key } },
        payload,
      ),
    ),
  );
}

async function getConflicts(
  admin: ReturnType<typeof createAdminClient>,
  companyId: string,
  serviceId: string,
  newStart: string,
  newEnd: string,
  newTeamId: string | null,
): Promise<ConflictInfo[]> {
  if (!newTeamId) return [];
  // Detetar conflitos na mesma equipa no mesmo dia
  const dayStr = newStart.slice(0, 10);
  const { data: others } = await admin
    .from("services_full")
    .select("id, reference_number, location_name, scheduled_start, scheduled_end")
    .eq("company_id", companyId)
    .eq("team_id", newTeamId)
    .gte("scheduled_start", `${dayStr}T00:00:00`)
    .lte("scheduled_start", `${dayStr}T23:59:59`)
    .neq("id", serviceId)
    .in("status", ["agendado", "em_curso"]);

  const conflicts: ConflictInfo[] = [];
  const ts = new Date(newStart).getTime();
  const te = new Date(newEnd).getTime();

  for (const o of others ?? []) {
    const os = new Date(o.scheduled_start).getTime();
    const oe = new Date(o.scheduled_end).getTime();
    if (!(te <= os || ts >= oe)) {
      conflicts.push({
        id: o.id,
        reference_number: o.reference_number,
        location_name: o.location_name,
        scheduled_start: o.scheduled_start,
        scheduled_end: o.scheduled_end,
      });
    }
  }

  return conflicts;
}

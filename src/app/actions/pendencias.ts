"use server";

import { requireProfile } from "@/lib/auth-guard";

// TASK 13 — Painel de pendências da gestora (exception-driven).
// Agrega só o que saiu do normal: pontos manuais, fora do raio GPS,
// serviços sem checkout, serviços iniciados sem ponto, fotos pendentes/falhadas.

export interface PendenciaItem {
  id: string;
  service_id: string | null;
  title: string;       // ex: cliente / local
  subtitle: string;    // ex: colaboradora / hora / distância
  at: string | null;   // timestamp relevante
}

export interface PendenciasResult {
  manualClockins: PendenciaItem[];
  gpsOutOfRange: PendenciaItem[];
  noCheckout: PendenciaItem[];
  startedNoClockin: PendenciaItem[];
  photosPending: PendenciaItem[];
  photosFailed: PendenciaItem[];
  totals: {
    manualClockins: number;
    gpsOutOfRange: number;
    noCheckout: number;
    startedNoClockin: number;
    photosPending: number;
    photosFailed: number;
    total: number;
  };
}

function startOfTodayISO() {
  const t = new Date();
  return new Date(t.getFullYear(), t.getMonth(), t.getDate()).toISOString();
}
function endOfTodayISO() {
  const t = new Date();
  return new Date(t.getFullYear(), t.getMonth(), t.getDate(), 23, 59, 59).toISOString();
}

export async function getPendencias(): Promise<
  { ok: true; data: PendenciasResult } | { ok: false; error: string }
> {
  const guard = await requireProfile({ roles: ["admin", "gestor"] });
  if (!guard.ok) return { ok: false, error: guard.error };
  const { admin, profile } = guard;
  const companyId = profile.company_id;

  const todayStart = startOfTodayISO();
  const todayEnd = endOfTodayISO();
  const nowISO = new Date().toISOString();
  const sevenDaysAgo = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString();

  // Timesheets de hoje (para manual + fora do raio + sem checkout).
  const [tsRes, photosRes, todayServicesRes] = await Promise.all([
    admin
      .from("timesheets")
      .select("id, service_id, collaborator_id, clock_in_at, clock_out_at, manual_checkin, location_warning, clock_in_distance_m")
      .eq("company_id", companyId)
      .gte("clock_in_at", todayStart)
      .lte("clock_in_at", todayEnd),
    admin
      .from("service_photos")
      .select("id, service_id, collaborator_id, status, created_at")
      .eq("company_id", companyId)
      .in("status", ["pending", "uploading", "failed", "review_required"])
      .gte("created_at", sevenDaysAgo)
      .order("created_at", { ascending: false }),
    admin
      .from("services_full")
      .select("id, client_name, location_name, scheduled_start, scheduled_end, status, team_name")
      .eq("company_id", companyId)
      .gte("scheduled_start", todayStart)
      .lte("scheduled_start", todayEnd),
  ]);

  if (tsRes.error) return { ok: false, error: tsRes.error.message };
  if (photosRes.error) return { ok: false, error: photosRes.error.message };
  if (todayServicesRes.error) return { ok: false, error: todayServicesRes.error.message };

  const timesheets = tsRes.data ?? [];
  const photos = photosRes.data ?? [];
  const services = todayServicesRes.data ?? [];

  // Mapas de apoio para nomes.
  const serviceIds = [...new Set([
    ...timesheets.map((t) => t.service_id),
    ...photos.map((p) => p.service_id),
  ].filter(Boolean))] as string[];
  const collabIds = [...new Set([
    ...timesheets.map((t) => t.collaborator_id),
    ...photos.map((p) => p.collaborator_id),
  ].filter(Boolean))] as string[];

  const [svcRes, collabRes] = await Promise.all([
    serviceIds.length
      ? admin.from("services_full").select("id, client_name, location_name, scheduled_start").in("id", serviceIds)
      : Promise.resolve({ data: [] as { id: string; client_name: string | null; location_name: string | null; scheduled_start: string }[] }),
    collabIds.length
      ? admin.from("profiles").select("id, full_name").in("id", collabIds)
      : Promise.resolve({ data: [] as { id: string; full_name: string | null }[] }),
  ]);

  const svcMap = new Map((svcRes.data ?? []).map((s) => [s.id, s]));
  const nameMap = new Map((collabRes.data ?? []).map((p) => [p.id, p.full_name]));

  function svcLabel(serviceId: string | null) {
    if (!serviceId) return { title: "Serviço", subtitle: "" };
    const s = svcMap.get(serviceId);
    return {
      title: s?.client_name ?? "Serviço",
      subtitle: s?.location_name ?? "",
    };
  }

  // 1. Pontos manuais (sem GPS) hoje.
  const manualClockins: PendenciaItem[] = timesheets
    .filter((t) => t.manual_checkin)
    .map((t) => {
      const l = svcLabel(t.service_id);
      return {
        id: t.id,
        service_id: t.service_id,
        title: l.title,
        subtitle: `${nameMap.get(t.collaborator_id ?? "") ?? "Colaboradora"} · ${l.subtitle}`,
        at: t.clock_in_at,
      };
    });

  // 2. Pontos fora do raio GPS hoje.
  const gpsOutOfRange: PendenciaItem[] = timesheets
    .filter((t) => t.location_warning && !t.manual_checkin)
    .map((t) => {
      const l = svcLabel(t.service_id);
      const dist = t.clock_in_distance_m != null ? `${t.clock_in_distance_m}m do local` : "fora do raio";
      return {
        id: t.id,
        service_id: t.service_id,
        title: l.title,
        subtitle: `${nameMap.get(t.collaborator_id ?? "") ?? "Colaboradora"} · ${dist}`,
        at: t.clock_in_at,
      };
    });

  // 3. Serviços sem checkout: ponto aberto cujo serviço já devia ter terminado.
  const noCheckout: PendenciaItem[] = timesheets
    .filter((t) => !t.clock_out_at)
    .map((t) => {
      const s = svcMap.get(t.service_id ?? "");
      const l = svcLabel(t.service_id);
      return {
        id: t.id,
        service_id: t.service_id,
        title: l.title,
        subtitle: `${nameMap.get(t.collaborator_id ?? "") ?? "Colaboradora"} · entrada às ${fmtTime(t.clock_in_at)}`,
        at: s?.scheduled_start ?? t.clock_in_at,
      };
    });

  // 4. Serviços de hoje já iniciados (hora passou) sem qualquer ponto.
  const tsServiceIds = new Set(timesheets.map((t) => t.service_id));
  const startedNoClockin: PendenciaItem[] = services
    .filter(
      (s) =>
        ["agendado", "em_curso"].includes(s.status ?? "") &&
        s.scheduled_start <= nowISO &&
        !tsServiceIds.has(s.id),
    )
    .map((s) => ({
      id: s.id,
      service_id: s.id,
      title: s.client_name ?? "Serviço",
      subtitle: `${s.team_name ?? "Equipa"} · início previsto ${fmtTime(s.scheduled_start)}`,
      at: s.scheduled_start,
    }));

  // 5/6. Fotos pendentes e falhadas.
  const photosPending: PendenciaItem[] = photos
    .filter((p) => p.status === "pending" || p.status === "uploading")
    .map((p) => {
      const l = svcLabel(p.service_id);
      return {
        id: p.id,
        service_id: p.service_id,
        title: l.title,
        subtitle: `${nameMap.get(p.collaborator_id ?? "") ?? "Colaboradora"} · ${l.subtitle}`,
        at: p.created_at,
      };
    });

  const photosFailed: PendenciaItem[] = photos
    .filter((p) => p.status === "failed" || p.status === "review_required")
    .map((p) => {
      const l = svcLabel(p.service_id);
      return {
        id: p.id,
        service_id: p.service_id,
        title: l.title,
        subtitle: `${nameMap.get(p.collaborator_id ?? "") ?? "Colaboradora"} · ${l.subtitle}`,
        at: p.created_at,
      };
    });

  const totals = {
    manualClockins: manualClockins.length,
    gpsOutOfRange: gpsOutOfRange.length,
    noCheckout: noCheckout.length,
    startedNoClockin: startedNoClockin.length,
    photosPending: photosPending.length,
    photosFailed: photosFailed.length,
    total:
      manualClockins.length +
      gpsOutOfRange.length +
      noCheckout.length +
      startedNoClockin.length +
      photosPending.length +
      photosFailed.length,
  };

  return {
    ok: true,
    data: { manualClockins, gpsOutOfRange, noCheckout, startedNoClockin, photosPending, photosFailed, totals },
  };
}

function fmtTime(iso: string | null) {
  if (!iso) return "—";
  return new Date(iso).toLocaleTimeString("pt-PT", { hour: "2-digit", minute: "2-digit" });
}

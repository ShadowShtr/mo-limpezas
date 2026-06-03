import Link from "next/link";
import { redirect } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { MapPin, Clock, ChevronRight, Sun, Moon, Coffee } from "lucide-react";
import { formatTime, formatDate } from "@/lib/utils";
import { StatusBadge } from "./_components/status-badge";

export default async function AppHomePage() {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) redirect("/login");

  const admin = createAdminClient();
  const { data: profile } = await admin
    .from("profiles")
    .select("full_name, role")
    .eq("id", user.id)
    .single();

  if (!profile) redirect("/login");

  // Equipas onde a colaboradora está activa
  const { data: memberships } = await supabase
    .from("team_members")
    .select("team_id")
    .eq("collaborator_id", user.id)
    .is("left_at", null);

  const teamIds = (memberships ?? []).map((m) => m.team_id);

  const today = new Date();
  const todayStart = new Date(today.getFullYear(), today.getMonth(), today.getDate()).toISOString();
  const todayEnd   = new Date(today.getFullYear(), today.getMonth(), today.getDate(), 23, 59, 59).toISOString();

  const { data: services } = teamIds.length
    ? await supabase
        .from("services_full")
        .select("id, scheduled_start, scheduled_end, status, client_name, location_name, location_address, team_color")
        .in("team_id", teamIds)
        .gte("scheduled_start", todayStart)
        .lte("scheduled_start", todayEnd)
        .order("scheduled_start")
    : { data: [] };

  const list = services ?? [];

  const hour = today.getHours();
  const greeting =
    hour < 12 ? "Bom dia" : hour < 19 ? "Boa tarde" : "Boa noite";
  const GreetIcon = hour < 12 ? Sun : hour < 19 ? Coffee : Moon;

  const done    = list.filter((s) => s.status === "concluido").length;
  const total   = list.length;

  return (
    <div className="flex flex-col gap-5 pb-2">

      {/* Saudação */}
      <div className="flex items-start justify-between">
        <div>
          <div className="flex items-center gap-1.5 text-[var(--color-text-sub)] text-sm mb-0.5">
            <GreetIcon className="w-4 h-4" />
            <span>{greeting}</span>
          </div>
          <h1 className="text-xl font-bold text-[var(--color-text-main)] leading-tight">
            {profile.full_name.split(" ")[0]}
          </h1>
          <p className="text-xs text-[var(--color-text-muted)] mt-0.5 capitalize">
            {formatDate(today.toISOString())}
          </p>
        </div>

        {/* Progresso do dia */}
        {total > 0 && (
          <div className="text-right">
            <p className="text-2xl font-bold text-[var(--color-primary)]">{done}/{total}</p>
            <p className="text-[10px] text-[var(--color-text-muted)] uppercase tracking-wide">concluídos</p>
          </div>
        )}
      </div>

      {/* Barra de progresso */}
      {total > 0 && (
        <div className="h-1.5 bg-[var(--color-border)] rounded-full overflow-hidden">
          <div
            className="h-full bg-[var(--color-primary)] rounded-full transition-all"
            style={{ width: `${(done / total) * 100}%` }}
          />
        </div>
      )}

      {/* Lista de serviços */}
      <div>
        <h2 className="text-xs font-semibold text-[var(--color-text-muted)] uppercase tracking-wide mb-3">
          Serviços de hoje
        </h2>

        {list.length === 0 ? (
          <div className="bg-white rounded-2xl border border-[var(--color-border)] p-8 text-center">
            <div className="w-12 h-12 rounded-2xl bg-[var(--color-primary-light)] flex items-center justify-center mx-auto mb-3">
              <Sun className="w-6 h-6 text-[var(--color-primary)]" />
            </div>
            <p className="text-sm font-medium text-[var(--color-text-main)]">Nenhum serviço hoje</p>
            <p className="text-xs text-[var(--color-text-muted)] mt-1">Aproveita o descanso!</p>
          </div>
        ) : (
          <div className="flex flex-col gap-3">
            {list.map((s) => (
              <Link
                key={s.id}
                href={`/app/servico/${s.id}`}
                className="bg-white rounded-2xl border border-[var(--color-border)] p-4 flex gap-3 items-start active:scale-[0.98] transition-transform"
              >
                {/* Barra colorida lateral */}
                <div
                  className="w-1 self-stretch rounded-full shrink-0 mt-0.5"
                  style={{ backgroundColor: s.team_color ?? "#E2E8F0" }}
                />

                <div className="flex-1 min-w-0">
                  <div className="flex items-start justify-between gap-2">
                    <div>
                      <p className="text-sm font-semibold text-[var(--color-text-main)] truncate">
                        {s.client_name}
                      </p>
                      <p className="text-xs text-[var(--color-text-sub)] mt-0.5 flex items-center gap-1">
                        <MapPin className="w-3 h-3 shrink-0" />
                        <span className="truncate">{s.location_name}</span>
                      </p>
                    </div>
                    <StatusBadge status={s.status} />
                  </div>

                  <div className="flex items-center gap-1 mt-2 text-xs text-[var(--color-text-muted)]">
                    <Clock className="w-3 h-3" />
                    <span>{formatTime(s.scheduled_start)} – {formatTime(s.scheduled_end)}</span>
                  </div>
                </div>

                <ChevronRight className="w-4 h-4 text-[var(--color-text-muted)] mt-1 shrink-0" />
              </Link>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}

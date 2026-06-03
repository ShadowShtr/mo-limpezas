import { notFound, redirect } from "next/navigation";
import Link from "next/link";
import { createClient } from "@/lib/supabase/server";
import { ArrowLeft, MapPin, Clock, Key, FileText, Navigation, Users } from "lucide-react";
import { formatTime, formatDate } from "@/lib/utils";
import { StatusBadge } from "../../_components/status-badge";

interface Props {
  params: Promise<{ id: string }>;
}

export default async function ServicoDetailPage({ params }: Props) {
  const { id } = await params;
  const supabase = await createClient();

  const { data: { user } } = await supabase.auth.getUser();
  if (!user) redirect("/login");

  const { data: s } = await supabase
    .from("services_full")
    .select(`
      id, scheduled_start, scheduled_end, actual_start, actual_end,
      status, notes,
      client_name, client_id,
      location_name, location_address, location_lat, location_lng,
      location_access_code, location_instructions,
      team_name, team_color
    `)
    .eq("id", id)
    .single();

  if (!s) notFound();

  const mapsUrl = s.location_lat && s.location_lng
    ? `https://www.google.com/maps/dir/?api=1&destination=${s.location_lat},${s.location_lng}`
    : `https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(s.location_address ?? s.location_name)}`;

  const dateLabel = formatDate(s.scheduled_start);

  return (
    <div className="flex flex-col gap-4 pb-2">

      {/* Voltar */}
      <div className="flex items-center gap-2">
        <Link href="/app" className="p-1.5 rounded-lg hover:bg-[var(--color-border)] transition-colors">
          <ArrowLeft className="w-5 h-5 text-[var(--color-text-sub)]" />
        </Link>
        <span className="text-sm text-[var(--color-text-sub)]">Hoje</span>
      </div>

      {/* Card principal */}
      <div className="bg-white rounded-2xl border border-[var(--color-border)] overflow-hidden">
        {/* Cabeçalho colorido */}
        <div
          className="h-1.5"
          style={{ backgroundColor: s.team_color ?? "var(--color-primary)" }}
        />

        <div className="p-5 space-y-4">
          {/* Título + estado */}
          <div className="flex items-start justify-between gap-3">
            <div>
              <h1 className="text-lg font-bold text-[var(--color-text-main)]">{s.client_name}</h1>
              <p className="text-sm text-[var(--color-text-sub)]">{s.location_name}</p>
            </div>
            <StatusBadge status={s.status} />
          </div>

          {/* Data e hora */}
          <div className="flex items-center gap-2 text-sm text-[var(--color-text-sub)]">
            <Clock className="w-4 h-4 text-[var(--color-primary)] shrink-0" />
            <span className="capitalize">{dateLabel}</span>
            <span className="text-[var(--color-text-muted)]">·</span>
            <span className="font-medium text-[var(--color-text-main)]">
              {formatTime(s.scheduled_start)} – {formatTime(s.scheduled_end)}
            </span>
          </div>

          {/* Morada */}
          {s.location_address && (
            <div className="flex items-start gap-2 text-sm text-[var(--color-text-sub)]">
              <MapPin className="w-4 h-4 text-[var(--color-primary)] shrink-0 mt-0.5" />
              <span>{s.location_address}</span>
            </div>
          )}

          {/* Equipa */}
          {s.team_name && (
            <div className="flex items-center gap-2 text-sm text-[var(--color-text-sub)]">
              <Users className="w-4 h-4 text-[var(--color-primary)] shrink-0" />
              <span>{s.team_name}</span>
            </div>
          )}
        </div>
      </div>

      {/* Botão Navegar */}
      <a
        href={mapsUrl}
        target="_blank"
        rel="noopener noreferrer"
        className="flex items-center justify-center gap-2 w-full py-3.5 rounded-2xl bg-[var(--color-primary)] text-white font-semibold text-sm active:bg-[var(--color-primary-hover)] transition-colors"
      >
        <Navigation className="w-4 h-4" />
        Navegar para o local
      </a>

      {/* Acesso */}
      {s.location_access_code && (
        <div className="bg-white rounded-2xl border border-[var(--color-border)] p-4">
          <div className="flex items-center gap-2 mb-2">
            <Key className="w-4 h-4 text-[var(--color-warning)]" />
            <h3 className="text-sm font-semibold text-[var(--color-text-main)]">Código de acesso</h3>
          </div>
          <p className="text-sm text-[var(--color-text-sub)] font-mono bg-amber-50 rounded-lg px-3 py-2">
            {s.location_access_code}
          </p>
        </div>
      )}

      {/* Instruções */}
      {s.location_instructions && (
        <div className="bg-white rounded-2xl border border-[var(--color-border)] p-4">
          <div className="flex items-center gap-2 mb-2">
            <FileText className="w-4 h-4 text-[var(--color-info)]" />
            <h3 className="text-sm font-semibold text-[var(--color-text-main)]">Instruções</h3>
          </div>
          <p className="text-sm text-[var(--color-text-sub)] leading-relaxed">
            {s.location_instructions}
          </p>
        </div>
      )}

      {/* Notas do serviço */}
      {s.notes && (
        <div className="bg-white rounded-2xl border border-[var(--color-border)] p-4">
          <div className="flex items-center gap-2 mb-2">
            <FileText className="w-4 h-4 text-[var(--color-text-muted)]" />
            <h3 className="text-sm font-semibold text-[var(--color-text-main)]">Notas</h3>
          </div>
          <p className="text-sm text-[var(--color-text-sub)] leading-relaxed">{s.notes}</p>
        </div>
      )}

      {/* Placeholder clock-in/out — implementado em [3.3] */}
      <div className="bg-[var(--color-primary-light)] rounded-2xl border border-[var(--color-primary-muted)] p-4 text-center">
        <p className="text-xs text-[var(--color-primary)] font-medium">
          Registo de ponto disponível em breve
        </p>
      </div>
    </div>
  );
}

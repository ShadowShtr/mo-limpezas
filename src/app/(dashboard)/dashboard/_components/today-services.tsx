import { formatTime } from "@/lib/utils";
import { MapPin, Users } from "lucide-react";

type Service = {
  id: string;
  reference_number: string;
  scheduled_start: string;
  scheduled_end: string;
  status: string;
  location_name: string;
  client_name: string;
  team_name: string | null;
  team_color: string | null;
};

const STATUS_STYLE: Record<string, { label: string; dot: string; text: string; bg: string }> = {
  agendado:      { label: "Agendado",       dot: "bg-[var(--color-primary)]",  text: "text-[var(--color-primary)]",  bg: "bg-[var(--color-primary-light)]" },
  em_curso:      { label: "Em curso",       dot: "bg-[var(--color-warning)]",  text: "text-amber-700",               bg: "bg-amber-50" },
  concluido:     { label: "Concluído",      dot: "bg-[var(--color-success)]",  text: "text-[var(--color-success)]",  bg: "bg-[var(--color-primary-light)]" },
  cancelado:     { label: "Cancelado",      dot: "bg-[var(--color-danger)]",   text: "text-[var(--color-danger)]",   bg: "bg-red-50" },
  falta:         { label: "Falta",          dot: "bg-[var(--color-danger)]",   text: "text-[var(--color-danger)]",   bg: "bg-red-50" },
  sem_cobertura: { label: "Sem cobertura",  dot: "bg-[var(--color-danger)]",   text: "text-[var(--color-danger)]",   bg: "bg-red-50" },
};

interface Props {
  services: Service[];
}

export function TodayServices({ services }: Props) {
  return (
    <div className="bg-white rounded-xl border border-[var(--color-border)]">
      <div className="flex items-center justify-between px-5 py-4 border-b border-[var(--color-border)]">
        <h2 className="text-sm font-semibold text-[var(--color-text-main)]">Serviços de hoje</h2>
        <span className="text-xs text-[var(--color-text-muted)]">{services.length} serviços</span>
      </div>

      {services.length === 0 ? (
        <div className="py-12 text-center">
          <p className="text-sm text-[var(--color-text-muted)]">Nenhum serviço agendado para hoje.</p>
        </div>
      ) : (
        <div className="divide-y divide-[var(--color-border)]">
          {services.map((s) => {
            const style = STATUS_STYLE[s.status] ?? STATUS_STYLE.agendado;
            return (
              <div key={s.id} className="flex items-center gap-4 px-5 py-3.5 hover:bg-[var(--color-background)] transition-colors">

                {/* Hora */}
                <div className="w-14 shrink-0 text-right">
                  <p className="text-sm font-medium text-[var(--color-text-main)]">
                    {formatTime(s.scheduled_start)}
                  </p>
                  <p className="text-xs text-[var(--color-text-muted)]">
                    {formatTime(s.scheduled_end)}
                  </p>
                </div>

                {/* Barra colorida da equipa */}
                <div
                  className="w-1 self-stretch rounded-full shrink-0"
                  style={{ backgroundColor: s.team_color ?? "#E2E8F0" }}
                />

                {/* Dados */}
                <div className="flex-1 min-w-0">
                  <div className="flex items-center gap-2 flex-wrap">
                    <span className="text-xs font-mono text-[var(--color-text-muted)]">
                      {s.reference_number}
                    </span>
                    <span className="text-sm font-medium text-[var(--color-text-main)] truncate">
                      {s.client_name}
                    </span>
                  </div>
                  <div className="flex items-center gap-3 mt-0.5">
                    <span className="flex items-center gap-1 text-xs text-[var(--color-text-sub)]">
                      <MapPin className="w-3 h-3" />
                      {s.location_name}
                    </span>
                    {s.team_name && (
                      <span className="flex items-center gap-1 text-xs text-[var(--color-text-sub)]">
                        <Users className="w-3 h-3" />
                        {s.team_name}
                      </span>
                    )}
                  </div>
                </div>

                {/* Badge de estado */}
                <span className={`flex items-center gap-1.5 text-xs font-medium px-2.5 py-1 rounded-full shrink-0 ${style.bg} ${style.text}`}>
                  <span className={`w-1.5 h-1.5 rounded-full ${style.dot}`} />
                  {style.label}
                </span>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}

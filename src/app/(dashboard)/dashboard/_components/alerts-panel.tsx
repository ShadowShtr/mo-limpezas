import { AlertTriangle, MapPin } from "lucide-react";
import { formatTime } from "@/lib/utils";

type Alert = {
  id: string;
  reference_number: string;
  scheduled_start: string;
  status: string;
  location_name: string;
  client_name: string;
  team_name: string | null;
};

interface Props {
  alerts: Alert[];
}

export function AlertsPanel({ alerts }: Props) {
  return (
    <div className="bg-white rounded-xl border border-[var(--color-border)]">
      <div className="flex items-center gap-2 px-5 py-4 border-b border-[var(--color-border)]">
        <AlertTriangle className="w-4 h-4 text-[var(--color-danger)]" />
        <h2 className="text-sm font-semibold text-[var(--color-text-main)]">Alertas</h2>
        {alerts.length > 0 && (
          <span className="ml-auto text-xs font-medium text-white bg-[var(--color-danger)] px-2 py-0.5 rounded-full">
            {alerts.length}
          </span>
        )}
      </div>

      {alerts.length === 0 ? (
        <div className="py-12 text-center">
          <div className="w-10 h-10 rounded-full bg-[var(--color-primary-light)] flex items-center justify-center mx-auto mb-3">
            <AlertTriangle className="w-5 h-5 text-[var(--color-primary)]" />
          </div>
          <p className="text-sm text-[var(--color-text-muted)]">Sem alertas ativos</p>
        </div>
      ) : (
        <div className="divide-y divide-[var(--color-border)]">
          {alerts.map((a) => (
            <div key={a.id} className="px-5 py-3.5">
              <div className="flex items-start gap-3">
                <div className="w-7 h-7 rounded-lg bg-red-50 flex items-center justify-center shrink-0 mt-0.5">
                  <AlertTriangle className="w-3.5 h-3.5 text-[var(--color-danger)]" />
                </div>
                <div className="flex-1 min-w-0">
                  <div className="flex items-center gap-1.5">
                    <span className="text-xs font-mono text-[var(--color-text-muted)]">
                      {a.reference_number}
                    </span>
                    <span className={`text-xs font-medium px-1.5 py-0.5 rounded ${
                      a.status === "sem_cobertura"
                        ? "bg-red-50 text-[var(--color-danger)]"
                        : "bg-amber-50 text-amber-700"
                    }`}>
                      {a.status === "sem_cobertura" ? "Sem cobertura" : "Falta"}
                    </span>
                  </div>
                  <p className="text-sm font-medium text-[var(--color-text-main)] truncate mt-0.5">
                    {a.client_name}
                  </p>
                  <div className="flex items-center gap-1 mt-0.5">
                    <MapPin className="w-3 h-3 text-[var(--color-text-muted)]" />
                    <span className="text-xs text-[var(--color-text-sub)] truncate">{a.location_name}</span>
                  </div>
                  <p className="text-xs text-[var(--color-text-muted)] mt-0.5">
                    {formatTime(a.scheduled_start)}
                    {a.team_name ? ` · ${a.team_name}` : " · Sem equipa"}
                  </p>
                </div>
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

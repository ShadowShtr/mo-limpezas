import { Clock, AlertTriangle } from "lucide-react";
import { formatTime } from "@/lib/utils";

type Timesheet = {
  id: string;
  clock_in_at: string | null;
  clock_out_at: string | null;
  duration_minutes: number | null;
  location_warning: boolean;
  service_id: string;
};

interface Props {
  timesheets: Timesheet[];
}

export function PresencaHistory({ timesheets }: Props) {
  return (
    <div className="bg-white rounded-xl border border-[var(--color-border)]">
      <div className="flex items-center gap-2 px-5 py-4 border-b border-[var(--color-border)]">
        <Clock className="w-4 h-4 text-[var(--color-text-muted)]" />
        <h3 className="text-sm font-semibold text-[var(--color-text-main)]">Histórico de presenças</h3>
        <span className="ml-auto text-xs text-[var(--color-text-muted)]">últimos 30 registos</span>
      </div>

      {timesheets.length === 0 ? (
        <div className="py-10 text-center">
          <p className="text-sm text-[var(--color-text-muted)]">Nenhum registo de ponto ainda.</p>
        </div>
      ) : (
        <div className="overflow-x-auto">
          <table className="w-full">
            <thead>
              <tr className="bg-[var(--color-background)] border-b border-[var(--color-border)]">
                <th className="text-left px-4 py-3 text-xs font-medium text-[var(--color-text-muted)] uppercase tracking-wide">Data</th>
                <th className="text-left px-4 py-3 text-xs font-medium text-[var(--color-text-muted)] uppercase tracking-wide">Entrada</th>
                <th className="text-left px-4 py-3 text-xs font-medium text-[var(--color-text-muted)] uppercase tracking-wide">Saída</th>
                <th className="text-left px-4 py-3 text-xs font-medium text-[var(--color-text-muted)] uppercase tracking-wide">Duração</th>
                <th className="px-4 py-3" />
              </tr>
            </thead>
            <tbody className="divide-y divide-[var(--color-border)]">
              {timesheets.map((t) => {
                const date = t.clock_in_at
                  ? new Date(t.clock_in_at).toLocaleDateString("pt-PT", { day: "numeric", month: "short", year: "numeric" })
                  : "—";
                const hours = t.duration_minutes
                  ? `${Math.floor(t.duration_minutes / 60)}h${String(t.duration_minutes % 60).padStart(2, "0")}`
                  : "—";

                return (
                  <tr key={t.id} className="hover:bg-[var(--color-background)] transition-colors">
                    <td className="px-4 py-3 text-sm text-[var(--color-text-main)]">{date}</td>
                    <td className="px-4 py-3 text-sm text-[var(--color-text-main)]">
                      {t.clock_in_at ? formatTime(t.clock_in_at) : "—"}
                    </td>
                    <td className="px-4 py-3 text-sm text-[var(--color-text-main)]">
                      {t.clock_out_at ? formatTime(t.clock_out_at) : (
                        <span className="text-xs text-[var(--color-warning)]">Em curso</span>
                      )}
                    </td>
                    <td className="px-4 py-3 text-sm font-medium text-[var(--color-text-main)]">{hours}</td>
                    <td className="px-4 py-3">
                      {t.location_warning && (
                        <span title="Fora do raio GPS">
                          <AlertTriangle className="w-4 h-4 text-[var(--color-warning)]" />
                        </span>
                      )}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

import { CalendarCheck, CheckCircle, Loader2, AlertTriangle } from "lucide-react";

interface KPIs {
  total: number;
  done: number;
  ongoing: number;
  noCoverage: number;
}

interface Props {
  kpis: KPIs;
}

export function DashboardKPIs({ kpis }: Props) {
  const cards = [
    {
      label: "SERVIÇOS HOJE",
      value: kpis.total,
      icon: CalendarCheck,
      iconColor: "text-[var(--color-primary)]",
      iconBg: "bg-[var(--color-primary-light)]",
    },
    {
      label: "CONCLUÍDOS",
      value: kpis.done,
      icon: CheckCircle,
      iconColor: "text-[var(--color-success)]",
      iconBg: "bg-[var(--color-primary-light)]",
      suffix: kpis.total > 0 ? `${Math.round((kpis.done / kpis.total) * 100)}%` : null,
    },
    {
      label: "EM CURSO",
      value: kpis.ongoing,
      icon: Loader2,
      iconColor: "text-[var(--color-warning)]",
      iconBg: "bg-amber-50",
    },
    {
      label: "SEM COBERTURA",
      value: kpis.noCoverage,
      icon: AlertTriangle,
      iconColor: kpis.noCoverage > 0 ? "text-[var(--color-danger)]" : "text-[var(--color-text-muted)]",
      iconBg: kpis.noCoverage > 0 ? "bg-red-50" : "bg-[var(--color-background)]",
      highlight: kpis.noCoverage > 0,
    },
  ];

  return (
    <div className="grid grid-cols-2 lg:grid-cols-4 gap-4">
      {cards.map((c) => {
        const Icon = c.icon;
        return (
          <div
            key={c.label}
            className={`bg-white rounded-xl border p-5 ${
              c.highlight ? "border-red-200" : "border-[var(--color-border)]"
            }`}
          >
            <div className="flex items-start justify-between mb-3">
              <div className={`w-9 h-9 rounded-lg flex items-center justify-center ${c.iconBg}`}>
                <Icon className={`w-5 h-5 ${c.iconColor}`} />
              </div>
              {c.suffix && (
                <span className="text-xs font-medium text-[var(--color-primary)] bg-[var(--color-primary-light)] px-2 py-0.5 rounded-full">
                  {c.suffix}
                </span>
              )}
            </div>
            <p className="text-3xl font-bold text-[var(--color-text-main)]">{c.value}</p>
            <p className="text-xs font-medium text-[var(--color-text-muted)] uppercase tracking-wide mt-1">
              {c.label}
            </p>
          </div>
        );
      })}
    </div>
  );
}

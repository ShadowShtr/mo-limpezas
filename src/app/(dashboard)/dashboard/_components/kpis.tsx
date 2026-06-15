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
      label: "Serviços hoje",
      value: kpis.total,
      icon: CalendarCheck,
      accent: "#22C55E",
      accentBg: "rgba(34,197,94,0.10)",
    },
    {
      label: "Concluídos",
      value: kpis.done,
      icon: CheckCircle,
      accent: "#22C55E",
      accentBg: "rgba(34,197,94,0.10)",
      suffix: kpis.total > 0 ? `${Math.round((kpis.done / kpis.total) * 100)}%` : null,
    },
    {
      label: "Em curso",
      value: kpis.ongoing,
      icon: Loader2,
      accent: "#F59E0B",
      accentBg: "rgba(245,158,11,0.10)",
    },
    {
      label: "Sem cobertura",
      value: kpis.noCoverage,
      icon: AlertTriangle,
      accent: kpis.noCoverage > 0 ? "#EF4444" : "#94A3B8",
      accentBg: kpis.noCoverage > 0 ? "rgba(239,68,68,0.10)" : "rgba(148,163,184,0.08)",
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
            className="glass-card rounded-2xl p-5"
            style={c.highlight ? { outline: "1px solid rgba(239,68,68,0.2)" } : undefined}
          >
            <div className="flex items-start justify-between mb-4">
              <div
                className="w-10 h-10 rounded-xl flex items-center justify-center"
                style={{ background: c.accentBg }}
              >
                <Icon className="w-5 h-5" style={{ color: c.accent }} />
              </div>
              {c.suffix && (
                <span
                  className="text-[11px] font-semibold px-2 py-0.5 rounded-full"
                  style={{ background: "rgba(34,197,94,0.10)", color: "#16A34A" }}
                >
                  {c.suffix}
                </span>
              )}
            </div>
            <p
              className="text-3xl font-bold leading-none"
              style={{ color: "var(--color-text-main)", letterSpacing: "-0.02em" }}
            >
              {c.value}
            </p>
            <p
              className="text-xs font-medium mt-1.5"
              style={{ color: "var(--color-text-muted)" }}
            >
              {c.label}
            </p>
          </div>
        );
      })}
    </div>
  );
}

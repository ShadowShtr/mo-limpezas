"use client";

import { parseISO, format } from "date-fns";

export type ServiceForBlock = {
  id: string;
  reference_number: string;
  scheduled_start: string;
  scheduled_end: string;
  status: string;
  location_name: string;
  client_name: string;
  calculated_value: number | null;
  manual_value: number | null;
  notes: string | null;
};

const STATUS_STYLE: Record<string, { bg: string; border: string; text: string; dot: string }> = {
  agendado:  { bg: "#F0FDF4", border: "#16A34A", text: "#15803D", dot: "#16A34A" },
  em_curso:  { bg: "#FFFBEB", border: "#F59E0B", text: "#92400E", dot: "#F59E0B" },
  concluido: { bg: "#F8FAFC", border: "#94A3B8", text: "#475569", dot: "#94A3B8" },
  cancelado: { bg: "#FEF2F2", border: "#DC2626", text: "#B91C1C", dot: "#DC2626" },
  falta:     { bg: "#FEF2F2", border: "#DC2626", text: "#B91C1C", dot: "#DC2626" },
};

const STATUS_LABEL: Record<string, string> = {
  agendado:  "Agendado",
  em_curso:  "Em curso",
  concluido: "Concluído",
  cancelado: "Cancelado",
  falta:     "Falta",
};

interface ServiceBlockProps {
  service: ServiceForBlock;
  slotHeight: number; // px per 30 min
  startHour: number;
  onClick?: (service: ServiceForBlock) => void;
}

export function ServiceBlock({ service, slotHeight, startHour, onClick }: ServiceBlockProps) {
  const start = parseISO(service.scheduled_start);
  const end = parseISO(service.scheduled_end);

  const startMinTotal = start.getHours() * 60 + start.getMinutes();
  const endMinTotal = end.getHours() * 60 + end.getMinutes();
  const offsetMin = startMinTotal - startHour * 60;
  const durationMin = endMinTotal - startMinTotal;

  const top = (offsetMin / 30) * slotHeight;
  const height = Math.max((durationMin / 30) * slotHeight, slotHeight);

  const style = STATUS_STYLE[service.status] ?? STATUS_STYLE.agendado;
  const value = service.manual_value ?? service.calculated_value;
  const isShort = height <= slotHeight; // ≤ 30 min
  const isMedium = height > slotHeight && height <= slotHeight * 2; // 31–60 min

  return (
    <div
      role="button"
      tabIndex={0}
      onClick={() => onClick?.(service)}
      onKeyDown={(e) => e.key === "Enter" && onClick?.(service)}
      className="absolute left-1 right-1 rounded-lg overflow-hidden cursor-pointer transition-all select-none focus:outline-none focus:ring-2 focus:ring-[var(--color-primary)] hover:brightness-95 hover:shadow-sm"
      style={{
        top: `${top}px`,
        height: `${height - 2}px`,
        backgroundColor: style.bg,
        borderLeft: `3px solid ${style.border}`,
        border: `1px solid ${style.border}`,
        borderLeftWidth: "3px",
        zIndex: 1,
      }}
    >
      <div className="px-2 py-1 h-full flex flex-col justify-between overflow-hidden">
        {/* Top row: local name + ref number */}
        <div className="flex items-start justify-between gap-1 min-w-0">
          <span
            className="text-[11px] font-semibold leading-tight truncate"
            style={{ color: style.text }}
          >
            {service.location_name}
          </span>
          {!isShort && (
            <span
              className="text-[10px] font-mono shrink-0 leading-tight"
              style={{ color: style.text, opacity: 0.7 }}
            >
              #{service.reference_number.slice(-4)}
            </span>
          )}
        </div>

        {/* Client name (medium+) */}
        {!isShort && !isMedium && (
          <span
            className="text-[10px] truncate leading-tight"
            style={{ color: style.text, opacity: 0.8 }}
          >
            {service.client_name}
          </span>
        )}

        {/* Bottom: time + value */}
        {!isShort && (
          <div
            className="flex items-center justify-between gap-1 mt-auto"
            style={{ color: style.text, opacity: 0.75 }}
          >
            <span className="text-[10px] font-medium whitespace-nowrap">
              {format(start, "HH:mm")}–{format(end, "HH:mm")}
            </span>
            {value != null && (
              <span className="text-[10px] font-medium whitespace-nowrap">
                €{value.toFixed(0)}
              </span>
            )}
          </div>
        )}

        {/* Very short: just show time inline */}
        {isShort && (
          <span className="text-[10px] font-medium" style={{ color: style.text, opacity: 0.75 }}>
            {format(start, "HH:mm")}
          </span>
        )}
      </div>
    </div>
  );
}

export { STATUS_LABEL };

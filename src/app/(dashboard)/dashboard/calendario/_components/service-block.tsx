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
  team_color: string | null;
  team_name: string | null;
};

// Fundo + texto por estado; border vem da cor da equipa (ou fallback do estado)
const STATUS_BG: Record<string, { bg: string; text: string; fallbackBorder: string }> = {
  agendado:  { bg: "#F0FDF4", text: "#15803D", fallbackBorder: "#16A34A" },
  em_curso:  { bg: "#FFFBEB", text: "#92400E", fallbackBorder: "#F59E0B" },
  concluido: { bg: "#F8FAFC", text: "#475569", fallbackBorder: "#94A3B8" },
  cancelado: { bg: "#FEF2F2", text: "#B91C1C", fallbackBorder: "#DC2626" },
  falta:     { bg: "#FEF2F2", text: "#B91C1C", fallbackBorder: "#DC2626" },
};

export const STATUS_LABEL: Record<string, string> = {
  agendado:  "Agendado",
  em_curso:  "Em curso",
  concluido: "Concluído",
  cancelado: "Cancelado",
  falta:     "Falta",
};

interface ServiceBlockProps {
  service: ServiceForBlock;
  slotHeight: number;
  startHour: number;
  onClick?: (service: ServiceForBlock) => void;
}

export function ServiceBlock({ service, slotHeight, startHour, onClick }: ServiceBlockProps) {
  const start = parseISO(service.scheduled_start);
  const end = parseISO(service.scheduled_end);

  const startMin = start.getHours() * 60 + start.getMinutes();
  const endMin = end.getHours() * 60 + end.getMinutes();
  const offsetMin = startMin - startHour * 60;
  const durationMin = endMin - startMin;

  const top = (offsetMin / 30) * slotHeight;
  const height = Math.max((durationMin / 30) * slotHeight, slotHeight);

  const s = STATUS_BG[service.status] ?? STATUS_BG.agendado;
  const borderColor = service.team_color ?? s.fallbackBorder;
  const isShort = height <= slotHeight;

  return (
    <div
      role="button"
      tabIndex={0}
      onClick={(e) => { e.stopPropagation(); onClick?.(service); }}
      onKeyDown={(e) => e.key === "Enter" && onClick?.(service)}
      className="absolute left-0.5 right-0.5 rounded overflow-hidden cursor-pointer transition-all select-none focus:outline-none focus:ring-1 focus:ring-[var(--color-primary)] hover:brightness-95 hover:shadow-sm"
      style={{
        top: `${top + 1}px`,
        height: `${height - 2}px`,
        backgroundColor: s.bg,
        borderLeft: `3px solid ${borderColor}`,
        border: `1px solid ${borderColor}30`,
        borderLeftWidth: "3px",
        zIndex: 1,
      }}
    >
      <div className="px-1.5 py-0.5 h-full flex flex-col overflow-hidden">
        <span
          className="text-[11px] font-semibold leading-tight truncate"
          style={{ color: s.text }}
        >
          {service.location_name}
        </span>
        {!isShort && (
          <span
            className="text-[10px] leading-tight truncate"
            style={{ color: s.text, opacity: 0.75 }}
          >
            {format(start, "HH:mm")}–{format(end, "HH:mm")}
          </span>
        )}
        {!isShort && service.team_name && (
          <span
            className="text-[10px] leading-tight truncate mt-auto"
            style={{ color: s.text, opacity: 0.6 }}
          >
            {service.team_name}
          </span>
        )}
      </div>
    </div>
  );
}

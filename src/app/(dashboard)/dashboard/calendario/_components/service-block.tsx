"use client";

import { useState } from "react";
import { parseISO, format, differenceInMinutes } from "date-fns";
import { MapPin, Clock, Euro, FileText, Lock, Key, Users } from "lucide-react";
import { useDraggable } from "@dnd-kit/core";
import { CSS } from "@dnd-kit/utilities";

export type ServiceForBlock = {
  id: string;
  reference_number: string;
  scheduled_start: string;
  scheduled_end: string;
  status: string;
  location_name: string;
  location_address: string;
  location_has_access_code: boolean;
  location_has_key: boolean;
  location_key_label: string | null;
  location_lat: number | null;
  location_lng: number | null;
  client_name: string;
  calculated_value: number | null;
  manual_value: number | null;
  notes: string | null;
  team_color: string | null;
  team_name: string | null;
  /** Gestores/admin veem valor financeiro; colaboradoras não */
  canSeeFinancials: boolean;
};

// ─── Extrai cidade do endereço (padrão PT: XXXX-XXX Cidade) ─────────────────

function extractCity(address: string): string {
  // Tenta extrair cidade após código postal português (XXXX-XXX Cidade)
  const m = address.match(/\d{4}-\d{3}\s+([^,]+)/);
  if (m) return m[1].trim();
  // Fallback: último segmento separado por vírgula
  const parts = address.split(",");
  if (parts.length >= 2) return parts[parts.length - 1].trim();
  return address;
}

// ─── Estilos por estado ───────────────────────────────────────────────────────

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

// ─── Tooltip ──────────────────────────────────────────────────────────────────

interface TooltipState { x: number; y: number }

function ServiceTooltip({ service, pos }: { service: ServiceForBlock; pos: TooltipState }) {
  const start = parseISO(service.scheduled_start);
  const end   = parseISO(service.scheduled_end);
  const mins  = differenceInMinutes(end, start);
  const dur   = `${Math.floor(mins / 60)}h${mins % 60 > 0 ? `${mins % 60}min` : ""}`;
  const value = service.manual_value ?? service.calculated_value;

  const viewportW = typeof window === "undefined" ? 1024 : window.innerWidth;
  const viewportH = typeof window === "undefined" ? 768 : window.innerHeight;
  const tooltipW = 280;
  const tooltipH = 220;
  const style: React.CSSProperties = {
    left: pos.x + tooltipW + 24 > viewportW ? pos.x - tooltipW - 12 : pos.x + 12,
    top:  pos.y + tooltipH > viewportH ? Math.max(8, viewportH - tooltipH - 8) : pos.y,
    opacity: 1,
  };

  return (
    <div
      className="fixed z-[9999] w-[280px] bg-white border border-[var(--color-border)] rounded-xl shadow-2xl p-4 text-xs pointer-events-none transition-opacity duration-100"
      style={style}
    >
      {/* Cabeçalho */}
      <div className="flex items-start justify-between gap-2 mb-3 pb-2.5 border-b border-[var(--color-border)]">
        <div className="min-w-0">
          <p className="font-bold text-sm text-[var(--color-text-main)] truncate">
            {extractCity(service.location_address) || service.location_name}
          </p>
          <p className="text-xs text-[var(--color-text-muted)] truncate">{service.client_name}</p>
        </div>
        <span
          className="shrink-0 text-[10px] font-semibold px-1.5 py-0.5 rounded-full"
          style={{
            backgroundColor: STATUS_BG[service.status]?.bg ?? "#F0FDF4",
            color:            STATUS_BG[service.status]?.text ?? "#15803D",
          }}
        >
          {STATUS_LABEL[service.status] ?? service.status}
        </span>
      </div>

      {/* Linhas de info */}
      <div className="space-y-1.5">
        <Row icon={Clock} label="Horário">
          {format(start, "HH:mm")} às {format(end, "HH:mm")} · {dur}
        </Row>

        <Row icon={MapPin} label="Morada">
          <a
            href={`https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(service.location_address)}`}
            target="_blank"
            rel="noopener noreferrer"
            className="pointer-events-auto text-[var(--color-primary)] hover:underline break-words"
            onClick={(e) => e.stopPropagation()}
          >
            {service.location_address || service.location_name}
          </a>
        </Row>

        {service.team_name && (
          <Row icon={Users} label="Equipa">
            <span className="flex items-center gap-1.5">
              {service.team_color && (
                <span className="w-2 h-2 rounded-full shrink-0 inline-block" style={{ backgroundColor: service.team_color }} />
              )}
              {service.team_name}
            </span>
          </Row>
        )}

        {service.location_has_key && (
          <Row icon={Key} label="Chave">
            <span>{service.location_key_label || "Equipa tem chave"}</span>
          </Row>
        )}

        {service.location_has_access_code && (
          <Row icon={Lock} label="Acesso">
            <span>Código registado (ver ficha)</span>
          </Row>
        )}

        {service.notes && (
          <Row icon={FileText} label="Obs.">
            <span className="text-[var(--color-text-sub)] break-words">{service.notes}</span>
          </Row>
        )}

        {service.canSeeFinancials && value != null && (
          <Row icon={Euro} label="Valor">
            <span className="font-semibold text-[var(--color-primary)]">€{value.toFixed(2)}</span>
          </Row>
        )}
      </div>

      {/* Ref */}
      <p className="mt-2.5 pt-2 border-t border-[var(--color-border)] font-mono text-[10px] text-[var(--color-text-muted)]">
        Ref. #{service.reference_number}
      </p>
    </div>
  );
}

function Row({
  icon: Icon, label, children,
}: {
  icon: React.ComponentType<{ className?: string }>;
  label: string;
  children: React.ReactNode;
}) {
  return (
    <div className="flex gap-1.5 items-start">
      <Icon className="w-3 h-3 text-[var(--color-text-muted)] shrink-0 mt-0.5" />
      <div className="flex-1 min-w-0">
        <span className="text-[var(--color-text-muted)]">{label}: </span>
        {children}
      </div>
    </div>
  );
}

// ─── ServiceBlock ─────────────────────────────────────────────────────────────

interface ServiceBlockProps {
  service: ServiceForBlock;
  slotHeight: number;
  startHour: number;
  teamId: string;
  onClick?: (service: ServiceForBlock) => void;
  /** Quando true, renderiza como overlay de drag (sem useDraggable, sem tooltip) */
  isOverlay?: boolean;
  /** Número da paragem da equipa neste dia (1, 2, 3...). Só mostrado se > 0 e a equipa tiver >1 serviço. */
  stopIndex?: number;
}

export function ServiceBlock({ service, slotHeight, startHour, teamId, onClick, isOverlay = false, stopIndex }: ServiceBlockProps) {
  const [tooltip, setTooltip] = useState<TooltipState | null>(null);

  const isDraggable = !isOverlay &&
    service.status !== "concluido" &&
    service.status !== "cancelado" &&
    service.status !== "falta";

  const { attributes, listeners, setNodeRef, transform, isDragging } = useDraggable({
    id: service.id,
    data: { service, teamId },
    disabled: !isDraggable,
  });

  const start = parseISO(service.scheduled_start);
  const end   = parseISO(service.scheduled_end);

  const startMin    = start.getHours() * 60 + start.getMinutes();
  const endMin      = end.getHours()   * 60 + end.getMinutes();
  const offsetMin   = startMin - startHour * 60;
  const durationMin = endMin - startMin;

  const top    = (offsetMin / 30) * slotHeight;
  const height = Math.max((durationMin / 30) * slotHeight, slotHeight);

  const s = STATUS_BG[service.status] ?? STATUS_BG.agendado;
  const borderColor = service.team_color ?? s.fallbackBorder;
  const isShort = height <= slotHeight;
  const isMedium = height > slotHeight && height < slotHeight * 3;
  const isLarge = height >= slotHeight * 3;
  const hasAccess = service.location_has_key || service.location_has_access_code;
  const noteText = service.notes?.trim() || "";

  // Overlay não usa transform nem posição absoluta — é controlado pelo DragOverlay
  const overlayStyle: React.CSSProperties = isOverlay ? {
    width: "100%",
    height: `${height - 2}px`,
    backgroundColor: s.bg,
    borderLeft: `3px solid ${borderColor}`,
    border: `1px solid ${borderColor}30`,
    borderLeftWidth: "3px",
    borderRadius: "4px",
    boxShadow: "0 8px 24px rgba(0,0,0,0.18)",
    cursor: "grabbing",
  } : {
    position: "absolute",
    top: `${top + 1}px`,
    height: `${height - 2}px`,
    left: "2px",
    right: "2px",
    backgroundColor: s.bg,
    borderLeft: `3px solid ${borderColor}`,
    border: `1px solid ${borderColor}30`,
    borderLeftWidth: "3px",
    zIndex: isDragging ? 50 : 1,
    opacity: isDragging ? 0.35 : 1,
    transform: CSS.Translate.toString(transform),
    cursor: isDraggable ? (isDragging ? "grabbing" : "grab") : "pointer",
    transition: isDragging ? undefined : "opacity 0.15s ease",
  };

  return (
    <>
      <div
        ref={isOverlay ? undefined : setNodeRef}
        role="button"
        tabIndex={0}
        onClick={(e) => {
          if (isDragging) return;
          e.stopPropagation();
          onClick?.(service);
        }}
        onKeyDown={(e) => e.key === "Enter" && onClick?.(service)}
        onMouseEnter={(e) => !isDragging && setTooltip({ x: e.clientX, y: e.clientY })}
        onMouseLeave={() => setTooltip(null)}
        onMouseMove={(e) => !isDragging && setTooltip({ x: e.clientX, y: e.clientY })}
        className="rounded overflow-hidden select-none focus:outline-none focus:ring-1 focus:ring-[var(--color-primary)] hover:brightness-95 hover:shadow-md"
        style={overlayStyle}
        {...(isOverlay ? {} : { ...listeners, ...attributes })}
      >
        <div className="px-1.5 py-0.5 h-full flex flex-col overflow-hidden relative">
          {stopIndex != null && stopIndex > 0 && (
            <span
              className="absolute top-0.5 right-0.5 w-4 h-4 rounded-full flex items-center justify-center text-[9px] font-bold leading-none shrink-0"
              style={{ backgroundColor: borderColor, color: "#fff", opacity: 0.9 }}
            >
              {stopIndex}
            </span>
          )}
          <span className="text-[10px] font-semibold leading-tight tabular-nums" style={{ color: s.text }}>
            {format(start, "HH:mm")}–{format(end, "HH:mm")}
          </span>
          {/* Cidade/localidade sempre visível, mesmo em cartão pequeno */}
          <span className="text-[11px] font-semibold leading-tight truncate pr-4" style={{ color: s.text }}>
            {extractCity(service.location_address) || service.location_name}
          </span>
          {/* Cliente visível a partir do cartão médio */}
          {!isShort && (
            <span className="text-[10px] leading-tight truncate" style={{ color: s.text, opacity: 0.75 }}>
              {service.client_name}
            </span>
          )}
          {(isMedium || isLarge) && noteText && (
            <span className="text-[10px] leading-tight truncate" style={{ color: s.text, opacity: 0.72 }}>
              Obs: {noteText}
            </span>
          )}
          {!isShort && (service.team_name || hasAccess) && (
            <span className="text-[10px] leading-tight truncate mt-auto" style={{ color: s.text, opacity: 0.6 }}>
              {service.team_name}
              {hasAccess && (
                <span className="inline-flex items-center gap-0.5 ml-1 align-middle">
                  {service.location_has_key && <Key className="inline w-2.5 h-2.5" />}
                  {service.location_has_access_code && <Lock className="inline w-2.5 h-2.5" />}
                </span>
              )}
              {isLarge && (
                <span className="ml-1">{STATUS_LABEL[service.status] ?? service.status}</span>
              )}
            </span>
          )}
        </div>
      </div>

      {!isOverlay && tooltip && !isDragging && <ServiceTooltip service={service} pos={tooltip} />}
    </>
  );
}

import { format, parseISO } from "date-fns";
import { pt } from "date-fns/locale";
import type { ServiceForBlock } from "./service-block";

// ─── Haversine ────────────────────────────────────────────────────────────────

function haversineKm(lat1: number, lng1: number, lat2: number, lng2: number): number {
  const R = 6371;
  const toRad = (d: number) => (d * Math.PI) / 180;
  const dLat = toRad(lat2 - lat1);
  const dLng = toRad(lng2 - lng1);
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

/** Tempo de viagem estimado em minutos (30 km/h média urbana). */
export function travelMinutes(
  lat1: number, lng1: number,
  lat2: number, lng2: number,
): number {
  return Math.max(1, Math.round(haversineKm(lat1, lng1, lat2, lng2) * 2));
}

// ─── Tipos ────────────────────────────────────────────────────────────────────

export interface TeamRoute {
  teamId: string;
  teamName: string;
  teamColor: string;
  services: ServiceForBlock[];
}

// ─── Helpers de cor ─────────────────────────────────────────────────────────

function hexToRgb(hex: string): [number, number, number] {
  const h = hex.replace("#", "");
  return [
    parseInt(h.slice(0, 2), 16) || 0,
    parseInt(h.slice(2, 4), 16) || 0,
    parseInt(h.slice(4, 6), 16) || 0,
  ];
}

/** Versão clara da cor da equipa (mistura com branco) para o fundo dos blocos. */
function tint([r, g, b]: [number, number, number], amount = 0.85): [number, number, number] {
  return [
    Math.round(r + (255 - r) * amount),
    Math.round(g + (255 - g) * amount),
    Math.round(b + (255 - b) * amount),
  ];
}

// ─── Geração do PDF (grelha: colunas = equipas, linhas = horas) ───────────────

export async function generateDayPdf(
  date: Date,
  routes: TeamRoute[],
) {
  const { jsPDF } = await import("jspdf");

  const doc = new jsPDF({ orientation: "landscape", unit: "mm", format: "a4" });
  const pageW = doc.internal.pageSize.getWidth();   // ~297
  const pageH = doc.internal.pageSize.getHeight();  // ~210
  const dateLabel = format(date, "EEEE, d 'de' MMMM 'de' yyyy", { locale: pt });
  const dateShort = format(date, "yyyy-MM-dd");

  // ── Cabeçalho ──────────────────────────────────────────────────────────────
  const margin = 10;
  doc.setFontSize(15);
  doc.setFont("helvetica", "bold");
  doc.setTextColor(22, 163, 74);
  doc.text("Plano Operacional", margin, 12);

  doc.setFontSize(10);
  doc.setFont("helvetica", "normal");
  doc.setTextColor(71, 85, 105);
  doc.text(dateLabel.charAt(0).toUpperCase() + dateLabel.slice(1), margin, 18);

  // ── Intervalo horário (dinâmico, com fallback 7h–18h) ───────────────────────
  let minHour = 7;
  let maxHour = 18;
  const allServices = routes.flatMap((r) => r.services);
  if (allServices.length) {
    const starts = allServices.map((s) => parseISO(s.scheduled_start).getHours());
    const ends   = allServices.map((s) => {
      const e = parseISO(s.scheduled_end);
      return e.getHours() + (e.getMinutes() > 0 ? 1 : 0);
    });
    minHour = Math.min(minHour, ...starts);
    maxHour = Math.max(maxHour, ...ends);
  }
  const totalMinutes = (maxHour - minHour) * 60;

  // ── Geometria da grelha ─────────────────────────────────────────────────────
  const gridTop    = 24;          // abaixo do cabeçalho
  const headerH    = 9;           // faixa com nome das equipas
  const bodyTop    = gridTop + headerH;
  const gridBottom = pageH - 8;   // deixa espaço para o rodapé
  const gutterW    = 13;          // coluna das horas
  const gridLeft   = margin + gutterW;
  const gridRight  = pageW - margin;
  const cols       = routes.length || 1;
  const colW       = (gridRight - gridLeft) / cols;
  const pxPerMin   = (gridBottom - bodyTop) / totalMinutes;

  const yForTime = (iso: string) => {
    const d = parseISO(iso);
    const mins = (d.getHours() * 60 + d.getMinutes()) - minHour * 60;
    return bodyTop + Math.max(0, Math.min(mins, totalMinutes)) * pxPerMin;
  };

  // ── Linhas horárias + etiquetas ─────────────────────────────────────────────
  doc.setDrawColor(226, 232, 235);
  doc.setLineWidth(0.2);
  for (let h = minHour; h <= maxHour; h++) {
    const y = bodyTop + (h - minHour) * 60 * pxPerMin;
    doc.setDrawColor(219, 224, 230);
    doc.line(gridLeft, y, gridRight, y);
    doc.setFontSize(7.5);
    doc.setTextColor(120, 128, 140);
    doc.text(`${String(h).padStart(2, "0")}:00`, margin, y + 2.5);
    // meia-hora (tracejada leve)
    if (h < maxHour) {
      const yHalf = y + 30 * pxPerMin;
      doc.setDrawColor(238, 241, 244);
      doc.line(gridLeft, yHalf, gridRight, yHalf);
    }
  }

  // ── Cabeçalho + separadores das colunas (equipas) ───────────────────────────
  doc.setDrawColor(210, 216, 222);
  doc.setLineWidth(0.2);
  routes.forEach((route, i) => {
    const x = gridLeft + i * colW;
    const rgb = hexToRgb(route.teamColor);

    // Faixa de cor + nome
    doc.setFillColor(rgb[0], rgb[1], rgb[2]);
    doc.rect(x, gridTop, colW, headerH, "F");
    doc.setFontSize(7.5);
    doc.setFont("helvetica", "bold");
    doc.setTextColor(255, 255, 255);
    doc.text(
      doc.splitTextToSize(route.teamName, colW - 3)[0] ?? route.teamName,
      x + 1.5, gridTop + 6,
    );

    // Separador vertical da coluna
    doc.line(x, gridTop, x, gridBottom);
  });
  // Bordas externas da grelha
  doc.line(gridRight, gridTop, gridRight, gridBottom);
  doc.setDrawColor(210, 216, 222);
  doc.line(gridLeft, gridTop, gridRight, gridTop);
  doc.line(gridLeft, bodyTop, gridRight, bodyTop);
  doc.line(gridLeft, gridBottom, gridRight, gridBottom);

  // ── Blocos de serviço ───────────────────────────────────────────────────────
  routes.forEach((route, i) => {
    const x = gridLeft + i * colW;
    const rgb = hexToRgb(route.teamColor);
    const bg  = tint(rgb);

    for (const svc of route.services) {
      const yTop = yForTime(svc.scheduled_start);
      const yEnd = yForTime(svc.scheduled_end);
      const h = Math.max(yEnd - yTop, 5);
      const bx = x + 0.6;
      const bw = colW - 1.2;

      // Fundo + borda esquerda colorida
      doc.setFillColor(bg[0], bg[1], bg[2]);
      doc.setDrawColor(rgb[0], rgb[1], rgb[2]);
      doc.setLineWidth(0.2);
      doc.rect(bx, yTop + 0.4, bw, h - 0.8, "FD");
      doc.setFillColor(rgb[0], rgb[1], rgb[2]);
      doc.rect(bx, yTop + 0.4, 1, h - 0.8, "F");

      // Texto
      const tx = bx + 2.2;
      let ty = yTop + 3.2;
      doc.setTextColor(30, 41, 59);
      doc.setFont("helvetica", "bold");
      doc.setFontSize(6.8);
      const nameLines = doc.splitTextToSize(svc.location_name, bw - 3).slice(0, 2);
      doc.text(nameLines, tx, ty);
      ty += nameLines.length * 2.6;

      if (h > 9) {
        doc.setFont("helvetica", "normal");
        doc.setFontSize(6);
        doc.setTextColor(90, 98, 110);
        const start = parseISO(svc.scheduled_start);
        const end   = parseISO(svc.scheduled_end);
        doc.text(`${format(start, "HH:mm")}–${format(end, "HH:mm")}`, tx, ty);
        ty += 2.4;
        if (h > 14 && svc.location_address) {
          const addr = doc.splitTextToSize(svc.location_address, bw - 3).slice(0, 1);
          doc.text(addr, tx, ty);
        }
      }
    }
  });

  // ── Rodapé ─────────────────────────────────────────────────────────────────
  const totalServices = allServices.length;
  doc.setFontSize(7);
  doc.setTextColor(156, 163, 175);
  doc.setFont("helvetica", "normal");
  doc.text(
    `${totalServices} serviço${totalServices !== 1 ? "s" : ""} · ${routes.length} equipa${routes.length !== 1 ? "s" : ""} · Gerado em ${format(new Date(), "d/MM/yyyy HH:mm")}`,
    margin, pageH - 3,
  );

  doc.save(`plano-${dateShort}.pdf`);
}

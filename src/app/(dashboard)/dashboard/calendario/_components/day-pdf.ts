import { format, parseISO, differenceInMinutes } from "date-fns";
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

// ─── Geração do PDF ───────────────────────────────────────────────────────────

export async function generateDayPdf(
  date: Date,
  routes: TeamRoute[],
) {
  const { jsPDF } = await import("jspdf");
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const autoTable = (await import("jspdf-autotable")).default as (doc: any, options: any) => void;

  const doc = new jsPDF({ orientation: "portrait", unit: "mm", format: "a4" });
  const dateLabel = format(date, "EEEE, d 'de' MMMM 'de' yyyy", { locale: pt });
  const dateShort = format(date, "yyyy-MM-dd");

  // ── Cabeçalho ──────────────────────────────────────────────────────────────
  doc.setFontSize(18);
  doc.setFont("helvetica", "bold");
  doc.setTextColor(22, 163, 74); // verde primário
  doc.text("Plano Operacional", 14, 18);

  doc.setFontSize(11);
  doc.setFont("helvetica", "normal");
  doc.setTextColor(71, 85, 105);
  doc.text(dateLabel.charAt(0).toUpperCase() + dateLabel.slice(1), 14, 26);

  // Linha separadora
  doc.setDrawColor(229, 231, 235);
  doc.setLineWidth(0.5);
  doc.line(14, 30, 196, 30);

  let y = 38;

  const totalServices = routes.reduce((s, r) => s + r.services.length, 0);
  const totalValue = routes.reduce((s, r) =>
    s + r.services.reduce((sv, svc) => sv + (svc.manual_value ?? svc.calculated_value ?? 0), 0), 0,
  );

  doc.setFontSize(9);
  doc.setTextColor(107, 114, 128);
  doc.text(`${totalServices} serviço${totalServices !== 1 ? "s" : ""}  ·  ${routes.length} equipa${routes.length !== 1 ? "s" : ""}  ·  Total: €${totalValue.toFixed(2)}`, 14, y);
  y += 10;

  // ── Secção por equipa ──────────────────────────────────────────────────────
  for (const route of routes) {
    if (!route.services.length) continue;

    const sorted = [...route.services].sort((a, b) =>
      a.scheduled_start.localeCompare(b.scheduled_start),
    );

    // Cabeçalho da equipa
    if (y > 260) { doc.addPage(); y = 18; }

    // Quadrado de cor + nome da equipa
    const hexColor = route.teamColor.replace("#", "");
    const r = parseInt(hexColor.slice(0, 2), 16);
    const g = parseInt(hexColor.slice(2, 4), 16);
    const b = parseInt(hexColor.slice(4, 6), 16);
    doc.setFillColor(r, g, b);
    doc.roundedRect(14, y - 3.5, 4, 4, 1, 1, "F");

    doc.setFontSize(11);
    doc.setFont("helvetica", "bold");
    doc.setTextColor(30, 41, 59);
    doc.text(route.teamName, 21, y);
    y += 6;

    // Construir linhas da tabela com intercalação de viagem
    const tableBody: (string | { content: string; styles: object })[][] = [];

    for (let i = 0; i < sorted.length; i++) {
      const svc = sorted[i];
      const start = parseISO(svc.scheduled_start);
      const end   = parseISO(svc.scheduled_end);
      const durMin = differenceInMinutes(end, start);
      const dur = `${Math.floor(durMin / 60)}h${durMin % 60 > 0 ? `${durMin % 60}m` : ""}`;
      const value = svc.manual_value ?? svc.calculated_value;

      tableBody.push([
        `${i + 1}`,
        `${format(start, "HH:mm")}–${format(end, "HH:mm")}`,
        svc.location_name,
        svc.client_name,
        svc.location_address,
        dur,
        value != null ? `€${value.toFixed(2)}` : "—",
        svc.location_access_code ?? "—",
      ]);

      // Linha de viagem entre este e o próximo
      const next = sorted[i + 1];
      if (
        next &&
        svc.location_lat != null && svc.location_lng != null &&
        next.location_lat != null && next.location_lng != null
      ) {
        const mins = travelMinutes(
          svc.location_lat, svc.location_lng,
          next.location_lat, next.location_lng,
        );
        const dist = haversineKm(svc.location_lat, svc.location_lng, next.location_lat, next.location_lng);
        tableBody.push([
          {
            content: `↓  ~${mins} min de viagem  (${dist.toFixed(1)} km em linha reta)`,
            styles: {
              colSpan: 8,
              fontStyle: "italic",
              textColor: [107, 114, 128],
              fillColor: [249, 250, 251],
              fontSize: 7.5,
            },
          },
          "", "", "", "", "", "", "",
        ]);
      }
    }

    autoTable(doc, {
      startY: y,
      head: [["#", "Horário", "Local", "Cliente", "Morada", "Dur.", "Valor", "Acesso"]],
      body: tableBody,
      theme: "grid",
      styles: { fontSize: 8, cellPadding: 2.5, overflow: "linebreak" },
      headStyles: {
        fillColor: [22, 163, 74],
        textColor: 255,
        fontStyle: "bold",
        fontSize: 8,
      },
      columnStyles: {
        0: { cellWidth: 7, halign: "center" },
        1: { cellWidth: 22 },
        2: { cellWidth: 32 },
        3: { cellWidth: 28 },
        4: { cellWidth: 45 },
        5: { cellWidth: 12, halign: "center" },
        6: { cellWidth: 16, halign: "right" },
        7: { cellWidth: 18, halign: "center" },
      },
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      didParseCell: (data: any) => {
        if (data.row.raw?.[0]?.styles?.colSpan === 8) {
          Object.assign(data.cell.styles, data.row.raw[0].styles);
        }
      },
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      didDrawPage: (data: any) => { y = data.cursor.y + 8; },
    });

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    y = (doc as any).lastAutoTable?.finalY ?? y;
    y += 10;
  }

  // ── Rodapé ─────────────────────────────────────────────────────────────────
  const pageCount = doc.getNumberOfPages();
  for (let p = 1; p <= pageCount; p++) {
    doc.setPage(p);
    doc.setFontSize(7.5);
    doc.setTextColor(156, 163, 175);
    doc.text(
      `Escala · Gerado em ${format(new Date(), "d/MM/yyyy HH:mm")} · Pág. ${p}/${pageCount}`,
      14, 290,
    );
  }

  doc.save(`plano-${dateShort}.pdf`);
}

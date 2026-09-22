// ============================================================================
// O PDF de um orçamento
// ============================================================================
//
// 🔴 LOCAL. Gerado no browser e descarregado, e mais nada.
//
//    Não há persistência do ficheiro, não há bucket, não há anexo enviado por
//    email. Isso é a 103-B2 e tem de trazer consigo a pergunta que este ciclo
//    não responde: qual dos PDF é o que o cliente recebeu, quando um orçamento
//    tem três revisões. Guardar bytes antes de haver resposta seria criar
//    ficheiros que ninguém sabe atribuir.
//
// 🔴 TODOS os valores vêm de `crm_quotes` / `crm_quote_items` — das colunas
//    que a RPC gravou. NADA é recalculado aqui.
//
//    A razão é directa: um recálculo no cliente pode divergir do que a base
//    tem (arredondamento, taxa de IVA que mudou nas definições entretanto), e
//    então o papel que vai para o cliente diz um total que o sistema não
//    confirma. O documento mostra o que está gravado, ou não serve de prova
//    de nada.
//
// 🔴 `internal_notes` NUNCA entra neste ficheiro.
//
//    São notas de trabalho — margem, desconfiança sobre o pagamento, o que
//    for. Existem para a gestora e para mais ninguém. Este módulo não recebe
//    sequer o campo: a assinatura aceita `QuoteWithItems`, e o teste
//    `crm-orcamentos-guard.test.ts` exige que a cadeia `internal_notes`
//    não apareça em lado nenhum deste ficheiro. Um PDF com notas internas
//    entregue a um cliente não se desfaz.
// ============================================================================

import {
  QUOTE_PRICING_KIND_LABELS,
  QUOTE_UNIT_LABELS,
  type QuotePricingKind,
  type QuoteUnit,
} from "@/lib/crm/quotes";
import type { QuoteItemRow, QuoteRow } from "@/app/actions/crm-orcamentos";

interface Entrada {
  quote: QuoteRow;
  items: QuoteItemRow[];
  empresaNome: string;
}

const fmtEur = (v: number): string =>
  new Intl.NumberFormat("pt-PT", { style: "currency", currency: "EUR" }).format(v);

/** Fuso explícito: o processo corre em UTC na Vercel, e a data é civil. */
const fmtDate = (iso: string): string =>
  new Intl.DateTimeFormat("pt-PT", { dateStyle: "medium", timeZone: "Europe/Lisbon" })
    .format(new Date(`${iso}T12:00:00Z`));

const unidade = (u: string): string =>
  QUOTE_UNIT_LABELS[u as QuoteUnit] ?? u;

/**
 * Desenha o PDF e devolve o documento, sem o descarregar.
 *
 * 🔴 Separado de `downloadQuotePdf` para poder ser MEDIDO. Um teste que só
 *    lesse este ficheiro à procura da cadeia `internal_notes` provaria apenas
 *    que a cadeia não está escrita — não que ela não chega ao papel por outro
 *    caminho. Com o documento na mão, `crm-quote-pdf.test.ts` gera o PDF a
 *    sério e procura o texto das notas internas lá dentro.
 *
 * `jspdf` e `jspdf-autotable` entram por import dinâmico, como no resto da
 * aplicação: são ~300 kB que não têm de viajar com a página só porque existe
 * um botão que talvez ninguém carregue.
 */
export async function buildQuotePdf({ quote, items, empresaNome }: Entrada) {
  const { default: jsPDF } = await import("jspdf");
  const { default: autoTable } = await import("jspdf-autotable");

  const doc = new jsPDF({ unit: "mm", format: "a4" });
  const pageW = doc.internal.pageSize.getWidth();
  const margin = 14;
  const rMargin = pageW - margin;

  // ── Cabeçalho ─────────────────────────────────────────────────────────────
  doc.setFillColor(22, 163, 74);
  doc.rect(0, 0, pageW, 30, "F");
  doc.setTextColor(255, 255, 255);
  doc.setFontSize(15);
  doc.setFont("helvetica", "bold");
  doc.text("Orçamento", margin, 12);
  doc.setFontSize(9);
  doc.setFont("helvetica", "normal");
  doc.text(`Nº ${quote.quote_number}`, margin, 20);
  doc.text(empresaNome, rMargin, 12, { align: "right" });
  doc.text(`Emitido: ${fmtDate(quote.issue_date)}`, rMargin, 20, { align: "right" });
  doc.setTextColor(0, 0, 0);

  // ── Destinatário e condições ──────────────────────────────────────────────
  let y = 40;
  const linha = (etiqueta: string, valor: string, largura: number) => {
    doc.setFont("helvetica", "bold");
    doc.text(etiqueta, margin, y);
    doc.setFont("helvetica", "normal");
    doc.text(valor, margin + largura, y);
    y += 6;
  };

  doc.setFontSize(10);
  linha("Para:", quote.target_name, 22);
  linha("Válido até:", fmtDate(quote.valid_until), 26);
  linha(
    "Tipo:",
    QUOTE_PRICING_KIND_LABELS[quote.pricing_kind as QuotePricingKind] ?? quote.pricing_kind,
    22,
  );

  // A revisão só se anuncia quando existe: num R0 a linha seria ruído.
  if (quote.revision > 0) {
    linha("Revisão:", `R${quote.revision}`, 22);
  }

  // ── As linhas ─────────────────────────────────────────────────────────────
  autoTable(doc, {
    startY: y + 2,
    margin: { left: margin, right: margin },
    head: [["Descrição", "Qtd.", "Unidade", "Preço", "Total"]],
    body: items.map((i) => [
      i.description,
      String(i.quantity),
      unidade(i.unit),
      fmtEur(i.unit_price),
      // 🔴 `line_total` gravado pela RPC, não `quantity × unit_price`.
      fmtEur(i.line_total),
    ]),
    styles: { fontSize: 9, cellPadding: 2 },
    headStyles: { fillColor: [22, 163, 74], textColor: 255 },
    columnStyles: {
      1: { halign: "right" },
      3: { halign: "right" },
      4: { halign: "right" },
    },
  });

  // ── Totais ────────────────────────────────────────────────────────────────
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let fy = ((doc as any).lastAutoTable?.finalY ?? y + 20) + 10;

  doc.setFontSize(10);
  doc.text("Subtotal:", rMargin - 60, fy);
  doc.text(fmtEur(quote.subtotal), rMargin, fy, { align: "right" });

  if (quote.discount_pct > 0) {
    fy += 7;
    doc.text(`Desconto (${quote.discount_pct}%):`, rMargin - 60, fy);
    // O valor do desconto é a diferença entre o que está gravado: o subtotal e
    // a base de incidência. A base não tem coluna própria, mas deduz-se sem
    // recalcular nada — `total − IVA` é exactamente o que a RPC somou.
    const base = quote.total - quote.vat_amount;
    doc.text(`− ${fmtEur(quote.subtotal - base)}`, rMargin, fy, { align: "right" });
  }

  fy += 7;
  if (quote.apply_vat && quote.vat_amount > 0) {
    doc.text(`IVA (${quote.vat_rate}%):`, rMargin - 60, fy);
    doc.text(fmtEur(quote.vat_amount), rMargin, fy, { align: "right" });
  } else {
    doc.text("IVA:", rMargin - 60, fy);
    doc.text("Isento de IVA", rMargin, fy, { align: "right" });
  }

  doc.setDrawColor(22, 163, 74);
  doc.line(rMargin - 65, fy + 3, rMargin, fy + 3);
  doc.setFont("helvetica", "bold");
  doc.setFontSize(12);
  doc.setTextColor(22, 163, 74);
  doc.text("Total:", rMargin - 60, fy + 10);
  doc.text(fmtEur(quote.total), rMargin, fy + 10, { align: "right" });
  doc.setTextColor(0, 0, 0);
  doc.setFont("helvetica", "normal");
  doc.setFontSize(9);

  let ny = fy + 20;

  if (quote.payment_terms) {
    doc.setFont("helvetica", "bold");
    doc.text("Condições de pagamento", margin, ny);
    doc.setFont("helvetica", "normal");
    ny += 5;
    for (const l of doc.splitTextToSize(quote.payment_terms, pageW - margin * 2)) {
      doc.text(l, margin, ny);
      ny += 4.5;
    }
    ny += 3;
  }

  // 🔴 `notes` — as notas PARA O CLIENTE. `internal_notes` não existe neste
  //    ficheiro, e não é por falta de espaço.
  if (quote.notes) {
    doc.setFont("helvetica", "bold");
    doc.text("Observações", margin, ny);
    doc.setFont("helvetica", "normal");
    ny += 5;
    for (const l of doc.splitTextToSize(quote.notes, pageW - margin * 2)) {
      doc.text(l, margin, ny);
      ny += 4.5;
    }
  }

  return doc;
}

/** Desenha e descarrega — é o que o botão do detalhe chama. */
export async function downloadQuotePdf(entrada: Entrada): Promise<void> {
  const doc = await buildQuotePdf(entrada);
  // 🔴 A barra é `/` no número (`ORC2026/001`) e `/` não pode aparecer num
  //    nome de ficheiro em Windows nem em macOS.
  doc.save(`${entrada.quote.quote_number.replace(/\//g, "-")}.pdf`);
}

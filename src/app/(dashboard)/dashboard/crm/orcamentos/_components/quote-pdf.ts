// ============================================================================
// O PDF do orçamento
// ============================================================================
//
// 🔴 `jspdf` é importado dinamicamente e só corre no cliente. No servidor pesa
//    e parte (depende de `window`). É o mesmo padrão do PDF das cobranças
//    (`cobrancas/_components/invoices-client.tsx`), e o layout segue-o de
//    propósito: quem já conhece um documento da casa reconhece o outro.
//
// 🔴 O PDF apresenta números; não os calcula. Os totais vêm do orçamento tal
//    como está gravado — recalcular aqui abriria a porta a um documento que diz
//    um valor e a base diz outro.
// ============================================================================

import type { QuoteRow } from "@/app/actions/crm-orcamentos";
import { QUOTE_UNIT_LABELS, type QuoteUnit } from "@/lib/crm/quotes";

function fmtEur(v: number): string {
  return new Intl.NumberFormat("pt-PT", { minimumFractionDigits: 2, maximumFractionDigits: 2 })
    .format(v);
}

function fmtData(iso: string | null): string {
  if (!iso) return "—";
  const [a, m, d] = iso.slice(0, 10).split("-");
  return `${d}/${m}/${a}`;
}

export interface QuotePdfOptions {
  /** Telefone da empresa para o rodapé. */
  companyPhone?: string;
}

/**
 * Constrói o PDF e devolve-o como `Blob`, para quem chama decidir o que fazer
 * — descarregar, ou enviar por email.
 *
 * Separar a construção do destino é o que permite que o mesmo documento vá
 * para o ecrã e para o anexo do email, sem serem dois PDF diferentes.
 */
export async function buildQuotePdf(
  quote: QuoteRow,
  opts: QuotePdfOptions = {},
): Promise<Blob> {
  const { default: jsPDF } = await import("jspdf");
  const { default: autoTable } = await import("jspdf-autotable");

  const doc = new jsPDF({ unit: "mm", format: "a4" });
  const pageW = 210;
  const margin = 14;

  // ── Cabeçalho ──
  doc.setFillColor(22, 163, 74);
  doc.rect(0, 0, pageW, 30, "F");
  doc.setTextColor(255, 255, 255);
  doc.setFontSize(15);
  doc.setFont("helvetica", "bold");
  doc.text("Orçamento", margin, 12);
  doc.setFontSize(9);
  doc.setFont("helvetica", "normal");
  doc.text(`Nº ${quote.quote_number}`, margin, 20);
  doc.text(`Data: ${fmtData(quote.issue_date)}`, pageW - margin - 45, 20);
  doc.setTextColor(0, 0, 0);

  // ── Identificação ──
  let y = 38;
  doc.setFontSize(10);

  const linha = (rotulo: string, valor: string, largura = 28) => {
    doc.setFont("helvetica", "bold");
    doc.text(rotulo, margin, y);
    doc.setFont("helvetica", "normal");
    doc.text(valor, margin + largura, y);
    y += 7;
  };

  linha("Cliente:", quote.target_name, 22);
  linha("Válido até:", fmtData(quote.valid_until));
  if (quote.proposed_frequency) linha("Periodicidade:", quote.proposed_frequency, 30);

  // ── Linhas ──
  autoTable(doc, {
    startY: y + 6,
    margin: { left: margin, right: margin },
    head: [["Descrição", "Qtd.", "Un.", "Preço (€)", "Total (€)"]],
    body: (quote.items ?? []).map((it) => [
      it.description,
      String(it.quantity),
      QUOTE_UNIT_LABELS[it.unit as QuoteUnit] ?? it.unit,
      fmtEur(it.unit_price),
      fmtEur(it.line_total),
    ]),
    headStyles: { fillColor: [22, 163, 74], textColor: 255, fontStyle: "bold", fontSize: 9 },
    bodyStyles: { fontSize: 9 },
    alternateRowStyles: { fillColor: [248, 250, 252] },
    columnStyles: {
      0: { cellWidth: 82 },
      1: { halign: "right" },
      2: { halign: "center" },
      3: { halign: "right" },
      4: { halign: "right" },
    },
  });

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let fimTabela = (doc as any).lastAutoTable.finalY + 8;
  const rMargin = pageW - margin;

  doc.setFontSize(10);
  doc.text("Subtotal:", rMargin - 60, fimTabela);
  doc.text(fmtEur(quote.subtotal), rMargin, fimTabela, { align: "right" });

  // O desconto só aparece quando existe: uma linha a dizer «Desconto: 0,00 €»
  // é ruído num documento que vai para um cliente.
  if (quote.discount_pct > 0) {
    fimTabela += 7;
    doc.text(`Desconto (${quote.discount_pct}%):`, rMargin - 60, fimTabela);
    doc.text(
      `-${fmtEur(quote.subtotal - (quote.total - quote.vat_amount))}`,
      rMargin,
      fimTabela,
      { align: "right" },
    );
  }

  fimTabela += 7;
  if (quote.apply_vat && quote.vat_rate > 0) {
    doc.text(`IVA (${quote.vat_rate}%):`, rMargin - 60, fimTabela);
    doc.text(fmtEur(quote.vat_amount), rMargin, fimTabela, { align: "right" });
  } else {
    doc.text("IVA:", rMargin - 60, fimTabela);
    doc.text("Isento", rMargin, fimTabela, { align: "right" });
  }

  doc.setDrawColor(22, 163, 74);
  doc.line(rMargin - 65, fimTabela + 3, rMargin, fimTabela + 3);
  doc.setFont("helvetica", "bold");
  doc.setFontSize(12);
  doc.setTextColor(22, 163, 74);
  doc.text("TOTAL:", rMargin - 60, fimTabela + 11);
  doc.text(fmtEur(quote.total), rMargin, fimTabela + 11, { align: "right" });
  doc.setTextColor(0, 0, 0);
  doc.setFont("helvetica", "normal");

  let yFim = fimTabela + 22;

  if (quote.payment_terms) {
    doc.setFontSize(9);
    doc.setFont("helvetica", "bold");
    doc.text("Condições de pagamento", margin, yFim);
    doc.setFont("helvetica", "normal");
    yFim += 5;
    for (const l of doc.splitTextToSize(quote.payment_terms, pageW - margin * 2)) {
      doc.text(l, margin, yFim);
      yFim += 4.5;
    }
    yFim += 3;
  }

  if (quote.notes) {
    doc.setFontSize(9);
    doc.setFont("helvetica", "bold");
    doc.text("Observações", margin, yFim);
    doc.setFont("helvetica", "normal");
    yFim += 5;
    for (const l of doc.splitTextToSize(quote.notes, pageW - margin * 2)) {
      doc.text(l, margin, yFim);
      yFim += 4.5;
    }
  }

  // 🔴 As notas internas NUNCA entram no PDF. É o campo onde se escreve «este
  //    cliente regateia» ou «margem apertada» — vai para um cliente e é um
  //    problema. Por isso não há aqui nenhuma referência a `internal_notes`.

  // ── Rodapé ──
  doc.setFontSize(8);
  doc.setTextColor(150, 150, 150);
  const rodape = opts.companyPhone
    ? `Mó Limpezas Lda · Portugal · ${opts.companyPhone}`
    : "Mó Limpezas Lda · Portugal";
  doc.text(rodape, pageW / 2, 287, { align: "center" });

  return doc.output("blob");
}

/** Nome de ficheiro legível, sem a barra do número. */
export function quotePdfFilename(quote: QuoteRow): string {
  return `${quote.quote_number.replace("/", "-")}.pdf`;
}

/** Constrói e descarrega — o caminho do botão «Ver PDF». */
export async function downloadQuotePdf(quote: QuoteRow, opts?: QuotePdfOptions): Promise<void> {
  const blob = await buildQuotePdf(quote, opts);
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = quotePdfFilename(quote);
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  // Sem isto, o blob fica em memória até a aba fechar.
  URL.revokeObjectURL(url);
}

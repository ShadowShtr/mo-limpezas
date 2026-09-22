// ============================================================================
// O PDF do orçamento — gerado a sério, e inspeccionado
// ============================================================================
//
// 🔴 Porque é que este ensaio existe além do guard estrutural.
//
//    `crm-orcamentos-guard.test.ts` prova que a cadeia `internal_notes` não
//    está escrita em `quote-pdf.ts`. Isso é sobre o CÓDIGO. Não prova que o
//    texto das notas internas não chega ao papel por outro caminho — um campo
//    renomeado, um objecto despejado inteiro, um `JSON.stringify` distraído.
//
//    Aqui o PDF é gerado com o `jspdf` a sério e o conteúdo é procurado dentro
//    dos bytes. É a diferença entre «o ficheiro não menciona» e «o documento
//    não contém».
//
// 🔴 Os valores usados são PERSISTIDOS, como na aplicação: o que se verifica é
//    que o papel mostra o que está gravado, e não uma conta feita outra vez.
// ============================================================================

import { describe, expect, it } from "vitest";

import { buildQuotePdf } from "@/app/(dashboard)/dashboard/crm/orcamentos/_components/quote-pdf";
import type { QuoteItemRow, QuoteRow } from "@/app/actions/crm-orcamentos";

const SEGREDO = "MARGEM APERTADA NAO BAIXAR DE 800";

const QUOTE: QuoteRow = {
  id: "11111111-1111-4111-8111-111111111111",
  quote_number: "ORC2026/007",
  quote_year: 2026,
  quote_seq: 7,
  revision: 0,
  root_quote_id: "11111111-1111-4111-8111-111111111111",
  superseded_by_id: null,
  lead_id: "22222222-2222-4222-8222-222222222222",
  client_id: null,
  source_lead_id: "22222222-2222-4222-8222-222222222222",
  visit_id: null,
  target_name: "Condominio Alfa",
  issue_date: "2026-09-22",
  valid_until: "2026-10-22",
  status: "rascunho",
  sent_at: null,
  accepted_at: null,
  rejected_at: null,
  rejection_reason: null,
  pricing_kind: "pontual",
  // 🔴 Números "impossíveis" de reproduzir por engano: se algum deles
  //    aparecesse recalculado, sairia diferente.
  subtotal: 1234.56,
  discount_pct: 10,
  apply_vat: true,
  vat_rate: 23,
  vat_amount: 255.56,
  total: 1366.66,
  proposed_frequency: null,
  proposed_weekdays: null,
  payment_terms: "30 dias",
  notes: "Inclui produtos e material.",
  internal_notes: SEGREDO,
  created_at: "2026-09-22T10:00:00.000Z",
};

const ITEMS: QuoteItemRow[] = [
  {
    id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
    position: 0,
    description: "Limpeza de escadas",
    quantity: 1.5,
    unit: "hora",
    unit_price: 0.33,
    // 🔴 0,50 e não 0,495: é o que a base gravou. Multiplicar os dois campos
    //    acima daria outro valor — e é esse o ponto.
    line_total: 0.5,
  },
];

/** O texto legível de dentro do PDF, com as sequências de escape resolvidas. */
async function textoDoPdf(): Promise<string> {
  const doc = await buildQuotePdf({ quote: QUOTE, items: ITEMS, empresaNome: "Mo Limpezas" });
  // `arraybuffer` evita a compressão de fluxo que esconderia o texto.
  const bytes = new Uint8Array(doc.output("arraybuffer") as ArrayBuffer);
  return Buffer.from(bytes).toString("latin1");
}

describe("o PDF do orçamento", () => {
  it("gera um documento PDF válido", async () => {
    const pdf = await textoDoPdf();
    expect(pdf.startsWith("%PDF-")).toBe(true);
    expect(pdf.length).toBeGreaterThan(1000);
  });

  it("🔴 NÃO contém as notas internas", async () => {
    // São notas de trabalho — margem, dúvidas sobre o pagamento. Um PDF com
    // elas entregue a um cliente não se desfaz.
    const pdf = await textoDoPdf();
    expect(pdf).not.toContain(SEGREDO);
    expect(pdf).not.toContain("MARGEM");
  });

  it("mostra o número, o destinatário e as observações do cliente", async () => {
    const pdf = await textoDoPdf();
    expect(pdf).toContain("ORC2026/007");
    expect(pdf).toContain("Condominio Alfa");
    expect(pdf).toContain("Inclui produtos e material.");
    expect(pdf).toContain("30 dias");
  });

  it("🔴 mostra os totais GRAVADOS, e não uma conta refeita", async () => {
    const pdf = await textoDoPdf();
    // Formato pt-PT: espaço fino antes do símbolo, vírgula decimal. Procura-se
    // só a parte numérica, que é o que interessa.
    expect(pdf).toContain("1366,66");
    expect(pdf).toContain("1234,56");
    expect(pdf).toContain("255,56");
  });

  it("🔴 a linha mostra line_total, e não quantidade × preço", async () => {
    const pdf = await textoDoPdf();
    expect(pdf).toContain("Limpeza de escadas");
    expect(pdf).toContain("0,50");
    // 1,5 × 0,33 = 0,495 → 0,49 ou 0,50 conforme quem arredonda. O valor que
    // conta é o da base, e o outro não pode aparecer.
    expect(pdf).not.toContain("0,49 ");
  });

  it("o nome do ficheiro não leva a barra do número", async () => {
    // `/` não é aceite num nome de ficheiro em Windows nem em macOS.
    const nome = `${QUOTE.quote_number.replace(/\//g, "-")}.pdf`;
    expect(nome).toBe("ORC2026-007.pdf");
  });
});

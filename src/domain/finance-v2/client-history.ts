// ============================================================================
// Histórico financeiro do cliente
// ============================================================================
//
// Responde a duas perguntas que a gestão fez por palavras suas:
//
//   «Quanto é que este cliente nos pagou em cada mês?»
//   «Quanto é que já nos pagou no ano?»
//
// ---------------------------------------------------------------------------
// Conceitos que não se confundem
// ---------------------------------------------------------------------------
//
//   Faturado        faturas **emitidas** — um rascunho não é faturação
//   Nota de cobrança recebível independente, sem fingir que é fatura
//   Recebido        dinheiro que entrou, por qualquer uma das duas origens
//   Em aberto       fatura ou nota ainda não recebida integralmente
//
// 🔴 Um serviço agendado **não** é faturação, e um contrato previsto **não** é
//    receita. Confundi-los daria a um cliente um histórico de pagamentos que
//    ele nunca fez — e essa é a conversa mais difícil que um sistema destes
//    pode provocar.
//
// Puro: recebe factos, devolve o histórico. Sem Supabase, sem relógio.
// ============================================================================

import type { FactoFatura, Fonte } from "./aggregate";
import { ESTADOS_FATURADO, ESTADOS_PAGA, periodoDaFatura } from "./aggregate";

export interface FactoNotaCobranca {
  id: string;
  clientId: string;
  chargeDate: string;
  total: number;
  received: number;
  paidAt: string | null;
}

export interface MesCliente {
  /** 1–12. */
  month: number;
  invoiced: number;
  received: number;
  outstanding: number;
  invoiceCount: number;
  paymentCount: number;
  manualCharged: number;
  manualReceived: number;
  manualOutstanding: number;
  manualChargeCount: number;
}

export interface HistoricoCliente {
  estado: "AVAILABLE" | "EMPTY" | "ERROR";
  clientId: string;
  year: number;
  /** Sempre 12 meses, de Janeiro a Dezembro. */
  months: MesCliente[];
  yearInvoiced: number;
  yearReceived: number;
  yearOutstanding: number;
  invoiceCount: number;
  yearManualCharged: number;
  yearManualReceived: number;
  yearManualOutstanding: number;
  manualChargeCount: number;
  nota?: string;
}

function cent(n: number): number {
  return Math.round(n * 100) / 100;
}

/** O mês de uma data `YYYY-MM-DD`, se pertencer ao ano pedido. */
function mesNoAno(iso: string | null, year: number): number | null {
  if (!iso) return null;
  const d = iso.slice(0, 10);
  if (Number(d.slice(0, 4)) !== year) return null;
  const m = Number(d.slice(5, 7));
  return m >= 1 && m <= 12 ? m : null;
}

/**
 * Monta o histórico de um cliente num ano.
 *
 * 🔴 Um mês sem movimento é **zero real**, não «indisponível». A leitura
 *    correu, o cliente simplesmente não pagou nada nesse mês — e o gráfico tem
 *    de mostrar a barra vazia, porque um mês em falta lê-se como um buraco nos
 *    dados em vez de um mês sem faturação.
 *
 * `recebimentos` é opcional: quando não há fonte conciliada de pagamentos de
 * fatura, usa-se o `paid_at` da própria fatura. As duas nunca se somam — seria
 * contar o mesmo dinheiro duas vezes.
 *
 * `notas` é uma segunda origem, discriminada. Soma no total recebido/em aberto,
 * mas NUNCA em `invoiced`/`invoiceCount`.
 */
export function montarHistoricoCliente(
  faturas: Fonte<FactoFatura>,
  clientId: string,
  year: number,
  recebimentos?: Fonte<{ date: string; amount: number }>,
  notas?: Fonte<FactoNotaCobranca>,
): HistoricoCliente {
  const vazio = (estado: HistoricoCliente["estado"], nota?: string): HistoricoCliente => ({
    estado,
    clientId,
    year,
    months: Array.from({ length: 12 }, (_, i) => ({
      month: i + 1,
      invoiced: 0,
      received: 0,
      outstanding: 0,
      invoiceCount: 0,
      paymentCount: 0,
      manualCharged: 0,
      manualReceived: 0,
      manualOutstanding: 0,
      manualChargeCount: 0,
    })),
    yearInvoiced: 0,
    yearReceived: 0,
    yearOutstanding: 0,
    invoiceCount: 0,
    yearManualCharged: 0,
    yearManualReceived: 0,
    yearManualOutstanding: 0,
    manualChargeCount: 0,
    nota,
  });

  if (!faturas.ok) return vazio("ERROR", faturas.erro);
  if (recebimentos && !recebimentos.ok) return vazio("ERROR", recebimentos.erro);
  if (notas && !notas.ok) return vazio("ERROR", notas.erro);

  const meses = vazio("AVAILABLE").months;

  // Só as faturas deste cliente. O filtro é explícito e não depende de quem
  // chamou ter filtrado antes — isolar clientes é o mínimo que este relatório
  // tem de garantir.
  const doCliente = faturas.factos.filter((f) => f.clientId === clientId);

  for (const f of doCliente) {
    if (!(ESTADOS_FATURADO as readonly string[]).includes(f.status)) continue;

    const mFat = mesNoAno(periodoDaFatura(f), year);
    if (mFat !== null) {
      const b = meses[mFat - 1];
      b.invoiced = cent(b.invoiced + f.total);
      b.invoiceCount += 1;

      const pago = (ESTADOS_PAGA as readonly string[]).includes(f.status) || f.paidAt != null;
      if (!pago) b.outstanding = cent(b.outstanding + f.total);
    }

    // Recebido pelas próprias faturas, quando não há fonte de caixa dedicada.
    if (!recebimentos) {
      const mPag = mesNoAno(f.paidAt, year);
      if (mPag !== null) {
        const b = meses[mPag - 1];
        b.received = cent(b.received + f.total);
        b.paymentCount += 1;
      }
    }
  }

  // Fonte de caixa dedicada às faturas, quando existe. Substitui — não acumula.
  if (recebimentos && recebimentos.ok) {
    for (const r of recebimentos.factos) {
      const m = mesNoAno(r.date, year);
      if (m === null) continue;
      const b = meses[m - 1];
      b.received = cent(b.received + r.amount);
      b.paymentCount += 1;
    }
  }

  // Notas de cobrança entram pela própria origem. O valor total pertence ao
  // mês da obrigação; o recebido pertence ao mês em que efetivamente entrou.
  if (notas?.ok) {
    for (const n of notas.factos.filter((item) => item.clientId === clientId)) {
      const mCharge = mesNoAno(n.chargeDate, year);
      const received = cent(Math.max(0, Math.min(n.received, n.total)));
      const open = cent(Math.max(0, n.total - received));
      if (mCharge !== null) {
        const b = meses[mCharge - 1];
        b.manualCharged = cent(b.manualCharged + n.total);
        b.manualOutstanding = cent(b.manualOutstanding + open);
        b.outstanding = cent(b.outstanding + open);
        b.manualChargeCount += 1;
      }
      const mPaid = mesNoAno(n.paidAt, year);
      if (mPaid !== null && received > 0) {
        const b = meses[mPaid - 1];
        b.manualReceived = cent(b.manualReceived + received);
        b.received = cent(b.received + received);
        b.paymentCount += 1;
      }
    }
  }

  const yearInvoiced = cent(meses.reduce((a, m) => a + m.invoiced, 0));
  const yearReceived = cent(meses.reduce((a, m) => a + m.received, 0));
  const yearOutstanding = cent(meses.reduce((a, m) => a + m.outstanding, 0));
  const invoiceCount = meses.reduce((a, m) => a + m.invoiceCount, 0);
  const yearManualCharged = cent(meses.reduce((a, m) => a + m.manualCharged, 0));
  const yearManualReceived = cent(meses.reduce((a, m) => a + m.manualReceived, 0));
  const yearManualOutstanding = cent(meses.reduce((a, m) => a + m.manualOutstanding, 0));
  const manualChargeCount = meses.reduce((a, m) => a + m.manualChargeCount, 0);

  return {
    estado: invoiceCount === 0 && manualChargeCount === 0 && yearReceived === 0 ? "EMPTY" : "AVAILABLE",
    clientId,
    year,
    months: meses,
    yearInvoiced,
    yearReceived,
    yearOutstanding,
    invoiceCount,
    yearManualCharged,
    yearManualReceived,
    yearManualOutstanding,
    manualChargeCount,
  };
}

export const NOMES_MESES = [
  "Jan", "Fev", "Mar", "Abr", "Mai", "Jun",
  "Jul", "Ago", "Set", "Out", "Nov", "Dez",
] as const;

"use client";

// ============================================================================
// Cobranças → Por cliente
// ============================================================================
//
// Responde às duas perguntas da gestão: quanto é que este cliente pagou em
// cada mês, e quanto já pagou no ano.
//
// Vive **dentro de Cobranças**, e não como oitava vista do Financeiro. Uma aba
// nova no módulo seria um segundo sítio para falar de faturação, e os dois
// acabariam a discordar.
// ============================================================================

import { useEffect, useState, useTransition } from "react";
import { Users } from "lucide-react";

import {
  getClientFinancialHistory,
  listClientsForFinance,
} from "@/app/actions/client-financial-history";
import { NOMES_MESES, type HistoricoCliente } from "@/domain/finance-v2/client-history";
import { FinanceCard, SectionHeader } from "@/components/financeiro/v2/finance-card";
import { FinanceKpiCard, FinanceKpiGrid } from "@/components/financeiro/v2/finance-kpi-card";
import { ErroCard, Skeleton, VazioCompacto } from "@/components/financeiro/v2/visual-contract";
import { fmtEur, fmtEurCompact } from "@/lib/finance-format";
import { ChartNoAxesCombined, Clock3, ReceiptText, Wallet } from "lucide-react";

const ANOS = [2026, 2025, 2024];

export function ClientHistoryClient({ clienteInicial }: { clienteInicial?: string }) {
  const [clientes, setClientes] = useState<{ id: string; name: string }[]>([]);
  const [clientId, setClientId] = useState(clienteInicial ?? "");
  const [year, setYear] = useState(ANOS[0]);
  const [hist, setHist] = useState<HistoricoCliente | null>(null);
  const [erro, setErro] = useState<string | null>(null);
  const [pendente, iniciar] = useTransition();

  useEffect(() => {
    listClientsForFinance().then((r) => {
      if (!r.ok) { setErro(r.error); return; }
      setClientes(r.clients);
      if (!clientId && r.clients.length > 0) setClientId(r.clients[0].id);
    });
    // Só à montagem: a lista de clientes não depende do filtro.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    if (!clientId) return;
    iniciar(async () => {
      const r = await getClientFinancialHistory({ clientId, year });
      if (r.ok) { setHist(r.data); setErro(null); }
      else { setHist(null); setErro(r.error); }
    });
  }, [clientId, year]);

  const nome = clientes.find((c) => c.id === clientId)?.name ?? "—";
  const maxMes = hist ? Math.max(...hist.months.map((m) => m.received), 1) : 1;

  return (
    <div className="space-y-4">
      {/* Filtros */}
      <FinanceCard>
        <div className="flex flex-wrap items-end gap-3">
          <div className="min-w-[200px]">
            <label htmlFor="hc-cliente" className="block text-[12px] font-medium text-[#344054] mb-1.5">
              Cliente
            </label>
            <select
              id="hc-cliente"
              value={clientId}
              onChange={(e) => setClientId(e.target.value)}
              className="w-full h-10 px-3 rounded-[10px] border border-[var(--finance-border)] bg-white text-[13px] text-[var(--finance-text)] focus:outline-none focus:ring-2 focus:ring-[var(--finance-primary)]"
            >
              {clientes.length === 0 && <option value="">A carregar…</option>}
              {clientes.map((c) => (
                <option key={c.id} value={c.id}>{c.name}</option>
              ))}
            </select>
          </div>
          <div className="w-[120px]">
            <label htmlFor="hc-ano" className="block text-[12px] font-medium text-[#344054] mb-1.5">
              Ano
            </label>
            <select
              id="hc-ano"
              value={year}
              onChange={(e) => setYear(Number(e.target.value))}
              className="w-full h-10 px-3 rounded-[10px] border border-[var(--finance-border)] bg-white text-[13px] text-[var(--finance-text)] focus:outline-none focus:ring-2 focus:ring-[var(--finance-primary)]"
            >
              {ANOS.map((a) => <option key={a} value={a}>{a}</option>)}
            </select>
          </div>
        </div>
      </FinanceCard>

      {erro && <FinanceCard><ErroCard mensagem={erro} /></FinanceCard>}

      {/* KPIs do cliente.
          🔴 Faturado, Recebido e Em aberto são três conceitos, não três nomes
             para o mesmo número. Um rascunho não entra em nenhum deles. */}
      <FinanceKpiGrid>
        <FinanceKpiCard
          label="Faturado no ano"
          slot={pendente || !hist ? { estado: "carregando" } : { estado: "pronto", dados: fmtEur(hist.yearInvoiced) }}
          icon={<ChartNoAxesCombined className="w-[18px] h-[18px]" />}
          tom="primary"
        />
        <FinanceKpiCard
          label="Recebido no ano"
          slot={pendente || !hist ? { estado: "carregando" } : { estado: "pronto", dados: fmtEur(hist.yearReceived) }}
          icon={<Wallet className="w-[18px] h-[18px]" />}
          tom="green"
        />
        <FinanceKpiCard
          label="Em aberto"
          slot={pendente || !hist ? { estado: "carregando" } : { estado: "pronto", dados: fmtEur(hist.yearOutstanding) }}
          icon={<Clock3 className="w-[18px] h-[18px]" />}
          tom="orange"
        />
        <FinanceKpiCard
          label="Faturas"
          slot={pendente || !hist ? { estado: "carregando" } : { estado: "pronto", dados: String(hist.invoiceCount) }}
          icon={<ReceiptText className="w-[18px] h-[18px]" />}
          tom="neutral"
        />
      </FinanceKpiGrid>

      {/* Gráfico dos doze meses */}
      <FinanceCard>
        <SectionHeader
          title={`Pagamentos recebidos — ${year}`}
          hint={nome}
          right={
            <span className="flex items-center gap-1.5 text-[11px] text-[var(--finance-text-secondary)]">
              <span className="w-2.5 h-2.5 rounded-full inline-block bg-[var(--finance-green)]" />
              Recebido
            </span>
          }
        />

        {pendente || !hist ? (
          <Skeleton h={180} />
        ) : hist.estado === "EMPTY" ? (
          <VazioCompacto texto={`Sem movimento financeiro para ${nome} em ${year}.`} />
        ) : (
          <div className="space-y-2.5">
            {hist.months.map((m) => (
              <div key={m.month} className="flex items-center gap-3">
                <span className="w-8 shrink-0 text-[11.5px] text-[var(--finance-text-muted)]">
                  {NOMES_MESES[m.month - 1]}
                </span>
                <span className="flex-1 h-2.5 rounded-full bg-[var(--finance-track)] overflow-hidden">
                  {/* Um mês sem movimento fica com a barra vazia — é zero real,
                      e não um buraco nos dados. */}
                  <span
                    className="block h-2.5 rounded-full bg-[var(--finance-green)] transition-all"
                    style={{ width: `${m.received > 0 ? Math.max((m.received / maxMes) * 100, 2) : 0}%` }}
                  />
                </span>
                <span className="w-[86px] shrink-0 text-right text-[12.5px] font-semibold text-[var(--finance-text)] tabular-nums">
                  {m.received > 0 ? fmtEurCompact(m.received) : "—"}
                </span>
              </div>
            ))}
          </div>
        )}
      </FinanceCard>

      {clientes.length === 0 && !erro && (
        <FinanceCard>
          <div className="flex items-center gap-3 py-2">
            <Users className="w-4 h-4 text-[var(--finance-text-muted)]" aria-hidden />
            <p className="text-[13px] text-[var(--finance-text-muted)]">A carregar clientes…</p>
          </div>
        </FinanceCard>
      )}
    </div>
  );
}

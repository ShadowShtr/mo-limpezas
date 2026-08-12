"use client";

import { useState, useEffect, useCallback } from "react";
import {
  ChevronDown, CheckCircle2, Circle,
  ChartNoAxesCombined, Wallet, Clock3, ReceiptText, PieChart,
} from "lucide-react";
import { createClient } from "@/lib/supabase/client";
import {
  getOperationalSummary,
  type FinancialDashboardData,
  type OperationalSummary,
} from "@/app/actions/financial-dashboard";
import { FinanceCard } from "@/components/financeiro/v2/finance-card";
import { FinanceKpiCard, FinanceKpiGrid } from "@/components/financeiro/v2/finance-kpi-card";
import { FinanceAlertStrip, type AlertaItem } from "@/components/financeiro/v2/finance-alert-strip";
import { FinanceAttentionPanel, type AtencaoItem } from "@/components/financeiro/v2/finance-attention-panel";
import { FinanceMainChart } from "@/components/financeiro/v2/finance-chart-card";
import {
  FinanceAging,
  FinanceCashForecast,
  FinanceRevenueByService,
  FinanceTeamEfficiency,
  FinanceTopClients,
} from "@/components/financeiro/v2/finance-intelligence";
import { ErroCard, Skeleton } from "@/components/financeiro/v2/visual-contract";
import { fmtEur, fmtEurCompact } from "@/lib/finance-format";

// ─── Tabela mensal resumida ────────────────────────────────────────────────────

function MonthlyTable({ data }: { data: FinancialDashboardData["monthly"] }) {
  const visible = [...data].reverse();

  return (
    <div className="bg-white rounded-xl border border-[var(--color-border)] p-5">
      <p className="text-sm font-semibold text-[var(--color-text-main)] mb-4">Receita e Custos — últimos 12 meses</p>
      <div className="overflow-x-auto">
        <table className="w-full text-xs">
          <thead>
            <tr className="text-[var(--color-text-muted)] border-b border-[var(--color-border)]">
              <th className="pb-2 px-3 text-left font-medium">Mês</th>
              <th className="pb-2 px-3 text-right font-medium">Receita</th>
              <th className="pb-2 px-3 text-right font-medium">Custos</th>
              <th className="pb-2 px-3 text-right font-medium">Margem</th>
              <th className="pb-2 px-3 text-right font-medium">%</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-[var(--color-border)]">
            {visible.map((m) => {
              const pct = m.revenue > 0 ? Math.round((m.margin / m.revenue) * 100) : 0;
              return (
                <tr key={`${m.year}-${m.month}`} className="hover:bg-[var(--color-background)]">
                  <td className="py-2 px-3 font-medium text-[var(--color-text-main)]">{m.label}</td>
                  <td className="py-2 px-3 text-right text-[var(--color-text-main)]">{fmtEur(m.revenue)}</td>
                  <td className="py-2 px-3 text-right text-[var(--color-text-sub)]">{fmtEur(m.costs)}</td>
                  <td className={`py-2 px-3 text-right font-medium ${m.margin >= 0 ? "text-[var(--color-primary)]" : "text-red-500"}`}>
                    {fmtEur(m.margin)}
                  </td>
                  <td className={`py-2 px-3 text-right ${pct >= 0 ? "text-[var(--color-primary)]" : "text-red-500"}`}>
                    {pct}%
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </div>
  );
}

// ─── Resumo operacional (dia / semana / mês, em tempo real) ────────────────────

type Period = "today" | "week" | "month";

// Lista de conferência do período selecionado: no dia mostra serviço a serviço;
// na semana/mês agrupa por cliente — para bater o total do cartão linha a linha.
function PeriodBreakdown({ period, summary }: { period: Period; summary: OperationalSummary }) {
  const { rows, bounds } = summary;
  const inPeriod = (day: string) =>
    period === "today"
      ? day === bounds.today
      : period === "week"
      ? day >= bounds.weekStart && day <= bounds.weekEnd
      : day >= bounds.monthStart && day <= bounds.monthEnd;

  const periodRows = rows.filter((r) => inPeriod(r.day));
  const total = periodRows.reduce((s, r) => s + r.value, 0);
  const title = period === "today" ? "Serviços de hoje" : period === "week" ? "Clientes da semana" : "Clientes do mês";

  if (periodRows.length === 0) {
    return (
      <div className="bg-white rounded-xl border border-[var(--color-border)] p-6 text-center text-sm text-[var(--color-text-muted)]">
        Sem serviços neste período.
      </div>
    );
  }

  if (period === "today") {
    const sorted = [...periodRows].sort((a, b) => a.client_name.localeCompare(b.client_name, "pt"));
    return (
      <BreakdownShell title={title} total={total} count={periodRows.length}>
        {sorted.map((r) => (
          <div key={r.id} className="flex items-center gap-3 px-4 py-2.5">
            {r.status === "concluido"
              ? <CheckCircle2 className="w-4 h-4 text-green-600 shrink-0" />
              : <Circle className="w-4 h-4 text-[var(--color-border)] shrink-0" />}
            <div className="flex-1 min-w-0">
              <p className="text-sm font-medium text-[var(--color-text-main)] truncate">
                {r.client_name}
                {r.is_avenca && <span className="ml-2 text-[10px] font-medium px-1.5 py-0.5 rounded-full bg-blue-50 text-blue-700 border border-blue-200">Avença</span>}
              </p>
              <p className="text-xs text-[var(--color-text-muted)] truncate">{r.location_name}</p>
            </div>
            <p className="text-sm font-semibold text-[var(--color-text-main)] shrink-0">{fmtEur(r.value)}</p>
          </div>
        ))}
      </BreakdownShell>
    );
  }

  // Semana / mês: agrupar por cliente
  const byClient = new Map<string, { count: number; done: number; total: number; hasAvenca: boolean }>();
  for (const r of periodRows) {
    const e = byClient.get(r.client_name) ?? { count: 0, done: 0, total: 0, hasAvenca: false };
    e.count += 1;
    e.total += r.value;
    if (r.status === "concluido") e.done += 1;
    if (r.is_avenca) e.hasAvenca = true;
    byClient.set(r.client_name, e);
  }
  const grouped = [...byClient.entries()].sort((a, b) => b[1].total - a[1].total);

  return (
    <BreakdownShell title={title} total={total} count={periodRows.length}>
      {grouped.map(([client, e]) => (
        <div key={client} className="flex items-center gap-3 px-4 py-2.5">
          {e.done === e.count
            ? <CheckCircle2 className="w-4 h-4 text-green-600 shrink-0" />
            : <Circle className="w-4 h-4 text-[var(--color-border)] shrink-0" />}
          <div className="flex-1 min-w-0">
            <p className="text-sm font-medium text-[var(--color-text-main)] truncate">
              {client}
              {e.hasAvenca && <span className="ml-2 text-[10px] font-medium px-1.5 py-0.5 rounded-full bg-blue-50 text-blue-700 border border-blue-200">Avença</span>}
            </p>
            <p className="text-xs text-[var(--color-text-muted)]">
              {e.count} serviço{e.count !== 1 ? "s" : ""} · {e.done} concluído{e.done !== 1 ? "s" : ""}
            </p>
          </div>
          <p className="text-sm font-semibold text-[var(--color-text-main)] shrink-0">{fmtEur(e.total)}</p>
        </div>
      ))}
    </BreakdownShell>
  );
}

function BreakdownShell({ title, total, count, children }: {
  title: string;
  total: number;
  count: number;
  children: React.ReactNode;
}) {
  return (
    <div className="bg-white rounded-xl border border-[var(--color-border)] overflow-hidden">
      <div className="px-4 py-3 border-b border-[var(--color-border)] flex items-center justify-between bg-[var(--color-background)]">
        <p className="text-sm font-semibold text-[var(--color-text-main)]">{title}</p>
        <p className="text-xs text-[var(--color-text-muted)]">{count} serviço{count !== 1 ? "s" : ""}</p>
      </div>
      <div className="divide-y divide-[var(--color-border)] max-h-[420px] overflow-y-auto">
        {children}
      </div>
      <div className="px-4 py-3 border-t-2 border-[var(--color-border)] flex items-center justify-between bg-[var(--color-background)]">
        <p className="text-sm font-semibold text-[var(--color-text-main)]">Total</p>
        <p className="text-sm font-bold text-green-700">{fmtEur(total)}</p>
      </div>
    </div>
  );
}

const PERIODOS_OPERACIONAIS = [
  ["today", "Hoje", ""],
  ["week", "Esta semana", "seg – dom"],
  ["month", "Este mês", ""],
] as const;

// ─── Componente principal ─────────────────────────────────────────────────────

interface Props {
  data: FinancialDashboardData | null;
  error: string | null;
  companyId: string;
  initialSummary: OperationalSummary | null;
  /** Serviços concluídos ainda por faturar. Leitura pura — ver `getUnbilledServices`. */
  unbilled: { count: number; total: number } | null;
}

export function FinancialDashboardClient({ data, error, companyId, initialSummary, unbilled }: Props) {
  // Financeiro V2 (PR A): `data` e `error` deixaram de ter cópia em estado
  // local. Vinham de `useState(initialData)` porque o botão "Atualizar" os
  // reescrevia no cliente; sem esse botão, a página é renderizada no servidor
  // para o período da URL e o cliente só apresenta. Uma cópia em estado que
  // ninguém actualiza é apenas uma forma de o ecrã ficar desactualizado em
  // silêncio quando o período muda.
  //
  // O resumo operacional (`summary`) MANTÉM estado: é actualizado em tempo real
  // pela subscrição a `services`, que continua igual.
  const [summary, setSummary] = useState<OperationalSummary | null>(initialSummary);
  const [selectedPeriod, setSelectedPeriod] = useState<Period | null>(null);

  const refreshSummary = useCallback(async () => {
    const res = await getOperationalSummary();
    if (res.ok) setSummary(res.data);
  }, []);

  // Tempo real: qualquer alteração no calendário (services) atualiza o resumo
  // dia/semana/mês. Fallback: refetch a cada 60s e ao voltar à janela.
  useEffect(() => {
    const supabase = createClient();
    const channel = supabase
      .channel(`financeiro-summary-${companyId}`)
      .on(
        "postgres_changes",
        { event: "*", schema: "public", table: "services", filter: `company_id=eq.${companyId}` },
        () => void refreshSummary(),
      )
      .subscribe();
    const interval = setInterval(() => void refreshSummary(), 60_000);
    const onFocus = () => void refreshSummary();
    window.addEventListener("focus", onFocus);
    return () => {
      supabase.removeChannel(channel);
      clearInterval(interval);
      window.removeEventListener("focus", onFocus);
    };
  }, [companyId, refreshSummary]);


  const now = new Date();
  const mesAtualLabel = now.toLocaleDateString("pt-PT", { month: "long", year: "numeric" });

  const hojeLabel = now.toLocaleDateString("pt-PT", { day: "numeric", month: "short" });

  // ── Alertas e Atenção, construídos só a partir do que a fonte garante ──────
  //
  // Nada aqui é inventado. `unbilled` vem de `getUnbilledServices` (leitura
  // pura) e `pendingRevenue` do painel financeiro. Atrasos por idade e
  // próximos vencimentos exigiriam repartir as faturas por data de
  // vencimento — a fonte actual dá só o agregado, por isso não aparecem.
  const alertas: AlertaItem[] = [];
  if (unbilled && unbilled.count > 0) {
    alertas.push({
      id: "por-faturar",
      icon: <ReceiptText className="w-[18px] h-[18px]" />,
      tom: "primary",
      titulo: `${unbilled.count} serviço${unbilled.count !== 1 ? "s" : ""} por faturar`,
      subtexto: `Valor estimado ${fmtEurCompact(unbilled.total)}`,
      href: "/dashboard/cobrancas",
    });
  }
  if (data && data.pendingRevenue > 0) {
    alertas.push({
      id: "em-aberto",
      icon: <Clock3 className="w-[18px] h-[18px]" />,
      tom: "orange",
      titulo: `${fmtEur(data.pendingRevenue)} em aberto`,
      subtexto: "Faturas pendentes ou vencidas",
      href: "/dashboard/cobrancas",
    });
  }

  const atencao: AtencaoItem[] = alertas.map((a) => ({
    id: a.id,
    icon: a.icon,
    tom: a.tom,
    titulo: a.titulo,
    subtexto: a.subtexto,
    href: a.href,
  }));

  return (
    <div className="space-y-4">

      {error && (
        <FinanceCard>
          <ErroCard mensagem={error} />
        </FinanceCard>
      )}

      {/* ── 1. ALERTAS ────────────────────────────────────────────────────────
          Antes dos KPIs, como manda a hierarquia aprovada: o que exige acção
          vem antes do que descreve o passado.

          🔴 Só entram alertas com fonte real. Atrasos e próximos vencimentos
             exigem repartir as faturas por data de vencimento, e a fonte
             actual só dá um total agregado (`pendingRevenue`). Ficam de fora
             em vez de mostrarem um número que não se pode defender — a faixa
             encolhe e distribui o espaço pelos que existem. */}
      <FinanceAlertStrip itens={alertas} />

      {/* ── 2. CINCO KPIs ─────────────────────────────────────────────────── */}
      <FinanceKpiGrid>
        <FinanceKpiCard
          label="Receita"
          slot={data ? { estado: "pronto", dados: fmtEur(data.currentMonthRevenue) } : { estado: "indisponivel" }}
          icon={<ChartNoAxesCombined className="w-[18px] h-[18px]" />}
          tom="primary"
        />
        {/* 🔴 "Recebido" existe como espaço, não como número. Distinguir
             faturado de efectivamente recebido exige conciliar pagamentos, e
             a fonte actual não o faz. Preenchê-lo com a receita faturada
             seria afirmar que está tudo cobrado. */}
        <FinanceKpiCard
          label="Recebido"
          slot={{ estado: "indisponivel", porque: "Requer conciliação de pagamentos" }}
          icon={<Wallet className="w-[18px] h-[18px]" />}
          tom="green"
        />
        <FinanceKpiCard
          label="Em aberto"
          slot={data ? { estado: "pronto", dados: fmtEur(data.pendingRevenue) } : { estado: "indisponivel" }}
          icon={<Clock3 className="w-[18px] h-[18px]" />}
          tom="orange"
        />
        {/* O rótulo diz "(Salários)" porque é só isso que a fonte cobre.
            Chamar-lhe "Custos" faria passar a folha por custo total. */}
        <FinanceKpiCard
          label="Custos (Salários)"
          slot={data ? { estado: "pronto", dados: fmtEur(data.currentMonthCosts) } : { estado: "indisponivel" }}
          icon={<ReceiptText className="w-[18px] h-[18px]" />}
          tom="peach"
        />
        <FinanceKpiCard
          label="Margem"
          slot={data ? { estado: "pronto", dados: fmtEur(data.currentMonthMargin) } : { estado: "indisponivel" }}
          sufixo={data ? `· ${data.currentMonthMarginPct}%` : undefined}
          icon={<PieChart className="w-[18px] h-[18px]" />}
          tom="primary"
        />
      </FinanceKpiGrid>

      {/* ── 3. GRÁFICO DOMINANTE + ATENÇÃO ────────────────────────────────── */}
      <div className="grid grid-cols-1 xl:grid-cols-3 gap-4">
        <div className="xl:col-span-2">
          <FinanceMainChart
            titulo="Evolução financeira"
            hint="De faturas e folhas registadas"
            seletor="Mês"
            slot={
              data
                ? {
                    estado: "pronto",
                    dados: data.monthly.map((m) => ({
                      label: m.label,
                      faturado: m.revenue,
                      recebido: null,
                      despesas: m.costs,
                    })),
                  }
                : { estado: "indisponivel" }
            }
          />
        </div>
        <FinanceAttentionPanel itens={atencao} />
      </div>

      {/* ── 4. PREVISÃO · AGING · TOP CLIENTES ────────────────────────────── */}
      <div className="grid grid-cols-1 lg:grid-cols-3 gap-4">
        <FinanceCashForecast
          slot={{ estado: "indisponivel", porque: "Requer o pipeline canónico (PR B)" }}
        />
        <FinanceAging
          slot={{ estado: "indisponivel", porque: "Requer repartir faturas por vencimento" }}
        />
        <FinanceTopClients
          slot={
            data
              ? {
                  estado: "pronto",
                  dados: data.byClient.map((c) => ({ id: c.client_id, nome: c.client_name, valor: c.total })),
                }
              : { estado: "indisponivel" }
          }
          metrica="Receita faturada no ano"
        />
      </div>

      {/* ── 5. RECEITA POR SERVIÇO · EFICIÊNCIA ───────────────────────────── */}
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
        {/* 🔴 Classificar receita por tipo de serviço exigiria adivinhar a
             partir da descrição. Não se faz regex sobre texto livre para
             produzir números financeiros. */}
        <FinanceRevenueByService
          slot={{ estado: "indisponivel", porque: "Requer classificação de serviço na fonte" }}
        />
        <FinanceTeamEfficiency
          slot={{ estado: "indisponivel", porque: "Requer cruzar horas com receita (PR B)" }}
        />
      </div>

      {/* ── 6. OPERACIONAL, COMPACTO ──────────────────────────────────────────
          Os três cartões gigantes Hoje/Semana/Mês saíram do topo: ocupavam
          meio ecrã e repetiam o período. Os dados não se perderam — ficam
          aqui numa faixa, com o mesmo detalhe ao clicar. */}
      <FinanceCard padded={false}>
        <div className="flex flex-col sm:flex-row">
          {PERIODOS_OPERACIONAIS.map(([chave, rotulo, sub], i) => {
            const sm = summary?.[chave] ?? null;
            const activo = selectedPeriod === chave;
            return (
              <button
                key={chave}
                type="button"
                aria-pressed={activo}
                onClick={() => setSelectedPeriod((prev) => (prev === chave ? null : chave))}
                className={[
                  "flex-1 min-w-0 text-left px-5 py-4 transition-colors",
                  i > 0 ? "border-t sm:border-t-0 sm:border-l border-[var(--finance-divider)]" : "",
                  activo ? "bg-[var(--finance-primary-soft-2)]" : "hover:bg-[var(--finance-surface-soft)]",
                ].join(" ")}
              >
                <div className="flex items-center gap-2">
                  <p className="text-[12px] font-medium text-[var(--finance-text-secondary)]">{rotulo}</p>
                  <span className="text-[11px] text-[var(--finance-text-muted)]">
                    {chave === "today" ? hojeLabel : chave === "month" ? mesAtualLabel : sub}
                  </span>
                  <ChevronDown
                    className={`w-3.5 h-3.5 ml-auto text-[var(--finance-text-muted)] transition-transform ${activo ? "rotate-180" : ""}`}
                    aria-hidden
                  />
                </div>
                {sm == null ? (
                  <Skeleton h={20} w="60%" className="mt-2" />
                ) : (
                  <>
                    <p className="mt-1 text-[19px] font-bold text-[var(--finance-text)] tabular-nums">
                      {fmtEur(sm.expected)}
                    </p>
                    <p className="text-[11.5px] text-[var(--finance-text-muted)]">
                      <span className="font-semibold text-[var(--finance-green)]">{fmtEur(sm.done)}</span>
                      {" "}concluído · {sm.concluded}/{sm.services} serviço{sm.services !== 1 ? "s" : ""}
                    </p>
                  </>
                )}
              </button>
            );
          })}
        </div>
      </FinanceCard>

      {selectedPeriod && summary && <PeriodBreakdown period={selectedPeriod} summary={summary} />}

      {data && <MonthlyTable data={data.monthly} />}
    </div>
  );
}

"use client";

import { useState, useEffect, useCallback, useTransition } from "react";
import Link from "next/link";
import {
  Euro, AlertCircle, Loader2,
  ArrowUpRight, ArrowDownRight, RefreshCw, Receipt, Wallet,
  BarChart2, FileText, Repeat, CalendarDays, Landmark, BarChart3,
  ChevronDown, CheckCircle2, Circle,
} from "lucide-react";
import { createClient } from "@/lib/supabase/client";
import {
  getFinancialDashboard,
  getOperationalSummary,
  type FinancialDashboardData,
  type OperationalSummary,
} from "@/app/actions/financial-dashboard";

// ─── Helpers ──────────────────────────────────────────────────────────────────

function fmtEur(v: number) {
  return v.toLocaleString("pt-PT", { minimumFractionDigits: 2, maximumFractionDigits: 2 }) + " €";
}
function fmtEurCompact(v: number) {
  if (v >= 1000) return (v / 1000).toLocaleString("pt-PT", { maximumFractionDigits: 1 }) + "k €";
  return fmtEur(v);
}

// ─── KPI Card ─────────────────────────────────────────────────────────────────

interface KpiCardProps {
  label: string;
  value: string;
  sub?: string;
  trend?: "up" | "down" | "neutral";
  trendLabel?: string;
  accent?: string;
}

function KpiCard({ label, value, sub, trend, trendLabel, accent = "var(--color-primary)" }: KpiCardProps) {
  return (
    <div className="bg-white rounded-xl border border-[var(--color-border)] p-5 flex flex-col gap-3">
      <p className="text-sm text-[var(--color-text-muted)] font-medium">{label}</p>
      <p className="text-2xl font-bold text-[var(--color-text-main)]" style={{ color: accent !== "var(--color-primary)" ? accent : undefined }}>
        {value}
      </p>
      <div className="flex items-center gap-1.5 text-xs">
        {trend === "up" && <ArrowUpRight className="w-3.5 h-3.5 text-[var(--color-primary)]" />}
        {trend === "down" && <ArrowDownRight className="w-3.5 h-3.5 text-red-500" />}
        {trendLabel && (
          <span className={trend === "up" ? "text-[var(--color-primary)]" : trend === "down" ? "text-red-500" : "text-[var(--color-text-muted)]"}>
            {trendLabel}
          </span>
        )}
        {sub && <span className="text-[var(--color-text-muted)]">{sub}</span>}
      </div>
    </div>
  );
}

// ─── Gráfico de barras + linha (Receita vs Custos) ────────────────────────────

function RevenueChart({ data }: { data: FinancialDashboardData["monthly"] }) {
  const maxVal = Math.max(...data.flatMap((m) => [m.revenue, m.costs]), 1);
  const H = 160;

  return (
    <div className="bg-white rounded-xl border border-[var(--color-border)] p-5">
      <div className="flex items-center justify-between mb-4">
        <p className="text-sm font-semibold text-[var(--color-text-main)]">Receita vs Custos (12 meses)</p>
        <div className="flex items-center gap-4 text-xs text-[var(--color-text-muted)]">
          <span className="flex items-center gap-1.5"><span className="w-3 h-3 rounded-sm bg-[#16A34A] inline-block" />Receita</span>
          <span className="flex items-center gap-1.5"><span className="w-3 h-3 rounded-sm bg-[#EF4444] inline-block" />Custos</span>
          <span className="flex items-center gap-1.5"><span className="w-4 h-0.5 bg-[#F59E0B] inline-block" />Margem</span>
        </div>
      </div>
      <svg viewBox={`0 0 ${data.length * 44} ${H + 32}`} className="w-full overflow-visible">
        {/* Linhas de referência */}
        {[0, 0.25, 0.5, 0.75, 1].map((pct) => (
          <line
            key={pct}
            x1="0" y1={H - pct * H}
            x2={data.length * 44} y2={H - pct * H}
            stroke="#E5E7EB" strokeWidth="1"
          />
        ))}
        {/* Barras e linha de margem */}
        {data.map((m, i) => {
          const x = i * 44;
          const revH = (m.revenue / maxVal) * H;
          const cosH = (m.costs   / maxVal) * H;
          return (
            <g key={i}>
              {/* Barra receita */}
              <rect x={x + 4}  y={H - revH} width={16} height={revH} fill="#16A34A" rx="2" opacity="0.85" />
              {/* Barra custos */}
              <rect x={x + 22} y={H - cosH} width={16} height={cosH} fill="#EF4444" rx="2" opacity="0.75" />
            </g>
          );
        })}
        {/* Linha de margem */}
        <polyline
          fill="none"
          stroke="#F59E0B"
          strokeWidth="2"
          strokeLinejoin="round"
          points={data.map((m, i) => {
            const marginPct = Math.max(m.margin, 0) / maxVal;
            return `${i * 44 + 20},${H - marginPct * H}`;
          }).join(" ")}
        />
        {/* Labels do eixo X */}
        {data.map((m, i) => (
          <text
            key={i}
            x={i * 44 + 20}
            y={H + 18}
            textAnchor="middle"
            fontSize="9"
            fill="#9CA3AF"
          >
            {m.label}
          </text>
        ))}
      </svg>
    </div>
  );
}

// ─── Gráfico horizontal por cliente ───────────────────────────────────────────

function ClientRevenueChart({ data }: { data: FinancialDashboardData["byClient"] }) {
  const max = Math.max(...data.map((c) => c.total), 1);

  return (
    <div className="bg-white rounded-xl border border-[var(--color-border)] p-5">
      <p className="text-sm font-semibold text-[var(--color-text-main)] mb-4">Receita por Cliente (ano atual)</p>
      {data.length === 0 ? (
        <p className="text-sm text-[var(--color-text-muted)] py-6 text-center">Sem dados de faturação este ano.</p>
      ) : (
        <div className="space-y-3">
          {data.map((c) => (
            <div key={c.client_id} className="flex items-center gap-3">
              <p className="text-xs text-[var(--color-text-sub)] w-28 truncate shrink-0">{c.client_name}</p>
              <div className="flex-1 bg-gray-100 rounded-full h-2 overflow-hidden">
                <div
                  className="h-2 rounded-full bg-[#16A34A] transition-all"
                  style={{ width: `${(c.total / max) * 100}%` }}
                />
              </div>
              <p className="text-xs font-medium text-[var(--color-text-main)] w-20 text-right shrink-0">
                {fmtEurCompact(c.total)}
              </p>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

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

function PeriodCard({ label, sub, summary, selected, onClick }: {
  label: string;
  sub: string;
  summary: OperationalSummary["today"] | null;
  selected: boolean;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={`bg-white rounded-xl border p-5 text-left transition-colors ${
        selected
          ? "border-[var(--color-primary)] ring-2 ring-[var(--color-primary-muted)]"
          : "border-[var(--color-border)] hover:border-[var(--color-primary)]"
      }`}
    >
      <div className="flex items-center justify-between mb-2">
        <p className="text-sm font-semibold text-[var(--color-text-main)]">{label}</p>
        <span className="flex items-center gap-1.5 text-[11px] text-[var(--color-text-muted)]">
          {sub}
          <ChevronDown className={`w-3.5 h-3.5 transition-transform ${selected ? "rotate-180 text-[var(--color-primary)]" : ""}`} />
        </span>
      </div>
      {summary == null ? (
        <div className="flex items-center gap-2 text-sm text-[var(--color-text-muted)] py-2">
          <Loader2 className="w-4 h-4 animate-spin" /> A carregar…
        </div>
      ) : (
        <>
          <p className="text-2xl font-bold text-[var(--color-text-main)]">{fmtEur(summary.expected)}</p>
          <div className="mt-2 space-y-1 text-xs text-[var(--color-text-muted)]">
            <p>
              <span className="font-semibold text-green-600">{fmtEur(summary.done)}</span> já concluído
              ({summary.concluded}/{summary.services} serviço{summary.services !== 1 ? "s" : ""})
            </p>
            <div className="w-full h-1.5 bg-gray-100 rounded-full overflow-hidden">
              <div
                className="h-full bg-[var(--color-primary)] rounded-full transition-all"
                style={{ width: `${summary.expected > 0 ? Math.min(100, (summary.done / summary.expected) * 100) : 0}%` }}
              />
            </div>
          </div>
        </>
      )}
    </button>
  );
}

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

// ─── Componente principal ─────────────────────────────────────────────────────

interface Props {
  data: FinancialDashboardData | null;
  error: string | null;
  companyId: string;
  initialSummary: OperationalSummary | null;
}

export function FinancialDashboardClient({ data: initialData, error: initialError, companyId, initialSummary }: Props) {
  const [data,  setData]  = useState<FinancialDashboardData | null>(initialData);
  const [error, setError] = useState<string | null>(initialError);
  const [summary, setSummary] = useState<OperationalSummary | null>(initialSummary);
  const [selectedPeriod, setSelectedPeriod] = useState<Period | null>(null);
  const [isPending, startTransition] = useTransition();

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

  function handleRefresh() {
    setError(null);
    void refreshSummary();
    startTransition(async () => {
      const res = await getFinancialDashboard(companyId);
      if (res.ok) setData(res.data);
      else setError(res.error);
    });
  }

  const now = new Date();
  const mesAtualLabel = now.toLocaleDateString("pt-PT", { month: "long", year: "numeric" });

  return (
    <div className="space-y-6">

      {/* ── Resumo operacional: dia / semana / mês (tempo real, do calendário) ── */}
      <div>
        <div className="flex items-center gap-2 mb-3">
          <CalendarDays className="w-4 h-4 text-[var(--color-primary)]" />
          <p className="text-xs font-semibold text-[var(--color-text-muted)] uppercase tracking-wider">
            Resumo do calendário — atualiza em tempo real
          </p>
        </div>
        <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
          <PeriodCard
            label="Hoje"
            sub={now.toLocaleDateString("pt-PT", { day: "numeric", month: "short" })}
            summary={summary?.today ?? null}
            selected={selectedPeriod === "today"}
            onClick={() => setSelectedPeriod((p) => (p === "today" ? null : "today"))}
          />
          <PeriodCard
            label="Esta semana"
            sub="seg – dom"
            summary={summary?.week ?? null}
            selected={selectedPeriod === "week"}
            onClick={() => setSelectedPeriod((p) => (p === "week" ? null : "week"))}
          />
          <PeriodCard
            label="Este mês"
            sub={mesAtualLabel}
            summary={summary?.month ?? null}
            selected={selectedPeriod === "month"}
            onClick={() => setSelectedPeriod((p) => (p === "month" ? null : "month"))}
          />
        </div>

        {/* Lista de conferência do período clicado */}
        {selectedPeriod && summary && (
          <div className="mt-4">
            <PeriodBreakdown period={selectedPeriod} summary={summary} />
          </div>
        )}
      </div>

      {/* Atalhos para módulos financeiros */}
      <div className="grid grid-cols-2 lg:grid-cols-4 gap-3">
        <Link
          href="/dashboard/cobrancas"
          className="flex items-center gap-3 p-4 bg-white rounded-xl border border-[var(--color-border)] hover:border-[var(--color-primary)] hover:bg-[var(--color-primary-light)] transition-colors group"
        >
          <div className="w-9 h-9 rounded-lg bg-green-50 flex items-center justify-center shrink-0 group-hover:bg-[var(--color-primary-muted)]">
            <Receipt className="w-4 h-4 text-[var(--color-primary)]" />
          </div>
          <div>
            <p className="text-sm font-semibold text-[var(--color-text-main)]">Cobranças</p>
            <p className="text-xs text-[var(--color-text-muted)]">Faturas e documentos</p>
          </div>
        </Link>
        <Link
          href="/dashboard/folha-pagamento"
          className="flex items-center gap-3 p-4 bg-white rounded-xl border border-[var(--color-border)] hover:border-[var(--color-primary)] hover:bg-[var(--color-primary-light)] transition-colors group"
        >
          <div className="w-9 h-9 rounded-lg bg-green-50 flex items-center justify-center shrink-0 group-hover:bg-[var(--color-primary-muted)]">
            <Wallet className="w-4 h-4 text-[var(--color-primary)]" />
          </div>
          <div>
            <p className="text-sm font-semibold text-[var(--color-text-main)]">Pagamentos</p>
            <p className="text-xs text-[var(--color-text-muted)]">Folha de salários</p>
          </div>
        </Link>
        <Link
          href="/dashboard/financeiro/fluxo-caixa"
          className="flex items-center gap-3 p-4 bg-white rounded-xl border border-[var(--color-border)] hover:border-[var(--color-primary)] hover:bg-[var(--color-primary-light)] transition-colors group"
        >
          <div className="w-9 h-9 rounded-lg bg-green-50 flex items-center justify-center shrink-0 group-hover:bg-[var(--color-primary-muted)]">
            <BarChart2 className="w-4 h-4 text-[var(--color-primary)]" />
          </div>
          <div>
            <p className="text-sm font-semibold text-[var(--color-text-main)]">Fluxo de Caixa</p>
            <p className="text-xs text-[var(--color-text-muted)]">Entradas e saídas</p>
          </div>
        </Link>
        <Link
          href="/dashboard/financeiro/contas"
          className="flex items-center gap-3 p-4 bg-white rounded-xl border border-[var(--color-border)] hover:border-[var(--color-primary)] hover:bg-[var(--color-primary-light)] transition-colors group"
        >
          <div className="w-9 h-9 rounded-lg bg-green-50 flex items-center justify-center shrink-0 group-hover:bg-[var(--color-primary-muted)]">
            <FileText className="w-4 h-4 text-[var(--color-primary)]" />
          </div>
          <div>
            <p className="text-sm font-semibold text-[var(--color-text-main)]">Contas</p>
            <p className="text-xs text-[var(--color-text-muted)]">A pagar e a receber</p>
          </div>
        </Link>
        <Link
          href="/dashboard/financeiro/pagamentos"
          className="flex items-center gap-3 p-4 bg-white rounded-xl border border-[var(--color-border)] hover:border-[var(--color-primary)] hover:bg-[var(--color-primary-light)] transition-colors group"
        >
          <div className="w-9 h-9 rounded-lg bg-green-50 flex items-center justify-center shrink-0 group-hover:bg-[var(--color-primary-muted)]">
            <Repeat className="w-4 h-4 text-[var(--color-primary)]" />
          </div>
          <div>
            <p className="text-sm font-semibold text-[var(--color-text-main)]">Pagamentos Fixos</p>
            <p className="text-xs text-[var(--color-text-muted)]">Fixos e variáveis · lembrete</p>
          </div>
        </Link>
        <Link
          href="/dashboard/financeiro/conciliacao"
          className="flex items-center gap-3 p-4 bg-white rounded-xl border border-[var(--color-border)] hover:border-[var(--color-primary)] hover:bg-[var(--color-primary-light)] transition-colors group"
        >
          <div className="w-9 h-9 rounded-lg bg-green-50 flex items-center justify-center shrink-0 group-hover:bg-[var(--color-primary-muted)]">
            <Landmark className="w-4 h-4 text-[var(--color-primary)]" />
          </div>
          <div>
            <p className="text-sm font-semibold text-[var(--color-text-main)]">Conciliação Bancária</p>
            <p className="text-xs text-[var(--color-text-muted)]">Extratos e movimentos</p>
          </div>
        </Link>
        <Link
          href="/dashboard/relatorios"
          className="flex items-center gap-3 p-4 bg-white rounded-xl border border-[var(--color-border)] hover:border-[var(--color-primary)] hover:bg-[var(--color-primary-light)] transition-colors group"
        >
          <div className="w-9 h-9 rounded-lg bg-green-50 flex items-center justify-center shrink-0 group-hover:bg-[var(--color-primary-muted)]">
            <BarChart3 className="w-4 h-4 text-[var(--color-primary)]" />
          </div>
          <div>
            <p className="text-sm font-semibold text-[var(--color-text-main)]">Relatórios</p>
            <p className="text-xs text-[var(--color-text-muted)]">Horas, receita e faturação diária</p>
          </div>
        </Link>
      </div>

      {/* Cabeçalho com botão de refresh */}
      <div className="flex items-center justify-between">
        <p className="text-sm text-[var(--color-text-muted)]">
          Dados calculados a partir de faturas e folhas de pagamento registadas.
        </p>
        <button
          onClick={handleRefresh}
          disabled={isPending}
          className="flex items-center gap-2 text-sm px-3 py-1.5 rounded-lg border border-[var(--color-border)] text-[var(--color-text-sub)] hover:bg-[var(--color-background)] transition-colors disabled:opacity-50"
        >
          {isPending ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <RefreshCw className="w-3.5 h-3.5" />}
          Atualizar
        </button>
      </div>

      {/* Erro */}
      {error && (
        <div className="flex items-center gap-3 p-4 bg-red-50 border border-red-200 rounded-xl text-sm text-red-700">
          <AlertCircle className="w-4 h-4 shrink-0" />
          {error}
        </div>
      )}

      {/* Loading overlay */}
      {isPending && (
        <div className="flex items-center justify-center py-8 text-[var(--color-text-muted)]">
          <Loader2 className="w-5 h-5 animate-spin mr-2" />
          A carregar dados...
        </div>
      )}

      {data && !isPending && (
        <>
          {/* KPIs — mês atual */}
          <div>
            <p className="text-xs font-semibold text-[var(--color-text-muted)] uppercase tracking-wider mb-3">
              Mês atual — {mesAtualLabel}
            </p>
            <div className="grid grid-cols-2 lg:grid-cols-4 gap-4">
              <KpiCard
                label="Receita"
                value={fmtEur(data.currentMonthRevenue)}
                sub="faturado este mês"
                trend="neutral"
              />
              <KpiCard
                label="Custos (Salários)"
                value={fmtEur(data.currentMonthCosts)}
                sub="folha de pagamento"
                trend="neutral"
                accent="#6B7280"
              />
              <KpiCard
                label="Margem Bruta"
                value={fmtEur(data.currentMonthMargin)}
                sub={`${data.currentMonthMarginPct}% da receita`}
                trend={data.currentMonthMargin >= 0 ? "up" : "down"}
                trendLabel={data.currentMonthMargin >= 0 ? "positiva" : "negativa"}
                accent={data.currentMonthMargin >= 0 ? "var(--color-primary)" : "#EF4444"}
              />
              <KpiCard
                label="Pendente a Receber"
                value={fmtEur(data.pendingRevenue)}
                sub="faturas pendentes/vencidas"
                trend={data.pendingRevenue > 0 ? "down" : "neutral"}
                trendLabel={data.pendingRevenue > 0 ? "por cobrar" : "tudo cobrado"}
                accent={data.pendingRevenue > 0 ? "#F59E0B" : "var(--color-primary)"}
              />
            </div>
          </div>

          {/* Gráficos */}
          <div className="grid grid-cols-1 xl:grid-cols-2 gap-6">
            <RevenueChart data={data.monthly} />
            <ClientRevenueChart data={data.byClient} />
          </div>

          {/* Tabela de custos/receita dos 12 meses */}
          <MonthlyTable data={data.monthly} />

          {/* Resumo do ano — no fundo, como fecho */}
          <div>
            <p className="text-xs font-semibold text-[var(--color-text-muted)] uppercase tracking-wider mb-3">
              Resumo do ano {now.getFullYear()}
            </p>
            <div className="grid grid-cols-2 lg:grid-cols-3 gap-4">
              <KpiCard
                label="Receita Total"
                value={fmtEur(data.yearRevenue)}
                sub="acumulado no ano"
                trend="up"
              />
              <KpiCard
                label="Custos Totais"
                value={fmtEur(data.yearCosts)}
                sub="salários acumulados"
                trend="neutral"
                accent="#6B7280"
              />
              <KpiCard
                label="Projeção Anual"
                value={fmtEur(data.projectedAnnualRevenue)}
                sub="estimativa baseada na média mensal"
                trend="up"
                trendLabel="estimado"
                accent="#8B5CF6"
              />
            </div>
          </div>
        </>
      )}

      {!data && !isPending && !error && (
        <div className="flex flex-col items-center justify-center py-16 text-[var(--color-text-muted)]">
          <Euro className="w-10 h-10 mb-3 opacity-30" />
          <p className="text-sm">Sem dados financeiros disponíveis.</p>
          <p className="text-xs mt-1">Gere faturas ou registe folhas de pagamento primeiro.</p>
        </div>
      )}
    </div>
  );
}

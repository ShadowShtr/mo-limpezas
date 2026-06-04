"use client";

import { useState, useTransition } from "react";
import {
  TrendingUp, TrendingDown, Euro, AlertCircle, Loader2,
  ArrowUpRight, ArrowDownRight, RefreshCw,
} from "lucide-react";
import { getFinancialDashboard, type FinancialDashboardData } from "@/app/actions/financial-dashboard";

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
  const visible = [...data].reverse().slice(0, 6);

  return (
    <div className="bg-white rounded-xl border border-[var(--color-border)] p-5">
      <p className="text-sm font-semibold text-[var(--color-text-main)] mb-4">Resumo Mensal (últimos 6 meses)</p>
      <div className="overflow-x-auto">
        <table className="w-full text-xs">
          <thead>
            <tr className="text-[var(--color-text-muted)] border-b border-[var(--color-border)]">
              <th className="pb-2 text-left font-medium">Mês</th>
              <th className="pb-2 text-right font-medium">Receita</th>
              <th className="pb-2 text-right font-medium">Custos</th>
              <th className="pb-2 text-right font-medium">Margem</th>
              <th className="pb-2 text-right font-medium">%</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-[var(--color-border)]">
            {visible.map((m) => {
              const pct = m.revenue > 0 ? Math.round((m.margin / m.revenue) * 100) : 0;
              return (
                <tr key={`${m.year}-${m.month}`} className="hover:bg-[var(--color-background)]">
                  <td className="py-2 font-medium text-[var(--color-text-main)]">{m.label}</td>
                  <td className="py-2 text-right text-[var(--color-text-main)]">{fmtEur(m.revenue)}</td>
                  <td className="py-2 text-right text-[var(--color-text-sub)]">{fmtEur(m.costs)}</td>
                  <td className={`py-2 text-right font-medium ${m.margin >= 0 ? "text-[var(--color-primary)]" : "text-red-500"}`}>
                    {fmtEur(m.margin)}
                  </td>
                  <td className={`py-2 text-right ${pct >= 0 ? "text-[var(--color-primary)]" : "text-red-500"}`}>
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

// ─── Componente principal ─────────────────────────────────────────────────────

interface Props {
  data: FinancialDashboardData | null;
  error: string | null;
  companyId: string;
}

export function FinancialDashboardClient({ data: initialData, error: initialError, companyId }: Props) {
  const [data,  setData]  = useState<FinancialDashboardData | null>(initialData);
  const [error, setError] = useState<string | null>(initialError);
  const [isPending, startTransition] = useTransition();

  function handleRefresh() {
    setError(null);
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

          {/* KPIs — ano */}
          <div>
            <p className="text-xs font-semibold text-[var(--color-text-muted)] uppercase tracking-wider mb-3">
              Ano {now.getFullYear()}
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

          {/* Gráficos */}
          <div className="grid grid-cols-1 xl:grid-cols-2 gap-6">
            <RevenueChart data={data.monthly} />
            <ClientRevenueChart data={data.byClient} />
          </div>

          {/* Tabela resumo mensal */}
          <MonthlyTable data={data.monthly} />
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

"use client";

import { useState, useEffect, useCallback } from "react";
import {
  ChevronDown, CheckCircle2, Circle,
  ChartNoAxesCombined, Wallet, Clock3, ReceiptText, PieChart, CalendarDays, CircleAlert,
} from "lucide-react";
import { createClient } from "@/lib/supabase/client";
import {
  getOperationalSummary,
  type FinancialDashboardData,
  type OperationalSummary,
} from "@/app/actions/financial-dashboard";
import { FinanceCard, IconCircle } from "@/components/financeiro/v2/finance-card";
import { FinanceKpiCard, FinanceKpiGrid } from "@/components/financeiro/v2/finance-kpi-card";
import { FinanceAlertStrip, type AlertaItem } from "@/components/financeiro/v2/finance-alert-strip";
import { FinanceAttentionPanel, type AtencaoItem } from "@/components/financeiro/v2/finance-attention-panel";
import { FinanceMainChart } from "@/components/financeiro/v2/finance-chart-card";
import { FinanceBuildingsCard } from "@/components/financeiro/v2/finance-buildings-card";
import {
  FinanceAging,
  FinanceRevenueByService,
  FinanceTeamEfficiency,
  FinanceTopClients,
} from "@/components/financeiro/v2/finance-intelligence";
import { ErroCard, Skeleton, type Slot } from "@/components/financeiro/v2/visual-contract";
import { fmtEur, fmtEurCompact } from "@/lib/finance-format";
import type { FinanceDashboardSnapshot, Medida } from "@/domain/finance-v2/types";

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
                  <td className={`py-2 px-3 text-right font-medium ${m.margin >= 0 ? "text-[var(--finance-primary)]" : "text-red-500"}`}>
                    {fmtEur(m.margin)}
                  </td>
                  <td className={`py-2 px-3 text-right ${pct >= 0 ? "text-[var(--finance-primary)]" : "text-red-500"}`}>
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

/**
 * Traduz uma `Medida` do motor para o `Slot` que a UI entende.
 *
 * 🔴 Aqui é onde os quatro estados do modelo de leitura chegam ao ecrã, e
 *    onde se garante que não colapsam:
 *
 *      AVAILABLE 0   → "0,00 €"        (zero verdadeiro)
 *      UNAVAILABLE   → "Indisponível"  (não sabemos)
 *      ERROR         → "Indisponível"  + a razão
 *
 *    Nunca há um caminho de `null` para `0`: `fmtEur` só é chamado quando
 *    `valor` é um número.
 */
function slotDeMedida(m: Medida | undefined, sufixo?: (v: number) => string): Slot<string> {
  if (!m) return { estado: "indisponivel" };
  if (m.estado === "ERROR") return { estado: "indisponivel", porque: m.nota ?? "Falha ao carregar." };
  if (m.valor === null) return { estado: "indisponivel", porque: m.nota };
  return { estado: "pronto", dados: sufixo ? sufixo(m.valor) : fmtEur(m.valor) };
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
  /**
   * Serviços por faturar.
   *
   * Deixou de alimentar a faixa de alertas — isso passou para o motor, que os
   * produz numa colecção única. Fica na assinatura porque a página continua a
   * calculá-lo e removê-lo era churn sem ganho.
   */
  unbilled: { count: number; total: number } | null;
  /**
   * A fotografia do motor novo, já do período seleccionado.
   *
   * 🔴 É esta que governa os KPIs. `data` (o legado) sobrevive apenas para a
   *    série de 12 meses do gráfico — ignora o período, e é por isso que
   *    deixou de alimentar números.
   */
  snapshot: FinanceDashboardSnapshot | null;
  snapshotError: string | null;
}

export function FinancialDashboardClient({
  data, error, companyId, initialSummary, snapshot, snapshotError,
}: Props) {
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
  // Uma colecção única, do motor, usada pela faixa **e** pelo painel Atenção.
  // Duas implementações do mesmo alerta acabariam a discordar.
  const alertas: AlertaItem[] = (snapshot?.alerts.alertas ?? []).map((a) => {
    if (a.tipo === "VENCIDO") {
      return {
        id: "vencido",
        icon: <CircleAlert className="w-[18px] h-[18px]" />,
        tom: "red" as const,
        titulo: `${fmtEur(a.amount)} em atraso`,
        subtexto: `${a.count} fatura${a.count !== 1 ? "s" : ""} em aberto`,
        href: "/dashboard/cobrancas",
      };
    }
    if (a.tipo === "VENCE_7_DIAS") {
      return {
        id: "vence-7",
        icon: <CalendarDays className="w-[18px] h-[18px]" />,
        tom: "orange" as const,
        titulo: `${fmtEur(a.amount)} vencem em 7 dias`,
        subtexto: `${a.count} fatura${a.count !== 1 ? "s" : ""} a vencer`,
        href: "/dashboard/cobrancas",
      };
    }
    return {
      id: "por-faturar",
      icon: <ReceiptText className="w-[18px] h-[18px]" />,
      tom: "primary" as const,
      titulo: `${a.count} serviço${a.count !== 1 ? "s" : ""} por faturar`,
      subtexto: `Valor estimado ${fmtEurCompact(a.amount)}`,
      href: "/dashboard/cobrancas",
    };
  });

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

      {(snapshotError || error) && (
        <FinanceCard>
          <ErroCard mensagem={snapshotError ?? error ?? undefined} />
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

      {/* ── 2. RESUMO DO CALENDÁRIO ───────────────────────────────────────────
          Primeiro de tudo, a pedido do dono. É a única parte desta página
          que fala do trabalho em curso e não do dinheiro já registado — e num
          mês sem faturação emitida, é também a única que tem números a sério.

          Clicar continua a abrir a lista de conferência do período. */}
      <div>
        <div className="flex items-center gap-2 mb-3">
          <CalendarDays className="w-4 h-4 text-[var(--finance-primary)]" aria-hidden />
          <p className="text-[12px] font-semibold text-[var(--finance-text-secondary)] uppercase tracking-[0.04em]">
            Resumo do calendário
          </p>
          <span className="inline-flex items-center gap-1.5 text-[11px] text-[var(--finance-text-muted)]">
            <span className="w-1.5 h-1.5 rounded-full bg-[var(--finance-green)] animate-pulse" />
            atualiza em tempo real
          </span>
        </div>

        <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
          {PERIODOS_OPERACIONAIS.map(([chave, rotulo, sub]) => {
            const sm = summary?.[chave] ?? null;
            const activo = selectedPeriod === chave;
            const progresso =
              sm && sm.expected > 0 ? Math.min(100, (sm.done / sm.expected) * 100) : 0;

            return (
              <button
                key={chave}
                type="button"
                aria-pressed={activo}
                onClick={() => setSelectedPeriod((prev) => (prev === chave ? null : chave))}
                className={[
                  "text-left rounded-[18px] border bg-[var(--finance-surface)] px-5 py-4 transition-all duration-150",
                  activo
                    ? "border-[var(--finance-primary-border)] bg-[var(--finance-primary-soft-2)]"
                    : "border-[var(--finance-border)] hover:shadow-[0_4px_16px_rgba(16,24,40,.06)]",
                ].join(" ")}
                style={{ boxShadow: activo ? undefined : "0 1px 2px rgba(16,24,40,.03), 0 2px 8px rgba(16,24,40,.035)" }}
              >
                <div className="flex items-center gap-3">
                  <IconCircle bg="var(--finance-primary-soft)" fg="var(--finance-primary)" size={34}>
                    <CalendarDays className="w-4 h-4" />
                  </IconCircle>
                  <div className="min-w-0 flex-1">
                    <p className="text-[12px] font-medium text-[#344054]">{rotulo}</p>
                    <p className="text-[11px] text-[var(--finance-text-muted)] truncate">
                      {chave === "today" ? hojeLabel : chave === "month" ? mesAtualLabel : sub}
                    </p>
                  </div>
                  <ChevronDown
                    className={`w-4 h-4 shrink-0 text-[var(--finance-text-muted)] transition-transform ${activo ? "rotate-180" : ""}`}
                    aria-hidden
                  />
                </div>

                {sm == null ? (
                  <Skeleton h={26} w="65%" className="mt-3" />
                ) : (
                  <>
                    <p className="mt-3 text-[23px] leading-none font-bold tracking-[-0.02em] text-[var(--finance-text)] tabular-nums">
                      {fmtEur(sm.expected)}
                    </p>
                    <p className="mt-2 text-[11.5px] text-[var(--finance-text-muted)]">
                      <span className="font-semibold text-[var(--finance-green)]">{fmtEur(sm.done)}</span>
                      {" "}concluído · {sm.concluded}/{sm.services} serviço{sm.services !== 1 ? "s" : ""}
                    </p>
                    <span className="mt-2 block h-1.5 rounded-full bg-[var(--finance-track)] overflow-hidden">
                      <span
                        className="block h-1.5 rounded-full bg-[var(--finance-green)] transition-all"
                        style={{ width: `${progresso}%` }}
                      />
                    </span>
                  </>
                )}
              </button>
            );
          })}
        </div>
      </div>

      {selectedPeriod && summary && <PeriodBreakdown period={selectedPeriod} summary={summary} />}

      {/* ── 3. CINCO KPIs ─────────────────────────────────────────────────── */}
      <FinanceKpiGrid>
        {/* Faturado: só faturas **emitidas** no período. Um rascunho não é
            receita — e hoje as 11 faturas da base estão todas em rascunho,
            por isso este número é honestamente 0,00 €. */}
        <FinanceKpiCard
          label="Faturado"
          slot={slotDeMedida(snapshot?.kpis.faturado)}
          icon={<ChartNoAxesCombined className="w-[18px] h-[18px]" />}
          tom="primary"
        />
        {/* Recebido: entradas de caixa confirmadas no período. Fonte única —
            somar também `paid_at` das faturas contaria o mesmo recebimento
            duas vezes. */}
        <FinanceKpiCard
          label="Recebido"
          slot={slotDeMedida(snapshot?.kpis.recebido)}
          icon={<Wallet className="w-[18px] h-[18px]" />}
          tom="green"
        />
        <FinanceKpiCard
          label="Em aberto"
          slot={slotDeMedida(snapshot?.kpis.emAberto)}
          icon={<Clock3 className="w-[18px] h-[18px]" />}
          tom="orange"
        />
        {/* Custos: saídas de caixa confirmadas + folha, com protecção contra
            contar o salário duas vezes quando já saiu pelo caixa. O rótulo
            deixou de dizer "(Salários)" porque a fonte deixou de ser só a
            folha — agora cobre fornecedores, despesas e avarias. */}
        <FinanceKpiCard
          label="Custos"
          slot={slotDeMedida(snapshot?.kpis.custos)}
          icon={<ReceiptText className="w-[18px] h-[18px]" />}
          tom="peach"
        />
        {/* A percentagem só aparece quando há faturação. Sem ela o rácio seria
            uma divisão por zero, e não se mostra Infinity nem NaN. */}
        <FinanceKpiCard
          label="Margem"
          slot={slotDeMedida(snapshot?.kpis.margem)}
          sufixo={
            snapshot?.kpis.margemPct.valor != null
              ? `· ${snapshot.kpis.margemPct.valor.toLocaleString("pt-PT", { maximumFractionDigits: 1 })}%`
              : undefined
          }
          icon={<PieChart className="w-[18px] h-[18px]" />}
          tom="primary"
        />
      </FinanceKpiGrid>

      {/* ── 4. GRÁFICO DOMINANTE + ATENÇÃO ────────────────────────────────── */}
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

      {/* ── 5. PREVISÃO · AGING · TOP CLIENTES ────────────────────────────── */}
      <div className="grid grid-cols-1 lg:grid-cols-3 gap-4">
        {/*
          A «Previsão de caixa» deu o lugar aos «Prédios».

          A previsão continua bloqueada pelo incidente de periodicidade — usar
          `fixed_variable_payments` para projectar projectaria as datas
          esmagadas de Agosto. Os prédios têm fonte própria e imediata.

          🔴 Nenhum valor deste card entra nos KPIs. Prédios são uma cadeia à
             parte: `building_cards.monthly_value`, e mais nada.
        */}
        <FinanceBuildingsCard
          slot={
            snapshot?.buildings.estado === "ERROR" || !snapshot
              ? { estado: "indisponivel", porque: snapshot?.buildings.nota }
              : {
                  estado: "pronto",
                  dados: {
                    linhas: snapshot.buildings.linhas,
                    totalConhecido: snapshot.buildings.totalConhecido,
                    contagem: snapshot.buildings.contagem,
                    comValor: snapshot.buildings.comValor,
                    semValor: snapshot.buildings.semValor,
                    nota: snapshot.buildings.nota,
                  },
                }
          }
        />
        <FinanceAging
          slot={
            snapshot?.aging.estado === "AVAILABLE"
              ? {
                  estado: "pronto",
                  dados: snapshot.aging.faixas.map((f) => ({
                    label: f.faixa === "30+" ? "+30 dias" : `${f.faixa} dias`,
                    valor: f.amount,
                  })),
                }
              : { estado: "indisponivel", porque: snapshot?.aging.nota }
          }
        />
        <FinanceTopClients
          slot={
            snapshot?.topClients.estado === "AVAILABLE"
              ? {
                  estado: "pronto",
                  dados: snapshot.topClients.clientes.map((c) => ({
                    id: c.clientId,
                    nome: c.clientName,
                    valor: c.value,
                  })),
                }
              : { estado: "indisponivel", porque: snapshot?.topClients.nota }
          }
          metrica="Faturado no período"
          // Clicar num cliente abre o seu histórico em Cobranças, já filtrado.
          // O ranking deixa de ser informação morta.
          hrefDe={(c) => `/dashboard/cobrancas?cliente=${c.id}`}
        />
      </div>

      {/* ── 6. RECEITA POR SERVIÇO · EFICIÊNCIA ───────────────────────────── */}
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
        {/*
          «Receita por serviço» saiu daqui e entrou «Despesas por categoria».

          Não foi uma troca estética. Classificar receita por tipo de serviço
          exigiria adivinhar a partir da descrição — e não se faz regex sobre
          texto livre para produzir números contabilísticos. Já a classificação
          de despesas existe desde sempre em `cash_flow_entries.category`, com
          444 movimentos reais por trás.

          O componente `FinanceRevenueByService` não foi apagado: fica em
          STANDBY e volta quando os serviços tiverem classificação verdadeira.
        */}
        <FinanceRevenueByService
          titulo="Despesas por categoria"
          slot={
            snapshot?.expensesByCategory.estado === "AVAILABLE" && snapshot.expensesByCategory.total > 0
              ? {
                  estado: "pronto",
                  dados: snapshot.expensesByCategory.fatias.map((f) => ({
                    nome: f.categoria,
                    valor: f.valor,
                    cor: f.cor,
                    chave: f.chave,
                  })),
                }
              : { estado: "indisponivel", porque: snapshot?.expensesByCategory.nota ?? "Sem despesas neste período." }
          }
          // Clicar numa categoria abre as despesas dessa categoria em Contas,
          // já filtradas e prontas a corrigir. Um número no donut deixa de ser
          // o fim da linha.
          /*
            🔴 O que o gráfico NÃO mostra, dito em voz alta.

            O donut conta só movimentos `confirmado`, como os Custos. Uma
            despesa acabada de registar em Contas nasce `pendente` — e quem a
            registou vem procurá-la aqui, não a encontra, e conclui que a
            categoria não funcionou. Aconteceu mesmo.
          */
          rodape={
            snapshot && snapshot.expensesByCategory.pendentes.contagem > 0 ? (
              <p className="w-full mt-1 text-[11.5px] leading-snug text-[var(--finance-orange)]">
                Mais {fmtEur(snapshot.expensesByCategory.pendentes.total)} em{" "}
                {snapshot.expensesByCategory.pendentes.contagem}{" "}
                {snapshot.expensesByCategory.pendentes.contagem === 1 ? "despesa registada" : "despesas registadas"}
                {" "}por confirmar. Entram no gráfico quando forem marcadas como
                pagas em Contas.
              </p>
            ) : null
          }
          hrefDe={(f) =>
            f.chave && snapshot
              ? `/dashboard/financeiro/contas?mes=${snapshot.period.year}-${String(snapshot.period.month).padStart(2, "0")}&categoria=${encodeURIComponent(f.chave)}`
              : null
          }
        />
        <FinanceTeamEfficiency
          slot={{ estado: "indisponivel", porque: "Requer cruzar horas com receita (PR B)" }}
        />
      </div>


      {data && <MonthlyTable data={data.monthly} />}
    </div>
  );
}

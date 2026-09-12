"use client";

import { useState, useEffect } from "react";
import {
  ChevronLeft, ChevronRight, Loader2, AlertCircle, CalendarDays,
  CheckCircle2, Clock, RefreshCw, Plus,
} from "lucide-react";
import { pt } from "date-fns/locale";
import { createClient } from "@/lib/supabase/client";
import {
  ServiceCreateSheet,
  type Client,
  type Location,
  type Team,
} from "../../calendario/_components/service-create-sheet";
import { safeFormat, isValidIsoDateString } from "@/lib/utils";
import {
  type DailyBillingData,
  type DailyBillingRow,
} from "@/app/actions/daily-billing";
import { useDailyBillingQuery } from "./use-daily-billing-query";
import { useDailyBillingPayments } from "./use-daily-billing-payments";
import { formatBillingCurrency as fmtEur, PaymentRow } from "./payment-row";

// ─── Helpers ──────────────────────────────────────────────────────────────────

function todayStr() {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

function shiftDay(dateStr: string, delta: number): string {
  const d = new Date(`${dateStr}T12:00:00`);
  d.setDate(d.getDate() + delta);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

/**
 * Quanto já foi recebido de um serviço, em €: valor livre > estado 50/100.
 * Usa o total COM IVA (quando aplicável) — nunca o valor base — para bater
 * certo com o que a linha e o Fluxo de Caixa mostram.
 */
function receivedOf(r: DailyBillingRow, vatRate: number): number {
  if (r.paid_amount != null) return r.paid_amount;
  const total = r.value * (r.apply_vat ? 1 + vatRate / 100 : 1);
  if (r.payment_status === "pago_total") return total;
  if (r.payment_status === "sinal_50") return total / 2;
  return 0;
}

// ─── Componente ───────────────────────────────────────────────────────────────

interface Props {
  initialDate: string;
  initialData: DailyBillingData | null;
  initialError: string | null;
  companyId: string;
  clients: Client[];
  locations: Location[];
  teams: Team[];
}

export function DailyBillingClient({ initialDate, initialData, initialError, companyId, clients, locations, teams }: Props) {
  const {
    date, data, error, loading, refresh, changeDay, updateData, isCurrentDate, reportError,
  } = useDailyBillingQuery(initialDate, initialData, initialError);
  const {
    editingId, amountInput, savingIds, setAmountInput, startEdit, cancelEdit, applyPayment,
  } = useDailyBillingPayments({ date, updateData, refresh, isCurrentDate, reportError });
  const [creating, setCreating] = useState(false);

  // Tempo real: qualquer alteração em `services` da empresa recarrega o dia
  // (criação/edição/apagamento no calendário reflete-se aqui de imediato).
  // Fallback: refetch a cada 60s e ao voltar à janela, caso o Realtime não
  // esteja ativo para a tabela.
  useEffect(() => {
    const supabase = createClient();
    const channel = supabase
      .channel(`daily-billing-${companyId}`)
      .on(
        "postgres_changes",
        { event: "*", schema: "public", table: "services", filter: `company_id=eq.${companyId}` },
        () => void refresh(),
      )
      .subscribe();

    const interval = setInterval(() => void refresh(), 60_000);
    const onFocus = () => void refresh();
    window.addEventListener("focus", onFocus);

    return () => {
      supabase.removeChannel(channel);
      clearInterval(interval);
      window.removeEventListener("focus", onFocus);
    };
  }, [companyId, refresh]);

  const day = data?.day ?? [];
  const pending = (data?.pending ?? []).filter((r) => !r.is_avenca);
  const vatRate = data?.vatRate ?? 23;

  // Totais do dia (com IVA quando aplicável)
  const withVat = (r: DailyBillingRow) => r.value * (r.apply_vat ? 1 + vatRate / 100 : 1);
  const totalDay = day.reduce((s, r) => s + withVat(r), 0);
  const receivedDay = day.reduce((s, r) => s + Math.min(receivedOf(r, vatRate), withVat(r)), 0);
  const outstandingDay = Math.max(0, totalDay - receivedDay);
  const pendingTotal = pending.reduce((s, r) => s + Math.max(0, withVat(r) - receivedOf(r, vatRate)), 0);

  const isToday = date === todayStr();
  const dayLabel = safeFormat(new Date(`${date}T12:00:00`), "EEEE, d 'de' MMMM", { locale: pt });

  function selectDay(newDate: string) {
    cancelEdit();
    changeDay(newDate);
  }

  return (
    <div className="space-y-5">
      {/* Navegação de dia */}
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex items-center gap-2">
          <button
            onClick={() => selectDay(shiftDay(date, -1))}
            className="p-2 rounded-lg border border-[var(--color-border)] text-[var(--color-text-sub)] hover:bg-[var(--color-background)] transition-colors"
            aria-label="Dia anterior"
          >
            <ChevronLeft className="w-4 h-4" />
          </button>
          <input
            type="date"
            value={date}
            onChange={(e) => { if (isValidIsoDateString(e.target.value)) selectDay(e.target.value); }}
            className="px-3 py-2 rounded-lg border border-[var(--color-border)] text-sm text-[var(--color-text-main)] focus:outline-none focus:ring-2 focus:ring-[var(--finance-primary)]"
          />
          <button
            onClick={() => selectDay(shiftDay(date, 1))}
            className="p-2 rounded-lg border border-[var(--color-border)] text-[var(--color-text-sub)] hover:bg-[var(--color-background)] transition-colors"
            aria-label="Dia seguinte"
          >
            <ChevronRight className="w-4 h-4" />
          </button>
          {!isToday && (
            <button
              onClick={() => selectDay(todayStr())}
              className="px-3 py-2 rounded-lg border border-[var(--color-border)] text-xs font-medium text-[var(--finance-primary)] hover:bg-[var(--finance-primary-soft)] transition-colors"
            >
              Hoje
            </button>
          )}
        </div>
        <div className="flex items-center gap-3">
          <p className="text-sm font-medium text-[var(--color-text-main)] capitalize">{dayLabel}</p>
          {/*
            🔴 Adicionar uma cobrança ao dia = agendar o serviço desse dia,
               AQUI — sem sair do ecrã.

               Esta lista não tem linhas próprias: cada linha É um serviço
               agendado, e a coluna de cobrança é o estado de pagamento dele.
               Criar aqui um registo solto produziria cobrança sem serviço por
               trás — dinheiro num sítio e o trabalho noutro, que é a
               dessincronização que o Financeiro inteiro evita.

               A primeira versão deste botão navegava para o calendário no dia
               certo. Chegava lá, mas transformava «adicionar» numa viagem, e
               quem está a fechar o dia perdia o contexto. O formulário passa a
               vir ter com a pessoa — e é o MESMO `ServiceCreateSheet` que o
               calendário e a ficha de cliente já usam. Um caminho de criação,
               não três cópias dele.
          */}
          <button
            onClick={() => setCreating(true)}
            className="inline-flex items-center gap-2 rounded-lg bg-[var(--finance-primary)] px-3.5 py-2 text-sm font-semibold text-white transition-colors hover:opacity-90"
          >
            <Plus className="w-4 h-4" /> Adicionar cobrança
          </button>
          <button
            onClick={() => void refresh()}
            disabled={loading}
            title="Atualizar"
            className="p-2 rounded-lg border border-[var(--color-border)] text-[var(--color-text-sub)] hover:bg-[var(--color-background)] transition-colors disabled:opacity-50"
          >
            {loading ? <Loader2 className="w-4 h-4 animate-spin" /> : <RefreshCw className="w-4 h-4" />}
          </button>
        </div>
      </div>

      {loading && data == null && (
        <div className="flex items-center justify-center gap-2 rounded-xl border border-[var(--color-border)] bg-white px-4 py-8 text-sm text-[var(--color-text-muted)]">
          <Loader2 className="h-4 w-4 animate-spin" /> A carregar cobranças…
        </div>
      )}

      {/* KPIs do dia */}
      <div className="grid grid-cols-3 gap-3">
        <div className="bg-white rounded-xl border border-[var(--color-border)] p-4">
          <p className="text-xs text-[var(--color-text-muted)] mb-1">Total do dia (c/ IVA)</p>
          <p className="text-xl font-bold text-[var(--color-text-main)]">{data ? fmtEur(totalDay) : "—"}</p>
          <p className="text-xs text-[var(--color-text-muted)] mt-0.5">{day.length} serviço{day.length !== 1 ? "s" : ""}</p>
        </div>
        <div className="bg-white rounded-xl border border-[var(--color-border)] p-4">
          <p className="text-xs text-[var(--color-text-muted)] mb-1">Recebido</p>
          <p className="text-xl font-bold text-green-600">{data ? fmtEur(receivedDay) : "—"}</p>
          <p className="text-xs text-[var(--color-text-muted)] mt-0.5">50% conta metade · valor livre conta o registado</p>
        </div>
        <div className="bg-white rounded-xl border border-[var(--color-border)] p-4">
          <p className="text-xs text-[var(--color-text-muted)] mb-1">Por receber</p>
          <p className={`text-xl font-bold ${outstandingDay > 0 ? "text-amber-600" : "text-green-600"}`}>{data ? fmtEur(outstandingDay) : "—"}</p>
          <p className="text-xs text-[var(--color-text-muted)] mt-0.5">{data ? (outstandingDay > 0 ? "há cobranças em aberto" : "dia fechado") : "dados indisponíveis"}</p>
        </div>
      </div>

      {error && (
        <div className="flex items-center gap-3 p-4 bg-red-50 border border-red-200 rounded-xl text-sm text-red-700">
          <AlertCircle className="w-4 h-4 shrink-0" />
          {error}
        </div>
      )}

      {/* Serviços do dia */}
      <div className="bg-white rounded-xl border border-[var(--color-border)] overflow-hidden">
        <div className="px-4 py-3 border-b border-[var(--color-border)] flex items-center gap-2">
          <CalendarDays className="w-4 h-4 text-[var(--finance-primary)]" />
          <p className="text-sm font-semibold text-[var(--color-text-main)]">Serviços do dia</p>
        </div>
        {day.length === 0 ? (
          <p className="text-sm text-[var(--color-text-muted)] px-4 py-8 text-center">Sem serviços neste dia.</p>
        ) : (
          <div className="divide-y divide-[var(--color-border)]">
            {day.map((r) => (
              <PaymentRow
                key={r.id}
                row={r}
                vatRate={vatRate}
                saving={savingIds.has(r.id)}
                editing={editingId === r.id}
                amountInput={amountInput}
                onAmountInput={setAmountInput}
                onStartEdit={() => startEdit(r)}
                onCancelEdit={cancelEdit}
                onApply={(status, amount) => void applyPayment(r, status, amount)}
              />
            ))}
          </div>
        )}
      </div>

      {/* Pendentes de dias anteriores */}
      <div className="bg-white rounded-xl border border-amber-200 overflow-hidden">
        <div className="px-4 py-3 border-b border-amber-200 bg-amber-50 flex items-center justify-between">
          <div className="flex items-center gap-2">
            <Clock className="w-4 h-4 text-amber-600" />
            <p className="text-sm font-semibold text-amber-800">
              Por cobrar de dias anteriores ({pending.length})
            </p>
          </div>
          <p className="text-sm font-semibold text-amber-700">{fmtEur(pendingTotal)}</p>
        </div>
        {pending.length === 0 ? (
          <p className="text-sm text-[var(--color-text-muted)] px-4 py-6 text-center flex items-center justify-center gap-2">
            <CheckCircle2 className="w-4 h-4 text-green-600" /> Nada pendente dos últimos 60 dias.
          </p>
        ) : (
          <div className="divide-y divide-[var(--color-border)]">
            {pending.map((r) => (
              <PaymentRow
                key={r.id}
                row={r}
                vatRate={vatRate}
                showDate
                saving={savingIds.has(r.id)}
                editing={editingId === r.id}
                amountInput={amountInput}
                onAmountInput={setAmountInput}
                onStartEdit={() => startEdit(r)}
                onCancelEdit={cancelEdit}
                onApply={(status, amount) => void applyPayment(r, status, amount)}
              />
            ))}
          </div>
        )}
      </div>

      {/*
        O MESMO componente que o calendário e a ficha de cliente usam. A data
        é a do dia em vista, não «hoje»: quem está a fechar o dia 12 cria para
        o dia 12. Depois de criar, recarrega-se a lista — o serviço novo entra
        já com o seu estado de cobrança por preencher.
      */}
      <ServiceCreateSheet
        open={creating}
        onClose={() => setCreating(false)}
        onCreated={() => { setCreating(false); void refresh(); }}
        companyId={companyId}
        date={new Date(`${date}T12:00:00`)}
        initialStartTime="09:00"
        initialTeamId={teams[0]?.id ?? ""}
        clients={clients}
        locations={locations}
        teams={teams}
      />
    </div>
  );
}

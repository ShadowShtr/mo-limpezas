"use client";

import { useState, useEffect, useCallback, useRef } from "react";
import {
  ChevronLeft, ChevronRight, Loader2, AlertCircle, CalendarDays,
  CheckCircle2, Euro, Clock, RefreshCw,
} from "lucide-react";
import { format, parseISO } from "date-fns";
import { pt } from "date-fns/locale";
import { createClient } from "@/lib/supabase/client";
import {
  getDailyBilling,
  setServicePayment,
  type DailyBillingData,
  type DailyBillingRow,
} from "@/app/actions/daily-billing";

// ─── Helpers ──────────────────────────────────────────────────────────────────

function fmtEur(v: number) {
  return v.toLocaleString("pt-PT", { minimumFractionDigits: 2, maximumFractionDigits: 2 }) + " €";
}

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
}

export function DailyBillingClient({ initialDate, initialData, initialError, companyId }: Props) {
  const [date, setDate] = useState(initialDate);
  const [data, setData] = useState<DailyBillingData | null>(initialData);
  const [error, setError] = useState<string | null>(initialError);
  const [loading, setLoading] = useState(false);
  // Serviço com o editor de valor recebido aberto
  const [editingId, setEditingId] = useState<string | null>(null);
  const [amountInput, setAmountInput] = useState("");
  const [savingId, setSavingId] = useState<string | null>(null);
  const dateRef = useRef(date);
  useEffect(() => {
    dateRef.current = date;
  }, [date]);

  const refresh = useCallback(async (d?: string) => {
    const target = d ?? dateRef.current;
    const res = await getDailyBilling(target);
    // Ignora respostas de dias que já não estão selecionados (navegação rápida)
    if (target !== dateRef.current) return;
    if (res.ok) { setData(res.data); setError(null); }
    else setError(res.error);
    setLoading(false);
  }, []);

  function changeDay(newDate: string) {
    setDate(newDate);
    dateRef.current = newDate;
    setLoading(true);
    setEditingId(null);
    void refresh(newDate);
  }

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

  async function applyPayment(row: DailyBillingRow, status: "nao_informado" | "sinal_50" | "pago_total", amount?: number | null) {
    setSavingId(row.id);
    const res = await setServicePayment(row.id, status, amount);
    setSavingId(null);
    setEditingId(null);
    if (!res.ok) { setError(res.error); return; }
    setError(null);
    // Atualização otimista local + refetch para consistência
    setData((prev) => {
      if (!prev) return prev;
      const patch = (r: DailyBillingRow) =>
        r.id === row.id
          ? { ...r, payment_status: status, paid_amount: amount ?? null, paid_at: new Date().toISOString() }
          : r;
      return { ...prev, day: prev.day.map(patch), pending: prev.pending.map(patch) };
    });
    void refresh();
  }

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
  const dayLabel = format(new Date(`${date}T12:00:00`), "EEEE, d 'de' MMMM", { locale: pt });

  return (
    <div className="space-y-5">
      {/* Navegação de dia */}
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex items-center gap-2">
          <button
            onClick={() => changeDay(shiftDay(date, -1))}
            className="p-2 rounded-lg border border-[var(--color-border)] text-[var(--color-text-sub)] hover:bg-[var(--color-background)] transition-colors"
            aria-label="Dia anterior"
          >
            <ChevronLeft className="w-4 h-4" />
          </button>
          <input
            type="date"
            value={date}
            onChange={(e) => { if (e.target.value) changeDay(e.target.value); }}
            className="px-3 py-2 rounded-lg border border-[var(--color-border)] text-sm text-[var(--color-text-main)] focus:outline-none focus:ring-2 focus:ring-[var(--color-primary)]"
          />
          <button
            onClick={() => changeDay(shiftDay(date, 1))}
            className="p-2 rounded-lg border border-[var(--color-border)] text-[var(--color-text-sub)] hover:bg-[var(--color-background)] transition-colors"
            aria-label="Dia seguinte"
          >
            <ChevronRight className="w-4 h-4" />
          </button>
          {!isToday && (
            <button
              onClick={() => changeDay(todayStr())}
              className="px-3 py-2 rounded-lg border border-[var(--color-border)] text-xs font-medium text-[var(--color-primary)] hover:bg-[var(--color-primary-light)] transition-colors"
            >
              Hoje
            </button>
          )}
        </div>
        <div className="flex items-center gap-3">
          <p className="text-sm font-medium text-[var(--color-text-main)] capitalize">{dayLabel}</p>
          <button
            onClick={() => { setLoading(true); void refresh(); }}
            disabled={loading}
            title="Atualizar"
            className="p-2 rounded-lg border border-[var(--color-border)] text-[var(--color-text-sub)] hover:bg-[var(--color-background)] transition-colors disabled:opacity-50"
          >
            {loading ? <Loader2 className="w-4 h-4 animate-spin" /> : <RefreshCw className="w-4 h-4" />}
          </button>
        </div>
      </div>

      {/* KPIs do dia */}
      <div className="grid grid-cols-3 gap-3">
        <div className="bg-white rounded-xl border border-[var(--color-border)] p-4">
          <p className="text-xs text-[var(--color-text-muted)] mb-1">Total do dia (c/ IVA)</p>
          <p className="text-xl font-bold text-[var(--color-text-main)]">{fmtEur(totalDay)}</p>
          <p className="text-xs text-[var(--color-text-muted)] mt-0.5">{day.length} serviço{day.length !== 1 ? "s" : ""}</p>
        </div>
        <div className="bg-white rounded-xl border border-[var(--color-border)] p-4">
          <p className="text-xs text-[var(--color-text-muted)] mb-1">Recebido</p>
          <p className="text-xl font-bold text-green-600">{fmtEur(receivedDay)}</p>
          <p className="text-xs text-[var(--color-text-muted)] mt-0.5">50% conta metade · valor livre conta o registado</p>
        </div>
        <div className="bg-white rounded-xl border border-[var(--color-border)] p-4">
          <p className="text-xs text-[var(--color-text-muted)] mb-1">Por receber</p>
          <p className={`text-xl font-bold ${outstandingDay > 0 ? "text-amber-600" : "text-green-600"}`}>{fmtEur(outstandingDay)}</p>
          <p className="text-xs text-[var(--color-text-muted)] mt-0.5">{outstandingDay > 0 ? "há cobranças em aberto" : "dia fechado"}</p>
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
          <CalendarDays className="w-4 h-4 text-[var(--color-primary)]" />
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
                saving={savingId === r.id}
                editing={editingId === r.id}
                amountInput={amountInput}
                onAmountInput={setAmountInput}
                onStartEdit={() => { setEditingId(r.id); setAmountInput(r.paid_amount != null ? String(r.paid_amount) : ""); }}
                onCancelEdit={() => setEditingId(null)}
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
                saving={savingId === r.id}
                editing={editingId === r.id}
                amountInput={amountInput}
                onAmountInput={setAmountInput}
                onStartEdit={() => { setEditingId(r.id); setAmountInput(r.paid_amount != null ? String(r.paid_amount) : ""); }}
                onCancelEdit={() => setEditingId(null)}
                onApply={(status, amount) => void applyPayment(r, status, amount)}
              />
            ))}
          </div>
        )}
      </div>
    </div>
  );
}

// ─── Linha de serviço com controlo de pagamento ───────────────────────────────

function PaymentRow({
  row, vatRate, showDate = false, saving, editing, amountInput,
  onAmountInput, onStartEdit, onCancelEdit, onApply,
}: {
  row: DailyBillingRow;
  vatRate: number;
  showDate?: boolean;
  saving: boolean;
  editing: boolean;
  amountInput: string;
  onAmountInput: (v: string) => void;
  onStartEdit: () => void;
  onCancelEdit: () => void;
  onApply: (status: "nao_informado" | "sinal_50" | "pago_total", amount?: number | null) => void;
}) {
  const total = row.value * (row.apply_vat ? 1 + vatRate / 100 : 1);
  const received = row.paid_amount != null
    ? row.paid_amount
    : row.payment_status === "pago_total" ? total
    : row.payment_status === "sinal_50" ? total / 2
    : 0;

  const parsedAmount = amountInput.trim() === "" ? null : Number(amountInput.replace(",", "."));

  const stateBtn = (active: boolean, cls: string) =>
    `px-2.5 py-1.5 rounded-lg text-xs font-semibold border transition-colors disabled:opacity-50 ${
      active ? cls : "bg-white text-[var(--color-text-sub)] border-[var(--color-border)] hover:bg-[var(--color-background)]"
    }`;

  return (
    <div className="px-4 py-3">
      <div className="flex flex-wrap items-center gap-3">
        {/* Cliente + local */}
        <div className="flex-1 min-w-[180px]">
          <p className="text-sm font-semibold text-[var(--color-text-main)] truncate">
            {row.client_name}
            {row.is_avenca && (
              <span className="ml-2 text-[10px] font-medium px-1.5 py-0.5 rounded-full bg-blue-50 text-blue-700 border border-blue-200 align-middle">
                Avença
              </span>
            )}
          </p>
          <p className="text-xs text-[var(--color-text-muted)] truncate">
            {row.location_name}
            {showDate && <> · {format(parseISO(row.scheduled_start), "d MMM", { locale: pt })}</>}
            {row.reference_number && <> · #{row.reference_number}</>}
          </p>
        </div>

        {/* Valor */}
        <div className="text-right shrink-0 w-28">
          <p className="text-sm font-bold text-[var(--color-text-main)]">{fmtEur(total)}</p>
          <p className="text-[11px] text-[var(--color-text-muted)]">
            {row.apply_vat ? `c/ IVA · base ${fmtEur(row.value)}` : "sem IVA"}
          </p>
        </div>

        {/* Estado de pagamento */}
        <div className="flex items-center gap-1.5 shrink-0">
          {saving ? (
            <Loader2 className="w-4 h-4 animate-spin text-[var(--color-primary)] mx-6" />
          ) : (
            <>
              <button
                disabled={saving}
                onClick={() => onApply("nao_informado", null)}
                className={stateBtn(row.payment_status === "nao_informado" && row.paid_amount == null, "bg-gray-600 text-white border-gray-600")}
              >
                Por pagar
              </button>
              <button
                disabled={saving}
                onClick={() => onApply("sinal_50", null)}
                className={stateBtn(row.payment_status === "sinal_50" && row.paid_amount == null, "bg-amber-500 text-white border-amber-500")}
              >
                50%
              </button>
              <button
                disabled={saving}
                onClick={() => onApply("pago_total", null)}
                className={stateBtn(row.payment_status === "pago_total" && row.paid_amount == null, "bg-green-600 text-white border-green-600")}
              >
                100%
              </button>
              <button
                disabled={saving}
                onClick={editing ? onCancelEdit : onStartEdit}
                title="Registar valor recebido (€)"
                className={stateBtn(row.paid_amount != null, "bg-[var(--color-primary)] text-white border-[var(--color-primary)]")}
              >
                <Euro className="w-3.5 h-3.5" />
              </button>
            </>
          )}
        </div>
      </div>

      {/* Info de pagamento registado */}
      {(received > 0 || row.paid_at) && !editing && (
        <p className="text-[11px] text-[var(--color-text-muted)] mt-1.5">
          Recebido: <span className="font-semibold text-green-700">{fmtEur(received)}</span>
          {received < total && <> · falta <span className="font-semibold text-amber-700">{fmtEur(total - received)}</span></>}
          {row.paid_at && <> · registado {format(parseISO(row.paid_at), "d MMM 'às' HH:mm", { locale: pt })}</>}
        </p>
      )}

      {/* Editor de valor livre */}
      {editing && (
        <div className="mt-2 flex items-center gap-2">
          <input
            type="number"
            min="0"
            step="0.01"
            autoFocus
            value={amountInput}
            onChange={(e) => onAmountInput(e.target.value)}
            placeholder={`Valor recebido (total: ${total.toFixed(2)})`}
            className="w-56 px-3 py-1.5 rounded-lg border border-[var(--color-border)] text-sm focus:outline-none focus:ring-2 focus:ring-[var(--color-primary)]"
          />
          <button
            disabled={saving || parsedAmount == null || !Number.isFinite(parsedAmount) || parsedAmount < 0}
            onClick={() => {
              if (parsedAmount == null) return;
              // Estado coerente com o valor: >= total → pago_total; >0 → sinal; 0 → por pagar
              const status = parsedAmount >= total - 0.005 ? "pago_total" : parsedAmount > 0 ? "sinal_50" : "nao_informado";
              onApply(status, parsedAmount);
            }}
            className="px-3 py-1.5 rounded-lg bg-[var(--color-primary)] text-white text-xs font-semibold hover:bg-[var(--color-primary-hover)] transition-colors disabled:opacity-50"
          >
            Guardar
          </button>
          <button
            onClick={onCancelEdit}
            className="px-3 py-1.5 rounded-lg border border-[var(--color-border)] text-xs text-[var(--color-text-sub)] hover:bg-[var(--color-background)] transition-colors"
          >
            Cancelar
          </button>
        </div>
      )}
    </div>
  );
}

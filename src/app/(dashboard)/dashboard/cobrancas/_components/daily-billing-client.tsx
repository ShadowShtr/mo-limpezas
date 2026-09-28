"use client";

// ============================================================================
// Cobranças › Diário
// ============================================================================
//
// Duas origens na mesma lista — serviços agendados e cobranças avulsas — com
// uma regra de valor por tipo, vinda do domínio. Os KPIs são calculados UMA vez
// sobre a união (`dailyBillingKpis`), e por isso não há dois totais a discordar.
//
// Concorrência: a leitura e as gravações vivem em dois hooks. A leitura só
// aplica a resposta mais recente do dia em vista; as gravações nunca escrevem
// estado — confirmadas, pedem uma recarga. Ver os cabeçalhos desses ficheiros.
//
// Realtime: `services` e `manual_charges`, ambas filtradas pela empresa. É
// convergência, não confirmação: a gravação própria já recarrega por si.
// ============================================================================

import { useEffect, useState } from "react";
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
import { addDaysToDateString, todayInLisbon } from "@/lib/lisbon-time";
import { setServicePayment, type DailyBillingData } from "@/app/actions/daily-billing";
import {
  createManualCharge,
  setManualChargePayment,
  updateManualCharge,
  voidManualCharge,
} from "@/app/actions/manual-charges";
import { deleteCalendarService } from "@/app/actions/cancellations";
import {
  billingRowKey,
  dailyBillingKpis,
  hasRegisteredPayment,
  isPendingReceivable,
  type DailyBillingRow,
} from "@/domain/billing/daily-billing";
import { interpretBillingRefusal } from "@/domain/billing/billing-errors";
import { useDailyBillingQuery } from "./use-daily-billing-query";
import { useBillingMutations } from "./use-billing-mutations";
import { BillingRow } from "./billing-row";
import { BillingEditorSheet } from "./billing-editor-sheet";
import { AddChargeChooser, ManualChargeCreateSheet } from "./add-charge-dialogs";
import { fmtEur } from "./billing-format";

interface Props {
  initialDate: string;
  initialData: DailyBillingData | null;
  initialError: string | null;
  companyId: string;
  clients: Client[];
  locations: Location[];
  teams: Team[];
}

type Adding = null | "choose" | "service" | "manual";

export function DailyBillingClient({ initialDate, initialData, initialError, companyId, clients, locations, teams }: Props) {
  const { date, data, error, loading, refresh, changeDay, isCurrentDate } =
    useDailyBillingQuery(initialDate, initialData, initialError);
  const { run, isBusy, mutationError, clearMutationError } = useBillingMutations({ date, refresh, isCurrentDate });

  const [adding, setAdding] = useState<Adding>(null);
  const [editingKey, setEditingKey] = useState<string | null>(null);
  const [deleting, setDeleting] = useState<DailyBillingRow | null>(null);

  // Tempo real: as duas tabelas desta lista, filtradas pela empresa. Fallback:
  // recarga a cada 60s e ao voltar à janela, caso o Realtime falhe.
  useEffect(() => {
    const supabase = createClient();
    const channel = supabase
      .channel(`daily-billing-${companyId}`)
      .on(
        "postgres_changes",
        { event: "*", schema: "public", table: "services", filter: `company_id=eq.${companyId}` },
        () => void refresh(),
      )
      .on(
        "postgres_changes",
        { event: "*", schema: "public", table: "manual_charges", filter: `company_id=eq.${companyId}` },
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

  function goTo(newDate: string) {
    setEditingKey(null);
    setDeleting(null);
    clearMutationError();
    changeDay(newDate);
  }

  const vatRate = data?.vatRate ?? 23;
  const day = data?.day ?? [];
  const pending = (data?.pending ?? []).filter((r) => isPendingReceivable(r, vatRate));
  const kpis = dailyBillingKpis(day, pending, vatRate);

  // O editor segue a linha pela chave, no snapshot mais recente: depois de uma
  // gravação mostra o estado que a base confirmou. Se a linha sair da lista
  // (anulada, apagada, mudou de dia), o editor fecha-se sozinho.
  const editingRow = editingKey
    ? [...day, ...pending].find((r) => billingRowKey(r) === editingKey) ?? null
    : null;

  const isToday = date === todayInLisbon();
  const dayLabel = safeFormat(new Date(`${date}T12:00:00`), "EEEE, d 'de' MMMM", { locale: pt });
  const clientOptions = clients.map((c) => ({ id: c.id, name: c.name }));

  async function applyPayment(row: DailyBillingRow, status: "nao_informado" | "sinal_50" | "pago_total", amount: number | null) {
    return run(billingRowKey(row), async () => {
      const r = row.type === "service"
        ? await setServicePayment(row.id, status, amount)
        : await setManualChargePayment(row.id, status, amount);
      return r.ok ? { ok: true as const } : r;
    });
  }

  async function confirmDelete(row: DailyBillingRow) {
    const r = await run(billingRowKey(row), async () => {
      if (row.type === "manual_charge") {
        const res = await voidManualCharge(row.id);
        return res.ok ? { ok: true as const } : res;
      }
      const res = await deleteCalendarService(row.id, "single");
      if (res.ok) return { ok: true as const };
      return { ok: false as const, error: interpretBillingRefusal(res.error)?.message ?? res.error };
    });
    if (r.ok) setDeleting(null);
  }

  const renderRows = (rows: DailyBillingRow[], showDate: boolean) => (
    <div className="divide-y divide-[var(--color-border)]">
      {rows.map((r) => (
        <BillingRow
          key={billingRowKey(r)}
          row={r}
          vatRate={vatRate}
          showDate={showDate}
          busy={isBusy(billingRowKey(r))}
          onEdit={() => { clearMutationError(); setEditingKey(billingRowKey(r)); }}
          onDelete={() => { clearMutationError(); setDeleting(r); }}
        />
      ))}
    </div>
  );

  const aCarregarDia = data === null && loading;

  return (
    <div className="space-y-5">
      {/* Navegação de dia */}
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex items-center gap-2">
          <button
            onClick={() => goTo(addDaysToDateString(date, -1))}
            className="p-2 rounded-lg border border-[var(--color-border)] text-[var(--color-text-sub)] hover:bg-[var(--color-background)] transition-colors"
            aria-label="Dia anterior"
          >
            <ChevronLeft className="w-4 h-4" />
          </button>
          <input
            type="date"
            value={date}
            onChange={(e) => { if (isValidIsoDateString(e.target.value)) goTo(e.target.value); }}
            className="px-3 py-2 rounded-lg border border-[var(--color-border)] text-sm text-[var(--color-text-main)] focus:outline-none focus:ring-2 focus:ring-[var(--finance-primary)]"
          />
          <button
            onClick={() => goTo(addDaysToDateString(date, 1))}
            className="p-2 rounded-lg border border-[var(--color-border)] text-[var(--color-text-sub)] hover:bg-[var(--color-background)] transition-colors"
            aria-label="Dia seguinte"
          >
            <ChevronRight className="w-4 h-4" />
          </button>
          {!isToday && (
            <button
              onClick={() => goTo(todayInLisbon())}
              className="px-3 py-2 rounded-lg border border-[var(--color-border)] text-xs font-medium text-[var(--finance-primary)] hover:bg-[var(--finance-primary-soft)] transition-colors"
            >
              Hoje
            </button>
          )}
        </div>
        <div className="flex items-center gap-3">
          <p className="text-sm font-medium text-[var(--color-text-main)] capitalize">{dayLabel}</p>
          <button
            onClick={() => setAdding("choose")}
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

      {/* KPIs do dia — uma regra por tipo, calculada uma vez sobre a união */}
      <div className="grid grid-cols-3 gap-3">
        <div className="bg-white rounded-xl border border-[var(--color-border)] p-4">
          <p className="text-xs text-[var(--color-text-muted)] mb-1">Total do dia (c/ IVA)</p>
          <p className="text-xl font-bold text-[var(--color-text-main)]">{fmtEur(kpis.total)}</p>
          <p className="text-xs text-[var(--color-text-muted)] mt-0.5">
            {kpis.counts.services} serviço{kpis.counts.services !== 1 ? "s" : ""}
            {kpis.counts.manualCharges > 0 && <> · {kpis.counts.manualCharges} avulsa{kpis.counts.manualCharges !== 1 ? "s" : ""}</>}
          </p>
        </div>
        <div className="bg-white rounded-xl border border-[var(--color-border)] p-4">
          <p className="text-xs text-[var(--color-text-muted)] mb-1">Recebido</p>
          <p className="text-xl font-bold text-green-600">{fmtEur(kpis.received)}</p>
          <p className="text-xs text-[var(--color-text-muted)] mt-0.5">50% conta metade · valor livre conta o registado</p>
        </div>
        <div className="bg-white rounded-xl border border-[var(--color-border)] p-4">
          <p className="text-xs text-[var(--color-text-muted)] mb-1">Por receber</p>
          <p className={`text-xl font-bold ${kpis.outstanding > 0 ? "text-amber-600" : "text-green-600"}`}>{fmtEur(kpis.outstanding)}</p>
          <p className="text-xs text-[var(--color-text-muted)] mt-0.5">{kpis.outstanding > 0 ? "há cobranças em aberto" : "dia fechado"}</p>
        </div>
      </div>

      {(error || mutationError) && (
        <div role="alert" className="flex items-center gap-3 p-4 bg-red-50 border border-red-200 rounded-xl text-sm text-red-700">
          <AlertCircle className="w-4 h-4 shrink-0" />
          {mutationError ?? error}
        </div>
      )}

      {/* Cobranças do dia */}
      <div className="bg-white rounded-xl border border-[var(--color-border)] overflow-hidden">
        <div className="px-4 py-3 border-b border-[var(--color-border)] flex items-center gap-2">
          <CalendarDays className="w-4 h-4 text-[var(--finance-primary)]" />
          <p className="text-sm font-semibold text-[var(--color-text-main)]">Cobranças do dia</p>
        </div>
        {aCarregarDia ? (
          <p className="text-sm text-[var(--color-text-muted)] px-4 py-8 text-center flex items-center justify-center gap-2">
            <Loader2 className="w-4 h-4 animate-spin" /> A carregar cobranças…
          </p>
        ) : day.length === 0 ? (
          <p className="text-sm text-[var(--color-text-muted)] px-4 py-8 text-center">Sem cobranças neste dia.</p>
        ) : renderRows(day, false)}
      </div>

      {/* Pendentes de dias anteriores */}
      <div className="bg-white rounded-xl border border-amber-200 overflow-hidden">
        <div className="px-4 py-3 border-b border-amber-200 bg-amber-50 flex items-center justify-between">
          <div className="flex items-center gap-2">
            <Clock className="w-4 h-4 text-amber-600" />
            <p className="text-sm font-semibold text-amber-800">
              Por cobrar de dias anteriores ({kpis.counts.pending})
            </p>
          </div>
          <p className="text-sm font-semibold text-amber-700">{fmtEur(kpis.pendingTotal)}</p>
        </div>
        {aCarregarDia ? null : pending.length === 0 ? (
          <p className="text-sm text-[var(--color-text-muted)] px-4 py-6 text-center flex items-center justify-center gap-2">
            <CheckCircle2 className="w-4 h-4 text-green-600" /> Nada pendente dos últimos 60 dias.
          </p>
        ) : renderRows(pending, true)}
      </div>

      {adding === "choose" && (
        <AddChargeChooser
          onClose={() => setAdding(null)}
          onNewService={() => setAdding("service")}
          onManualCharge={() => setAdding("manual")}
        />
      )}

      {adding === "manual" && (
        <ManualChargeCreateSheet
          date={date}
          clients={clientOptions}
          onClose={() => setAdding(null)}
          onCreate={async (input) => {
            const r = await createManualCharge(input);
            if (!r.ok) return r;
            setAdding(null);
            void refresh();
            return { ok: true };
          }}
        />
      )}

      {/*
        O MESMO componente que o calendário e a ficha de cliente usam. A data
        é a do dia em vista, não «hoje»: quem está a fechar o dia 12 cria para
        o dia 12.
      */}
      <ServiceCreateSheet
        open={adding === "service"}
        onClose={() => setAdding(null)}
        onCreated={() => { setAdding(null); void refresh(); }}
        companyId={companyId}
        date={new Date(`${date}T12:00:00`)}
        initialStartTime="09:00"
        initialTeamId={teams[0]?.id ?? ""}
        clients={clients}
        locations={locations}
        teams={teams}
      />

      {editingRow && (
        <BillingEditorSheet
          key={editingKey ?? undefined}
          row={editingRow}
          vatRate={vatRate}
          busy={isBusy(billingRowKey(editingRow))}
          clients={clientOptions}
          onClose={() => setEditingKey(null)}
          onPayment={(status, amount) => applyPayment(editingRow, status, amount)}
          onSaveManual={(patch) => run(billingRowKey(editingRow), async () => {
            const r = await updateManualCharge(editingRow.id, patch);
            return r.ok ? { ok: true as const } : r;
          })}
        />
      )}

      {deleting && (
        <DeleteConfirm
          row={deleting}
          busy={isBusy(billingRowKey(deleting))}
          error={mutationError}
          onCancel={() => { setDeleting(null); clearMutationError(); }}
          onConfirm={() => void confirmDelete(deleting)}
        />
      )}
    </div>
  );
}

function DeleteConfirm({
  row, busy, error, onCancel, onConfirm,
}: {
  row: DailyBillingRow;
  busy: boolean;
  error: string | null;
  onCancel: () => void;
  onConfirm: () => void;
}) {
  // 🔴 Com dinheiro registado não se oferece a exclusão: a base recusaria na
  //    mesma, e oferecer um botão que vai falhar ensina a ignorar erros. O
  //    caminho é retirar o recebimento no editor primeiro.
  const comRecebimento = hasRegisteredPayment(row);
  const titulo = row.type === "service" ? "Excluir serviço" : "Excluir cobrança avulsa";
  const texto = row.type === "service"
    ? "O serviço sai do calendário e da app das equipas. Esta ação não se desfaz."
    : "A cobrança deixa de contar nos totais. Fica registada como anulada no histórico.";

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4"
      onClick={(e) => { if (e.target === e.currentTarget && !busy) onCancel(); }}
      role="dialog"
      aria-modal="true"
      aria-label={titulo}
    >
      <div className="w-full max-w-sm rounded-2xl bg-white p-5 shadow-xl space-y-3">
        <p className="text-base font-semibold text-[var(--color-text-main)]">{titulo}</p>
        <p className="text-sm text-[var(--color-text-sub)]">{row.client_name}</p>
        {comRecebimento ? (
          <p className="rounded-lg bg-amber-50 px-3 py-2 text-xs text-amber-800">
            Tem um recebimento registado. Retire primeiro o recebimento em «Editar» e depois exclua.
          </p>
        ) : (
          <p className="text-xs text-[var(--color-text-muted)]">{texto}</p>
        )}
        {error && <p role="alert" className="text-xs text-red-700">{error}</p>}
        <div className="flex justify-end gap-2 pt-1">
          <button type="button" onClick={onCancel} disabled={busy}
            className="rounded-lg border border-[var(--color-border)] px-3 py-2 text-sm hover:bg-[var(--color-background)]">
            Cancelar
          </button>
          {!comRecebimento && (
            <button type="button" onClick={onConfirm} disabled={busy}
              className="inline-flex items-center gap-2 rounded-lg bg-red-600 px-3 py-2 text-sm font-semibold text-white hover:bg-red-700 disabled:opacity-50">
              {busy && <Loader2 className="h-4 w-4 animate-spin" />} Excluir
            </button>
          )}
        </div>
      </div>
    </div>
  );
}

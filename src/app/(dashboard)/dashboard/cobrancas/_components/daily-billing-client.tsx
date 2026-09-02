"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import {
  AlertCircle,
  CalendarDays,
  CheckCircle2,
  ChevronLeft,
  ChevronRight,
  Clock,
  Loader2,
  Pencil,
  Plus,
  ReceiptText,
  RefreshCw,
  Trash2,
  X,
} from "lucide-react";
import { format, parseISO } from "date-fns";
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
  getDailyBilling,
  setServicePayment,
  type DailyBillingData,
  type DailyBillingRow,
} from "@/app/actions/daily-billing";
import {
  createManualCharge,
  deleteBillingService,
  setManualChargePayment,
  updateManualCharge,
  voidManualCharge,
  type ManualChargePaymentStatus,
} from "@/app/actions/manual-charges";

function fmtEur(value: number) {
  return value.toLocaleString("pt-PT", { minimumFractionDigits: 2, maximumFractionDigits: 2 }) + " €";
}

function todayStr() {
  const date = new Date();
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}`;
}

function shiftDay(dateStr: string, delta: number): string {
  const date = new Date(`${dateStr}T12:00:00`);
  date.setDate(date.getDate() + delta);
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}`;
}

function totalOf(row: DailyBillingRow, vatRate: number): number {
  return row.value * (row.apply_vat ? 1 + vatRate / 100 : 1);
}

function receivedOf(row: DailyBillingRow, vatRate: number): number {
  if (row.paid_amount != null) return row.paid_amount;
  const total = totalOf(row, vatRate);
  if (row.payment_status === "pago_total") return total;
  if (row.payment_status === "sinal_50") return total / 2;
  return 0;
}

interface Props {
  initialDate: string;
  initialData: DailyBillingData | null;
  initialError: string | null;
  companyId: string;
  clients: Client[];
  locations: Location[];
  teams: Team[];
}

type AddMode = null | "choose" | "service" | "manual";

interface ManualFormState {
  clientId: string;
  chargeDate: string;
  description: string;
  amount: string;
  applyVat: boolean;
  notes: string;
}

function emptyManualForm(date: string, clients: Client[]): ManualFormState {
  return {
    clientId: clients[0]?.id ?? "",
    chargeDate: date,
    description: "",
    amount: "",
    applyVat: true,
    notes: "",
  };
}

export function DailyBillingClient({
  initialDate,
  initialData,
  initialError,
  companyId,
  clients,
  locations,
  teams,
}: Props) {
  const [date, setDate] = useState(initialDate);
  const [data, setData] = useState<DailyBillingData | null>(initialData);
  const [error, setError] = useState<string | null>(initialError);
  const [loading, setLoading] = useState(false);
  const [savingId, setSavingId] = useState<string | null>(null);
  const [editing, setEditing] = useState<DailyBillingRow | null>(null);
  const [addMode, setAddMode] = useState<AddMode>(null);
  const [manualForm, setManualForm] = useState<ManualFormState>(() => emptyManualForm(initialDate, clients));
  const dateRef = useRef(date);

  useEffect(() => { dateRef.current = date; }, [date]);

  const refresh = useCallback(async (targetDate?: string) => {
    const target = targetDate ?? dateRef.current;
    const result = await getDailyBilling(target);
    if (target !== dateRef.current) return;
    if (result.ok) {
      setData(result.data);
      setError(null);
    } else {
      setError(result.error);
    }
    setLoading(false);
  }, []);

  function changeDay(nextDate: string) {
    setDate(nextDate);
    dateRef.current = nextDate;
    setLoading(true);
    setEditing(null);
    setManualForm((current) => ({ ...current, chargeDate: nextDate }));
    void refresh(nextDate);
  }

  // Realtime é gatilho, não fonte: qualquer alteração nas duas origens força
  // refetch canónico. O fallback cobre publicação/reconexão indisponível.
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
      void supabase.removeChannel(channel);
      clearInterval(interval);
      window.removeEventListener("focus", onFocus);
    };
  }, [companyId, refresh]);

  async function applyPayment(
    row: DailyBillingRow,
    status: ManualChargePaymentStatus,
    amount?: number | null,
  ) {
    setSavingId(row.id);
    const result = row.type === "service"
      ? await setServicePayment(row.id, status, amount)
      : await setManualChargePayment(row.id, status, amount);
    setSavingId(null);
    if (!result.ok) {
      setError(result.error);
      return;
    }
    setError(null);
    setEditing(null);
    setLoading(true);
    void refresh();
  }

  async function removeRow(row: DailyBillingRow) {
    const label = row.type === "service" ? "este serviço" : "esta nota de cobrança";
    if (!window.confirm(`Confirma excluir ${label}?`)) return;
    setSavingId(row.id);
    const result = row.type === "service"
      ? await deleteBillingService(row.id)
      : await voidManualCharge(row.id);
    setSavingId(null);
    if (!result.ok) {
      setError(result.error);
      return;
    }
    setEditing(null);
    setLoading(true);
    void refresh();
  }

  function openManualCreate() {
    setManualForm(emptyManualForm(date, clients));
    setAddMode("manual");
  }

  async function submitManualCreate() {
    const amount = Number(manualForm.amount.replace(",", "."));
    setSavingId("new-manual");
    const result = await createManualCharge({
      clientId: manualForm.clientId,
      chargeDate: manualForm.chargeDate,
      description: manualForm.description,
      amount,
      applyVat: manualForm.applyVat,
      notes: manualForm.notes,
    });
    setSavingId(null);
    if (!result.ok) {
      setError(result.error);
      return;
    }
    setAddMode(null);
    setLoading(true);
    void refresh();
  }

  const day = data?.day ?? [];
  const pending = data?.pending ?? [];
  const vatRate = data?.vatRate ?? 23;
  const totalDay = day.reduce((sum, row) => sum + totalOf(row, vatRate), 0);
  const receivedDay = day.reduce((sum, row) => sum + Math.min(receivedOf(row, vatRate), totalOf(row, vatRate)), 0);
  const outstandingDay = Math.max(0, totalDay - receivedDay);
  const pendingTotal = pending.reduce(
    (sum, row) => sum + Math.max(0, totalOf(row, vatRate) - receivedOf(row, vatRate)),
    0,
  );
  const isToday = date === todayStr();
  const dayLabel = safeFormat(new Date(`${date}T12:00:00`), "EEEE, d 'de' MMMM", { locale: pt });

  return (
    <div className="space-y-5">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex items-center gap-2">
          <button onClick={() => changeDay(shiftDay(date, -1))} className="p-2 rounded-lg border border-[var(--color-border)]" aria-label="Dia anterior">
            <ChevronLeft className="w-4 h-4" />
          </button>
          <input
            type="date"
            value={date}
            onChange={(event) => { if (isValidIsoDateString(event.target.value)) changeDay(event.target.value); }}
            className="px-3 py-2 rounded-lg border border-[var(--color-border)] text-sm"
          />
          <button onClick={() => changeDay(shiftDay(date, 1))} className="p-2 rounded-lg border border-[var(--color-border)]" aria-label="Dia seguinte">
            <ChevronRight className="w-4 h-4" />
          </button>
          {!isToday && <button onClick={() => changeDay(todayStr())} className="px-3 py-2 rounded-lg border text-xs font-medium">Hoje</button>}
        </div>
        <div className="flex items-center gap-3">
          <p className="text-sm font-medium capitalize">{dayLabel}</p>
          <button
            onClick={() => setAddMode("choose")}
            className="inline-flex items-center gap-2 rounded-lg bg-[var(--finance-primary)] px-3.5 py-2 text-sm font-semibold text-white"
          >
            <Plus className="w-4 h-4" /> Adicionar cobrança
          </button>
          <button onClick={() => { setLoading(true); void refresh(); }} disabled={loading} title="Atualizar" className="p-2 rounded-lg border disabled:opacity-50">
            {loading ? <Loader2 className="w-4 h-4 animate-spin" /> : <RefreshCw className="w-4 h-4" />}
          </button>
        </div>
      </div>

      <div className="grid grid-cols-1 md:grid-cols-3 gap-3">
        <Kpi label="Total do dia (c/ IVA)" value={fmtEur(totalDay)} hint={`${day.length} recebível${day.length !== 1 ? "eis" : ""}`} />
        <Kpi label="Recebido" value={fmtEur(receivedDay)} hint="Serviços + notas de cobrança" tone="green" />
        <Kpi label="Por receber" value={fmtEur(outstandingDay)} hint={outstandingDay > 0 ? "há cobranças em aberto" : "dia fechado"} tone={outstandingDay > 0 ? "amber" : "green"} />
      </div>

      {error && (
        <div className="flex items-center gap-3 p-4 bg-red-50 border border-red-200 rounded-xl text-sm text-red-700">
          <AlertCircle className="w-4 h-4 shrink-0" /> {error}
        </div>
      )}

      <BillingSection
        title="Cobranças do dia"
        icon={<CalendarDays className="w-4 h-4 text-[var(--finance-primary)]" />}
        rows={day}
        vatRate={vatRate}
        savingId={savingId}
        onEdit={setEditing}
        onDelete={(row) => void removeRow(row)}
        empty="Sem cobranças neste dia."
      />

      <BillingSection
        title={`Por cobrar de dias anteriores (${pending.length})`}
        icon={<Clock className="w-4 h-4 text-amber-600" />}
        rows={pending}
        vatRate={vatRate}
        savingId={savingId}
        onEdit={setEditing}
        onDelete={(row) => void removeRow(row)}
        showDate
        amber
        right={fmtEur(pendingTotal)}
        empty="Nada pendente dos últimos 60 dias."
      />

      <ServiceCreateSheet
        open={addMode === "service"}
        onClose={() => setAddMode(null)}
        onCreated={() => { setAddMode(null); setLoading(true); void refresh(); }}
        companyId={companyId}
        date={new Date(`${date}T12:00:00`)}
        initialStartTime="09:00"
        initialTeamId={teams[0]?.id ?? ""}
        clients={clients}
        locations={locations}
        teams={teams}
      />

      {addMode === "choose" && (
        <Modal title="Adicionar cobrança" onClose={() => setAddMode(null)}>
          <div className="grid gap-3 sm:grid-cols-2">
            <button onClick={() => setAddMode("service")} className="rounded-xl border p-5 text-left hover:bg-slate-50">
              <CalendarDays className="w-5 h-5 mb-3 text-[var(--finance-primary)]" />
              <p className="font-semibold">Novo serviço</p>
              <p className="mt-1 text-xs text-slate-500">Cria trabalho operacional no calendário.</p>
            </button>
            <button onClick={openManualCreate} className="rounded-xl border p-5 text-left hover:bg-slate-50">
              <ReceiptText className="w-5 h-5 mb-3 text-[var(--finance-primary)]" />
              <p className="font-semibold">Cobrança avulsa / Nota de cobrança</p>
              <p className="mt-1 text-xs text-slate-500">Recebível financeiro sem serviço e sem fatura obrigatória.</p>
            </button>
          </div>
        </Modal>
      )}

      {addMode === "manual" && (
        <Modal title="Nova nota de cobrança" onClose={() => setAddMode(null)}>
          <ManualChargeForm
            form={manualForm}
            setForm={setManualForm}
            clients={clients}
            disabled={savingId === "new-manual"}
          />
          <div className="mt-5 flex justify-end gap-2">
            <button onClick={() => setAddMode(null)} className="rounded-lg border px-4 py-2 text-sm">Cancelar</button>
            <button
              onClick={() => void submitManualCreate()}
              disabled={savingId === "new-manual" || !manualForm.clientId || !manualForm.description.trim() || !manualForm.amount}
              className="rounded-lg bg-[var(--finance-primary)] px-4 py-2 text-sm font-semibold text-white disabled:opacity-50"
            >
              {savingId === "new-manual" ? "A guardar…" : "Criar cobrança"}
            </button>
          </div>
        </Modal>
      )}

      {editing && (
        <BillingEditor
          row={editing}
          vatRate={vatRate}
          clients={clients}
          saving={savingId === editing.id}
          onClose={() => setEditing(null)}
          onPayment={(status, amount) => void applyPayment(editing, status, amount)}
          onUpdated={() => { setEditing(null); setLoading(true); void refresh(); }}
          onError={setError}
          onSaving={(saving) => setSavingId(saving ? editing.id : null)}
        />
      )}
    </div>
  );
}

function Kpi({ label, value, hint, tone = "default" }: { label: string; value: string; hint: string; tone?: "default" | "green" | "amber" }) {
  const valueClass = tone === "green" ? "text-green-600" : tone === "amber" ? "text-amber-600" : "text-[var(--color-text-main)]";
  return (
    <div className="bg-white rounded-xl border border-[var(--color-border)] p-4">
      <p className="text-xs text-[var(--color-text-muted)] mb-1">{label}</p>
      <p className={`text-xl font-bold ${valueClass}`}>{value}</p>
      <p className="text-xs text-[var(--color-text-muted)] mt-0.5">{hint}</p>
    </div>
  );
}

function BillingSection({
  title, icon, rows, vatRate, savingId, onEdit, onDelete, empty, showDate = false, amber = false, right,
}: {
  title: string;
  icon: React.ReactNode;
  rows: DailyBillingRow[];
  vatRate: number;
  savingId: string | null;
  onEdit: (row: DailyBillingRow) => void;
  onDelete: (row: DailyBillingRow) => void;
  empty: string;
  showDate?: boolean;
  amber?: boolean;
  right?: string;
}) {
  return (
    <div className={`bg-white rounded-xl border ${amber ? "border-amber-200" : "border-[var(--color-border)]"} overflow-hidden`}>
      <div className={`px-4 py-3 border-b flex items-center justify-between ${amber ? "border-amber-200 bg-amber-50" : "border-[var(--color-border)]"}`}>
        <div className="flex items-center gap-2">{icon}<p className={`text-sm font-semibold ${amber ? "text-amber-800" : "text-[var(--color-text-main)]"}`}>{title}</p></div>
        {right && <p className="text-sm font-semibold text-amber-700">{right}</p>}
      </div>
      {rows.length === 0 ? (
        <p className="text-sm text-[var(--color-text-muted)] px-4 py-7 text-center flex items-center justify-center gap-2">
          {amber && <CheckCircle2 className="w-4 h-4 text-green-600" />} {empty}
        </p>
      ) : (
        <div className="divide-y divide-[var(--color-border)]">
          {rows.map((row) => (
            <BillingRow key={`${row.type}:${row.id}`} row={row} vatRate={vatRate} showDate={showDate} saving={savingId === row.id} onEdit={() => onEdit(row)} onDelete={() => onDelete(row)} />
          ))}
        </div>
      )}
    </div>
  );
}

function BillingRow({ row, vatRate, showDate, saving, onEdit, onDelete }: { row: DailyBillingRow; vatRate: number; showDate: boolean; saving: boolean; onEdit: () => void; onDelete: () => void }) {
  const total = totalOf(row, vatRate);
  const received = receivedOf(row, vatRate);
  return (
    <div className="px-4 py-3 flex flex-wrap items-center gap-3">
      <div className="flex-1 min-w-[200px]">
        <div className="flex items-center gap-2">
          <p className="text-sm font-semibold truncate">{row.client_name}</p>
          <span className={`text-[10px] font-semibold rounded-full border px-1.5 py-0.5 ${row.type === "manual_charge" ? "bg-violet-50 text-violet-700 border-violet-200" : "bg-slate-50 text-slate-600 border-slate-200"}`}>
            {row.type === "manual_charge" ? "Nota" : row.is_avenca ? "Avença" : "Serviço"}
          </span>
        </div>
        <p className="text-xs text-[var(--color-text-muted)] truncate">
          {row.type === "manual_charge" ? row.description : row.location_name}
          {showDate && <> · {format(parseISO(row.scheduled_start), "d MMM", { locale: pt })}</>}
          {row.reference_number && <> · #{row.reference_number}</>}
        </p>
        {received > 0 && <p className="mt-1 text-[11px] text-green-700">Recebido {fmtEur(received)}{received < total ? ` · falta ${fmtEur(total - received)}` : ""}</p>}
      </div>
      <div className="w-32 text-right shrink-0">
        <p className="text-sm font-bold">{fmtEur(total)}</p>
        <p className="text-[11px] text-[var(--color-text-muted)]">{row.apply_vat ? "com IVA" : "sem IVA"}</p>
      </div>
      <div className="flex gap-2 shrink-0">
        <button disabled={saving} onClick={onEdit} className="inline-flex items-center gap-1.5 rounded-lg border px-3 py-1.5 text-xs font-semibold disabled:opacity-50">
          <Pencil className="w-3.5 h-3.5" /> Editar
        </button>
        <button disabled={saving} onClick={onDelete} className="inline-flex items-center gap-1.5 rounded-lg border border-red-200 px-3 py-1.5 text-xs font-semibold text-red-700 disabled:opacity-50">
          {saving ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Trash2 className="w-3.5 h-3.5" />} Excluir
        </button>
      </div>
    </div>
  );
}

function BillingEditor({
  row, vatRate, clients, saving, onClose, onPayment, onUpdated, onError, onSaving,
}: {
  row: DailyBillingRow;
  vatRate: number;
  clients: Client[];
  saving: boolean;
  onClose: () => void;
  onPayment: (status: ManualChargePaymentStatus, amount?: number | null) => void;
  onUpdated: () => void;
  onError: (error: string | null) => void;
  onSaving: (saving: boolean) => void;
}) {
  const total = totalOf(row, vatRate);
  const received = receivedOf(row, vatRate);
  const hasPayment = received > 0 || row.payment_status !== "nao_informado" || Boolean(row.paid_at);
  const [amountInput, setAmountInput] = useState(row.paid_amount != null ? String(row.paid_amount) : "");
  const [manualForm, setManualForm] = useState<ManualFormState>({
    clientId: row.client_id ?? "",
    chargeDate: row.scheduled_start.slice(0, 10),
    description: row.description,
    amount: String(row.value),
    applyVat: row.apply_vat,
    notes: row.notes ?? "",
  });

  async function saveManualFields() {
    const amount = Number(manualForm.amount.replace(",", "."));
    onSaving(true);
    const result = await updateManualCharge(row.id, {
      clientId: manualForm.clientId,
      chargeDate: manualForm.chargeDate,
      description: manualForm.description,
      amount,
      applyVat: manualForm.applyVat,
      notes: manualForm.notes,
    });
    onSaving(false);
    if (!result.ok) { onError(result.error); return; }
    onError(null);
    onUpdated();
  }

  const parsedAmount = amountInput.trim() ? Number(amountInput.replace(",", ".")) : null;

  return (
    <Modal title={row.type === "service" ? "Editar cobrança do serviço" : "Editar nota de cobrança"} onClose={onClose}>
      {row.type === "manual_charge" && (
        <>
          <ManualChargeForm form={manualForm} setForm={setManualForm} clients={clients} disabled={saving || hasPayment} />
          {hasPayment && <p className="mt-3 rounded-lg bg-amber-50 border border-amber-200 p-3 text-xs text-amber-800">Retire primeiro o recebimento para alterar os campos financeiros ou a proveniência da nota.</p>}
        </>
      )}

      {row.type === "service" && (
        <div className="rounded-xl border p-4">
          <p className="text-sm font-semibold">{row.client_name}</p>
          <p className="text-xs text-slate-500">{row.location_name}{row.reference_number ? ` · #${row.reference_number}` : ""}</p>
          <p className="mt-2 text-sm font-bold">{fmtEur(total)}</p>
        </div>
      )}

      <div className="mt-5 border-t pt-4">
        <p className="text-sm font-semibold">Recebimento</p>
        <p className="mt-1 text-xs text-slate-500">Estado e Fluxo de Caixa são gravados na mesma transação.</p>
        <div className="mt-3 flex flex-wrap gap-2">
          <PaymentButton active={row.payment_status === "nao_informado" && row.paid_amount == null} disabled={saving} onClick={() => onPayment("nao_informado", null)}>Por pagar</PaymentButton>
          <PaymentButton active={row.payment_status === "sinal_50" && row.paid_amount == null} disabled={saving} onClick={() => onPayment("sinal_50", null)}>50%</PaymentButton>
          <PaymentButton active={row.payment_status === "pago_total" && row.paid_amount == null} disabled={saving} onClick={() => onPayment("pago_total", null)}>100%</PaymentButton>
        </div>
        <div className="mt-3 flex gap-2">
          <input type="number" min="0" step="0.01" value={amountInput} onChange={(event) => setAmountInput(event.target.value)} placeholder="Valor recebido (€)" className="flex-1 rounded-lg border px-3 py-2 text-sm" />
          <button
            disabled={saving || parsedAmount == null || !Number.isFinite(parsedAmount) || parsedAmount <= 0}
            onClick={() => {
              if (parsedAmount == null) return;
              onPayment(parsedAmount >= total - 0.005 ? "pago_total" : "sinal_50", parsedAmount);
            }}
            className="rounded-lg bg-[var(--finance-primary)] px-4 py-2 text-sm font-semibold text-white disabled:opacity-50"
          >
            Registar €
          </button>
        </div>
        {received > 0 && <p className="mt-2 text-xs text-green-700">Recebido atualmente: {fmtEur(received)}</p>}
      </div>

      <div className="mt-5 flex justify-end gap-2">
        <button onClick={onClose} className="rounded-lg border px-4 py-2 text-sm">Fechar</button>
        {row.type === "manual_charge" && (
          <button disabled={saving || hasPayment} onClick={() => void saveManualFields()} className="rounded-lg bg-[var(--finance-primary)] px-4 py-2 text-sm font-semibold text-white disabled:opacity-50">
            Guardar dados
          </button>
        )}
      </div>
    </Modal>
  );
}

function PaymentButton({ active, disabled, onClick, children }: { active: boolean; disabled: boolean; onClick: () => void; children: React.ReactNode }) {
  return <button disabled={disabled} onClick={onClick} className={`rounded-lg border px-3 py-2 text-xs font-semibold disabled:opacity-50 ${active ? "bg-[var(--finance-primary)] text-white border-[var(--finance-primary)]" : "bg-white"}`}>{children}</button>;
}

function ManualChargeForm({ form, setForm, clients, disabled }: { form: ManualFormState; setForm: React.Dispatch<React.SetStateAction<ManualFormState>>; clients: Client[]; disabled: boolean }) {
  const input = "w-full rounded-lg border px-3 py-2 text-sm disabled:bg-slate-50 disabled:text-slate-500";
  return (
    <div className="grid gap-3 sm:grid-cols-2">
      <label className="text-xs font-medium">Cliente
        <select disabled={disabled} value={form.clientId} onChange={(event) => setForm((state) => ({ ...state, clientId: event.target.value }))} className={`${input} mt-1`}>
          <option value="">Selecionar…</option>
          {clients.map((client) => <option key={client.id} value={client.id}>{client.name}</option>)}
        </select>
      </label>
      <label className="text-xs font-medium">Data
        <input disabled={disabled} type="date" value={form.chargeDate} onChange={(event) => setForm((state) => ({ ...state, chargeDate: event.target.value }))} className={`${input} mt-1`} />
      </label>
      <label className="sm:col-span-2 text-xs font-medium">Descrição
        <input disabled={disabled} value={form.description} onChange={(event) => setForm((state) => ({ ...state, description: event.target.value }))} className={`${input} mt-1`} />
      </label>
      <label className="text-xs font-medium">Valor base (€)
        <input disabled={disabled} type="number" min="0.01" step="0.01" value={form.amount} onChange={(event) => setForm((state) => ({ ...state, amount: event.target.value }))} className={`${input} mt-1`} />
      </label>
      <label className="flex items-end gap-2 rounded-lg border p-2.5 text-xs font-medium">
        <input disabled={disabled} type="checkbox" checked={form.applyVat} onChange={(event) => setForm((state) => ({ ...state, applyVat: event.target.checked }))} /> Aplicar IVA
      </label>
      <label className="sm:col-span-2 text-xs font-medium">Notas
        <textarea disabled={disabled} value={form.notes} onChange={(event) => setForm((state) => ({ ...state, notes: event.target.value }))} rows={3} className={`${input} mt-1`} />
      </label>
    </div>
  );
}

function Modal({ title, onClose, children }: { title: string; onClose: () => void; children: React.ReactNode }) {
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4" role="dialog" aria-modal="true">
      <div className="w-full max-w-xl max-h-[90vh] overflow-y-auto rounded-2xl bg-white shadow-xl">
        <div className="sticky top-0 flex items-center justify-between border-b bg-white px-5 py-4">
          <h3 className="font-semibold">{title}</h3>
          <button onClick={onClose} className="rounded-lg p-1.5 hover:bg-slate-100" aria-label="Fechar"><X className="w-4 h-4" /></button>
        </div>
        <div className="p-5">{children}</div>
      </div>
    </div>
  );
}

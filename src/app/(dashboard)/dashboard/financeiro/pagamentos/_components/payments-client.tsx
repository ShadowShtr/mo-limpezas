"use client";

import { useState, useTransition } from "react";
import {
  Plus, Trash2, Loader2, AlertCircle, X, Check, Clock, CheckCircle2,
  Repeat, Calendar, Zap, Pencil,
} from "lucide-react";
import {
  getPayments, createPayment, updatePayment, setPaymentStatus, deletePayment,
  type PaymentsData, type Payment, type PaymentKind,
} from "@/app/actions/payments";
import { todayInLisbon } from "@/lib/lisbon-time";

function fmtEur(v: number | null) {
  if (v === null || v === undefined) return "—";
  return v.toLocaleString("pt-PT", { minimumFractionDigits: 2, maximumFractionDigits: 2 }) + " €";
}
function fmtDate(s: string | null) {
  if (!s) return "—";
  return new Date(s + "T00:00:00").toLocaleDateString("pt-PT", { day: "2-digit", month: "short" });
}
interface Props {
  initialData: PaymentsData | null;
  error: string | null;
  mesParam: string;
  year: number;
  month: number;
}

type FormState = {
  id: string | null;
  kind: PaymentKind;
  description: string;
  amount: string;
  due_date: string;
  direct_debit: "" | "sim" | "nao";
  notes: string;
};

const emptyForm = (kind: PaymentKind): FormState => ({
  id: null, kind, description: "", amount: "", due_date: "", direct_debit: "", notes: "",
});

export function PaymentsClient({ initialData, error: initErr, mesParam, year, month }: Props) {
  const [data, setData] = useState<PaymentsData | null>(initialData);
  const [error, setError] = useState(initErr);
  const [isPending, startTransition] = useTransition();
  const [form, setForm] = useState<FormState | null>(null);
  const [formError, setFormError] = useState("");

  function reload() {
    startTransition(async () => {
      const res = await getPayments(year, month);
      if (res.ok) setData(res.data);
      else setError(res.error);
    });
  }

  function handleMonthChange(val: string) {
    window.location.href = `/dashboard/financeiro/pagamentos?mes=${val}`;
  }

  function openNew(kind: PaymentKind) {
    setFormError("");
    setForm(emptyForm(kind));
  }
  function openEdit(p: Payment) {
    setFormError("");
    setForm({
      id: p.id, kind: p.kind, description: p.description,
      amount: p.amount === null ? "" : String(p.amount),
      due_date: p.due_date ?? "",
      direct_debit: p.direct_debit === null ? "" : p.direct_debit ? "sim" : "nao",
      notes: p.notes ?? "",
    });
  }

  function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (!form) return;
    setFormError("");
    if (!form.description.trim()) { setFormError("Descrição obrigatória."); return; }
    const amount = form.amount.trim() === "" ? null : parseFloat(form.amount.replace(",", "."));
    if (amount !== null && (isNaN(amount) || amount < 0)) { setFormError("Valor inválido."); return; }
    const direct_debit = form.direct_debit === "" ? null : form.direct_debit === "sim";
    const due_date = form.due_date.trim() === "" ? null : form.due_date;
    const notes = form.notes.trim() === "" ? null : form.notes.trim();

    startTransition(async () => {
      const res = form.id
        ? await updatePayment(form.id, { description: form.description.trim(), amount, due_date, direct_debit, notes })
        : await createPayment({ kind: form.kind, description: form.description.trim(), amount, due_date, direct_debit, notes, year, month });
      if (!res.ok) { setFormError(res.error ?? "Erro."); return; }
      setForm(null);
      reload();
    });
  }

  function toggleStatus(p: Payment) {
    startTransition(async () => {
      await setPaymentStatus(p.id, p.status === "pago" ? "pendente" : "pago");
      reload();
    });
  }
  function handleDelete(p: Payment) {
    if (!confirm(`Eliminar "${p.description}"?`)) return;
    startTransition(async () => {
      await deletePayment(p.id);
      reload();
    });
  }

  const today = todayInLisbon();

  return (
    <div className="space-y-5">
      {/* Toolbar */}
      <div className="bg-white rounded-xl border border-[var(--color-border)] px-4 py-3 flex flex-wrap items-end gap-3">
        <div>
          <label className="block text-xs text-[var(--color-text-muted)] mb-1">Mês</label>
          <input
            type="month"
            defaultValue={mesParam}
            onChange={(e) => handleMonthChange(e.target.value)}
            className="px-3 py-2 rounded-lg border border-[var(--color-border)] text-sm focus:outline-none focus:ring-2 focus:ring-[var(--color-primary)]"
          />
        </div>
        <div className="flex-1" />
        <p className="text-xs text-[var(--color-text-muted)] max-w-xs">
          Os <strong>fixos</strong> repetem-se todos os meses automaticamente. Os <strong>variáveis</strong> são pontuais.
        </p>
      </div>

      {error && (
        <div className="flex items-center gap-3 p-4 bg-red-50 border border-red-200 rounded-xl text-sm text-red-700">
          <AlertCircle className="w-4 h-4 shrink-0" />
          {error}
        </div>
      )}

      {/* KPIs */}
      {data && (
        <div className="grid grid-cols-2 lg:grid-cols-4 gap-4">
          <Kpi icon={<Clock className="w-4 h-4 text-amber-600" />} bg="bg-amber-50" label="Por pagar" value={fmtEur(data.totalPendente)} accent="text-amber-600" />
          <Kpi icon={<CheckCircle2 className="w-4 h-4 text-green-600" />} bg="bg-green-50" label="Já pago" value={fmtEur(data.totalPago)} accent="text-green-600" />
          <Kpi icon={<AlertCircle className="w-4 h-4 text-red-600" />} bg="bg-red-50" label="Em atraso" value={`${data.countOverdue}`} accent="text-red-600" />
          <Kpi icon={<Clock className="w-4 h-4 text-[var(--color-primary)]" />} bg="bg-[var(--color-primary-light)]" label="Itens por pagar" value={`${data.countPendente}`} accent="text-[var(--color-primary)]" />
        </div>
      )}

      {data && (
        <>
          <PaymentSection
            title="Pagamentos Fixos" subtitle="Repetem todos os meses" icon={<Repeat className="w-4 h-4 text-[var(--color-primary)]" />}
            items={data.fixos} today={today} onAdd={() => openNew("fixo")} onEdit={openEdit} onToggle={toggleStatus} onDelete={handleDelete} busy={isPending}
          />
          <PaymentSection
            title="Pagamentos Variáveis" subtitle="Pontuais deste mês" icon={<Zap className="w-4 h-4 text-amber-600" />}
            items={data.variaveis} today={today} onAdd={() => openNew("variavel")} onEdit={openEdit} onToggle={toggleStatus} onDelete={handleDelete} busy={isPending}
          />
        </>
      )}

      {/* Modal */}
      {form && (
        <div className="fixed inset-0 z-[9999] flex items-center justify-center">
          <div className="fixed inset-0 bg-black/40" onClick={() => setForm(null)} />
          <div className="relative z-10 bg-white rounded-xl shadow-xl border border-[var(--color-border)] p-6 w-full max-w-md mx-4 max-h-[90vh] overflow-y-auto">
            <div className="flex items-center justify-between mb-5">
              <h3 className="text-base font-semibold text-[var(--color-text-main)]">
                {form.id ? "Editar pagamento" : `Novo pagamento ${form.kind === "fixo" ? "fixo" : "variável"}`}
              </h3>
              <button onClick={() => setForm(null)} className="text-[var(--color-text-muted)] hover:text-[var(--color-text-main)]"><X className="w-5 h-5" /></button>
            </div>
            <form onSubmit={handleSubmit} className="space-y-4">
              <Field label="Descrição *">
                <input autoFocus value={form.description} onChange={(e) => setForm({ ...form, description: e.target.value })} className={inputCls} placeholder="ex: Renda do escritório" />
              </Field>
              <div className="grid grid-cols-2 gap-3">
                <Field label="Valor (€)">
                  <input inputMode="decimal" value={form.amount} onChange={(e) => setForm({ ...form, amount: e.target.value })} className={inputCls} placeholder="(opcional)" />
                </Field>
                <Field label="Data prevista">
                  <input type="date" value={form.due_date} onChange={(e) => setForm({ ...form, due_date: e.target.value })} className={inputCls} />
                </Field>
              </div>
              <Field label="Débito direto">
                <select value={form.direct_debit} onChange={(e) => setForm({ ...form, direct_debit: e.target.value as FormState["direct_debit"] })} className={inputCls}>
                  <option value="">— não definido —</option>
                  <option value="sim">Sim</option>
                  <option value="nao">Não</option>
                </select>
              </Field>
              <Field label="Notas">
                <textarea value={form.notes} onChange={(e) => setForm({ ...form, notes: e.target.value })} rows={2} className={inputCls + " resize-none"} />
              </Field>
              {formError && <p className="text-sm text-red-600">{formError}</p>}
              <div className="flex gap-3 pt-1">
                <button type="button" onClick={() => setForm(null)} className="flex-1 py-2 rounded-lg border border-[var(--color-border)] text-sm text-[var(--color-text-sub)] hover:bg-[var(--color-background)]">Cancelar</button>
                <button type="submit" disabled={isPending} className="flex-1 py-2 rounded-lg bg-[var(--color-primary)] text-white text-sm font-medium hover:bg-[var(--color-primary-hover)] disabled:opacity-50">
                  {isPending ? <Loader2 className="w-4 h-4 animate-spin mx-auto" /> : form.id ? "Guardar" : "Adicionar"}
                </button>
              </div>
            </form>
          </div>
        </div>
      )}
    </div>
  );
}

const inputCls = "w-full px-3 py-2 rounded-lg border border-[var(--color-border)] text-sm text-[var(--color-text-main)] focus:outline-none focus:ring-2 focus:ring-[var(--color-primary)] bg-white";

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div>
      <label className="block text-sm font-medium text-[var(--color-text-main)] mb-1.5">{label}</label>
      {children}
    </div>
  );
}

function Kpi({ icon, bg, label, value, accent }: { icon: React.ReactNode; bg: string; label: string; value: string; accent: string }) {
  return (
    <div className="bg-white rounded-xl border border-[var(--color-border)] p-4">
      <div className="flex items-center gap-2 mb-2">
        <div className={`w-7 h-7 rounded-lg ${bg} flex items-center justify-center`}>{icon}</div>
        <p className="text-xs text-[var(--color-text-muted)] font-medium">{label}</p>
      </div>
      <p className={`text-xl font-bold ${accent}`}>{value}</p>
    </div>
  );
}

function PaymentSection({
  title, subtitle, icon, items, today, onAdd, onEdit, onToggle, onDelete, busy,
}: {
  title: string; subtitle: string; icon: React.ReactNode; items: Payment[]; today: string;
  onAdd: () => void; onEdit: (p: Payment) => void; onToggle: (p: Payment) => void; onDelete: (p: Payment) => void; busy: boolean;
}) {
  return (
    <div className="bg-white rounded-xl border border-[var(--color-border)] overflow-hidden">
      <div className="px-4 py-3 border-b border-[var(--color-border)] flex items-center justify-between bg-[var(--color-background)]">
        <div className="flex items-center gap-2">
          {icon}
          <div>
            <h2 className="text-sm font-semibold text-[var(--color-text-main)]">{title}</h2>
            <p className="text-xs text-[var(--color-text-muted)]">{subtitle}</p>
          </div>
        </div>
        <button onClick={onAdd} className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-[var(--color-primary)] text-white text-xs font-medium hover:bg-[var(--color-primary-hover)]">
          <Plus className="w-3.5 h-3.5" /> Adicionar
        </button>
      </div>
      {items.length === 0 ? (
        <div className="py-10 text-center text-sm text-[var(--color-text-muted)]">Sem pagamentos nesta lista.</div>
      ) : (
        <div className="overflow-x-auto">
          <table className="w-full">
            <thead>
              <tr className="bg-white border-b border-[var(--color-border)]">
                <Th>Descrição</Th><Th right>Valor</Th><Th>Data</Th><Th>Déb. direto</Th><Th>Estado</Th><th className="px-3 py-2" />
              </tr>
            </thead>
            <tbody className="divide-y divide-[var(--color-border)]">
              {items.map((p) => {
                const overdue = p.status === "pendente" && p.due_date && p.due_date < today;
                return (
                  <tr key={p.id} className="hover:bg-[var(--color-background)]">
                    <td className="px-3 py-2.5 text-sm text-[var(--color-text-main)]">{p.description}</td>
                    <td className="px-3 py-2.5 text-sm font-semibold text-right text-[var(--color-text-main)]">{fmtEur(p.amount)}</td>
                    <td className={`px-3 py-2.5 text-xs ${overdue ? "text-red-600 font-semibold" : "text-[var(--color-text-sub)]"} flex items-center gap-1`}>
                      {p.due_date && <Calendar className="w-3 h-3" />}{fmtDate(p.due_date)}
                    </td>
                    <td className="px-3 py-2.5">
                      {p.direct_debit === null ? <span className="text-xs text-[var(--color-text-muted)]">—</span>
                        : p.direct_debit ? <span className="text-xs px-2 py-0.5 rounded-full bg-blue-100 text-blue-700 font-medium">SIM</span>
                        : <span className="text-xs px-2 py-0.5 rounded-full bg-gray-100 text-gray-500 font-medium">NÃO</span>}
                    </td>
                    <td className="px-3 py-2.5">
                      <button onClick={() => onToggle(p)} disabled={busy}
                        className={`text-xs px-2 py-0.5 rounded-full font-medium inline-flex items-center gap-1 ${p.status === "pago" ? "bg-green-100 text-green-700 hover:bg-green-200" : overdue ? "bg-red-100 text-red-700 hover:bg-red-200" : "bg-amber-100 text-amber-700 hover:bg-amber-200"}`}>
                        {p.status === "pago" ? <><Check className="w-3 h-3" /> Pago</> : <>{overdue ? "Em atraso" : "Por pagar"}</>}
                      </button>
                    </td>
                    <td className="px-3 py-2.5">
                      <div className="flex items-center gap-1 justify-end">
                        <button onClick={() => onEdit(p)} className="p-1 rounded text-[var(--color-text-muted)] hover:text-[var(--color-primary)] hover:bg-[var(--color-primary-light)]" title="Editar"><Pencil className="w-3.5 h-3.5" /></button>
                        <button onClick={() => onDelete(p)} className="p-1 rounded text-[var(--color-text-muted)] hover:text-red-600 hover:bg-red-50" title="Eliminar"><Trash2 className="w-3.5 h-3.5" /></button>
                      </div>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

function Th({ children, right }: { children: React.ReactNode; right?: boolean }) {
  return <th className={`${right ? "text-right" : "text-left"} px-3 py-2 text-xs font-medium text-[var(--color-text-muted)] uppercase tracking-wide`}>{children}</th>;
}

"use client";

import { useState, useEffect, useTransition } from "react";
import { useRouter } from "next/navigation";
import { AlertCircle, ArrowUpRight, ArrowDownRight, ShoppingBag, Plus, X, Loader2, CheckCircle2, Trash2 } from "lucide-react";
import Link from "next/link";
import {
  createCashFlowEntry,
  updateCashFlowEntry,
  deleteCashFlowEntry,
  type PendingExpense,
  type CashFlowCategory,
} from "@/app/actions/cash-flow";
import { usePagination, Pagination } from "@/components/ui/pagination";
import { todayInLisbon } from "@/lib/lisbon-time";
import { isValidIsoDateString } from "@/lib/utils";

function fmtEur(v: number) {
  return v.toLocaleString("pt-PT", { minimumFractionDigits: 2, maximumFractionDigits: 2 }) + " €";
}
function fmtDate(s: string | null) {
  return s ? new Date(s + "T00:00:00").toLocaleDateString("pt-PT") : "—";
}

const CATEGORY_LABELS: Record<string, string> = {
  despesa:    "Despesa",
  fornecedor: "Fornecedor",
  outro:      "Outro",
  faturacao:  "Faturação",
  salario:    "Salário",
};

const CATEGORY_COLORS: Record<string, string> = {
  despesa:    "bg-orange-100 text-orange-700",
  fornecedor: "bg-purple-100 text-purple-700",
  outro:      "bg-gray-100 text-gray-600",
  faturacao:  "bg-green-100 text-green-700",
  salario:    "bg-blue-100 text-blue-700",
};

interface ToReceive {
  id: string;
  invoice_number: string;
  client_name: string;
  total: number;
  due_date: string | null;
  status: string;
}
interface ToPay {
  id: string;
  collaborator_name: string;
  net_salary: number;
  period: string;
  status: string;
}

interface Props {
  toReceive: ToReceive[];
  toPay: ToPay[];
  expenses: PendingExpense[];
  companyId: string;
  error: string | null;
}

const inputCls = "w-full px-3 py-2 rounded-lg border border-[var(--color-border)] text-sm text-[var(--color-text-main)] focus:outline-none focus:ring-2 focus:ring-[var(--color-primary)] focus:border-transparent bg-white";

export function ContasClient({ toReceive, toPay, expenses: initialExpenses, companyId, error }: Props) {
  const [expenses, setExpenses] = useState<PendingExpense[]>(initialExpenses);
  const [showSheet, setShowSheet] = useState(false);
  const [isPending, startTransition] = useTransition();
  const router = useRouter();

  // Sincroniza com os dados do servidor após router.refresh() — substitui as
  // linhas otimistas (id temporário) pelas reais, com botões funcionais.
  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setExpenses(initialExpenses);
  }, [initialExpenses]);

  // Form state
  const [desc,     setDesc]     = useState("");
  const [amount,   setAmount]   = useState("");
  const [category, setCategory] = useState<CashFlowCategory>("despesa");
  const [date,     setDate]     = useState(todayInLisbon());
  const [notes,    setNotes]    = useState("");
  const [formErr,  setFormErr]  = useState("");

  const totalReceive  = toReceive.reduce((s, r) => s + r.total, 0);
  const totalPay      = toPay.reduce((s, r) => s + r.net_salary, 0);
  const totalExpenses = expenses.reduce((s, e) => s + e.amount, 0);

  const receivePag  = usePagination(toReceive, 10);
  const payPag      = usePagination(toPay, 10);
  const expensesPag = usePagination(expenses, 10);

  function resetForm() {
    setDesc(""); setAmount(""); setCategory("despesa");
    setDate(todayInLisbon());
    setNotes(""); setFormErr("");
  }

  function handleCreate(e: React.FormEvent) {
    e.preventDefault();
    setFormErr("");
    const val = parseFloat(amount);
    if (!desc.trim())      { setFormErr("A descrição é obrigatória."); return; }
    if (!val || val <= 0)  { setFormErr("Valor inválido."); return; }

    startTransition(async () => {
      const res = await createCashFlowEntry(companyId, {
        type: "saida",
        amount: val,
        description: desc.trim(),
        category,
        date,
        status: "pendente",
        notes: notes.trim() || undefined,
      });
      if (!res.ok) { setFormErr(res.error ?? "Erro ao registar."); return; }
      // Otimista (feedback imediato) + refresh para trocar o id temporário
      // pelo real — sem isto os botões "Pago"/eliminar não funcionavam até
      // recarregar a página à mão.
      setExpenses((prev) => [
        ...prev,
        { id: `temp-${Date.now()}`, description: desc.trim(), amount: val, category, date, notes: notes || null },
      ].sort((a, b) => a.date.localeCompare(b.date)));
      setShowSheet(false);
      resetForm();
      router.refresh();
    });
  }

  function handleMarkPaid(id: string) {
    startTransition(async () => {
      const res = await updateCashFlowEntry(id, { status: "confirmado" });
      if (res.ok) setExpenses((prev) => prev.filter((e) => e.id !== id));
    });
  }

  function handleDelete(id: string) {
    startTransition(async () => {
      const res = await deleteCashFlowEntry(id);
      if (res.ok) setExpenses((prev) => prev.filter((e) => e.id !== id));
    });
  }

  return (
    <div className="space-y-6">
      {error && (
        <div className="flex items-center gap-3 p-4 bg-red-50 border border-red-200 rounded-xl text-sm text-red-700">
          <AlertCircle className="w-4 h-4 shrink-0" />
          {error}
        </div>
      )}

      {/* KPI cards */}
      <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
        <div className="bg-white rounded-xl border border-green-200 p-5">
          <div className="flex items-center gap-2 mb-2">
            <ArrowUpRight className="w-5 h-5 text-green-600" />
            <p className="text-sm font-semibold text-[var(--color-text-main)]">A Receber</p>
          </div>
          <p className="text-2xl font-bold text-green-600">{fmtEur(totalReceive)}</p>
          <p className="text-xs text-[var(--color-text-muted)] mt-1">
            {toReceive.length} fatura{toReceive.length !== 1 ? "s" : ""} pendente{toReceive.length !== 1 ? "s" : ""}
          </p>
        </div>

        <div className="bg-white rounded-xl border border-red-200 p-5">
          <div className="flex items-center gap-2 mb-2">
            <ArrowDownRight className="w-5 h-5 text-red-600" />
            <p className="text-sm font-semibold text-[var(--color-text-main)]">A Pagar (Salários)</p>
          </div>
          <p className="text-2xl font-bold text-red-600">{fmtEur(totalPay)}</p>
          <p className="text-xs text-[var(--color-text-muted)] mt-1">
            {toPay.length} registo{toPay.length !== 1 ? "s" : ""} aprovado{toPay.length !== 1 ? "s" : ""}
          </p>
        </div>

        <div className="bg-white rounded-xl border border-amber-200 p-5">
          <div className="flex items-center gap-2 mb-2">
            <ShoppingBag className="w-5 h-5 text-amber-600" />
            <p className="text-sm font-semibold text-[var(--color-text-main)]">A Pagar (Despesas)</p>
          </div>
          <p className="text-2xl font-bold text-amber-600">{fmtEur(totalExpenses)}</p>
          <p className="text-xs text-[var(--color-text-muted)] mt-1">
            {expenses.length} despesa{expenses.length !== 1 ? "s" : ""} pendente{expenses.length !== 1 ? "s" : ""}
          </p>
        </div>
      </div>

      {/* Faturas Pendentes (a receber) */}
      <div className="bg-white rounded-xl border border-[var(--color-border)]">
        <div className="flex items-center justify-between px-5 py-4 border-b border-[var(--color-border)]">
          <div className="flex items-center gap-2">
            <ArrowUpRight className="w-4 h-4 text-green-600" />
            <h3 className="text-sm font-semibold text-[var(--color-text-main)]">Faturas Pendentes (a receber)</h3>
          </div>
          <Link href="/dashboard/cobrancas" className="text-xs text-[var(--color-primary)] hover:underline">Ver cobranças →</Link>
        </div>
        {toReceive.length === 0 ? (
          <div className="py-10 text-center">
            <p className="text-sm text-[var(--color-text-muted)]">Sem faturas pendentes. Tudo cobrado!</p>
          </div>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full">
              <thead>
                <tr className="bg-[var(--color-background)] border-b border-[var(--color-border)]">
                  <th className="text-left px-4 py-3 text-xs font-medium text-[var(--color-text-muted)] uppercase tracking-wide">Nº</th>
                  <th className="text-left px-4 py-3 text-xs font-medium text-[var(--color-text-muted)] uppercase tracking-wide">Cliente</th>
                  <th className="text-left px-4 py-3 text-xs font-medium text-[var(--color-text-muted)] uppercase tracking-wide">Vencimento</th>
                  <th className="text-right px-4 py-3 text-xs font-medium text-[var(--color-text-muted)] uppercase tracking-wide">Total</th>
                  <th className="text-left px-4 py-3 text-xs font-medium text-[var(--color-text-muted)] uppercase tracking-wide">Estado</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-[var(--color-border)]">
                {receivePag.pageItems.map((r) => (
                  <tr key={r.id} className="hover:bg-[var(--color-background)] transition-colors">
                    <td className="px-4 py-3 text-sm font-medium text-[var(--color-text-main)]">{r.invoice_number}</td>
                    <td className="px-4 py-3 text-sm text-[var(--color-text-main)]">{r.client_name}</td>
                    <td className={`px-4 py-3 text-sm ${r.status === "vencido" ? "text-red-600 font-medium" : "text-[var(--color-text-sub)]"}`}>{fmtDate(r.due_date)}</td>
                    <td className="px-4 py-3 text-sm font-semibold text-right text-green-600">{fmtEur(r.total)}</td>
                    <td className="px-4 py-3">
                      <span className={`text-xs px-2 py-0.5 rounded-full font-medium ${r.status === "vencido" ? "bg-red-100 text-red-700" : "bg-amber-100 text-amber-700"}`}>
                        {r.status === "vencido" ? "Vencido" : "Pendente"}
                      </span>
                    </td>
                  </tr>
                ))}
              </tbody>
              <tfoot className="border-t-2 border-[var(--color-border)]">
                <tr>
                  <td colSpan={3} className="px-4 py-3 text-sm font-semibold text-[var(--color-text-main)]">Total a receber</td>
                  <td className="px-4 py-3 text-sm font-bold text-right text-green-600">{fmtEur(totalReceive)}</td>
                  <td />
                </tr>
              </tfoot>
            </table>
            <Pagination {...receivePag} hideWhenSinglePage />
          </div>
        )}
      </div>

      {/* Salários Aprovados (a pagar) */}
      <div className="bg-white rounded-xl border border-[var(--color-border)]">
        <div className="flex items-center justify-between px-5 py-4 border-b border-[var(--color-border)]">
          <div className="flex items-center gap-2">
            <ArrowDownRight className="w-4 h-4 text-red-600" />
            <h3 className="text-sm font-semibold text-[var(--color-text-main)]">Salários Aprovados (a pagar)</h3>
          </div>
          <Link href="/dashboard/folha-pagamento" className="text-xs text-[var(--color-primary)] hover:underline">Ver folha →</Link>
        </div>
        {toPay.length === 0 ? (
          <div className="py-10 text-center">
            <p className="text-sm text-[var(--color-text-muted)]">Sem salários pendentes de pagamento.</p>
          </div>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full">
              <thead>
                <tr className="bg-[var(--color-background)] border-b border-[var(--color-border)]">
                  <th className="text-left px-4 py-3 text-xs font-medium text-[var(--color-text-muted)] uppercase tracking-wide">Colaborador</th>
                  <th className="text-left px-4 py-3 text-xs font-medium text-[var(--color-text-muted)] uppercase tracking-wide">Período</th>
                  <th className="text-right px-4 py-3 text-xs font-medium text-[var(--color-text-muted)] uppercase tracking-wide">Líquido</th>
                  <th className="text-left px-4 py-3 text-xs font-medium text-[var(--color-text-muted)] uppercase tracking-wide">Estado</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-[var(--color-border)]">
                {payPag.pageItems.map((r) => (
                  <tr key={r.id} className="hover:bg-[var(--color-background)] transition-colors">
                    <td className="px-4 py-3 text-sm text-[var(--color-text-main)]">{r.collaborator_name}</td>
                    <td className="px-4 py-3 text-sm text-[var(--color-text-sub)]">{r.period}</td>
                    <td className="px-4 py-3 text-sm font-semibold text-right text-red-600">{fmtEur(r.net_salary)}</td>
                    <td className="px-4 py-3">
                      <span className="text-xs px-2 py-0.5 rounded-full bg-blue-100 text-blue-700 font-medium">Aprovado</span>
                    </td>
                  </tr>
                ))}
              </tbody>
              <tfoot className="border-t-2 border-[var(--color-border)]">
                <tr>
                  <td colSpan={2} className="px-4 py-3 text-sm font-semibold text-[var(--color-text-main)]">Total a pagar</td>
                  <td className="px-4 py-3 text-sm font-bold text-right text-red-600">{fmtEur(totalPay)}</td>
                  <td />
                </tr>
              </tfoot>
            </table>
            <Pagination {...payPag} hideWhenSinglePage />
          </div>
        )}
      </div>

      {/* Despesas Pendentes (a pagar) */}
      <div className="bg-white rounded-xl border border-[var(--color-border)]">
        <div className="flex items-center justify-between px-5 py-4 border-b border-[var(--color-border)]">
          <div className="flex items-center gap-2">
            <ShoppingBag className="w-4 h-4 text-amber-600" />
            <h3 className="text-sm font-semibold text-[var(--color-text-main)]">Despesas Pendentes (a pagar)</h3>
          </div>
          <button
            onClick={() => { resetForm(); setShowSheet(true); }}
            className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-[var(--color-primary)] text-white text-xs font-medium hover:opacity-90 transition-opacity"
          >
            <Plus className="w-3.5 h-3.5" />
            Registar despesa
          </button>
        </div>

        {expenses.length === 0 ? (
          <div className="py-10 text-center space-y-2">
            <ShoppingBag className="w-8 h-8 mx-auto text-[var(--color-border)]" />
            <p className="text-sm text-[var(--color-text-muted)]">Sem despesas pendentes.</p>
            <button
              onClick={() => { resetForm(); setShowSheet(true); }}
              className="text-xs text-[var(--color-primary)] hover:underline"
            >
              Registar uma despesa →
            </button>
          </div>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full">
              <thead>
                <tr className="bg-[var(--color-background)] border-b border-[var(--color-border)]">
                  <th className="text-left px-4 py-3 text-xs font-medium text-[var(--color-text-muted)] uppercase tracking-wide">Data</th>
                  <th className="text-left px-4 py-3 text-xs font-medium text-[var(--color-text-muted)] uppercase tracking-wide">Descrição</th>
                  <th className="text-left px-4 py-3 text-xs font-medium text-[var(--color-text-muted)] uppercase tracking-wide">Categoria</th>
                  <th className="text-right px-4 py-3 text-xs font-medium text-[var(--color-text-muted)] uppercase tracking-wide">Valor</th>
                  <th className="text-left px-4 py-3 text-xs font-medium text-[var(--color-text-muted)] uppercase tracking-wide">Estado</th>
                  <th className="px-4 py-3" />
                </tr>
              </thead>
              <tbody className="divide-y divide-[var(--color-border)]">
                {expensesPag.pageItems.map((e) => (
                  <tr key={e.id} className="hover:bg-[var(--color-background)] transition-colors">
                    <td className="px-4 py-3 text-sm text-[var(--color-text-sub)]">{fmtDate(e.date)}</td>
                    <td className="px-4 py-3 text-sm text-[var(--color-text-main)] max-w-xs">
                      <span className="truncate block">{e.description}</span>
                      {e.notes && <span className="text-xs text-[var(--color-text-muted)] block truncate">{e.notes}</span>}
                    </td>
                    <td className="px-4 py-3">
                      <span className={`text-xs px-2 py-0.5 rounded-full font-medium ${CATEGORY_COLORS[e.category] ?? "bg-gray-100 text-gray-600"}`}>
                        {CATEGORY_LABELS[e.category] ?? e.category}
                      </span>
                    </td>
                    <td className="px-4 py-3 text-sm font-semibold text-right text-amber-600">{fmtEur(e.amount)}</td>
                    <td className="px-4 py-3">
                      <span className="text-xs px-2 py-0.5 rounded-full bg-amber-100 text-amber-700 font-medium">Pendente</span>
                    </td>
                    <td className="px-4 py-3">
                      <div className="flex items-center gap-1 justify-end">
                        <button
                          onClick={() => handleMarkPaid(e.id)}
                          disabled={isPending}
                          title="Marcar esta despesa como paga (sai desta lista)"
                          className="flex items-center gap-1 text-xs px-2.5 py-1.5 rounded-lg bg-green-600 text-white font-semibold hover:bg-green-700 transition-colors disabled:opacity-40"
                        >
                          <CheckCircle2 className="w-3.5 h-3.5" />
                          Marcar como paga
                        </button>
                        <button
                          onClick={() => handleDelete(e.id)}
                          disabled={isPending}
                          title="Eliminar"
                          className="p-1.5 rounded-lg text-[var(--color-text-muted)] hover:text-red-600 hover:bg-red-50 transition-colors disabled:opacity-40"
                        >
                          <Trash2 className="w-3.5 h-3.5" />
                        </button>
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
              <tfoot className="border-t-2 border-[var(--color-border)]">
                <tr>
                  <td colSpan={3} className="px-4 py-3 text-sm font-semibold text-[var(--color-text-main)]">Total a pagar</td>
                  <td className="px-4 py-3 text-sm font-bold text-right text-amber-600">{fmtEur(totalExpenses)}</td>
                  <td colSpan={2} />
                </tr>
              </tfoot>
            </table>
            <Pagination {...expensesPag} hideWhenSinglePage />
          </div>
        )}
      </div>

      {/* Sheet: Registar despesa */}
      {showSheet && (
        <>
          <div className="fixed inset-0 bg-black/40 z-40" onClick={() => setShowSheet(false)} />
          <div className="fixed inset-y-0 right-0 z-50 w-full max-w-md bg-white shadow-xl flex flex-col">
            <div className="flex items-center justify-between px-6 py-4 border-b border-[var(--color-border)]">
              <div>
                <h2 className="text-base font-semibold text-[var(--color-text-main)]">Registar despesa</h2>
                <p className="text-xs text-[var(--color-text-muted)]">Material, fornecedor, avaria, etc.</p>
              </div>
              <button onClick={() => setShowSheet(false)} className="p-2 rounded-lg text-[var(--color-text-muted)] hover:bg-[var(--color-background)] transition-colors">
                <X className="w-4 h-4" />
              </button>
            </div>

            <form onSubmit={handleCreate} className="flex-1 overflow-y-auto p-6 space-y-4">
              <div>
                <label className="block text-xs font-medium text-[var(--color-text-sub)] mb-1.5">Descrição *</label>
                <input
                  required
                  value={desc}
                  onChange={(e) => setDesc(e.target.value)}
                  placeholder="ex: Produtos de limpeza — Fornecedor X"
                  className={inputCls}
                />
              </div>

              <div className="grid grid-cols-2 gap-3">
                <div>
                  <label className="block text-xs font-medium text-[var(--color-text-sub)] mb-1.5">Valor (€) *</label>
                  <input
                    required
                    type="number"
                    min="0.01"
                    step="0.01"
                    value={amount}
                    onChange={(e) => setAmount(e.target.value)}
                    placeholder="0.00"
                    className={inputCls}
                  />
                </div>
                <div>
                  <label className="block text-xs font-medium text-[var(--color-text-sub)] mb-1.5">Data</label>
                  <input
                    type="date"
                    value={date}
                    onChange={(e) => { if (isValidIsoDateString(e.target.value)) setDate(e.target.value); }}
                    className={inputCls}
                  />
                </div>
              </div>

              <div>
                <label className="block text-xs font-medium text-[var(--color-text-sub)] mb-1.5">Categoria</label>
                <select value={category} onChange={(e) => setCategory(e.target.value as CashFlowCategory)} className={inputCls}>
                  <option value="despesa">Despesa geral</option>
                  <option value="fornecedor">Fornecedor</option>
                  <option value="outro">Dano / Avaria / Outro</option>
                </select>
              </div>

              <div>
                <label className="block text-xs font-medium text-[var(--color-text-sub)] mb-1.5">Notas</label>
                <textarea
                  value={notes}
                  onChange={(e) => setNotes(e.target.value)}
                  rows={3}
                  placeholder="Detalhes adicionais..."
                  className={inputCls + " resize-none"}
                />
              </div>

              {formErr && (
                <div className="flex items-center gap-2 p-3 rounded-lg bg-red-50 border border-red-200 text-sm text-red-700">
                  <AlertCircle className="w-4 h-4 shrink-0" />
                  {formErr}
                </div>
              )}
            </form>

            <div className="border-t border-[var(--color-border)] px-6 py-4 flex gap-3">
              <button
                type="button"
                onClick={() => setShowSheet(false)}
                className="flex-1 px-4 py-2 rounded-lg border border-[var(--color-border)] text-sm font-medium text-[var(--color-text-sub)] hover:bg-[var(--color-background)] transition-colors"
              >
                Cancelar
              </button>
              <button
                onClick={(e) => handleCreate(e as unknown as React.FormEvent)}
                disabled={isPending}
                className="flex-1 flex items-center justify-center gap-2 px-4 py-2 rounded-lg bg-[var(--color-primary)] text-white text-sm font-semibold hover:bg-[var(--color-primary-hover)] transition-colors disabled:opacity-50"
              >
                {isPending ? <Loader2 className="w-4 h-4 animate-spin" /> : <Plus className="w-4 h-4" />}
                Registar
              </button>
            </div>
          </div>
        </>
      )}
    </div>
  );
}

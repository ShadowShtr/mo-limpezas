"use client";

import { useState, useTransition } from "react";
import {
  TrendingUp, TrendingDown, Clock, Plus, Trash2,
  ArrowUpRight, ArrowDownRight, Loader2, AlertCircle, X,
} from "lucide-react";
import {
  getCashFlowEntries,
  createCashFlowEntry,
  deleteCashFlowEntry,
  updateCashFlowEntry,
  type CashFlowEntry,
  type CashFlowCategory,
  type CashFlowStatus,
} from "@/app/actions/cash-flow";

function fmtEur(v: number) {
  return v.toLocaleString("pt-PT", { minimumFractionDigits: 2, maximumFractionDigits: 2 }) + " €";
}
function fmtDate(s: string) {
  return new Date(s + "T00:00:00").toLocaleDateString("pt-PT");
}

const CATEGORY_LABELS: Record<string, string> = {
  faturacao: "Faturação",
  salario: "Salário",
  despesa: "Despesa",
  fornecedor: "Fornecedor",
  outro: "Outro",
};

const ORIGIN_BADGE: Record<string, { label: string; cls: string }> = {
  invoice: { label: "Fatura", cls: "bg-green-100 text-green-700" },
  payroll: { label: "Salário", cls: "bg-blue-100 text-blue-700" },
};

interface DataShape {
  entries: CashFlowEntry[];
  balance: number;
  entradas: number;
  saidas: number;
  pendentes: number;
}

interface Props {
  initialData: DataShape | null;
  error: string | null;
  companyId: string;
  mesParam: string;
  year: number;
  month: number;
}

export function CashFlowClient({ initialData, error: initErr, companyId, mesParam, year, month }: Props) {
  const [data, setData] = useState<DataShape | null>(initialData);
  const [error, setError] = useState(initErr);
  const [filterType, setFilterType] = useState<"" | "entrada" | "saida">("");
  const [filterStatus, setFilterStatus] = useState<"" | "pendente" | "confirmado">("");
  const [showNew, setShowNew] = useState(false);
  const [isPending, startTransition] = useTransition();

  // Novo registo form state
  const [newType, setNewType] = useState<"entrada" | "saida">("entrada");
  const [newAmount, setNewAmount] = useState("");
  const [newDesc, setNewDesc] = useState("");
  const [newCat, setNewCat] = useState<CashFlowCategory>("outro");
  const [newDate, setNewDate] = useState(new Date().toISOString().split("T")[0]);
  const [newStatus, setNewStatus] = useState<CashFlowStatus>("confirmado");
  const [newNotes, setNewNotes] = useState("");
  const [formError, setFormError] = useState("");

  function reload(y: number, m: number) {
    startTransition(async () => {
      const res = await getCashFlowEntries(companyId, { year: y, month: m });
      if (res.ok) setData({ entries: res.entries, balance: res.balance, entradas: res.entradas, saidas: res.saidas, pendentes: res.pendentes });
      else setError(res.error);
    });
  }

  function handleMonthChange(val: string) {
    const [y, m] = val.split("-").map(Number);
    window.location.href = `/dashboard/financeiro/fluxo-caixa?mes=${val}`;
    reload(y, m);
  }

  async function handleCreate(e: React.FormEvent) {
    e.preventDefault();
    setFormError("");
    if (!newAmount || isNaN(parseFloat(newAmount))) { setFormError("Valor inválido."); return; }
    if (!newDesc.trim()) { setFormError("Descrição obrigatória."); return; }
    startTransition(async () => {
      const res = await createCashFlowEntry(companyId, {
        type: newType,
        amount: parseFloat(newAmount),
        description: newDesc.trim(),
        category: newCat,
        date: newDate,
        status: newStatus,
        notes: newNotes || undefined,
      });
      if (!res.ok) { setFormError(res.error ?? "Erro."); return; }
      setShowNew(false);
      setNewAmount(""); setNewDesc(""); setNewCat("outro"); setNewNotes("");
      reload(year, month);
    });
  }

  async function handleDelete(id: string) {
    if (!confirm("Eliminar este registo manual?")) return;
    startTransition(async () => {
      await deleteCashFlowEntry(id);
      reload(year, month);
    });
  }

  async function handleConfirm(id: string) {
    startTransition(async () => {
      await updateCashFlowEntry(id, { status: "confirmado" });
      reload(year, month);
    });
  }

  const filtered = (data?.entries ?? []).filter((e) => {
    if (filterType && e.type !== filterType) return false;
    if (filterStatus && e.status !== filterStatus) return false;
    return true;
  });

  const inputCls = "w-full px-3 py-2 rounded-lg border border-[var(--color-border)] text-sm text-[var(--color-text-main)] focus:outline-none focus:ring-2 focus:ring-[var(--color-primary)] bg-white";

  return (
    <div className="space-y-5">
      {/* Toolbar: filtros + botão novo */}
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
        <div>
          <label className="block text-xs text-[var(--color-text-muted)] mb-1">Tipo</label>
          <select value={filterType} onChange={(e) => setFilterType(e.target.value as "" | "entrada" | "saida")}
            className="px-3 py-2 rounded-lg border border-[var(--color-border)] text-sm focus:outline-none focus:ring-2 focus:ring-[var(--color-primary)] bg-white">
            <option value="">Todos</option>
            <option value="entrada">Entradas</option>
            <option value="saida">Saídas</option>
          </select>
        </div>
        <div>
          <label className="block text-xs text-[var(--color-text-muted)] mb-1">Estado</label>
          <select value={filterStatus} onChange={(e) => setFilterStatus(e.target.value as "" | "pendente" | "confirmado")}
            className="px-3 py-2 rounded-lg border border-[var(--color-border)] text-sm focus:outline-none focus:ring-2 focus:ring-[var(--color-primary)] bg-white">
            <option value="">Todos</option>
            <option value="confirmado">Confirmado</option>
            <option value="pendente">Pendente</option>
          </select>
        </div>
        <div className="flex-1" />
        <button
          onClick={() => setShowNew(true)}
          className="flex items-center gap-2 px-4 py-2 rounded-lg bg-[var(--color-primary)] text-white text-sm font-medium hover:bg-[var(--color-primary-hover)] transition-colors"
        >
          <Plus className="w-4 h-4" />
          Novo registo
        </button>
      </div>

      {error && (
        <div className="flex items-center gap-3 p-4 bg-red-50 border border-red-200 rounded-xl text-sm text-red-700">
          <AlertCircle className="w-4 h-4 shrink-0" />
          {error}
        </div>
      )}

      {/* KPI Cards */}
      {data && (
        <div className="grid grid-cols-2 lg:grid-cols-4 gap-4">
          <div className="bg-white rounded-xl border border-[var(--color-border)] p-4">
            <div className="flex items-center gap-2 mb-2">
              <div className="w-7 h-7 rounded-lg bg-green-50 flex items-center justify-center">
                <ArrowUpRight className="w-4 h-4 text-green-600" />
              </div>
              <p className="text-xs text-[var(--color-text-muted)] font-medium">Entradas</p>
            </div>
            <p className="text-xl font-bold text-green-600">{fmtEur(data.entradas)}</p>
          </div>
          <div className="bg-white rounded-xl border border-[var(--color-border)] p-4">
            <div className="flex items-center gap-2 mb-2">
              <div className="w-7 h-7 rounded-lg bg-red-50 flex items-center justify-center">
                <ArrowDownRight className="w-4 h-4 text-red-600" />
              </div>
              <p className="text-xs text-[var(--color-text-muted)] font-medium">Saídas</p>
            </div>
            <p className="text-xl font-bold text-red-600">{fmtEur(data.saidas)}</p>
          </div>
          <div className={`bg-white rounded-xl border p-4 ${data.balance >= 0 ? "border-[var(--color-border)]" : "border-red-200"}`}>
            <div className="flex items-center gap-2 mb-2">
              <div className={`w-7 h-7 rounded-lg flex items-center justify-center ${data.balance >= 0 ? "bg-[var(--color-primary-light)]" : "bg-red-50"}`}>
                {data.balance >= 0
                  ? <TrendingUp className="w-4 h-4 text-[var(--color-primary)]" />
                  : <TrendingDown className="w-4 h-4 text-red-600" />}
              </div>
              <p className="text-xs text-[var(--color-text-muted)] font-medium">Saldo do mês</p>
            </div>
            <p className={`text-xl font-bold ${data.balance >= 0 ? "text-[var(--color-primary)]" : "text-red-600"}`}>{fmtEur(data.balance)}</p>
          </div>
          <div className="bg-white rounded-xl border border-amber-200 p-4">
            <div className="flex items-center gap-2 mb-2">
              <div className="w-7 h-7 rounded-lg bg-amber-50 flex items-center justify-center">
                <Clock className="w-4 h-4 text-amber-600" />
              </div>
              <p className="text-xs text-[var(--color-text-muted)] font-medium">Pendentes</p>
            </div>
            <p className="text-xl font-bold text-amber-600">{fmtEur(data.pendentes)}</p>
          </div>
        </div>
      )}

      {/* Tabela */}
      <div className="bg-white rounded-xl border border-[var(--color-border)] overflow-hidden">
        {isPending && (
          <div className="flex items-center justify-center py-6 text-[var(--color-text-muted)]">
            <Loader2 className="w-4 h-4 animate-spin mr-2" /> A carregar…
          </div>
        )}
        {!isPending && filtered.length === 0 ? (
          <div className="py-14 text-center">
            <TrendingUp className="w-8 h-8 mx-auto mb-3 text-[var(--color-border)]" />
            <p className="text-sm text-[var(--color-text-muted)]">Sem registos neste período.</p>
            <p className="text-xs text-[var(--color-text-muted)] mt-1">Os pagamentos de faturas e salários aparecem aqui automaticamente.</p>
          </div>
        ) : !isPending && (
          <div className="overflow-x-auto">
            <table className="w-full">
              <thead>
                <tr className="bg-[var(--color-background)] border-b border-[var(--color-border)]">
                  <th className="text-left px-4 py-3 text-xs font-medium text-[var(--color-text-muted)] uppercase tracking-wide">Data</th>
                  <th className="text-left px-4 py-3 text-xs font-medium text-[var(--color-text-muted)] uppercase tracking-wide">Descrição</th>
                  <th className="text-left px-4 py-3 text-xs font-medium text-[var(--color-text-muted)] uppercase tracking-wide">Categoria</th>
                  <th className="text-left px-4 py-3 text-xs font-medium text-[var(--color-text-muted)] uppercase tracking-wide">Origem</th>
                  <th className="text-right px-4 py-3 text-xs font-medium text-[var(--color-text-muted)] uppercase tracking-wide">Valor</th>
                  <th className="text-left px-4 py-3 text-xs font-medium text-[var(--color-text-muted)] uppercase tracking-wide">Estado</th>
                  <th className="px-4 py-3" />
                </tr>
              </thead>
              <tbody className="divide-y divide-[var(--color-border)]">
                {filtered.map((e) => (
                  <tr key={e.id} className={`hover:bg-[var(--color-background)] transition-colors ${e.status === "pendente" ? "opacity-60" : ""}`}>
                    <td className="px-4 py-3 text-sm text-[var(--color-text-sub)]">{fmtDate(e.date)}</td>
                    <td className="px-4 py-3 text-sm text-[var(--color-text-main)] max-w-xs truncate">{e.description}</td>
                    <td className="px-4 py-3 text-xs text-[var(--color-text-muted)]">{e.category ? CATEGORY_LABELS[e.category] : "—"}</td>
                    <td className="px-4 py-3">
                      {e.reference_type ? (
                        <span className={`text-xs px-2 py-0.5 rounded-full font-medium ${ORIGIN_BADGE[e.reference_type]?.cls ?? ""}`}>
                          {ORIGIN_BADGE[e.reference_type]?.label ?? e.reference_type}
                        </span>
                      ) : (
                        <span className="text-xs px-2 py-0.5 rounded-full bg-gray-100 text-gray-500 font-medium">Manual</span>
                      )}
                    </td>
                    <td className={`px-4 py-3 text-sm font-semibold text-right ${e.type === "entrada" ? "text-green-600" : "text-red-600"}`}>
                      {e.type === "entrada" ? "+" : "−"}{fmtEur(e.amount)}
                    </td>
                    <td className="px-4 py-3">
                      {e.status === "pendente" ? (
                        <button
                          onClick={() => handleConfirm(e.id)}
                          className="text-xs px-2 py-0.5 rounded-full bg-amber-100 text-amber-700 font-medium hover:bg-amber-200 transition-colors"
                        >
                          Pendente — confirmar
                        </button>
                      ) : (
                        <span className="text-xs px-2 py-0.5 rounded-full bg-green-100 text-green-700 font-medium">Confirmado</span>
                      )}
                    </td>
                    <td className="px-4 py-3">
                      {!e.reference_type && (
                        <button
                          onClick={() => handleDelete(e.id)}
                          className="p-1 rounded text-[var(--color-text-muted)] hover:text-red-600 hover:bg-red-50 transition-colors"
                          title="Eliminar"
                        >
                          <Trash2 className="w-3.5 h-3.5" />
                        </button>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>

      {/* Modal novo registo */}
      {showNew && (
        <div className="fixed inset-0 z-[9999] flex items-center justify-center">
          <div className="fixed inset-0 bg-black/40" onClick={() => setShowNew(false)} />
          <div className="relative z-10 bg-white rounded-xl shadow-xl border border-[var(--color-border)] p-6 w-full max-w-md mx-4 max-h-[90vh] overflow-y-auto">
            <div className="flex items-center justify-between mb-5">
              <h3 className="text-base font-semibold text-[var(--color-text-main)]">Novo registo</h3>
              <button onClick={() => setShowNew(false)} className="text-[var(--color-text-muted)] hover:text-[var(--color-text-main)]">
                <X className="w-5 h-5" />
              </button>
            </div>

            <form onSubmit={handleCreate} className="space-y-4">
              {/* Tipo */}
              <div>
                <label className="block text-sm font-medium text-[var(--color-text-main)] mb-1.5">Tipo</label>
                <div className="flex rounded-lg border border-[var(--color-border)] overflow-hidden">
                  <button type="button" onClick={() => setNewType("entrada")}
                    className={`flex-1 py-2 text-sm font-medium transition-colors ${newType === "entrada" ? "bg-green-600 text-white" : "text-[var(--color-text-sub)] hover:bg-[var(--color-background)]"}`}>
                    + Entrada
                  </button>
                  <button type="button" onClick={() => setNewType("saida")}
                    className={`flex-1 py-2 text-sm font-medium border-l border-[var(--color-border)] transition-colors ${newType === "saida" ? "bg-red-600 text-white" : "text-[var(--color-text-sub)] hover:bg-[var(--color-background)]"}`}>
                    − Saída
                  </button>
                </div>
              </div>

              <div>
                <label className="block text-sm font-medium text-[var(--color-text-main)] mb-1.5">Valor (€) *</label>
                <input type="number" step="0.01" min="0.01" required value={newAmount} onChange={(e) => setNewAmount(e.target.value)} className={inputCls} placeholder="0.00" />
              </div>

              <div>
                <label className="block text-sm font-medium text-[var(--color-text-main)] mb-1.5">Descrição *</label>
                <input required value={newDesc} onChange={(e) => setNewDesc(e.target.value)} className={inputCls} placeholder="ex: Renda do escritório" />
              </div>

              <div className="grid grid-cols-2 gap-3">
                <div>
                  <label className="block text-sm font-medium text-[var(--color-text-main)] mb-1.5">Categoria</label>
                  <select value={newCat} onChange={(e) => setNewCat(e.target.value as CashFlowCategory)} className={inputCls}>
                    <option value="despesa">Despesa</option>
                    <option value="fornecedor">Fornecedor</option>
                    <option value="faturacao">Faturação</option>
                    <option value="salario">Salário</option>
                    <option value="outro">Outro</option>
                  </select>
                </div>
                <div>
                  <label className="block text-sm font-medium text-[var(--color-text-main)] mb-1.5">Estado</label>
                  <select value={newStatus} onChange={(e) => setNewStatus(e.target.value as CashFlowStatus)} className={inputCls}>
                    <option value="confirmado">Confirmado</option>
                    <option value="pendente">Pendente</option>
                  </select>
                </div>
              </div>

              <div>
                <label className="block text-sm font-medium text-[var(--color-text-main)] mb-1.5">Data</label>
                <input type="date" required value={newDate} onChange={(e) => setNewDate(e.target.value)} className={inputCls} />
              </div>

              <div>
                <label className="block text-sm font-medium text-[var(--color-text-main)] mb-1.5">Notas</label>
                <textarea value={newNotes} onChange={(e) => setNewNotes(e.target.value)} rows={2} className={inputCls + " resize-none"} />
              </div>

              {formError && <p className="text-sm text-red-600">{formError}</p>}

              <div className="flex gap-3 pt-1">
                <button type="button" onClick={() => setShowNew(false)}
                  className="flex-1 py-2 rounded-lg border border-[var(--color-border)] text-sm text-[var(--color-text-sub)] hover:bg-[var(--color-background)] transition-colors">
                  Cancelar
                </button>
                <button type="submit" disabled={isPending}
                  className="flex-1 py-2 rounded-lg bg-[var(--color-primary)] text-white text-sm font-medium hover:bg-[var(--color-primary-hover)] transition-colors disabled:opacity-50">
                  {isPending ? <Loader2 className="w-4 h-4 animate-spin mx-auto" /> : "Criar registo"}
                </button>
              </div>
            </form>
          </div>
        </div>
      )}
    </div>
  );
}

"use client";

import { useState, useTransition } from "react";
import { Kpi } from "@/components/financeiro/v2/primitives";
import {
  TrendingUp, TrendingDown, Clock, Plus, Trash2,
  ArrowUpRight, ArrowDownRight, Loader2, AlertCircle, X, Pencil,
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
import Link from "next/link";
import { usePagination, Pagination } from "@/components/ui/pagination";
import { normalizarNomeCategoria } from "@/domain/finance-v2/expense-categories";
import type { ExpenseCategory, ExpenseCategoryCatalog } from "@/app/actions/expense-categories";
import { todayInLisbon } from "@/lib/lisbon-time";
import { isValidIsoDateString } from "@/lib/utils";

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
  year: number;
  month: number;
  expenseCatalog: ExpenseCategoryCatalog;
  /** Categoria por que filtrar à chegada, vinda do donut do Resumo. */
  categoriaInicial?: string | null;
}

export function CashFlowClient({
  initialData, error: initErr, companyId, year, month,
  expenseCatalog, categoriaInicial = null,
}: Props) {
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
  /**
   * 🔴 Faltava aqui, e foi por isso que despesas reais nasceram sem categoria.
   *
   * O seletor estruturado só existia em Contas. Quem registava pelo Fluxo de
   * Caixa — que é por onde estas entraram — ficava com a categoria legada, e
   * depois não aparecia no donut por nome. «COMBUSTIVEL» estava na descrição,
   * e a descrição não classifica nada.
   */
  const [newExpenseCat, setNewExpenseCat] = useState("");

  /**
   * Movimento em edição.
   *
   * 🔴 Existe para as despesas que já estão na base sem categoria — as quatro
   *    que nasceram pelo Fluxo de Caixa antes de o campo existir aqui. É a
   *    alternativa honesta ao backfill: quem sabe o que cada uma foi
   *    classifica-a à mão, uma a uma.
   */
  const [editando, setEditando] = useState<CashFlowEntry | null>(null);
  const [editCat, setEditCat] = useState("");
  const [editDesc, setEditDesc] = useState("");
  const [editAmount, setEditAmount] = useState("");
  const [editDate, setEditDate] = useState(todayInLisbon());
  const [editErr, setEditErr] = useState("");
  const [newDate, setNewDate] = useState(todayInLisbon());
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
        expenseCategoryId: newExpenseCat || null,
        date: newDate,
        status: newStatus,
        notes: newNotes || undefined,
      });
      if (!res.ok) { setFormError(res.error ?? "Erro."); return; }
      setShowNew(false);
      setNewAmount(""); setNewDesc(""); setNewCat("outro"); setNewNotes(""); setNewExpenseCat("");
      reload(year, month);
    });
  }

  // 🔴 O resultado da action TEM de ser lido.
  //
  // Estes três handlers descartavam-no e chamavam `reload()` a seguir. As
  // actions são fail-closed — período fechado, sem permissão, erro de base —
  // mas o erro morria aqui: o `reload()` relia o estado real (inalterado) e a
  // linha voltava a aparecer como estava, sem mensagem nenhuma. É a mesma
  // classe de defeito que em Pagamentos deu origem a «marquei como pago e não
  // atualizou». Ver src/__tests__/finance-unhandled-mutation-result.test.ts.
  async function handleDelete(id: string) {
    if (!confirm("Eliminar este registo manual?")) return;
    setError("");
    startTransition(async () => {
      const res = await deleteCashFlowEntry(id);
      if (!res.ok) {
        setError(res.error ?? "Não foi possível eliminar o movimento.");
        return;
      }
      reload(year, month);
    });
  }

  async function handleConfirm(id: string) {
    setError("");
    startTransition(async () => {
      const res = await updateCashFlowEntry(id, { status: "confirmado" });
      if (!res.ok) {
        setError(res.error ?? "Não foi possível confirmar o movimento.");
        return;
      }
      reload(year, month);
    });
  }

  // Reverter um registo manual confirmado para pendente (enganos acontecem).
  async function handleMarkPending(id: string) {
    setError("");
    startTransition(async () => {
      const res = await updateCashFlowEntry(id, { status: "pendente" });
      if (!res.ok) {
        setError(res.error ?? "Não foi possível repor o movimento como pendente.");
        return;
      }
      reload(year, month);
    });
  }

  function abrirEdicao(e: CashFlowEntry) {
    setEditando(e);
    setEditCat(e.expense_category_id ?? "");
    setEditDesc(e.description);
    setEditAmount(String(e.amount));
    setEditDate(e.date);
    setEditErr("");
  }

  function guardarEdicao() {
    if (!editando) return;
    setEditErr("");
    const val = parseFloat(editAmount);
    if (!editDesc.trim()) { setEditErr("Descrição obrigatória."); return; }
    if (!val || val <= 0) { setEditErr("Valor inválido."); return; }

    startTransition(async () => {
      const res = await updateCashFlowEntry(editando.id, {
        description: editDesc.trim(),
        date: editDate,
        // 🔴 O valor de um movimento **com origem** não se altera aqui: viria
        //    a discordar da fatura ou do pagamento que o gerou, e as duas
        //    versões ficariam plausíveis. O campo está desativado no ecrã, e
        //    esta guarda é a que conta — o ecrã é uma sugestão, a action é
        //    um endpoint.
        ...(editando.reference_type ? {} : { amount: val }),
        // `null` retira a categoria: escolher «Sem categoria» tem de poder
        // desfazer uma escolha errada.
        expenseCategoryId: editCat || null,
      });
      if (!res.ok) { setEditErr(res.error ?? "Erro ao guardar."); return; }
      setEditando(null);
      reload(year, month);
    });
  }

  const filtered = (data?.entries ?? []).filter((e) => {
    if (filterType && e.type !== filterType) return false;
    if (filterStatus && e.status !== filterStatus) return false;
    return true;
  });

  // ───────────────────────────────────────────────────────────────────────────
  // Filtro vindo do donut
  //
  // 🔴 O donut liga para **aqui**, e não para as Contas. As Contas listam só
  //    despesas **pendentes**; o donut conta pendentes e confirmadas. Clicar
  //    numa categoria cujas despesas já estavam confirmadas abria uma lista
  //    vazia — o link mandava para um sítio com âmbito mais estreito do que o
  //    número em que se tinha carregado.
  // ───────────────────────────────────────────────────────────────────────────
  const chaveDa = (e: CashFlowEntry) =>
    normalizarNomeCategoria(e.expense_category_name ?? e.category ?? "");

  const visiveis = categoriaInicial
    ? filtered.filter((e) => chaveDa(e) === normalizarNomeCategoria(categoriaInicial))
    : filtered;

  const pag = usePagination(visiveis, 10);

  const inputCls = "w-full px-3 py-2 rounded-lg border border-[var(--color-border)] text-sm text-[var(--color-text-main)] focus:outline-none focus:ring-2 focus:ring-[var(--finance-primary)] bg-white";

  return (
    <div className="space-y-5">
      {/* Toolbar: filtros + botão novo */}
      <div className="bg-white rounded-xl border border-[var(--color-border)] px-4 py-3 flex flex-wrap items-end gap-3">
        {/*
          O seletor de mês desta vista saiu. Era um `<input type="month">` que
          navegava para `?mes=…` — exactamente o que o seletor do módulo faz.
          Dois controlos para o mesmo efeito, no mesmo ecrã, capazes de
          discordar. Nenhuma capacidade se perdeu.
        */}
        <div>
          <label className="block text-xs text-[var(--color-text-muted)] mb-1">Tipo</label>
          <select value={filterType} onChange={(e) => setFilterType(e.target.value as "" | "entrada" | "saida")}
            className="px-3 py-2 rounded-lg border border-[var(--color-border)] text-sm focus:outline-none focus:ring-2 focus:ring-[var(--finance-primary)] bg-white">
            <option value="">Todos</option>
            <option value="entrada">Entradas</option>
            <option value="saida">Saídas</option>
          </select>
        </div>
        <div>
          <label className="block text-xs text-[var(--color-text-muted)] mb-1">Estado</label>
          <select value={filterStatus} onChange={(e) => setFilterStatus(e.target.value as "" | "pendente" | "confirmado")}
            className="px-3 py-2 rounded-lg border border-[var(--color-border)] text-sm focus:outline-none focus:ring-2 focus:ring-[var(--finance-primary)] bg-white">
            <option value="">Todos</option>
            <option value="confirmado">Confirmado</option>
            <option value="pendente">Pendente</option>
          </select>
        </div>
        <div className="flex-1" />
        <button
          onClick={() => setShowNew(true)}
          className="flex items-center gap-2 px-4 py-2 rounded-lg bg-[var(--finance-primary)] text-white text-sm font-medium hover:bg-[var(--finance-primary-hover)] transition-colors"
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
          <Kpi label="Entradas" value={fmtEur(data.entradas)} tone="positive" icon={<ArrowUpRight className="w-4 h-4" />} />
          <Kpi label="Saídas"   value={fmtEur(data.saidas)}   tone="danger"   icon={<ArrowDownRight className="w-4 h-4" />} />
          <Kpi
            label="Saldo do mês"
            value={fmtEur(data.balance)}
            tone={data.balance >= 0 ? "positive" : "danger"}
            icon={data.balance >= 0 ? <TrendingUp className="w-4 h-4" /> : <TrendingDown className="w-4 h-4" />}
          />
          <Kpi label="Pendentes" value={fmtEur(data.pendentes)} tone="warning" icon={<Clock className="w-4 h-4" />} />
        </div>
      )}

      {/* Tabela */}
      <div className="bg-white rounded-xl border border-[var(--color-border)] overflow-hidden">
        {isPending && (
          <div className="flex items-center justify-center py-6 text-[var(--color-text-muted)]">
            <Loader2 className="w-4 h-4 animate-spin mr-2" /> A carregar…
          </div>
        )}
        {!isPending && visiveis.length === 0 && categoriaInicial ? (
          // Vazio por filtro é diferente de vazio por não haver nada, e a
          // saída tem de estar à mão.
          <div className="py-14 text-center">
            <p className="text-sm text-[var(--color-text-muted)]">
              Nenhum movimento na categoria <strong>{categoriaInicial}</strong> neste mês.
            </p>
            <Link
              href="/dashboard/financeiro/fluxo-caixa"
              className="inline-block mt-2 text-sm font-medium text-[var(--finance-primary)] hover:underline"
            >
              Ver todos os movimentos ({filtered.length})
            </Link>
          </div>
        ) : !isPending && visiveis.length === 0 ? (
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
                {pag.pageItems.map((e) => (
                  <tr key={e.id} className={`hover:bg-[var(--color-background)] transition-colors ${e.status === "pendente" ? "opacity-60" : ""}`}>
                    <td className="px-4 py-3 text-sm text-[var(--color-text-sub)]">{fmtDate(e.date)}</td>
                    <td className="px-4 py-3 text-sm text-[var(--color-text-main)] max-w-xs truncate">{e.description}</td>
                    <td className="px-4 py-3">
                      {/* A estruturada manda; a legada é o que resta. */}
                      {e.expense_category_name ? (
                        <span
                          className="text-xs px-2 py-0.5 rounded-full font-medium"
                          style={
                            e.expense_category_color
                              ? { backgroundColor: `${e.expense_category_color}1A`, color: e.expense_category_color }
                              : undefined
                          }
                        >
                          {e.expense_category_name}
                        </span>
                      ) : (
                        <span className="text-xs text-[var(--color-text-muted)]">
                          {e.category ? CATEGORY_LABELS[e.category] : "—"}
                        </span>
                      )}
                    </td>
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
                          title="Marcar como pago/recebido"
                          className="text-xs px-2 py-0.5 rounded-full bg-amber-100 text-amber-700 font-medium hover:bg-amber-200 transition-colors"
                        >
                          Pendente — confirmar
                        </button>
                      ) : !e.reference_type ? (
                        <button
                          onClick={() => handleMarkPending(e.id)}
                          title="Voltar a pendente (por pagar)"
                          className="text-xs px-2 py-0.5 rounded-full bg-green-100 text-green-700 font-medium hover:bg-amber-100 hover:text-amber-700 transition-colors"
                        >
                          Confirmado — repor pendente
                        </button>
                      ) : (
                        <span className="text-xs px-2 py-0.5 rounded-full bg-green-100 text-green-700 font-medium">Confirmado</span>
                      )}
                    </td>
                    <td className="px-4 py-3">
                      <div className="flex items-center justify-end gap-1">
                      {/* Editar existe para **todos**, com ou sem origem: é
                          assim que se classifica um movimento que nasceu sem
                          categoria, incluindo os que vieram de um pagamento. */}
                      <button
                        onClick={() => abrirEdicao(e)}
                        className="p-1 rounded text-[var(--color-text-muted)] hover:text-[var(--finance-primary)] hover:bg-[var(--finance-primary-soft)] transition-colors"
                        title="Editar categoria e detalhes"
                      >
                        <Pencil className="w-3.5 h-3.5" />
                      </button>
                      {!e.reference_type && (
                        <button
                          onClick={() => handleDelete(e.id)}
                          className="p-1 rounded text-[var(--color-text-muted)] hover:text-red-600 hover:bg-red-50 transition-colors"
                          title="Eliminar"
                        >
                          <Trash2 className="w-3.5 h-3.5" />
                        </button>
                      )}
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
            <Pagination {...pag} hideWhenSinglePage />
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
                  {/* Ao trocar o tipo, o estado acompanha a intenção habitual:
                      entrada = dinheiro que entrou (confirmado); saída = despesa
                      a pagar (pendente). Continua alterável no seletor abaixo. */}
                  <button type="button" onClick={() => { setNewType("entrada"); setNewStatus("confirmado"); }}
                    className={`flex-1 py-2 text-sm font-medium transition-colors ${newType === "entrada" ? "bg-green-600 text-white" : "text-[var(--color-text-sub)] hover:bg-[var(--color-background)]"}`}>
                    + Entrada
                  </button>
                  <button type="button" onClick={() => { setNewType("saida"); setNewStatus("pendente"); }}
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
                {expenseCatalog.available && expenseCatalog.categories.length > 0 && (
                  <div className="col-span-2">
                    <label className="block text-sm font-medium text-[var(--color-text-main)] mb-1.5">
                      Categoria de despesa
                    </label>
                    <select value={newExpenseCat} onChange={(e) => setNewExpenseCat(e.target.value)} className={inputCls}>
                      <option value="">Sem categoria</option>
                      {expenseCatalog.categories.map((c: ExpenseCategory) => (
                        <option key={c.id} value={c.id}>{c.name}</option>
                      ))}
                    </select>
                    <p className="mt-1 text-[11px] text-[var(--color-text-muted)]">
                      É esta que o gráfico «Despesas por categoria» usa. Escrever
                      «combustível» na descrição não classifica nada.
                    </p>
                  </div>
                )}
                <div>
                  <label className="block text-sm font-medium text-[var(--color-text-main)] mb-1.5">Estado</label>
                  <select value={newStatus} onChange={(e) => setNewStatus(e.target.value as CashFlowStatus)} className={inputCls}>
                    <option value="pendente">Pendente (por pagar)</option>
                    <option value="confirmado">Confirmado (pago/recebido)</option>
                  </select>
                </div>
              </div>

              <div>
                <label className="block text-sm font-medium text-[var(--color-text-main)] mb-1.5">Data</label>
                <input type="date" required value={newDate} onChange={(e) => { if (isValidIsoDateString(e.target.value)) setNewDate(e.target.value); }} className={inputCls} />
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
                  className="flex-1 py-2 rounded-lg bg-[var(--finance-primary)] text-white text-sm font-medium hover:bg-[var(--finance-primary-hover)] transition-colors disabled:opacity-50">
                  {isPending ? <Loader2 className="w-4 h-4 animate-spin mx-auto" /> : "Criar registo"}
                </button>
              </div>
            </form>
          </div>
        </div>
      )}

      {/* ── Editar movimento ──────────────────────────────────────────────────
          Existe sobretudo por uma razão: classificar movimentos que já estão na
          base sem categoria. É a alternativa ao backfill — quem sabe o que cada
          um foi classifica-o, em vez de o sistema adivinhar pela descrição. */}
      {editando && (
        <>
          <div className="fixed inset-0 bg-black/40 z-40" onClick={() => setEditando(null)} />
          <div className="fixed inset-y-0 right-0 z-50 w-full max-w-md bg-white shadow-xl flex flex-col">
            <div className="flex items-center justify-between px-6 py-4 border-b border-[var(--color-border)]">
              <div className="min-w-0">
                <h2 className="text-base font-semibold text-[var(--color-text-main)]">Editar movimento</h2>
                <p className="text-xs text-[var(--color-text-muted)] truncate">{editando.description}</p>
              </div>
              <button onClick={() => setEditando(null)} className="p-2 rounded-lg text-[var(--color-text-muted)] hover:bg-[var(--color-background)]">
                <X className="w-4 h-4" />
              </button>
            </div>

            <div className="flex-1 overflow-y-auto p-6 space-y-4">
              <div>
                <label className="block text-sm font-medium text-[var(--color-text-main)] mb-1.5">Descrição *</label>
                <input value={editDesc} onChange={(e) => setEditDesc(e.target.value)} className={inputCls} />
              </div>

              <div className="grid grid-cols-2 gap-3">
                <div>
                  <label className="block text-sm font-medium text-[var(--color-text-main)] mb-1.5">Valor (€)</label>
                  <input
                    type="number" step="0.01" min="0.01"
                    value={editAmount}
                    disabled={!!editando.reference_type}
                    onChange={(e) => setEditAmount(e.target.value)}
                    className={`${inputCls} ${editando.reference_type ? "opacity-60 cursor-not-allowed bg-[var(--color-background)]" : ""}`}
                  />
                  {editando.reference_type && (
                    <p className="mt-1 text-[11px] leading-snug text-[var(--color-text-muted)]">
                      Este movimento veio de {ORIGIN_BADGE[editando.reference_type]?.label ?? editando.reference_type}.
                      Alterar aqui o valor fá-lo-ia discordar da origem, e as duas
                      versões ficariam plausíveis.
                    </p>
                  )}
                </div>
                <div>
                  <label className="block text-sm font-medium text-[var(--color-text-main)] mb-1.5">Data</label>
                  <input
                    type="date"
                    value={editDate}
                    onChange={(e) => { if (isValidIsoDateString(e.target.value)) setEditDate(e.target.value); }}
                    className={inputCls}
                  />
                </div>
              </div>

              {expenseCatalog.available && expenseCatalog.categories.length > 0 ? (
                <div>
                  <label className="block text-sm font-medium text-[var(--color-text-main)] mb-1.5">
                    Categoria de despesa
                  </label>
                  <select value={editCat} onChange={(e) => setEditCat(e.target.value)} className={inputCls}>
                    <option value="">Sem categoria</option>
                    {expenseCatalog.categories.map((c: ExpenseCategory) => (
                      <option key={c.id} value={c.id}>{c.name}</option>
                    ))}
                  </select>
                  <p className="mt-1 text-[11px] text-[var(--color-text-muted)]">
                    É esta que o gráfico «Despesas por categoria» usa.
                  </p>
                </div>
              ) : (
                <p className="text-xs text-[var(--color-text-muted)]">
                  Categorias indisponíveis nesta base.
                </p>
              )}

              {editErr && (
                <p role="alert" className="text-xs text-red-600 px-3 py-2 rounded-lg bg-red-50 border border-red-200">
                  {editErr}
                </p>
              )}
            </div>

            <div className="flex gap-3 px-6 py-4 border-t border-[var(--color-border)]">
              <button
                onClick={() => setEditando(null)}
                className="flex-1 px-4 py-2 rounded-lg border border-[var(--color-border)] text-sm font-medium text-[var(--color-text-sub)] hover:bg-[var(--color-background)]"
              >
                Cancelar
              </button>
              <button
                onClick={guardarEdicao}
                disabled={isPending}
                className="flex-1 flex items-center justify-center gap-2 px-4 py-2 rounded-lg bg-[var(--finance-primary)] text-white text-sm font-semibold hover:bg-[var(--finance-primary-hover)] disabled:opacity-50"
              >
                {isPending ? <Loader2 className="w-4 h-4 animate-spin" /> : null}
                Guardar
              </button>
            </div>
          </div>
        </>
      )}
    </div>
  );
}

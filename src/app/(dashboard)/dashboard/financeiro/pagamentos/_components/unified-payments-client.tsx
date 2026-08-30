"use client";

import { useMemo, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import {
  AlertCircle,
  Check,
  ChevronLeft,
  ChevronRight,
  Loader2,
  Pencil,
  Plus,
  Trash2,
  X,
  AlertTriangle,
  Repeat,
  Zap,
} from "lucide-react";
import type { FinanceLedgerRow } from "@/domain/finance/ledger";
import {
  categorySlices,
  filterFinanceLedger,
  financeLedgerMetrics,
  originLabel,
  originLabelFor,
  paginateFinanceLedger,
  presentationStatus,
  type FinanceGraphMode,
  type FinanceLedgerFilter,
  canMutateRow,
  integrityWarning,
  INTEGRITY_BLOCK_REASON,
  financeLedgerCounts,
  mesPorPreparar,
  categoryFilterOptions,
  categoryKey,
} from "@/domain/finance/ledger-presentation";
import { createPayment, deletePayment, setPaymentStatus, updatePayment } from "@/app/actions/payments";
import { createCashFlowEntry, deleteCashFlowEntry, updateCashFlowEntry } from "@/app/actions/cash-flow";
import { AttachmentsField } from "@/components/attachments/attachments-field";
import { RowMenu } from "@/components/financeiro/v2/primitives";
import { todayInLisbon } from "@/lib/lisbon-time";

export interface LedgerCategoryOption { id: string; name: string }

interface Props {
  rows: FinanceLedgerRow[];
  error: string | null;
  categories: LedgerCategoryOption[];
  /**
   * Resolvido pelo SERVIDOR a partir da sessão e passado para baixo.
   *
   * 🔴 `createCashFlowEntry` recebe-o, mas não confia nele: compara-o com o
   *    perfil autenticado e escreve com `profile.company_id`. O browser nunca
   *    é autoridade sobre a empresa — aqui é apenas o valor que o servidor já
   *    tinha resolvido, a fazer a viagem de volta.
   */
  companyId: string;
  year: number;
  month: number;
}

type EntryType = "payment" | "manual_output" | "manual_input";

interface FormState {
  row: FinanceLedgerRow | null;
  type: EntryType;
  kind: "fixo" | "variavel";
  description: string;
  amount: string;
  date: string;
  dueDate: string;
  categoryId: string;
  cashStatus: "pendente" | "confirmado";
  directDebit: "" | "sim" | "nao";
  notes: string;
}

const PAGE_SIZE = 15;
const COLORS = ["#0E9F6E", "#2563EB", "#D97706", "#DC2626", "#7C3AED", "#0891B2", "#475569"];
const inputClass = "w-full rounded-lg border border-[var(--color-border)] bg-white px-3 py-2 text-sm text-[var(--color-text-main)] outline-none focus:ring-2 focus:ring-[var(--finance-primary)]";

const euro = (cents: number | null): string => cents === null
  ? "—"
  : (cents / 100).toLocaleString("pt-PT", { style: "currency", currency: "EUR" });

const date = (value: string | null): string => value
  ? new Date(`${value}T12:00:00Z`).toLocaleDateString("pt-PT")
  : "—";

function emptyForm(type: EntryType): FormState {
  return {
    row: null,
    type,
    kind: "variavel",
    description: "",
    amount: "",
    date: todayInLisbon(),
    dueDate: "",
    categoryId: "",
    cashStatus: "confirmado",
    directDebit: "",
    notes: "",
  };
}

function formFromRow(row: FinanceLedgerRow): FormState {
  return {
    ...emptyForm(row.row_kind === "payment" ? "payment" : row.direction === "saida" ? "manual_output" : "manual_input"),
    row,
    kind: row.origin === "fixo" ? "fixo" : "variavel",
    description: row.description,
    amount: row.amount_cents === null ? "" : String(row.amount_cents / 100),
    date: row.cash_date ?? row.date,
    dueDate: row.due_date ?? "",
    categoryId: row.expense_category_id ?? "",
    cashStatus: row.cashflow_status ?? "confirmado",
    directDebit: row.direct_debit === null ? "" : row.direct_debit ? "sim" : "nao",
    notes: row.notes ?? "",
  };
}

export function UnifiedPaymentsClient({ rows, error: initialError, categories, companyId, year, month }: Props) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [filter, setFilter] = useState<FinanceLedgerFilter>("todos");
  const [category, setCategory] = useState("");
  const [origin, setOrigin] = useState("");
  const [search, setSearch] = useState("");
  const [page, setPage] = useState(1);
  const [graphMode, setGraphMode] = useState<FinanceGraphMode>("competencia");
  const [form, setForm] = useState<FormState | null>(null);
  const [formError, setFormError] = useState("");
  const [error, setError] = useState(initialError);
  const today = todayInLisbon();

  // 🔴 Sem subscricao Realtime, e isso e uma decisao medida.
  //
  //    A versao anterior desta vista abria um canal `postgres_changes` sobre
  //    `fixed_variable_payments` e `cash_flow_entries`. Nenhuma das duas
  //    tabelas esta na publicacao `supabase_realtime` em producao (verificado
  //    por leitura de `pg_publication_tables`), portanto o canal nunca
  //    entregava evento nenhum: era uma ligacao aberta a fingir frescura.
  //
  //    A vista fica correcta sem ele — `router.refresh()` depois de cada
  //    mutacao propria, e navegacao mensal por URL. Se um dia as tabelas forem
  //    publicadas, a subscricao volta como melhoria best-effort, com um teste
  //    a provar que a UI continua correcta sem ela.

  const filtered = useMemo(() => {
    const query = search.trim().toLocaleLowerCase("pt-PT");
    return filterFinanceLedger(rows, filter).filter((row) =>
      (!category || categoryKey(row) === category)
      && (!origin || row.origin === origin)
      && (!query || row.description.toLocaleLowerCase("pt-PT").includes(query)),
    );
  }, [rows, filter, category, origin, search]);

  const pages = Math.max(1, Math.ceil(filtered.length / PAGE_SIZE));
  const currentPage = Math.min(page, pages);
  const visible = paginateFinanceLedger(filtered, currentPage, PAGE_SIZE);
  const metrics = financeLedgerMetrics(rows, { year, month }, today);
  const slices = categorySlices(rows, { year, month }, graphMode);
  const graphTotal = slices.reduce((sum, slice) => sum + slice.amount_cents, 0);
  const origins = [...new Set(rows.map((row) => row.origin))].sort();
  const counts = financeLedgerCounts(rows);
  const porPreparar = mesPorPreparar(rows);
  const categoryOptions = categoryFilterOptions(rows, categories);

  function mutate(task: () => Promise<{ ok: boolean; error?: string }>, close = false) {
    setError("");
    setFormError("");
    startTransition(async () => {
      const result = await task();
      if (!result.ok) {
        const message = result.error ?? "Não foi possível concluir a operação.";
        if (form) setFormError(message); else setError(message);
        return;
      }
      if (close) setForm(null);
      router.refresh();
    });
  }

  function submit(event: React.FormEvent) {
    event.preventDefault();
    if (!form || !form.description.trim()) {
      setFormError("Descrição obrigatória.");
      return;
    }
    const amount = Number(form.amount.replace(",", "."));
    if (!Number.isFinite(amount) || amount <= 0) {
      setFormError("Indique um valor superior a zero.");
      return;
    }
    const categoryId = form.categoryId || null;
    const notes = form.notes.trim() || null;

    if (form.type === "payment") {
      const directDebit = form.directDebit === "" ? null : form.directDebit === "sim";
      if (form.row?.payment_id) {
        const patch = {
          description: form.description.trim(),
          due_date: form.dueDate || null,
          expense_category_id: categoryId,
          direct_debit: directDebit,
          notes,
          ...(form.row.payment_status === "pago" ? {} : { amount }),
        };
        mutate(() => updatePayment(form.row!.payment_id!, patch), true);
      } else {
        mutate(() => createPayment({
          kind: form.kind,
          description: form.description.trim(),
          amount,
          due_date: form.dueDate || null,
          expense_category_id: categoryId,
          direct_debit: directDebit,
          notes,
          year,
          month,
        }), true);
      }
      return;
    }

    if (form.row?.cashflow_id) {
      mutate(() => updateCashFlowEntry(form.row!.cashflow_id!, {
        description: form.description.trim(),
        amount,
        date: form.date,
        status: form.cashStatus,
        expenseCategoryId: categoryId,
        notes,
      }), true);
    } else {
      mutate(() => createCashFlowEntry(companyId, {
        type: form.type === "manual_output" ? "saida" : "entrada",
        amount,
        description: form.description.trim(),
        category: form.type === "manual_output" ? "despesa" : "outro",
        date: form.date,
        status: form.cashStatus,
        notes: notes ?? undefined,
        expenseCategoryId: categoryId,
      }), true);
    }
  }

  function remove(row: FinanceLedgerRow) {
    // Segunda barreira: mesmo que o menu falhasse, uma linha degradada
    // nunca chega a `deletePayment`/`deleteCashFlowEntry`.
    if (!canMutateRow(row)) { setError(INTEGRITY_BLOCK_REASON); return; }
    if (row.row_kind === "payment" && row.payment_status === "pendente" && !row.is_linked && row.payment_id) {
      if (confirm(`Eliminar "${row.description}"?`)) mutate(() => deletePayment(row.payment_id!));
      return;
    }
    if (row.is_manual && row.cashflow_id) {
      if (confirm(`Eliminar "${row.description}"?`)) mutate(() => deleteCashFlowEntry(row.cashflow_id!));
      return;
    }
    setError("Este registo tem histórico ou uma origem ligada e não pode ser eliminado nesta página.");
  }

  return (
    <div className="space-y-5">
      <div className="flex flex-wrap items-center justify-between gap-3">
        {/*
          🔴 Fixos e Variáveis voltaram a ser separadores, com contagem.

             A vista anterior tinha-os como abas e a unificada dissolveu-os
             num select de "origem", ao lado de Folha e Cobrança. O dado
             continuava lá — mas a pergunta «o que se repete todos os meses?»
             deixou de ter resposta num clique, e é essa a pergunta de quem
             prepara o mês.
        */}
        <div className="flex flex-wrap gap-2">
          {(["todos", "fixos", "variaveis", "por_pagar", "pagos", "manuais"] as const).map((value) => (
            <button key={value} onClick={() => setFilter(value)} className={`rounded-lg border px-3 py-2 text-xs font-medium ${filter === value ? "border-[var(--finance-primary)] bg-[var(--finance-primary-soft)] text-[var(--finance-primary)]" : "border-[var(--color-border)] bg-white text-[var(--color-text-sub)]"}`}>
              {{ todos: "Todos", fixos: "Fixos", variaveis: "Variáveis", por_pagar: "Por pagar", pagos: "Pagos", manuais: "Movimentos manuais" }[value]}
              <span className="ml-1.5 text-[var(--color-text-muted)]">{counts[value]}</span>
            </button>
          ))}
        </div>
        <div className="flex flex-wrap items-center gap-2">
          {/*
            Criar já com o tipo escolhido, como as duas listas antigas faziam.
            «Novo fixo» a partir do separador Fixos evita a viagem ao select.
          */}
          <button onClick={() => setForm({ ...emptyForm("payment"), kind: "fixo" })} className="inline-flex items-center gap-2 rounded-lg border border-[var(--color-border)] bg-white px-3 py-2.5 text-sm font-medium text-[var(--color-text-sub)]">
            <Repeat className="h-4 w-4" /> Novo fixo
          </button>
          <button onClick={() => setForm({ ...emptyForm("payment"), kind: "variavel" })} className="inline-flex items-center gap-2 rounded-lg border border-[var(--color-border)] bg-white px-3 py-2.5 text-sm font-medium text-[var(--color-text-sub)]">
            <Zap className="h-4 w-4" /> Novo variável
          </button>
          <button onClick={() => setForm(emptyForm("payment"))} className="inline-flex items-center gap-2 rounded-lg bg-[var(--finance-primary)] px-3.5 py-2.5 text-sm font-semibold text-white">
            <Plus className="h-4 w-4" /> Novo registo
          </button>
        </div>
      </div>

      {/*
        🔴 «Mês por preparar» ≠ «nada a pagar».

           Mostrar os totais a 0,00 € num mês em que ninguém lançou nada
           afirma que não há despesa. O que se sabe é apenas que ainda não foi
           registada. A vista anterior distinguia os dois estados; esta tinha
           perdido a distinção.
      */}
      {porPreparar && (
        <div className="flex items-start gap-3 rounded-xl border border-[var(--color-border)] bg-[var(--color-background)] p-4">
          <AlertCircle className="mt-0.5 h-4 w-4 shrink-0 text-[var(--color-text-muted)]" />
          <div className="text-sm">
            <p className="font-medium text-[var(--color-text-main)]">Mês ainda não preparado</p>
            <p className="mt-0.5 text-[var(--color-text-muted)]">
              Não há pagamentos registados neste mês. Isto não quer dizer que não
              haja nada a pagar — quer dizer que ainda não foi lançado.
            </p>
          </div>
        </div>
      )}

      {(error || initialError) && (
        <div role="alert" className="flex items-center gap-2 rounded-lg border border-red-200 bg-red-50 p-3 text-sm text-red-700">
          <AlertCircle className="h-4 w-4 shrink-0" /> {error || initialError}
        </div>
      )}

      <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
        <Metric label="Por pagar" value={euro(metrics.due_cents)} />
        <Metric label="Já pago" value={euro(metrics.paid_cents)} />
        <Metric label="Em atraso" value={euro(metrics.overdue_cents)} alert />
        <Metric label="Saídas do período" value={euro(metrics.cash_output_cents)} />
      </div>

      <section className="rounded-lg border border-[var(--color-border)] bg-white p-4">
        <div className="mb-4 flex flex-wrap items-center justify-between gap-3">
          <div>
            <h2 className="text-sm font-semibold text-[var(--color-text-main)]">Gastos por categoria</h2>
            <p className="text-xs text-[var(--color-text-muted)]">{graphMode === "competencia" ? "Obrigações do mês de competência" : "Saídas pela data efetiva de caixa"}</p>
          </div>
          <div className="flex rounded-lg border border-[var(--color-border)] p-0.5">
            {(["competencia", "caixa"] as const).map((mode) => (
              <button key={mode} onClick={() => setGraphMode(mode)} className={`rounded-md px-3 py-1.5 text-xs font-medium ${graphMode === mode ? "bg-[var(--finance-primary-soft)] text-[var(--finance-primary)]" : "text-[var(--color-text-muted)]"}`}>
                {mode === "competencia" ? "Competência" : "Caixa"}
              </button>
            ))}
          </div>
        </div>
        <CategoryChart slices={slices} total={graphTotal} />
      </section>

      <section className="overflow-hidden rounded-lg border border-[var(--color-border)] bg-white">
        <div className="grid gap-2 border-b border-[var(--color-border)] p-3 md:grid-cols-4">
          <input value={search} onChange={(event) => setSearch(event.target.value)} placeholder="Pesquisar descrição" className={inputClass} />
          {/*
            🔴 As opções saem das LINHAS, não só do catálogo.

               Antes vinham apenas de `categories` (catálogo activo). Uma linha
               com uma categoria desactivada — ou o catálogo indisponível, que
               devolve lista vazia sem falhar — deixava de ser filtrável: a
               tabela mostrava «Manutenção» e o filtro não tinha «Manutenção».
               Era esse o «a categoria aqui não atualizou».

               A união resolve os dois casos e mantém o catálogo como fonte dos
               nomes quando ele os tem.
          */}
          <select value={category} onChange={(event) => setCategory(event.target.value)} className={inputClass}>
            <option value="">Todas as categorias</option>
            <option value="uncategorized">Sem categoria</option>
            {categoryOptions.map((item) => <option key={item.id} value={item.id}>{item.name}</option>)}
          </select>
          <select value={origin} onChange={(event) => setOrigin(event.target.value)} className={inputClass}>
            <option value="">Todas as origens</option>
            {origins.map((item) => <option key={item} value={item}>{originLabelFor(item)}</option>)}
          </select>
          <p className="self-center text-right text-xs text-[var(--color-text-muted)]">{filtered.length} registos</p>
        </div>
        <div className="overflow-x-auto">
          <table className="w-full min-w-[980px] text-sm">
            <thead className="bg-[var(--color-background)] text-left text-xs uppercase text-[var(--color-text-muted)]">
              <tr>{["Data", "Descrição", "Vencimento", "Categoria", "Origem", "Valor", "Estado", "Ações"].map((label) => <th key={label} className="px-3 py-2.5 font-medium">{label}</th>)}</tr>
            </thead>
            <tbody className="divide-y divide-[var(--color-border)]">
              {visible.map((row) => {
                // 🔴 Uma linha em que Pagamentos e Caixa não batem certo não
                //    aceita escrita por aqui. Não se repara automaticamente
                //    nem se escolhe um lado como verdade — escrever por cima
                //    apagaria a prova de que divergiram.
                const anomalia = integrityWarning(row);
                const podeAlterar = canMutateRow(row);
                const bloqueado = () => setError(INTEGRITY_BLOCK_REASON);
                return (
                <tr key={row.row_id} className={anomalia ? "bg-amber-50/60" : "hover:bg-[var(--color-background)]"}>
                  <td className="px-3 py-3 tabular-nums">{date(row.date)}</td>
                  <td className="max-w-[260px] px-3 py-3 font-medium text-[var(--color-text-main)]">
                    {row.description}
                    {anomalia && (
                      <span className="mt-1 flex items-start gap-1.5 text-xs font-normal text-amber-800">
                        <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0" aria-hidden="true" />
                        <span>{anomalia}</span>
                      </span>
                    )}
                  </td>
                  <td className="px-3 py-3 tabular-nums">{date(row.due_date)}</td>
                  <td className="px-3 py-3">{row.category_name ?? "Sem categoria"}</td>
                  <td className="px-3 py-3">{originLabel(row)}</td>
                  <td className={`px-3 py-3 font-semibold tabular-nums ${row.direction === "entrada" ? "text-emerald-700" : "text-[var(--color-text-main)]"}`}>{row.direction === "entrada" ? "+" : "−"}{euro(row.amount_cents)}</td>
                  <td className="px-3 py-3"><Status label={presentationStatus(row, today)} /></td>
                  <td className="px-3 py-3">
                    <RowMenu label={`Ações de ${row.description}`} actions={[
                      { label: !podeAlterar ? "Verificar inconsistência" : row.is_manual || row.row_kind === "payment" ? "Editar" : "Gerido na origem", icon: <Pencil className="h-3.5 w-3.5" />, onSelect: () => !podeAlterar ? bloqueado() : row.is_manual || row.row_kind === "payment" ? setForm(formFromRow(row)) : setError("Este movimento deve ser alterado na área que o criou.") },
                      ...(row.row_kind === "payment" && row.payment_id ? [{ label: !podeAlterar ? "Estado bloqueado" : row.payment_status === "pago" ? "Marcar por pagar" : "Marcar como pago", icon: <Check className="h-3.5 w-3.5" />, onSelect: () => !podeAlterar ? bloqueado() : mutate(() => setPaymentStatus(row.payment_id!, row.payment_status === "pago" ? "pendente" : "pago")) }] : []),
                      { label: !podeAlterar ? "Não pode eliminar" : row.is_manual || (row.row_kind === "payment" && row.payment_status === "pendente" && !row.is_linked) ? "Eliminar" : "Não pode eliminar", icon: <Trash2 className="h-3.5 w-3.5" />, onSelect: () => !podeAlterar ? bloqueado() : remove(row), danger: true },
                    ]} />
                  </td>
                </tr>
                );
              })}
              {visible.length === 0 && <tr><td colSpan={8} className="px-4 py-12 text-center text-sm text-[var(--color-text-muted)]">Nenhum registo corresponde aos filtros.</td></tr>}
            </tbody>
          </table>
        </div>
        <div className="flex items-center justify-between border-t border-[var(--color-border)] px-3 py-2.5">
          <span className="text-xs text-[var(--color-text-muted)]">Página {currentPage} de {pages}</span>
          <div className="flex gap-1">
            <button aria-label="Página anterior" disabled={currentPage === 1} onClick={() => setPage(currentPage - 1)} className="rounded-lg border border-[var(--color-border)] p-2 disabled:opacity-40"><ChevronLeft className="h-4 w-4" /></button>
            <button aria-label="Página seguinte" disabled={currentPage === pages} onClick={() => setPage(currentPage + 1)} className="rounded-lg border border-[var(--color-border)] p-2 disabled:opacity-40"><ChevronRight className="h-4 w-4" /></button>
          </div>
        </div>
      </section>

      {form && <EntryModal form={form} setForm={setForm} categories={categories} pending={pending} error={formError} onSubmit={submit} />}
    </div>
  );
}

function Metric({ label, value, alert = false }: { label: string; value: string; alert?: boolean }) {
  return <div className="rounded-lg border border-[var(--color-border)] bg-white p-4"><p className="text-xs text-[var(--color-text-muted)]">{label}</p><p className={`mt-1 text-lg font-semibold tabular-nums ${alert ? "text-red-700" : "text-[var(--color-text-main)]"}`}>{value}</p></div>;
}

function Status({ label }: { label: string }) {
  const color = label === "Em atraso" ? "bg-red-50 text-red-700" : label === "Pago" || label === "Confirmado" ? "bg-emerald-50 text-emerald-700" : "bg-amber-50 text-amber-700";
  return <span className={`inline-flex rounded-md px-2 py-1 text-xs font-medium ${color}`}>{label}</span>;
}

function CategoryChart({ slices, total }: { slices: ReturnType<typeof categorySlices>; total: number }) {
  const gradient = slices.map((slice, index) => {
    const before = slices.slice(0, index).reduce((sum, item) => sum + item.amount_cents, 0);
    const start = total > 0 ? before / total * 100 : 0;
    const end = total > 0 ? (before + slice.amount_cents) / total * 100 : 0;
    return `${COLORS[index % COLORS.length]} ${start}% ${end}%`;
  }).join(", ");
  if (slices.length === 0) return <p className="py-10 text-center text-sm text-[var(--color-text-muted)]">Sem gastos neste período.</p>;
  return <div className="flex flex-col items-center gap-5 md:flex-row">
    <div className="grid h-36 w-36 shrink-0 place-items-center rounded-full" style={{ background: `conic-gradient(${gradient})` }}><div className="grid h-20 w-20 place-items-center rounded-full bg-white text-center text-xs font-semibold tabular-nums">{euro(total)}</div></div>
    <div className="w-full space-y-2">{slices.map((slice, index) => <div key={slice.category_id ?? "none"} className="flex items-center gap-2 text-sm"><span className="h-2.5 w-2.5 rounded-sm" style={{ backgroundColor: COLORS[index % COLORS.length] }} /><span className="flex-1 text-[var(--color-text-sub)]">{slice.name}</span><span className="font-medium tabular-nums">{euro(slice.amount_cents)}</span></div>)}</div>
  </div>;
}

function EntryModal({ form, setForm, categories, pending, error, onSubmit }: { form: FormState; setForm: (value: FormState | null) => void; categories: LedgerCategoryOption[]; pending: boolean; error: string; onSubmit: (event: React.FormEvent) => void }) {
  const update = (patch: Partial<FormState>) => setForm({ ...form, ...patch });
  const paid = form.row?.payment_status === "pago";
  return <div className="fixed inset-0 z-[9999] flex items-center justify-center p-4">
    <button aria-label="Fechar" className="absolute inset-0 bg-black/40" onClick={() => setForm(null)} />
    <div className="relative z-10 max-h-[92vh] w-full max-w-lg overflow-y-auto rounded-lg border border-[var(--color-border)] bg-white shadow-xl">
      <div className="flex items-center justify-between border-b border-[var(--color-border)] px-5 py-4"><h2 className="text-base font-semibold">{form.row ? "Editar registo" : "Novo registo"}</h2><button aria-label="Fechar" onClick={() => setForm(null)}><X className="h-5 w-5" /></button></div>
      <form onSubmit={onSubmit} className="space-y-4 p-5">
        <Field label="Tipo *"><select disabled={Boolean(form.row)} value={form.type} onChange={(event) => update({ type: event.target.value as EntryType })} className={inputClass}><option value="payment">Conta a pagar</option><option value="manual_output">Saída manual</option><option value="manual_input">Entrada manual</option></select></Field>
        {form.type === "payment" && <Field label="Natureza"><select value={form.kind} onChange={(event) => update({ kind: event.target.value as FormState["kind"] })} className={inputClass}><option value="variavel">Variável</option><option value="fixo">Fixo</option></select></Field>}
        <Field label="Descrição *"><input autoFocus value={form.description} onChange={(event) => update({ description: event.target.value })} className={inputClass} /></Field>
        <div className="grid grid-cols-2 gap-3">
          <Field label="Valor (€) *"><input inputMode="decimal" disabled={paid} value={form.amount} onChange={(event) => update({ amount: event.target.value })} className={`${inputClass} ${paid ? "bg-slate-50 opacity-70" : ""}`} />{paid && <p className="mt-1 text-xs text-[var(--color-text-muted)]">Reverta o pagamento antes de alterar o valor.</p>}</Field>
          {form.type === "payment" ? <Field label="Vencimento"><input type="date" value={form.dueDate} onChange={(event) => update({ dueDate: event.target.value })} className={inputClass} /></Field> : <Field label="Data"><input required type="date" value={form.date} onChange={(event) => update({ date: event.target.value })} className={inputClass} /></Field>}
        </div>
        <Field label="Categoria"><select value={form.categoryId} onChange={(event) => update({ categoryId: event.target.value })} className={inputClass}><option value="">Sem categoria</option>{categories.map((item) => <option key={item.id} value={item.id}>{item.name}</option>)}</select></Field>
        {form.type === "payment" ? <Field label="Débito direto"><select value={form.directDebit} onChange={(event) => update({ directDebit: event.target.value as FormState["directDebit"] })} className={inputClass}><option value="">Não definido</option><option value="sim">Sim</option><option value="nao">Não</option></select></Field> : <Field label="Estado"><select value={form.cashStatus} onChange={(event) => update({ cashStatus: event.target.value as FormState["cashStatus"] })} className={inputClass}><option value="confirmado">Confirmado</option><option value="pendente">Pendente — confirmar</option></select></Field>}
        <Field label="Notas"><textarea rows={2} value={form.notes} onChange={(event) => update({ notes: event.target.value })} className={inputClass} /></Field>
        {form.row?.payment_id && <Field label="Anexos"><AttachmentsField parentType="fixed_variable_payment" parentId={form.row.payment_id} /></Field>}
        {error && <p role="alert" className="rounded-lg border border-red-200 bg-red-50 p-3 text-sm text-red-700">{error}</p>}
        <div className="flex gap-3 pt-1"><button type="button" onClick={() => setForm(null)} className="flex-1 rounded-lg border border-[var(--color-border)] px-4 py-2 text-sm">Cancelar</button><button disabled={pending} className="flex flex-1 items-center justify-center gap-2 rounded-lg bg-[var(--finance-primary)] px-4 py-2 text-sm font-semibold text-white disabled:opacity-50">{pending && <Loader2 className="h-4 w-4 animate-spin" />} Guardar</button></div>
      </form>
    </div>
  </div>;
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return <label className="block text-sm font-medium text-[var(--color-text-main)]"><span className="mb-1.5 block">{label}</span>{children}</label>;
}

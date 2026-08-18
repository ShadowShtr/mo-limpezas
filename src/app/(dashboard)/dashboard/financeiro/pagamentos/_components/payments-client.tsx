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
import { LocalTabs, Kpi as V2Kpi, RowMenu, type KpiTone } from "@/components/financeiro/v2/primitives";
import { AttachmentsField } from "@/components/attachments/attachments-field";
import { listAttachments } from "@/app/actions/attachments";
import type { AttachmentView } from "@/lib/attachments";
import { todayInLisbon } from "@/lib/lisbon-time";
import { isValidIsoDateString } from "@/lib/utils";

function fmtEur(v: number | null) {
  if (v === null || v === undefined) return "—";
  return v.toLocaleString("pt-PT", { minimumFractionDigits: 2, maximumFractionDigits: 2 }) + " €";
}
/**
 * Uma data de vencimento, **sempre com ano**.
 *
 * 🔴 Mostrava só dia e mês. Num incidente em que quatro vencimentos
 * trimestrais foram esmagados numa data só, isso escondia a diferença que mais
 * importava: `03 mai. 2027` e `03 mai. 2026` apareciam exactamente iguais no
 * ecrã, e não havia como distinguir um contrato do ano que vem de um deste ano.
 *
 * Isto é **apresentação**. Não altera `due_date`, nem o que está gravado.
 */
function fmtDate(s: string | null) {
  if (!s) return "—";
  return new Date(s + "T00:00:00").toLocaleDateString("pt-PT", {
    day: "2-digit", month: "short", year: "numeric",
  });
}
interface Props {
  initialData: PaymentsData | null;
  error: string | null;
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
  attachment_url: string | null;
  attachment_name: string | null;
};

const emptyForm = (kind: PaymentKind): FormState => ({
  id: null, kind, description: "", amount: "", due_date: "", direct_debit: "", notes: "",
  attachment_url: null, attachment_name: null,
});

export function PaymentsClient({ initialData, error: initErr, year, month }: Props) {
  const [data, setData] = useState<PaymentsData | null>(initialData);
  const [error, setError] = useState(initErr);
  const [isPending, startTransition] = useTransition();
  const [form, setForm] = useState<FormState | null>(null);
  const [formError, setFormError] = useState("");
  const [attachError, setAttachError] = useState("");
  const [attachments, setAttachments] = useState<AttachmentView[]>([]);
  // Filtro **local**, sobre os dados já carregados. Trocar de aba não vai à
  // base, não muda o mês e não dispara mutação nenhuma.
  const [aba, setAba] = useState<"fixos" | "variaveis">("fixos");

  function reload() {
    startTransition(async () => {
      const res = await getPayments(year, month);
      if (res.ok) setData(res.data);
      else setError(res.error);
    });
  }

  function openNew(kind: PaymentKind) {
    setFormError("");
    setForm(emptyForm(kind));
  }
  function openEdit(p: Payment) {
    setFormError("");
    setAttachError("");
    // Os anexos vêm do servidor, que junta o legado deste pagamento com as
    // linhas de `attachments`. Enquanto carrega, a lista fica vazia — o
    // componente mostra "Sem anexos" e não perde nada: a fonte autoritativa
    // chega logo a seguir.
    setAttachments([]);
    listAttachments("fixed_variable_payment", p.id).then((res) => {
      if (res.ok) setAttachments(res.attachments);
      else setAttachError(res.error);
    });
    setForm({
      id: p.id, kind: p.kind, description: p.description,
      amount: p.amount === null ? "" : String(p.amount),
      due_date: p.due_date ?? "",
      direct_debit: p.direct_debit === null ? "" : p.direct_debit ? "sim" : "nao",
      notes: p.notes ?? "",
      attachment_url: p.attachment_url,
      attachment_name: p.attachment_name,
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

  // 🔴 O resultado da action TEM de ser lido.
  //
  // Até 2026-08-18 este handler fazia `await setPaymentStatus(...)` e chamava
  // `reload()` a seguir, sem olhar para a resposta. A action é fail-closed e
  // devolve `{ ok: false, error }` — período fechado, sem permissão, erro da
  // RPC — mas o erro era descartado. O `reload()` relia o estado real (que não
  // tinha mudado) e a linha voltava a aparecer como estava, sem mensagem
  // nenhuma. Para quem clicava: «marquei como pago e não atualizou».
  //
  // O caso mais provável em uso real é o mês fechado: a 073 recusa a escrita,
  // a action traduz o erro, e ninguém o via.
  function toggleStatus(p: Payment) {
    setError("");
    startTransition(async () => {
      const res = await setPaymentStatus(p.id, p.status === "pago" ? "pendente" : "pago");
      if (!res.ok) {
        setError(res.error ?? "Não foi possível alterar o estado do pagamento.");
        return;
      }
      reload();
    });
  }
  function handleDelete(p: Payment) {
    if (!confirm(`Eliminar "${p.description}"?`)) return;
    setError("");
    startTransition(async () => {
      const res = await deletePayment(p.id);
      if (!res.ok) {
        setError(res.error ?? "Não foi possível eliminar o pagamento.");
        return;
      }
      reload();
    });
  }

  // Os handlers de anexo único (upload/download/remove) saíram daqui: o
  // AttachmentsField trata dos três, através de src/app/actions/attachments.ts.
  // As actions legadas de payments.ts continuam a existir para o caminho antigo,
  // mas já não são chamadas por esta página.

  const today = todayInLisbon();

  return (
    <div className="space-y-5">
      {/*
        O seletor de mês desta vista saiu. Não é funcionalidade perdida: era um
        `<input type="month">` que navegava para `?mes=…`, exactamente o que o
        seletor do módulo faz agora que Pagamentos participa no período global.
        Manter os dois seria ter dois controlos para a mesma coisa, no mesmo
        ecrã, capazes de discordar.
      */}
      <div className="flex flex-wrap items-center justify-between gap-3">
        <LocalTabs
          value={aba}
          onChange={setAba}
          items={[
            { value: "fixos" as const, label: "Fixos", count: data?.fixos.length },
            { value: "variaveis" as const, label: "Variáveis", count: data?.variaveis.length },
          ]}
        />
        <p className="text-[12px] text-[#94A3B8] max-w-md">
          Os <strong className="font-medium text-[#64748B]">fixos</strong> repetem-se de mês para mês;
          os <strong className="font-medium text-[#64748B]">variáveis</strong> são pontuais.
          Nenhum é criado automaticamente ao abrir um mês.
        </p>
      </div>

      {error && (
        <div className="flex items-center gap-3 p-4 bg-red-50 border border-red-200 rounded-xl text-sm text-red-700">
          <AlertCircle className="w-4 h-4 shrink-0" />
          {error}
        </div>
      )}

      {/* Mês sem nenhuma linha registada.
          Mostrar os KPIs a 0,00 € aqui seria dizer que não há nada a pagar —
          e o que se sabe é apenas que ainda não foi registado nada. Ausência
          de dados não é ausência de despesa. */}
      {data && data.fixos.length === 0 && data.variaveis.length === 0 && (
        <div className="flex items-start gap-3 p-4 bg-[var(--color-background)] border border-[var(--color-border)] rounded-xl">
          <AlertCircle className="w-4 h-4 shrink-0 mt-0.5 text-[var(--color-text-muted)]" />
          <div className="text-sm">
            <p className="font-medium text-[var(--color-text-main)]">Mês ainda não preparado</p>
            <p className="text-[var(--color-text-muted)] mt-0.5">
              Não há pagamentos registados neste mês. Isto não quer dizer que não haja nada
              a pagar — quer dizer que ainda não foi lançado. Adicione os pagamentos deste
              mês nas listas abaixo.
            </p>
          </div>
        </div>
      )}

      {/* KPIs */}
      {data && (data.fixos.length > 0 || data.variaveis.length > 0) && (
        <div className="grid grid-cols-2 lg:grid-cols-4 gap-4">
          <Kpi icon={<Clock className="w-4 h-4 text-amber-600" />} bg="bg-amber-50" label="Por pagar" value={fmtEur(data.totalPendente)} accent="text-amber-600" />
          <Kpi icon={<CheckCircle2 className="w-4 h-4 text-green-600" />} bg="bg-green-50" label="Já pago" value={fmtEur(data.totalPago)} accent="text-green-600" />
          <Kpi icon={<AlertCircle className="w-4 h-4 text-red-600" />} bg="bg-red-50" label="Em atraso" value={`${data.countOverdue}`} accent="text-red-600" />
          <Kpi icon={<Clock className="w-4 h-4 text-[var(--finance-primary)]" />} bg="bg-[var(--finance-primary-soft)]" label="Itens por pagar" value={`${data.countPendente}`} accent="text-[var(--finance-primary)]" />
        </div>
      )}

      {data && (
        <>
          {aba === "fixos" ? (
            <PaymentSection
              title="Pagamentos Fixos" subtitle="Repetem de mês para mês" icon={<Repeat className="w-4 h-4 text-[var(--finance-primary)]" />}
              emptyLabel="Ainda não existem pagamentos fixos neste mês."
              items={data.fixos} today={today} onAdd={() => openNew("fixo")} onEdit={openEdit} onToggle={toggleStatus} onDelete={handleDelete} busy={isPending}
            />
          ) : (
            <PaymentSection
              title="Pagamentos Variáveis" subtitle="Pontuais deste mês" icon={<Zap className="w-4 h-4 text-amber-600" />}
              emptyLabel="Ainda não existem pagamentos variáveis neste mês."
              items={data.variaveis} today={today} onAdd={() => openNew("variavel")} onEdit={openEdit} onToggle={toggleStatus} onDelete={handleDelete} busy={isPending}
            />
          )}
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
                  <input type="date" value={form.due_date} onChange={(e) => { if (!e.target.value || isValidIsoDateString(e.target.value)) setForm({ ...form, due_date: e.target.value }); }} className={inputCls} />
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
              {/*
                Anexos múltiplos (migration 074). O campo de ficheiro único
                saiu: anexar um segundo sobrescrevia as colunas e apagava o
                ficheiro anterior do storage. O anexo legado deste pagamento,
                se existir, aparece na mesma lista — o read model junta as duas
                fontes. Ver docs/ATTACHMENTS-MULTIPLE.md.
              */}
              {form.id && (
                <Field label="Anexos (faturas/recibos)">
                  {/* Falhar a ler a lista tem de ser visível: sem isto, um
                      pagamento com anexos apareceria como se não tivesse. */}
                  {attachError && <p className="text-xs text-red-600 mb-2">{attachError}</p>}
                  <AttachmentsField
                    key={form.id}
                    parentType="fixed_variable_payment"
                    parentId={form.id}
                    initialAttachments={attachments}
                  />
                </Field>
              )}
              {formError && <p className="text-sm text-red-600">{formError}</p>}
              <div className="flex gap-3 pt-1">
                <button type="button" onClick={() => setForm(null)} className="flex-1 py-2 rounded-lg border border-[var(--color-border)] text-sm text-[var(--color-text-sub)] hover:bg-[var(--color-background)]">Cancelar</button>
                <button type="submit" disabled={isPending} className="flex-1 py-2 rounded-lg bg-[var(--finance-primary)] text-white text-sm font-medium hover:bg-[var(--finance-primary-hover)] disabled:opacity-50">
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

const inputCls = "w-full px-3 py-2 rounded-lg border border-[var(--color-border)] text-sm text-[var(--color-text-main)] focus:outline-none focus:ring-2 focus:ring-[var(--finance-primary)] bg-white";

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div>
      <label className="block text-sm font-medium text-[var(--color-text-main)] mb-1.5">{label}</label>
      {children}
    </div>
  );
}

/**
 * Financeiro V2: desenha com o primitivo partilhado.
 *
 * A assinatura ficou igual — os quatro pontos de chamada não foram tocados.
 * `accent` (uma cor) mapeia para `tone` (uma intenção), e `bg` deixou de ter
 * uso: o primitivo não pinta caixas atrás dos ícones.
 */
function Kpi({ icon, bg: _bg, label, value, accent }: { icon: React.ReactNode; bg: string; label: string; value: string; accent: string }) {
  const tone: KpiTone =
    accent.includes("red") ? "danger"
    : accent.includes("amber") ? "warning"
    : accent.includes("green") ? "positive"
    : "neutral";
  return <V2Kpi label={label} value={value} tone={tone} icon={icon} />;
}

function PaymentSection({
  title, subtitle, icon, emptyLabel, items, today, onAdd, onEdit, onToggle, onDelete, busy,
}: {
  title: string; subtitle: string; icon: React.ReactNode; emptyLabel: string; items: Payment[]; today: string;
  onAdd: () => void; onEdit: (p: Payment) => void; onToggle: (p: Payment) => void; onDelete: (p: Payment) => void; busy: boolean;
}) {
  return (
    <div
      className="bg-[var(--finance-surface)] rounded-[18px] border border-[var(--finance-border)] overflow-hidden"
      style={{ boxShadow: "0 1px 2px rgba(16,24,40,.03), 0 2px 8px rgba(16,24,40,.035)" }}
    >
      <div className="px-5 py-4 flex items-center justify-between gap-3">
        <div className="flex items-center gap-2.5 min-w-0">
          {icon}
          <div className="min-w-0">
            <h2 className="text-[14px] font-semibold text-[var(--finance-text)] truncate">{title}</h2>
            <p className="text-[12px] text-[var(--finance-text-muted)] truncate">{subtitle}</p>
          </div>
        </div>
        <button
          onClick={onAdd}
          className="shrink-0 inline-flex items-center gap-1.5 h-10 px-3.5 rounded-[10px] bg-[var(--finance-primary)] text-white text-[13px] font-medium hover:bg-[var(--finance-primary-hover)] transition-colors"
        >
          <Plus className="w-4 h-4" aria-hidden /> Adicionar
        </button>
      </div>
      {items.length === 0 ? (
        <div className="py-10 text-center text-[13px] text-[var(--finance-text-muted)]">{emptyLabel}</div>
      ) : (
        <div className="overflow-x-auto">
          <table className="w-full">
            <thead>
              <tr className="border-t border-[var(--finance-divider)]">
                <Th>Descrição</Th><Th>Vencimento</Th><Th right>Valor</Th><Th>Estado</Th><Th>Débito direto</Th>
                <th className="px-3 py-2 w-10" />
              </tr>
            </thead>
            <tbody className="divide-y divide-[var(--color-border)]">
              {items.map((p) => {
                const overdue = p.status === "pendente" && p.due_date && p.due_date < today;
                return (
                  <tr key={p.id} className="border-t border-[var(--finance-divider)] hover:bg-[#FAFBFC] transition-colors">
                    <td className="px-3 py-3.5 text-[13px] text-[var(--finance-text)]">{p.description}</td>
                    <td className="px-3 py-3.5">
                      <span className={`inline-flex items-center gap-1.5 text-[12.5px] ${overdue ? "text-[var(--finance-red)] font-semibold" : "text-[var(--finance-text-secondary)]"}`}>
                        {p.due_date && <Calendar className="w-3.5 h-3.5" aria-hidden />}
                        {fmtDate(p.due_date)}
                      </span>
                    </td>
                    <td className="px-3 py-3.5 text-[13px] font-semibold text-right text-[var(--finance-text)] tabular-nums">
                      {fmtEur(p.amount)}
                    </td>
                    {/* O estado é um badge pastel, e continua a alternar ao clicar —
                        `setPaymentStatus`, a mesma action de sempre. */}
                    <td className="px-3 py-3.5">
                      <button
                        onClick={() => onToggle(p)}
                        disabled={busy}
                        aria-label={`Alternar estado de ${p.description}`}
                        className={`inline-flex items-center gap-1 px-2.5 py-1 rounded-full text-[11.5px] font-medium transition-colors ${
                          p.status === "pago"
                            ? "bg-[var(--finance-green-soft)] text-[var(--finance-green)] hover:brightness-95"
                            : overdue
                              ? "bg-[var(--finance-red-soft)] text-[var(--finance-red)] hover:brightness-95"
                              : "bg-[var(--finance-orange-soft)] text-[var(--finance-orange)] hover:brightness-95"
                        }`}
                      >
                        {p.status === "pago" ? <><Check className="w-3 h-3" aria-hidden /> Pago</> : overdue ? "Vencido" : "Pendente"}
                      </button>
                    </td>
                    <td className="px-3 py-3.5">
                      {p.direct_debit === null ? (
                        <span className="text-[12px] text-[var(--finance-text-muted)]">—</span>
                      ) : p.direct_debit ? (
                        <span className="px-2 py-0.5 rounded-full bg-[var(--finance-blue-soft)] text-[#3538CD] text-[11.5px] font-medium">Sim</span>
                      ) : (
                        <span className="px-2 py-0.5 rounded-full bg-[var(--finance-track)] text-[var(--finance-slate)] text-[11.5px] font-medium">Não</span>
                      )}
                    </td>
                    {/* Editar e Eliminar recolheram para o «⋯». Recolher não é
                        remover: as duas actions são exactamente as de antes. */}
                    <td className="px-3 py-3.5">
                      <div className="flex items-center justify-end">
                        <RowMenu
                          label={`Ações de ${p.description}`}
                          actions={[
                            { label: "Editar", icon: <Pencil className="w-3.5 h-3.5" />, onSelect: () => onEdit(p) },
                            { label: p.status === "pago" ? "Marcar por pagar" : "Marcar como pago", icon: <Check className="w-3.5 h-3.5" />, onSelect: () => onToggle(p) },
                            { label: "Eliminar", icon: <Trash2 className="w-3.5 h-3.5" />, onSelect: () => onDelete(p), danger: true },
                          ]}
                        />
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

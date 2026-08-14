"use client";

import { useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { Search, Plus, Pencil, Trash2, X } from "lucide-react";
import {
  createBuildingCard, updateBuildingCard, deleteBuildingCard, type BuildingCard,
} from "@/app/actions/building-cards";
import { ConfirmDialog } from "@/components/ui/confirm-dialog";
import type { BuildingCardWeekday } from "@/types/database";

type Team = { id: string; name: string; color: string };

interface Props {
  buildingCards: BuildingCard[];
  teams: Team[];
  /**
   * Prédio a abrir já em edição, vindo de `?predio=<id>`.
   *
   * Quem chega pelo card do Financeiro vem corrigir **aquele** prédio. Abrir a
   * lista dos 146 e deixá-lo procurar seria mandá-lo fazer outra vez o
   * trabalho que o clique já tinha feito.
   */
  initialEditId?: string | null;
}

const WEEKDAY_LABELS: Record<BuildingCardWeekday, string> = {
  mon: "2ª feira", tue: "3ª feira", wed: "4ª feira", thu: "5ª feira",
  fri: "6ª feira", sat: "Sábado", sun: "Domingo",
};
const WEEKDAY_ORDER: BuildingCardWeekday[] = ["mon", "tue", "wed", "thu", "fri", "sat", "sun"];

const INPUT_CLS =
  "w-full px-3 py-2 rounded-lg border border-[var(--color-border)] text-sm text-[var(--color-text-main)] " +
  "focus:outline-none focus:ring-2 focus:ring-[var(--color-primary)] focus:border-transparent bg-white";
const SELECT_CLS =
  "w-full appearance-none px-3 py-2 pr-8 rounded-lg border border-[var(--color-border)] text-sm " +
  "text-[var(--color-text-main)] bg-white focus:outline-none focus:ring-2 focus:ring-[var(--color-primary)] focus:border-transparent";

interface FormState {
  name: string;
  address: string;
  weekday: BuildingCardWeekday;
  teamId: string;
  notes: string;
  /** Texto livre no formulário; convertido no submit. Vazio = sem valor. */
  monthlyValue: string;
}

/**
 * Um campo com etiqueta própria.
 *
 * A etiqueta fica **fora** da caixa e não desaparece ao escrever, que era o
 * problema de usar placeholders como rótulo: a seguir ao primeiro caracter,
 * seis caixas brancas iguais e nenhuma a dizer o que era.
 */
function Campo({
  etiqueta, nota, ajuda, obrigatorio, children,
}: {
  etiqueta: string;
  nota?: string;
  ajuda?: string;
  obrigatorio?: boolean;
  children: React.ReactNode;
}) {
  return (
    <label className="block">
      <span className="block mb-1.5 text-xs font-medium text-[var(--color-text-sub)]">
        {etiqueta}
        {obrigatorio && <span className="text-red-500" aria-hidden> *</span>}
        {nota && <span className="ml-1.5 font-normal text-[var(--color-text-muted)]">({nota})</span>}
      </span>
      {children}
      {ajuda && <span className="block mt-1 text-[11px] leading-snug text-[var(--color-text-muted)]">{ajuda}</span>}
    </label>
  );
}

const EMPTY_FORM: FormState = { name: "", address: "", weekday: "mon", teamId: "", notes: "", monthlyValue: "" };

export function PrediosTable({ buildingCards, teams, initialEditId = null }: Props) {
  const router = useRouter();
  const [search, setSearch] = useState("");
  const [editingId, setEditingId] = useState<string | null>(null);
  const [showForm, setShowForm] = useState(false);
  const [form, setForm] = useState<FormState>(EMPTY_FORM);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // 🔴 Uma vez por id, e não a cada render.
  //
  // Sem esta guarda, fechar o formulário e o React voltar a correr o efeito
  // reabria-o — e o botão «Cancelar» deixava de ter efeito nenhum, sem erro
  // nenhum a explicar porquê.
  const abertoPara = useRef<string | null>(null);
  useEffect(() => {
    if (!initialEditId || abertoPara.current === initialEditId) return;
    const alvo = buildingCards.find((c) => c.id === initialEditId);
    if (!alvo) return;          // id que já não existe: a aba abre na mesma
    abertoPara.current = initialEditId;
    openEditForm(alvo);
  }, [initialEditId, buildingCards]);

  const filtered = buildingCards.filter((c) =>
    c.name.toLowerCase().includes(search.toLowerCase()) ||
    (c.address ?? "").toLowerCase().includes(search.toLowerCase()),
  );
  const sorted = [...filtered].sort((a, b) => {
    const dOrder = WEEKDAY_ORDER.indexOf(a.weekday) - WEEKDAY_ORDER.indexOf(b.weekday);
    return dOrder !== 0 ? dOrder : a.sort_order - b.sort_order;
  });

  function teamById(id: string | null) {
    return id ? teams.find((t) => t.id === id) ?? null : null;
  }

  function openCreateForm() {
    setEditingId(null);
    setForm(EMPTY_FORM);
    setShowForm(true);
    setError(null);
  }

  function openEditForm(card: BuildingCard) {
    setEditingId(card.id);
    setForm({
      name: card.name, address: card.address ?? "", weekday: card.weekday,
      teamId: card.team_id ?? "", notes: card.notes ?? "",
      monthlyValue: card.monthly_value === null || card.monthly_value === undefined ? "" : String(card.monthly_value),
    });
    setShowForm(true);
    setError(null);
  }

  function closeForm() {
    setShowForm(false);
    setEditingId(null);
    setForm(EMPTY_FORM);
    setError(null);
  }

  async function handleSubmit() {
    if (!form.name.trim()) { setError("O nome do prédio é obrigatório."); return; }

    // 🔴 Campo vazio é **sem valor**, não zero. Zero diria que o prédio não
    //    rende nada; vazio diz que ainda não se sabe quanto rende.
    const bruto = form.monthlyValue.trim().replace(",", ".");
    const valorMensal = bruto === "" ? null : Number(bruto);
    if (valorMensal !== null && (!Number.isFinite(valorMensal) || valorMensal < 0)) {
      setError("A avença mensal tem de ser um número igual ou maior que zero.");
      return;
    }
    setSaving(true);
    setError(null);
    try {
      const result = editingId
        ? await updateBuildingCard(editingId, {
            name: form.name, address: form.address || null,
            teamId: form.teamId || null, notes: form.notes || null,
            monthlyValue: valorMensal,
          })
        : await createBuildingCard({
            weekday: form.weekday, name: form.name, address: form.address || null,
            teamId: form.teamId || null, notes: form.notes || null,
            monthlyValue: valorMensal,
          });

      if (!result.ok) { setError(result.error ?? "Erro ao guardar."); return; }
      closeForm();
      router.refresh();
    } finally {
      setSaving(false);
    }
  }

  async function handleDelete(card: BuildingCard) {
    const result = await deleteBuildingCard(card.id);
    if (!result.ok) { window.alert(result.error ?? "Erro ao apagar."); return; }
    router.refresh();
  }

  return (
    <div className="bg-white rounded-xl border border-[var(--color-border)]">
      <div className="flex flex-wrap items-center gap-3 p-4 border-b border-[var(--color-border)]">
        <div className="relative flex-1 min-w-48">
          <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-[var(--color-text-muted)]" />
          <input
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="Pesquisar prédio..."
            className="w-full pl-9 pr-3 py-2 text-sm rounded-lg border border-[var(--color-border)] bg-white
                       text-[var(--color-text-main)] placeholder:text-[var(--color-text-muted)]
                       focus:outline-none focus:ring-2 focus:ring-[var(--color-primary)] focus:border-transparent"
          />
        </div>
        <button
          onClick={openCreateForm}
          className="flex items-center gap-2 px-3 py-2 rounded-lg bg-[var(--color-primary)] text-white text-sm font-medium hover:bg-[var(--color-primary-hover)] transition-colors"
        >
          <Plus className="w-4 h-4" />
          Novo prédio
        </button>
      </div>

      {showForm && (
        /*
          🔴 Etiquetas a sério, e não placeholders.

          Todos os campos deste formulário se identificavam pelo texto cinzento
          lá dentro — que desaparece à primeira tecla. A seguir ficavam seis
          caixas brancas iguais: «Moçambique 27», «Rua de Moçambique n.27»,
          «2ª feira», «Equipa 13», «Geral 1x semana». Quem voltasse a abrir para
          corrigir a avença tinha de adivinhar qual era qual.

          Era pior no campo que mais importa: a avença é o único que costuma
          estar **vazio**, ou seja, o único cujo rótulo se vê — e mesmo assim
          desaparecia no instante em que se começava a escrever o valor.
        */
        <div
          className="p-4 border-b border-[var(--color-border)] bg-[var(--color-background)]"
          // Esc fecha, Ctrl/⌘+Enter grava. Quem vai corrigir 146 avenças não
          // deve ter de ir buscar o rato entre cada uma.
          onKeyDown={(e) => {
            if (e.key === "Escape") { e.preventDefault(); closeForm(); }
            if (e.key === "Enter" && (e.metaKey || e.ctrlKey) && !saving) { e.preventDefault(); handleSubmit(); }
          }}
        >
          <div className="flex items-start justify-between gap-3 mb-4">
            <div className="min-w-0">
              <p className="text-sm font-semibold text-[var(--color-text-main)]">
                {editingId ? "Editar prédio" : "Novo prédio"}
              </p>
              {/* Qual prédio. Com a lista logo por baixo e 146 linhas quase
                  iguais, «Editar prédio» sozinho não diz qual foi aberto. */}
              {editingId && form.name.trim() && (
                <p className="text-xs text-[var(--color-text-muted)] truncate mt-0.5">{form.name}</p>
              )}
            </div>
            <button onClick={closeForm} title="Fechar (Esc)"
              className="shrink-0 p-1 rounded-lg text-[var(--color-text-muted)] hover:bg-white hover:text-[var(--color-text-sub)]">
              <X className="w-4 h-4" />
            </button>
          </div>

          <div className="grid grid-cols-1 sm:grid-cols-2 gap-x-3 gap-y-4">
            <Campo etiqueta="Nome do prédio" obrigatorio>
              <input className={INPUT_CLS} value={form.name} autoFocus={!editingId}
                onChange={(e) => setForm((f) => ({ ...f, name: e.target.value }))} />
            </Campo>

            <Campo etiqueta="Morada" nota="opcional">
              <input className={INPUT_CLS} value={form.address}
                onChange={(e) => setForm((f) => ({ ...f, address: e.target.value }))} />
            </Campo>

            {/*
              O campo que se vem cá corrigir. Fica em primeiro na ordem de
              tabulação depois do nome, com o € visível — um número sem símbolo
              nenhum ao lado é a forma mais fácil de escrever cêntimos a pensar
              em euros.
            */}
            <Campo
              etiqueta="Avença mensal"
              nota={form.monthlyValue.trim() === "" ? "sem valor" : undefined}
              ajuda="Deixar vazio se ainda não se sabe. Vazio não é zero — zero diria que o prédio não rende nada."
            >
              <div className="relative">
                <span className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-sm text-[var(--color-text-muted)]">
                  €
                </span>
                <input
                  className={`${INPUT_CLS} pl-7 tabular-nums`}
                  type="text"
                  inputMode="decimal"
                  placeholder="0,00"
                  value={form.monthlyValue}
                  // 🔴 Reaberto pelo link do Financeiro, é este o campo que a
                  //    pessoa vem preencher. Poupa-lhe um clique.
                  autoFocus={!!editingId}
                  onChange={(e) => setForm((f) => ({ ...f, monthlyValue: e.target.value }))}
                />
              </div>
            </Campo>

            {/*
              A dizer porquê, em vez de só ficar cinzento.

              Um campo desativado sem explicação lê-se como avaria. O dia é a
              coluna do calendário onde o cartão vive: mudá-lo aqui seria mudar
              o prédio de coluna por um lado que não mostra o calendário.
            */}
            <Campo
              etiqueta="Dia da semana"
              ajuda={editingId ? "Para mudar de dia, arraste o cartão na coluna Prédios do calendário." : undefined}
            >
              <select
                className={`${SELECT_CLS} ${editingId ? "opacity-60 cursor-not-allowed bg-[var(--color-background)]" : ""}`}
                value={form.weekday}
                disabled={!!editingId}
                onChange={(e) => setForm((f) => ({ ...f, weekday: e.target.value as BuildingCardWeekday }))}
              >
                {WEEKDAY_ORDER.map((d) => <option key={d} value={d}>{WEEKDAY_LABELS[d]}</option>)}
              </select>
            </Campo>

            <Campo etiqueta="Equipa">
              <select className={SELECT_CLS} value={form.teamId}
                onChange={(e) => setForm((f) => ({ ...f, teamId: e.target.value }))}>
                <option value="">Sem equipa</option>
                {teams.map((t) => <option key={t.id} value={t.id}>{t.name}</option>)}
              </select>
            </Campo>

            <div className="sm:col-span-2">
              <Campo etiqueta="Notas" nota="opcional" ajuda="Ex.: chave, código do portão, frequência de limpeza.">
                <input className={INPUT_CLS} value={form.notes}
                  onChange={(e) => setForm((f) => ({ ...f, notes: e.target.value }))} />
              </Campo>
            </div>
          </div>

          {error && (
            <p role="alert" className="text-xs text-red-600 mt-3 px-3 py-2 rounded-lg bg-red-50 border border-red-100">
              {error}
            </p>
          )}

          <div className="flex flex-wrap items-center gap-2 justify-end mt-4">
            <span className="mr-auto text-[11px] text-[var(--color-text-muted)] hidden sm:block">
              Esc para fechar · Ctrl+Enter para guardar
            </span>
            <button onClick={closeForm} disabled={saving}
              className="px-3 py-2 text-sm font-medium rounded-lg border border-[var(--color-border)] text-[var(--color-text-sub)] hover:bg-white">
              Cancelar
            </button>
            <button onClick={handleSubmit} disabled={saving}
              className="px-4 py-2 text-sm font-medium rounded-lg bg-[var(--color-primary)] text-white hover:bg-[var(--color-primary-hover)] disabled:opacity-50">
              {saving ? "A guardar..." : "Guardar"}
            </button>
          </div>
        </div>
      )}

      <div className="overflow-x-auto">
        <table className="w-full">
          <thead>
            <tr className="bg-[var(--color-background)] border-b border-[var(--color-border)]">
              <th className="text-left px-4 py-3 text-xs font-medium text-[var(--color-text-muted)] uppercase tracking-wide">Prédio</th>
              <th className="text-left px-4 py-3 text-xs font-medium text-[var(--color-text-muted)] uppercase tracking-wide">Dia</th>
              <th className="text-left px-4 py-3 text-xs font-medium text-[var(--color-text-muted)] uppercase tracking-wide">Avença</th>
              <th className="text-left px-4 py-3 text-xs font-medium text-[var(--color-text-muted)] uppercase tracking-wide">Equipa</th>
              <th className="text-left px-4 py-3 text-xs font-medium text-[var(--color-text-muted)] uppercase tracking-wide">Notas</th>
              <th className="px-4 py-3" />
            </tr>
          </thead>
          <tbody className="divide-y divide-[var(--color-border)]">
            {sorted.length === 0 ? (
              <tr>
                <td colSpan={6} className="px-4 py-10 text-center text-sm text-[var(--color-text-muted)]">
                  Sem prédios registados.
                </td>
              </tr>
            ) : sorted.map((card) => {
              const team = teamById(card.team_id);
              return (
                <tr
                  key={card.id}
                  className={`hover:bg-[var(--color-background)]/50 ${
                    card.id === initialEditId ? "bg-[var(--color-primary)]/5" : ""
                  }`}
                >
                  <td className="px-4 py-3">
                    <p className="text-sm font-medium text-[var(--color-text-main)]">{card.name}</p>
                    {card.address && <p className="text-xs text-[var(--color-text-muted)]">{card.address}</p>}
                  </td>
                  <td className="px-4 py-3 text-sm text-[var(--color-text-sub)]">{WEEKDAY_LABELS[card.weekday]}</td>
                  {/* `null` é «Sem valor», nunca «0,00 €» — zero diria que o
                      prédio não rende nada, e o que se sabe é que não se sabe. */}
                  <td className="px-4 py-3 text-sm tabular-nums">
                    {card.monthly_value === null || card.monthly_value === undefined ? (
                      <span className="text-[var(--color-text-muted)] italic">Sem valor</span>
                    ) : (
                      <span className="font-semibold text-[var(--color-text-main)]">
                        {card.monthly_value.toLocaleString("pt-PT", { style: "currency", currency: "EUR" })}
                      </span>
                    )}
                  </td>
                  <td className="px-4 py-3">
                    <span
                      className="inline-flex items-center gap-1.5 px-2 py-0.5 rounded-full text-xs font-semibold text-white"
                      style={{ backgroundColor: team?.color ?? "#94A3B8" }}
                    >
                      {team?.name ?? "Sem equipa"}
                    </span>
                  </td>
                  <td className="px-4 py-3 text-xs text-[var(--color-text-muted)] max-w-[220px] truncate">{card.notes}</td>
                  <td className="px-4 py-3">
                    <div className="flex items-center justify-end gap-1">
                      <button onClick={() => openEditForm(card)} title="Editar"
                        className="p-1.5 rounded-lg text-[var(--color-text-muted)] hover:bg-[var(--color-background)] hover:text-[var(--color-text-sub)]">
                        <Pencil className="w-3.5 h-3.5" />
                      </button>
                      <ConfirmDialog
                        trigger={
                          <button title="Apagar" className="p-1.5 rounded-lg text-[var(--color-text-muted)] hover:bg-red-50 hover:text-red-600">
                            <Trash2 className="w-3.5 h-3.5" />
                          </button>
                        }
                        title="Apagar prédio"
                        description={`Remover "${card.name}" da lista de prédios? Esta ação não pode ser desfeita.`}
                        confirmLabel="Apagar"
                        onConfirm={() => handleDelete(card)}
                      />
                    </div>
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </div>
  );
}

"use client";

// ============================================================================
// Alocação de equipas — o rascunho é local, o save é um só
// ============================================================================
//
// 🔴 O que este ecrã fazia antes, e porque estava errado.
//
//    `handleDragEnd` chamava `moveCollaboratorToTeam` a meio do gesto. Cada
//    arrasto era uma escrita, PERMANENTE, em `team_members` — e apagava as
//    reatribuições diárias da pessoa, e notificava-a no telemóvel. Depois
//    fazia `fetchData()` para «confirmar».
//
//    Consequências reais:
//
//      · «Fechar» não desfazia nada, porque já estava gravado;
//      · «Guardar alocações» só guardava viaturas — as pessoas já lá estavam;
//      · arrastar para ver como ficava avisava a colaboradora;
//      · uma decisão já planeada para quinta-feira desaparecia.
//
//    A partir daqui: arrastar mexe SÓ no rascunho local. Zero escritas, zero
//    notificações, zero refetch. Só «Guardar alocações» escreve, e escreve
//    tudo numa transação.
//
// 🔴 A caixa DISPONÍVEL está sempre lá e aceita largar.
//
//    Antes era uma lista de quem sobrava. Agora é uma decisão possível: largar
//    alguém ali põe-na em stand by NAQUELE DIA, sem a tirar da equipa. No dia
//    seguinte, sem override, volta à equipa permanente.
// ============================================================================

import { useState, useEffect, useMemo, useCallback } from "react";
import { format } from "date-fns";
import { pt } from "date-fns/locale";
import { X, Loader2, Car, RefreshCw, ChevronDown, User, GripVertical } from "lucide-react";
import {
  DndContext, DragOverlay, PointerSensor, useSensor, useSensors,
  useDraggable, type DragStartEvent, type DragEndEvent,
} from "@dnd-kit/core";
import { carregarDia, guardarDiaEquipas } from "@/app/actions/equipas-r4";
import {
  equipaEfetivaNoRascunho,
  rascunhoInicial,
  rascunhoParaEscrita,
  rascunhoSujo,
  type DiaAlocacoes,
  type LinhaEfetiva,
  type PessoaBase,
  type Rascunho,
} from "@/lib/equipas/tipos";
import { DroppableColumn } from "./droppable-column";

const ABSENCE_LABELS: Record<string, string> = {
  doenca_com_baixa:     "Baixa médica",
  doenca_sem_baixa:     "Doença",
  pessoal_justificado:  "Pessoal just.",
  pessoal_injustificado:"Pessoal injust.",
  ferias:               "Férias",
  feriado:              "Feriado",
  formacao:             "Formação",
  outro:                "Outro",
};

/** O id da zona de largar do stand by. Não é um uuid de equipa, de propósito. */
export const ZONA_DISPONIVEL = "__disponivel__";

interface Props {
  open: boolean;
  onClose: () => void;
  companyId: string;
  selectedDate: Date;
  teams: { id: string; name: string; color: string }[];
}

// ─── Chip arrastável ────────────────────────────────────────────────────────

function MemberChip({
  member, color, fromTeamId, badge,
}: { member: PessoaBase; color: string; fromTeamId: string; badge?: string }) {
  const { attributes, listeners, setNodeRef, isDragging } = useDraggable({
    id: `member-${member.id}`,
    data: { collaboratorId: member.id, fromTeamId, fullName: member.full_name },
  });

  return (
    <span className="relative inline-flex">
      <span
        ref={setNodeRef}
        {...listeners}
        {...attributes}
        data-testid={`chip-${member.id}`}
        className="inline-flex items-center gap-1 pl-1.5 pr-2 py-0.5 rounded-full text-xs font-medium text-white cursor-grab active:cursor-grabbing touch-none select-none"
        style={{ backgroundColor: color, opacity: isDragging ? 0.4 : 1 }}
        title={badge ? `${member.full_name} — ${badge}` : member.full_name}
      >
        <GripVertical className="w-3 h-3 opacity-70 shrink-0" />
        {member.full_name.split(" ")[0]}
      </span>
      {badge && (
        <span
          className="absolute -top-1 -right-1 w-2 h-2 rounded-full bg-amber-500 ring-2 ring-white"
          title={badge}
        />
      )}
    </span>
  );
}

// ─── Componente ─────────────────────────────────────────────────────────────

export function TeamAllocationModal({ open, onClose, companyId, selectedDate }: Props) {
  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 8 } }),
  );

  const [loading, setLoading] = useState(false);
  const [saving,  setSaving]  = useState(false);
  const [message, setMessage] = useState<{ type: "error" | "success" | "info"; text: string } | null>(null);

  const [dia, setDia] = useState<DiaAlocacoes | null>(null);

  // 🔴 Duas fotografias, não uma.
  //
  //    `inicial` é o que a base tinha quando o modal abriu — é ele que diz se
  //    há alterações por guardar, e é para ele que se volta ao descartar.
  //    `rascunho` é o que o utilizador está a construir.
  const [inicial,  setInicial]  = useState<Rascunho>({ overrides: {}, viaturas: {} });
  const [rascunho, setRascunho] = useState<Rascunho>({ overrides: {}, viaturas: {} });

  const [dragging, setDragging] = useState<{ name: string; color: string } | null>(null);
  const [confirmarFecho, setConfirmarFecho] = useState(false);

  const sujo = useMemo(() => rascunhoSujo(inicial, rascunho), [inicial, rascunho]);

  const carregar = useCallback(async () => {
    setLoading(true);
    setMessage(null);
    const dateStr = format(selectedDate, "yyyy-MM-dd");
    const r = await carregarDia(companyId, dateStr);
    if (!r.ok) {
      setMessage({ type: "error", text: r.error });
      setLoading(false);
      return;
    }
    const base = rascunhoInicial(r.dia);
    setDia(r.dia);
    setInicial(base);
    setRascunho(base);
    setLoading(false);
  }, [companyId, selectedDate]);

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect
    if (open) carregar();
  }, [open, carregar]);

  // ── Derivados do RASCUNHO ─────────────────────────────────────────────────

  const pessoaPorId = useMemo(() => {
    const m: Record<string, PessoaBase> = {};
    for (const p of dia?.pessoas ?? []) m[p.id] = p;
    return m;
  }, [dia]);

  const linhaPorId = useMemo(() => {
    const m: Record<string, LinhaEfetiva> = {};
    for (const l of dia?.efetiva ?? []) m[l.collaborator_id] = l;
    return m;
  }, [dia]);

  /**
   * Quem está em cada equipa, quem está em stand by, e quem está ausente —
   * tudo derivado do rascunho.
   *
   * 🔴 Uma pessoa aparece numa lista SÓ. Ausente não entra na equipa nem no
   *    Disponível: uma representação efetiva por pessoa e por dia.
   */
  const vista = useMemo(() => {
    const porEquipa: Record<string, PessoaBase[]> = {};
    for (const t of dia?.equipas ?? []) porEquipa[t.id] = [];
    const disponiveis: Array<{ pessoa: PessoaBase; standby: boolean }> = [];
    const ausentes: Array<{ pessoa: PessoaBase; tipo: string }> = [];

    for (const linha of dia?.efetiva ?? []) {
      const pessoa = pessoaPorId[linha.collaborator_id];
      if (!pessoa) continue;

      if (linha.ausente) {
        ausentes.push({ pessoa, tipo: linha.origem });
        continue;
      }

      const equipa = equipaEfetivaNoRascunho(rascunho, linha);
      if (equipa && porEquipa[equipa]) {
        porEquipa[equipa].push(pessoa);
      } else {
        // 🔴 As duas formas de estar em Disponível, distinguidas.
        //    `standby` = havia equipa permanente e alguém decidiu que hoje não.
        const temOverride = Object.prototype.hasOwnProperty
          .call(rascunho.overrides, linha.collaborator_id);
        disponiveis.push({
          pessoa,
          standby: temOverride && rascunho.overrides[linha.collaborator_id] === null
                   && linha.permanent_team_id !== null,
        });
      }
    }

    for (const id of Object.keys(porEquipa)) {
      porEquipa[id].sort((a, b) => a.full_name.localeCompare(b.full_name));
    }
    disponiveis.sort((a, b) => a.pessoa.full_name.localeCompare(b.pessoa.full_name));
    return { porEquipa, disponiveis, ausentes };
  }, [dia, rascunho, pessoaPorId]);

  // ── Drag: SÓ estado local ─────────────────────────────────────────────────

  function handleDragStart(event: DragStartEvent) {
    const data = event.active.data.current as
      | { collaboratorId: string; fromTeamId: string; fullName: string } | undefined;
    if (!data) return;
    const cor = dia?.equipas.find((t) => t.id === data.fromTeamId)?.color ?? "#64748b";
    setDragging({ name: data.fullName, color: cor });
    setMessage(null);
  }

  /**
   * 🔴 Aqui não há `await`, não há server action, não há `fetchData()`.
   *
   *    É esta função que antes escrevia na base a meio do gesto. Agora só
   *    calcula o rascunho seguinte. Pode arrastar-se as vezes que quiser.
   */
  function handleDragEnd(event: DragEndEvent) {
    setDragging(null);
    const { active, over } = event;
    if (!over || !active.data.current) return;

    const { collaboratorId } = active.data.current as { collaboratorId: string };
    const alvo = String(over.id);
    const linha = linhaPorId[collaboratorId];
    if (!linha) return;

    const actual = equipaEfetivaNoRascunho(rascunho, linha);
    const destino = alvo === ZONA_DISPONIVEL ? null : alvo;
    if (actual === destino) return;

    setRascunho((prev) => {
      const overrides = { ...prev.overrides };

      // 🔴 Voltar à equipa permanente RETIRA o override, em vez de escrever um
      //    igual. É a diferença entre «sem decisão para este dia» e «decidido
      //    que fica onde já estava» — e é o que faz o dia seguinte comportar-se
      //    como deve.
      if (destino !== null && destino === linha.permanent_team_id) {
        delete overrides[collaboratorId];
      } else {
        overrides[collaboratorId] = destino;
      }

      // A condutora tem de continuar na equipa a que a viatura foi alocada.
      const viaturas = { ...prev.viaturas };
      for (const [teamId, v] of Object.entries(viaturas)) {
        if (v.driverId === collaboratorId && teamId !== destino) {
          viaturas[teamId] = { ...v, driverId: "" };
        }
      }
      return { overrides, viaturas };
    });
  }

  function definirViatura(teamId: string, vehicleId: string) {
    setRascunho((prev) => ({
      ...prev,
      viaturas: { ...prev.viaturas, [teamId]: { vehicleId, driverId: prev.viaturas[teamId]?.driverId ?? "" } },
    }));
  }

  function definirCondutora(teamId: string, driverId: string) {
    setRascunho((prev) => ({
      ...prev,
      viaturas: { ...prev.viaturas, [teamId]: { vehicleId: prev.viaturas[teamId]?.vehicleId ?? "", driverId } },
    }));
  }

  // ── Guardar: UMA transação ────────────────────────────────────────────────

  async function handleSave() {
    if (!dia) return;
    setSaving(true);
    setMessage(null);

    const escrita = rascunhoParaEscrita(rascunho);
    const r = await guardarDiaEquipas({
      companyId,
      date: dia.date,
      expectedSnapshot: dia.snapshot,
      overrides: escrita.overrides,
      viaturas: escrita.viaturas,
    });

    if (!r.ok) {
      // 🔴 Num conflito, o rascunho NÃO se descarta. A pessoa acabou de fazer
      //    o trabalho; o que ela precisa é de ver o que mudou, não de o perder.
      setMessage({
        type: "error",
        text: r.conflito
          ? "Estas alocações foram alteradas por outra pessoa. Atualize para rever antes de guardar."
          : r.error,
      });
      setSaving(false);
      return;
    }

    setInicial(rascunho);
    setDia({ ...dia, snapshot: r.snapshot });
    setMessage({ type: "success", text: "Alocações guardadas." });
    setSaving(false);
    setTimeout(onClose, 900);
  }

  // ── Fechar com alterações por guardar ─────────────────────────────────────

  function tentarFechar() {
    if (sujo) { setConfirmarFecho(true); return; }
    onClose();
  }

  function descartar() {
    setRascunho(inicial);
    setConfirmarFecho(false);
    onClose();
  }

  if (!open) return null;

  const dateLabel = format(selectedDate, "EEEE, d 'de' MMMM", { locale: pt });
  const equipas = dia?.equipas ?? [];

  return (
    <>
      <div className="fixed inset-0 bg-black/40 z-40" onClick={tentarFechar} />
      <div className="fixed inset-0 z-50 flex items-center justify-center p-4">
        <div className="bg-white rounded-xl shadow-2xl w-full max-w-3xl max-h-[90vh] flex flex-col">

          <div className="flex items-center justify-between px-6 py-4 border-b border-[var(--color-border)] shrink-0">
            <div>
              <h2 className="text-base font-semibold text-[var(--color-text-main)]">Alocação de equipas</h2>
              <p className="text-xs text-[var(--color-text-muted)] mt-0.5 capitalize">{dateLabel}</p>
            </div>
            <div className="flex items-center gap-2">
              {sujo && (
                <span
                  data-testid="indicador-por-guardar"
                  className="text-[11px] font-medium text-amber-700 bg-amber-50 border border-amber-200 rounded-full px-2 py-0.5"
                >
                  Alterações por guardar
                </span>
              )}
              <button
                onClick={carregar}
                disabled={loading}
                title="Atualizar"
                className="p-2 rounded-lg border border-[var(--color-border)] text-[var(--color-text-sub)] hover:bg-[var(--color-background)] transition-colors disabled:opacity-50"
              >
                <RefreshCw className={`w-4 h-4 ${loading ? "animate-spin" : ""}`} />
              </button>
              <button
                onClick={tentarFechar}
                aria-label="Fechar"
                className="p-2 rounded-lg text-[var(--color-text-muted)] hover:bg-[var(--color-background)] transition-colors"
              >
                <X className="w-5 h-5" />
              </button>
            </div>
          </div>

          <div className="flex-1 overflow-auto p-6">
            {loading ? (
              <div className="flex items-center justify-center py-16">
                <Loader2 className="w-6 h-6 animate-spin text-[var(--color-primary)]" />
              </div>
            ) : (
              <DndContext sensors={sensors} onDragStart={handleDragStart} onDragEnd={handleDragEnd}>
                <div className="grid grid-cols-1 md:grid-cols-2 gap-6">

                  {/* EQUIPAS */}
                  <div>
                    <h3 className="text-xs font-semibold uppercase tracking-wider text-[var(--color-text-muted)] mb-1">
                      Equipas ({equipas.length})
                    </h3>
                    <p className="text-[11px] text-[var(--color-text-muted)] mb-3">
                      Arrasta à vontade — nada é gravado até carregares em <strong>Guardar alocações</strong>.
                      As mudanças valem só para este dia; a equipa permanente altera-se em Equipas.
                    </p>
                    <div className="space-y-3">
                      {equipas.length === 0 && (
                        <p className="text-sm text-[var(--color-text-muted)] py-4 text-center">
                          Sem equipas configuradas.
                        </p>
                      )}
                      {equipas.map((team) => {
                        const alloc = rascunho.viaturas[team.id];
                        const membros = vista.porEquipa[team.id] ?? [];
                        return (
                          <DroppableColumn
                            key={team.id}
                            id={team.id}
                            className="p-4 rounded-xl border border-[var(--color-border)] bg-[var(--color-background)]"
                          >
                            <div className="flex items-center gap-2 mb-3">
                              <div className="w-3 h-3 rounded-full shrink-0" style={{ backgroundColor: team.color }} />
                              <span className="text-sm font-semibold text-[var(--color-text-main)]">{team.name}</span>
                            </div>

                            <div
                              data-testid={`equipa-${team.id}`}
                              className="flex flex-wrap gap-1.5 mb-3 min-h-[26px]"
                            >
                              {membros.length === 0 ? (
                                <span className="text-xs text-[var(--color-text-muted)]">Largar aqui</span>
                              ) : (
                                membros.map((m) => {
                                  const linha = linhaPorId[m.id];
                                  const deslocada = linha && linha.permanent_team_id !== team.id;
                                  return (
                                    <MemberChip
                                      key={m.id}
                                      member={m}
                                      color={team.color}
                                      fromTeamId={team.id}
                                      badge={deslocada ? "só hoje" : undefined}
                                    />
                                  );
                                })
                              )}
                            </div>

                            <div className="space-y-2">
                              <div className="relative">
                                <Car className="absolute left-2.5 top-1/2 -translate-y-1/2 w-3.5 h-3.5 text-[var(--color-text-muted)] pointer-events-none" />
                                <select
                                  aria-label={`Viatura de ${team.name}`}
                                  value={alloc?.vehicleId ?? ""}
                                  onChange={(e) => definirViatura(team.id, e.target.value)}
                                  className="w-full appearance-none pl-8 pr-8 py-1.5 rounded-lg border border-[var(--color-border)] text-sm text-[var(--color-text-main)] bg-white focus:outline-none focus:ring-2 focus:ring-[var(--color-primary)] focus:border-transparent"
                                >
                                  <option value="">Sem viatura</option>
                                  {(dia?.viaturasDisponiveis ?? []).map((v) => (
                                    <option key={v.id} value={v.id}>{v.model} — {v.plate}</option>
                                  ))}
                                </select>
                                <ChevronDown className="absolute right-2.5 top-1/2 -translate-y-1/2 w-3.5 h-3.5 text-[var(--color-text-muted)] pointer-events-none" />
                              </div>

                              {alloc?.vehicleId && (
                                <div className="relative">
                                  <User className="absolute left-2.5 top-1/2 -translate-y-1/2 w-3.5 h-3.5 text-[var(--color-text-muted)] pointer-events-none" />
                                  <select
                                    aria-label={`Condutora de ${team.name}`}
                                    value={alloc.driverId}
                                    onChange={(e) => definirCondutora(team.id, e.target.value)}
                                    className="w-full appearance-none pl-8 pr-8 py-1.5 rounded-lg border border-[var(--color-border)] text-sm text-[var(--color-text-main)] bg-white focus:outline-none focus:ring-2 focus:ring-[var(--color-primary)] focus:border-transparent"
                                  >
                                    <option value="">Sem condutora definida</option>
                                    {membros.map((m) => (
                                      <option key={m.id} value={m.id}>{m.full_name}</option>
                                    ))}
                                  </select>
                                  <ChevronDown className="absolute right-2.5 top-1/2 -translate-y-1/2 w-3.5 h-3.5 text-[var(--color-text-muted)] pointer-events-none" />
                                </div>
                              )}
                            </div>
                          </DroppableColumn>
                        );
                      })}
                    </div>

                    {(dia?.viaturasDisponiveis ?? []).length === 0 && (
                      <div className="mt-3 p-3 rounded-lg bg-amber-50 border border-amber-200 text-xs text-amber-700">
                        Sem viaturas ativas. Adiciona em <strong>Viaturas</strong> na sidebar.
                      </div>
                    )}
                  </div>

                  <div className="space-y-5">
                    {/* DISPONÍVEL — sempre visível, sempre a aceitar */}
                    <div>
                      <h3 className="text-xs font-semibold uppercase tracking-wider text-[var(--color-text-muted)] mb-2">
                        Disponível ({vista.disponiveis.length})
                      </h3>
                      <DroppableColumn
                        id={ZONA_DISPONIVEL}
                        className="p-3 rounded-xl border border-dashed border-[var(--color-border)] bg-[var(--color-background)] min-h-[84px]"
                      >
                        <div data-testid="zona-disponivel" className="flex flex-wrap gap-1.5">
                          {vista.disponiveis.length === 0 ? (
                            <span className="text-xs text-[var(--color-text-muted)]">
                              Arraste pessoas aqui para deixar em stand by.
                            </span>
                          ) : (
                            vista.disponiveis.map(({ pessoa, standby }) => (
                              <MemberChip
                                key={pessoa.id}
                                member={pessoa}
                                color="#64748b"
                                fromTeamId=""
                                badge={standby ? "stand by hoje" : undefined}
                              />
                            ))
                          )}
                        </div>
                      </DroppableColumn>
                    </div>

                    {/* AUSENTES */}
                    {vista.ausentes.length > 0 && (
                      <div>
                        <h3 className="text-xs font-semibold uppercase tracking-wider text-[var(--color-text-muted)] mb-3">
                          Ausentes ({vista.ausentes.length})
                        </h3>
                        <div className="space-y-1.5" data-testid="zona-ausentes">
                          {vista.ausentes.map(({ pessoa }) => (
                            <div key={pessoa.id} className="flex items-center gap-2 px-3 py-2 rounded-lg bg-red-50 border border-red-100">
                              <div className="w-6 h-6 rounded-full bg-red-200 flex items-center justify-center text-xs font-bold text-red-700 shrink-0">
                                {pessoa.full_name.charAt(0).toUpperCase()}
                              </div>
                              <span className="text-sm text-[var(--color-text-main)] flex-1">{pessoa.full_name}</span>
                              <span className="text-xs text-red-600 font-medium shrink-0">
                                {ABSENCE_LABELS[pessoa.id] ?? "Ausente"}
                              </span>
                            </div>
                          ))}
                        </div>
                      </div>
                    )}
                  </div>
                </div>

                <DragOverlay dropAnimation={null}>
                  {dragging ? (
                    <span
                      className="inline-flex items-center gap-1 pl-1.5 pr-2 py-0.5 rounded-full text-xs font-medium text-white shadow-lg"
                      style={{ backgroundColor: dragging.color }}
                    >
                      <GripVertical className="w-3 h-3 opacity-70 shrink-0" />
                      {dragging.name.split(" ")[0]}
                    </span>
                  ) : null}
                </DragOverlay>
              </DndContext>
            )}
          </div>

          <div className="border-t border-[var(--color-border)] px-6 py-4 flex items-center gap-3 shrink-0">
            {message && (
              <span
                data-testid="mensagem"
                className={`text-sm flex-1 ${
                  message.type === "error" ? "text-red-600"
                  : message.type === "info" ? "text-[var(--color-text-sub)]"
                  : "text-[var(--color-primary)]"
                }`}
              >
                {message.text}
              </span>
            )}
            <div className="ml-auto flex gap-2">
              <button
                onClick={tentarFechar}
                className="px-4 py-2 rounded-lg border border-[var(--color-border)] text-sm font-medium text-[var(--color-text-sub)] hover:bg-[var(--color-background)] transition-colors"
              >
                Fechar
              </button>
              <button
                onClick={handleSave}
                disabled={saving || loading}
                className="flex items-center gap-2 px-4 py-2 rounded-lg bg-[var(--color-primary)] text-white text-sm font-semibold hover:bg-[var(--color-primary-hover)] transition-colors disabled:opacity-50"
              >
                {saving && <Loader2 className="w-4 h-4 animate-spin" />}
                Guardar alocações
              </button>
            </div>
          </div>
        </div>
      </div>

      {/* 🔴 Fechar com alterações por guardar pergunta. Não grava sozinho:
             gravar por omissão é decidir pela pessoa numa operação que mexe
             com onde as colaboradoras vão trabalhar. */}
      {confirmarFecho && (
        <div className="fixed inset-0 z-[60] flex items-center justify-center p-4">
          <div className="fixed inset-0 bg-black/40" onClick={() => setConfirmarFecho(false)} />
          <div className="relative bg-white rounded-xl shadow-2xl w-full max-w-sm p-6" role="dialog" aria-modal="true">
            <h3 className="text-base font-semibold text-[var(--color-text-main)]">
              Descartar alterações não guardadas?
            </h3>
            <p className="text-sm text-[var(--color-text-sub)] mt-2">
              As alterações a este dia ainda não foram gravadas. Se fechar agora, perdem-se.
            </p>
            <div className="mt-5 flex justify-end gap-2">
              <button
                onClick={() => setConfirmarFecho(false)}
                className="px-4 py-2 rounded-lg border border-[var(--color-border)] text-sm font-medium text-[var(--color-text-sub)]"
              >
                Continuar a editar
              </button>
              <button
                onClick={descartar}
                className="px-4 py-2 rounded-lg bg-red-600 text-white text-sm font-semibold"
              >
                Descartar
              </button>
            </div>
          </div>
        </div>
      )}
    </>
  );
}

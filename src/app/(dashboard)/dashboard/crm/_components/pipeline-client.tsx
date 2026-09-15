"use client";

// ============================================================================
// O quadro do funil
// ============================================================================
//
// Arrasto por pointer events, como o Kanban das Tarefas
// (`dashboard/tarefas/_components/tasks-client.tsx`) — e não com `@dnd-kit`,
// que o calendário usa. A razão é a mesma que levou o Kanban a isto: um cartão
// de coluna só precisa de saber sobre que coluna está, e o mecanismo por
// pointer já está provado neste projeto em telemóvel.
//
// Só se move o cartão depois de 8px de deslocamento. Sem esse limiar, um toque
// com o dedo trémulo abre e arrasta ao mesmo tempo.
// ============================================================================

import { useEffect, useRef, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import Link from "next/link";
import { CircleAlert, Plus, TriangleAlert, User } from "lucide-react";

import { useToast } from "@/components/ui/toast";
import {
  LEAD_STAGES,
  LEAD_STAGE_LABELS,
  canTransition,
  type LeadStage,
} from "@/lib/crm/stages";
import { LEAD_SOURCE_LABELS, type LeadSource } from "@/lib/crm/sources";
import { moveLeadStage, reorderLeads, type LeadRow } from "@/app/actions/crm-leads";
import { todayInLisbon } from "@/lib/lisbon-time";

import { LeadSheet } from "./lead-sheet";
import { LostReasonDialog } from "./lost-reason-dialog";

export interface Membro {
  id: string;
  full_name: string;
}

interface Props {
  /** `null` quando a leitura falhou — diferente de uma lista vazia. */
  leads: LeadRow[] | null;
  erro: string | null;
  membros: Membro[];
}

/** Cores de coluna, em Tailwind, por nome de cor do domínio. */
const CORES: Record<string, { barra: string; fundo: string; texto: string }> = {
  slate: { barra: "bg-slate-400", fundo: "bg-slate-50", texto: "text-slate-600" },
  blue: { barra: "bg-blue-500", fundo: "bg-blue-50", texto: "text-blue-700" },
  amber: { barra: "bg-amber-500", fundo: "bg-amber-50", texto: "text-amber-700" },
  violet: { barra: "bg-violet-500", fundo: "bg-violet-50", texto: "text-violet-700" },
  green: { barra: "bg-green-600", fundo: "bg-green-50", texto: "text-green-700" },
  red: { barra: "bg-red-500", fundo: "bg-red-50", texto: "text-red-700" },
};

const COR_POR_ESTADO: Record<LeadStage, keyof typeof CORES> = {
  novo: "slate",
  contactado: "blue",
  visita_agendada: "amber",
  orcamento_enviado: "violet",
  ganho: "green",
  perdido: "red",
};

function fmtEur(v: number | null): string {
  if (v == null) return "—";
  return new Intl.NumberFormat("pt-PT", { style: "currency", currency: "EUR" }).format(v);
}

type DragState = {
  leadId: string;
  origem: LeadStage;
  startX: number;
  startY: number;
  x: number;
  y: number;
  ativo: boolean;
};

export function PipelineClient({ leads, erro, membros }: Props) {
  const router = useRouter();
  const { toast } = useToast();
  const [, startTransition] = useTransition();

  // Cópia local para mover o cartão sem esperar pelo servidor. O servidor
  // continua a ser a autoridade: em erro, repõe-se a lista que veio dele.
  //
  // O acerto é feito durante o render, e não num `useEffect`: um efeito que
  // chama `setState` provoca um segundo render em cascata, e o React
  // desaconselha-o explicitamente. Este padrão é o documentado para ajustar
  // estado quando uma prop muda.
  const [lista, setLista] = useState<LeadRow[]>(leads ?? []);
  const [leadsVistas, setLeadsVistas] = useState(leads);
  if (leads !== leadsVistas) {
    setLeadsVistas(leads);
    setLista(leads ?? []);
  }

  const [drag, setDrag] = useState<DragState | null>(null);
  const [alvo, setAlvo] = useState<LeadStage | null>(null);
  const [aPerder, setAPerder] = useState<
    { lead: LeadRow; destino: LeadStage; origem: LeadStage } | null
  >(null);
  const [aEditar, setAEditar] = useState<LeadRow | null>(null);
  const [aCriar, setACriar] = useState(false);
  const [filtroDono, setFiltroDono] = useState<string>("");

  const dragRef = useRef<DragState | null>(null);
  const alvoRef = useRef<LeadStage | null>(null);
  const arrastouRef = useRef(false);
  const colunasRef = useRef<Map<string, HTMLDivElement>>(new Map());

  const hoje = todayInLisbon();

  const visiveis = filtroDono
    ? lista.filter((l) => (filtroDono === "sem" ? !l.owner_id : l.owner_id === filtroDono))
    : lista;

  function porEstado(stage: LeadStage): LeadRow[] {
    return visiveis
      .filter((l) => l.stage === stage)
      .sort((a, b) => a.board_order - b.board_order
        || b.created_at.localeCompare(a.created_at));
  }

  // ── Arrasto ───────────────────────────────────────────────────────────────

  useEffect(() => {
    function handleMove(e: PointerEvent) {
      const d = dragRef.current;
      if (!d) return;

      const dx = e.clientX - d.startX;
      const dy = e.clientY - d.startY;
      const ativo = d.ativo || Math.sqrt(dx * dx + dy * dy) > 8;

      let sobre: LeadStage | null = null;
      if (ativo) {
        for (const [stage, el] of colunasRef.current) {
          const r = el.getBoundingClientRect();
          if (e.clientX >= r.left && e.clientX <= r.right && e.clientY >= r.top && e.clientY <= r.bottom) {
            sobre = stage as LeadStage;
            break;
          }
        }
      }

      alvoRef.current = sobre;
      setAlvo(sobre);
      const novo = { ...d, x: e.clientX, y: e.clientY, ativo };
      dragRef.current = novo;
      setDrag(novo);
      if (ativo) arrastouRef.current = true;
    }

    function handleUp() {
      const d = dragRef.current;
      const destino = alvoRef.current;
      dragRef.current = null;
      alvoRef.current = null;
      setDrag(null);
      setAlvo(null);

      if (!d || !d.ativo || !destino || destino === d.origem) return;

      const lead = lista.find((l) => l.id === d.leadId);
      if (!lead) return;

      if (!canTransition(d.origem, destino)) {
        toast(
          d.origem === "ganho"
            ? "Esta lead já foi convertida em cliente e não volta ao funil."
            : `Não é possível passar de ${LEAD_STAGE_LABELS[d.origem]} para ${LEAD_STAGE_LABELS[destino]}.`,
          "error",
        );
        return;
      }

      // Perder exige motivo, e a base recusa sem ele. Perguntar antes de
      // gravar evita mostrar um erro técnico a quem só arrastou um cartão.
      if (destino === "perdido") {
        setAPerder({ lead, destino, origem: d.origem });
        return;
      }

      aplicarMudanca(lead, destino, d.origem);
    }

    window.addEventListener("pointermove", handleMove);
    window.addEventListener("pointerup", handleUp);
    window.addEventListener("pointercancel", handleUp);
    return () => {
      window.removeEventListener("pointermove", handleMove);
      window.removeEventListener("pointerup", handleUp);
      window.removeEventListener("pointercancel", handleUp);
    };
    // `lista` entra porque o handler procura a lead nela.
  }, [lista]); // eslint-disable-line react-hooks/exhaustive-deps

  function aplicarMudanca(
    lead: LeadRow,
    destino: LeadStage,
    origem: LeadStage,
    motivo?: { lostReason: string; lostReasonNotes: string | null },
  ) {
    const antes = lista;
    setLista((atual) =>
      atual.map((l) => (l.id === lead.id ? { ...l, stage: destino } : l)),
    );

    startTransition(async () => {
      const res = await moveLeadStage(lead.id, {
        stage: destino,
        // 🔴 De onde o cartão veio, na leitura de quem o arrastou. É o que
        //    permite à base recusar quando outra pessoa já o moveu, em vez de
        //    a segunda escrita apagar a decisão da primeira.
        expectedStage: origem,
        lostReason: motivo?.lostReason as never,
        lostReasonNotes: motivo?.lostReasonNotes,
      });

      if (!res.ok) {
        // O servidor é a autoridade: repõe-se o que ele tinha dado.
        setLista(antes);
        toast(res.error.message, "error");
        return;
      }

      toast(`${lead.name} → ${LEAD_STAGE_LABELS[destino]}`, "success");
      router.refresh();
    });
  }

  /**
   * Guarda a ordem dos cartões de UMA coluna.
   *
   * 🔴 A coluna vai junto: a RPC valida que todos os cartões pertencem mesmo a
   *    ela antes de escrever seja o que for. Sem isso, um pedido com um id de
   *    outra coluna reordenava metade e falhava a meio.
   */
  function guardarOrdem(stage: LeadStage, ids: string[]) {
    startTransition(async () => {
      const res = await reorderLeads(stage, ids.map((leadId, i) => ({ leadId, boardOrder: i })));
      if (!res.ok) toast(res.error.message, "error");
      else router.refresh();
    });
  }

  // ── Estados de erro e vazio ───────────────────────────────────────────────

  if (erro) {
    return (
      <div className="rounded-xl border bg-white p-8 text-center" style={{ borderColor: "var(--color-border)" }}>
        <TriangleAlert className="mx-auto h-8 w-8 text-amber-500" />
        <p className="mt-3 text-sm font-medium">Não foi possível carregar o funil.</p>
        <p className="mt-1 text-[13px]" style={{ color: "var(--color-text-muted)" }}>{erro}</p>
        <button
          onClick={() => router.refresh()}
          className="mt-4 rounded-lg border px-3 py-1.5 text-[13px] font-medium"
          style={{ borderColor: "var(--color-border)" }}
        >
          Tentar de novo
        </button>
      </div>
    );
  }

  return (
    <div>
      {/* ── Barra de acções ── */}
      <div className="mb-4 flex flex-wrap items-center gap-2">
        <button
          onClick={() => setACriar(true)}
          className="flex items-center gap-1.5 rounded-lg px-3 py-2 text-[13px] font-semibold text-white"
          style={{ background: "#16A34A" }}
        >
          <Plus className="h-4 w-4" />
          Nova lead
        </button>

        <select
          value={filtroDono}
          onChange={(e) => setFiltroDono(e.target.value)}
          className="rounded-lg border px-3 py-2 text-[13px]"
          style={{ borderColor: "var(--color-border)" }}
          aria-label="Filtrar por responsável"
        >
          <option value="">Todos os responsáveis</option>
          <option value="sem">Sem responsável</option>
          {membros.map((m) => (
            <option key={m.id} value={m.id}>{m.full_name}</option>
          ))}
        </select>

        <span className="ml-auto text-[13px]" style={{ color: "var(--color-text-muted)" }}>
          {visiveis.length} {visiveis.length === 1 ? "lead" : "leads"}
        </span>
      </div>

      {/* ── O quadro ── */}
      <div className="flex gap-3 overflow-x-auto pb-4">
        {LEAD_STAGES.map((stage) => {
          const cor = CORES[COR_POR_ESTADO[stage]];
          const cartoes = porEstado(stage);
          const podeReceber = drag ? canTransition(drag.origem, stage) : true;
          const emAlvo = alvo === stage && podeReceber && drag?.origem !== stage;

          const total = cartoes.reduce((s, l) => s + (l.estimated_value ?? 0), 0);

          return (
            <div
              key={stage}
              ref={(el) => {
                if (el) colunasRef.current.set(stage, el);
                else colunasRef.current.delete(stage);
              }}
              className={`flex min-h-[320px] w-[260px] shrink-0 flex-col rounded-xl border transition-colors ${
                emAlvo ? "ring-2 ring-green-500/40" : ""
              } ${drag?.ativo && !podeReceber ? "opacity-40" : ""}`}
              style={{
                borderColor: "var(--color-border)",
                background: "var(--color-background)",
              }}
            >
              <div
                className="flex items-center gap-2 rounded-t-xl border-b bg-white px-3 py-2.5"
                style={{ borderColor: "var(--color-border)" }}
              >
                <span className={`h-4 w-1 rounded-full ${cor.barra}`} aria-hidden />
                <span className="flex-1 truncate text-[13px] font-semibold">
                  {LEAD_STAGE_LABELS[stage]}
                </span>
                <span
                  className={`rounded-full px-1.5 py-0.5 text-[11px] font-semibold ${cor.fundo} ${cor.texto}`}
                >
                  {cartoes.length}
                </span>
              </div>

              {total > 0 && (
                <div
                  className="border-b bg-white px-3 py-1.5 text-[11px]"
                  style={{ borderColor: "var(--color-border)", color: "var(--color-text-muted)" }}
                >
                  {fmtEur(total)} estimado
                </div>
              )}

              <div className="flex flex-1 flex-col gap-2 p-2.5">
                {cartoes.length === 0 ? (
                  <div
                    className="flex flex-1 items-center justify-center rounded-lg border border-dashed p-4 text-center text-[12px]"
                    style={{ borderColor: "var(--color-border)", color: "var(--color-text-muted)" }}
                  >
                    Sem leads
                  </div>
                ) : (
                  cartoes.map((lead, i) => (
                    <LeadCard
                      key={lead.id}
                      lead={lead}
                      hoje={hoje}
                      aArrastar={drag?.ativo === true && drag.leadId === lead.id}
                      onPointerDown={(e) => {
                        arrastouRef.current = false;
                        const d: DragState = {
                          leadId: lead.id,
                          origem: stage,
                          startX: e.clientX,
                          startY: e.clientY,
                          x: e.clientX,
                          y: e.clientY,
                          ativo: false,
                        };
                        dragRef.current = d;
                        setDrag(d);
                      }}
                      onAbrir={() => {
                        // Um clique que arrastou não é um clique.
                        if (arrastouRef.current) return;
                        setAEditar(lead);
                      }}
                      onSubir={
                        i === 0
                          ? undefined
                          : () => {
                              const ids = cartoes.map((c) => c.id);
                              [ids[i - 1], ids[i]] = [ids[i], ids[i - 1]];
                              setLista((atual) =>
                                atual.map((l) => {
                                  const pos = ids.indexOf(l.id);
                                  return pos === -1 ? l : { ...l, board_order: pos };
                                }),
                              );
                              guardarOrdem(stage, ids);
                            }
                      }
                    />
                  ))
                )}
              </div>
            </div>
          );
        })}
      </div>

      {/* ── Cartão a acompanhar o dedo ── */}
      {drag?.ativo && (
        <div
          className="pointer-events-none fixed z-50 w-[240px] rounded-lg border bg-white p-2.5 shadow-lg"
          style={{
            left: drag.x - 120,
            top: drag.y - 24,
            borderColor: "var(--color-border)",
          }}
        >
          <span className="text-[13px] font-medium">
            {lista.find((l) => l.id === drag.leadId)?.name}
          </span>
        </div>
      )}

      {aPerder && (
        <LostReasonDialog
          leadName={aPerder.lead.name}
          onCancel={() => setAPerder(null)}
          onConfirm={(motivo, notas) => {
            const { lead, destino, origem } = aPerder;
            setAPerder(null);
            aplicarMudanca(lead, destino, origem, { lostReason: motivo, lostReasonNotes: notas });
          }}
        />
      )}

      {(aCriar || aEditar) && (
        <LeadSheet
          lead={aEditar}
          membros={membros}
          onClose={() => {
            setACriar(false);
            setAEditar(null);
          }}
        />
      )}
    </div>
  );
}

// ── Cartão ────────────────────────────────────────────────────────────────

function LeadCard({
  lead,
  hoje,
  aArrastar,
  onPointerDown,
  onAbrir,
  onSubir,
}: {
  lead: LeadRow;
  hoje: string;
  aArrastar: boolean;
  onPointerDown: (e: React.PointerEvent) => void;
  onAbrir: () => void;
  onSubir?: () => void;
}) {
  // Uma próxima acção com data passada é uma lead esquecida. É o único aviso
  // do cartão, e é por isso que se vê de longe.
  const atrasada = lead.next_action_at != null && lead.next_action_at < hoje;

  return (
    <div
      onPointerDown={onPointerDown}
      onClick={onAbrir}
      className={`cursor-grab rounded-lg border bg-white p-2.5 transition-all active:cursor-grabbing ${
        aArrastar ? "scale-95 opacity-40" : "hover:shadow-md"
      }`}
      style={{ borderColor: atrasada ? "#F59E0B" : "var(--color-border)" }}
    >
      <div className="flex items-start gap-1.5">
        <span className="flex-1 text-[13px] font-medium leading-snug">{lead.name}</span>
        {onSubir && (
          <button
            onClick={(e) => {
              e.stopPropagation();
              onSubir();
            }}
            onPointerDown={(e) => e.stopPropagation()}
            title="Subir na coluna"
            aria-label={`Subir ${lead.name} na coluna`}
            className="shrink-0 rounded px-1 text-[11px] leading-none"
            style={{ color: "var(--color-text-muted)" }}
          >
            ▲
          </button>
        )}
      </div>

      {lead.contact_name && (
        <p className="mt-0.5 truncate text-[11.5px]" style={{ color: "var(--color-text-muted)" }}>
          {lead.contact_name}
        </p>
      )}

      <div className="mt-2 flex flex-wrap items-center gap-1.5 text-[11px]">
        {lead.estimated_value != null && (
          <span className="rounded bg-slate-100 px-1.5 py-0.5 font-medium text-slate-700">
            {fmtEur(lead.estimated_value)}
            {lead.estimated_value_kind === "mensal" ? "/mês" : ""}
          </span>
        )}
        {lead.source && (
          <span className="rounded bg-slate-50 px-1.5 py-0.5" style={{ color: "var(--color-text-muted)" }}>
            {LEAD_SOURCE_LABELS[lead.source as LeadSource] ?? lead.source}
          </span>
        )}
      </div>

      {lead.next_action_at && (
        <p
          className={`mt-2 flex items-center gap-1 text-[11px] ${atrasada ? "font-semibold text-amber-600" : ""}`}
          style={atrasada ? undefined : { color: "var(--color-text-muted)" }}
        >
          {atrasada && <CircleAlert className="h-3 w-3 shrink-0" />}
          {lead.next_action_note || "Próxima ação"} · {lead.next_action_at}
        </p>
      )}

      <div className="mt-2 flex items-center justify-between">
        <span
          className="flex items-center gap-1 text-[11px]"
          style={{ color: "var(--color-text-muted)" }}
        >
          <User className="h-3 w-3" />
          {lead.owner_name ?? "Sem responsável"}
        </span>
        <Link
          href={`/dashboard/crm/${lead.id}`}
          onClick={(e) => e.stopPropagation()}
          onPointerDown={(e) => e.stopPropagation()}
          className="text-[11px] font-medium"
          style={{ color: "#16A34A" }}
        >
          Abrir
        </Link>
      </div>
    </div>
  );
}

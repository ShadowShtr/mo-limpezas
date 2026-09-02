"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { AlertCircle, CalendarDays, Loader2, RefreshCw, UserRoundX } from "lucide-react";
import { carregarDiaEspelho } from "@/app/actions/equipas-dia-espelho";
import type { DiaAlocacoes, LinhaEfetiva } from "@/lib/equipas/tipos";
import { absenceDisplay, type AusenciaDia } from "@/lib/equipas/ausencias";

interface Props {
  companyId: string;
  initialDate: string;
}

type DiaEspelho = DiaAlocacoes & { ausencias: AusenciaDia[] };

export function EquipasDiaEfetivo({ companyId, initialDate }: Props) {
  const [date, setDate] = useState(initialDate);
  const [dia, setDia] = useState<DiaEspelho | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  // ═══════════════════════════════════════════════════════════════════════
  // 🔴 SÓ O PEDIDO MAIS RECENTE PODE ESCREVER ESTADO
  // ═══════════════════════════════════════════════════════════════════════
  //
  //    `clearTimeout` no cleanup do efeito só cancela um `load` que ainda não
  //    começou. Depois de `carregarDiaEspelho(A)` partir, mudar de A para B
  //    deixa dois pedidos em voo, e a rede não promete ordem:
  //
  //        pede A → pede B → responde B → setDia(B) → responde A → setDia(A)
  //
  //    O ecrã ficava com a composição de A por baixo de um input a dizer B.
  //    Era exactamente o estado stale que esta vista existe para não ter.
  //
  //    O contador é monotónico e vive num ref, fora do ciclo de render: cada
  //    chamada leva o seu número, e ao voltar compara-se com o último emitido.
  //    Uma resposta obsoleta não toca em `dia`, `error` nem `loading` — nem
  //    sequer para desligar o spinner, senão o ecrã dir-se-ia carregado
  //    enquanto o pedido bom ainda vinha a caminho.
  //
  //    Fica no `load`, e não dentro do efeito, de propósito: o botão Atualizar
  //    chama o mesmo `load`. Uma flag local ao efeito deixava o refresh manual
  //    a competir na mesma, que é metade do defeito por corrigir.
  const ultimoPedido = useRef(0);

  const load = useCallback(async (target: string) => {
    const pedido = ultimoPedido.current + 1;
    ultimoPedido.current = pedido;
    setLoading(true);

    const result = await carregarDiaEspelho(companyId, target);
    if (pedido !== ultimoPedido.current) return;

    if (result.ok) {
      setDia(result.dia);
      setError(null);
    } else {
      setDia(null);
      setError(result.error);
    }
    setLoading(false);
  }, [companyId]);

  useEffect(() => {
    const timer = window.setTimeout(() => { void load(date); }, 0);
    return () => window.clearTimeout(timer);
  }, [date, load]);

  // Desmontar invalida o que estiver em voo: a resposta que chegar depois já
  // não tem ecrã onde aterrar.
  useEffect(() => () => { ultimoPedido.current += 1; }, []);

  const personById = new Map((dia?.pessoas ?? []).map((person) => [person.id, person]));
  const effective = dia?.efetiva ?? [];
  const absent = effective.filter((line) => line.ausente);
  const available = effective.filter((line) => !line.ausente && line.effective_team_id === null);

  return (
    <section className="mb-6 rounded-xl border border-[var(--color-border)] bg-white p-5">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <div className="flex items-center gap-2">
            <CalendarDays className="h-4 w-4 text-[var(--color-primary)]" />
            <h2 className="text-sm font-semibold text-[var(--color-text-main)]">Equipa efetiva do dia</h2>
          </div>
          <p className="mt-1 text-xs text-[var(--color-text-muted)]">
            Espelho do Calendário: decisão diária tem prioridade; sem decisão diária vale a equipa permanente.
          </p>
        </div>
        <div className="flex items-center gap-2">
          <input type="date" value={date} onChange={(event) => setDate(event.target.value)} className="rounded-lg border border-[var(--color-border)] px-3 py-2 text-sm" />
          <button disabled={loading} onClick={() => void load(date)} className="rounded-lg border p-2 disabled:opacity-50" aria-label="Atualizar composição efetiva">
            {loading ? <Loader2 className="h-4 w-4 animate-spin" /> : <RefreshCw className="h-4 w-4" />}
          </button>
        </div>
      </div>

      {error && (
        <div className="mt-4 flex items-center gap-2 rounded-lg border border-red-200 bg-red-50 p-3 text-sm text-red-800">
          <AlertCircle className="h-4 w-4" /> {error}
        </div>
      )}

      {dia && (
        <div className="mt-5 grid gap-3 md:grid-cols-2 xl:grid-cols-3">
          {dia.equipas.map((team) => {
            const lines = effective.filter((line) => !line.ausente && line.effective_team_id === team.id);
            return (
              <TeamDayCard key={team.id} title={team.name} color={team.color} lines={lines} personById={personById} />
            );
          })}

          <TeamDayCard title="Disponível" color="#94A3B8" lines={available} personById={personById} />

          <div className="rounded-xl border border-amber-200 bg-amber-50/60 p-4">
            <div className="flex items-center gap-2">
              <UserRoundX className="h-4 w-4 text-amber-700" />
              <h3 className="text-sm font-semibold text-amber-900">Ausentes ({absent.length})</h3>
            </div>
            <div className="mt-3 space-y-2">
              {absent.length === 0 && <p className="text-xs text-amber-800/70">Sem ausências nesta data.</p>}
              {absent.map((line) => {
                const person = personById.get(line.collaborator_id);
                const absence = dia.ausencias.find((item) => item.collaborator_id === line.collaborator_id);
                const display = absence ? absenceDisplay(absence) : null;
                return (
                  <div key={line.collaborator_id} className="rounded-lg bg-white/80 px-3 py-2">
                    <p className="text-xs font-semibold text-[var(--color-text-main)]">{person?.full_name ?? "Colaborador"}</p>
                    <p className="mt-0.5 text-[11px] text-[var(--color-text-muted)]">
                      {display
                        ? `${display.typeLabel} · Saída ${display.departureLabel} · Regresso ${display.returnLabel}`
                        : "Ausente"}
                    </p>
                  </div>
                );
              })}
            </div>
          </div>
        </div>
      )}
    </section>
  );
}

function TeamDayCard({
  title,
  color,
  lines,
  personById,
}: {
  title: string;
  color: string;
  lines: LinhaEfetiva[];
  personById: Map<string, { id: string; full_name: string; avatar_url: string | null }>;
}) {
  return (
    <div className="overflow-hidden rounded-xl border border-[var(--color-border)] bg-white">
      <div className="h-1" style={{ backgroundColor: color }} />
      <div className="p-4">
        <h3 className="text-sm font-semibold">{title} <span className="font-normal text-[var(--color-text-muted)]">({lines.length})</span></h3>
        <div className="mt-3 space-y-2">
          {lines.length === 0 && <p className="text-xs text-[var(--color-text-muted)]">Sem pessoas.</p>}
          {lines.map((line) => {
            const person = personById.get(line.collaborator_id);
            const override = line.origem === "override_team" || line.origem === "override_standby";
            return (
              <div key={line.collaborator_id} className="flex items-center justify-between rounded-lg bg-[var(--color-background)] px-3 py-2">
                <span className="text-xs font-medium">{person?.full_name ?? "Colaborador"}</span>
                <span className={`text-[10px] rounded-full px-2 py-0.5 ${override ? "bg-violet-100 text-violet-700" : "bg-slate-100 text-slate-600"}`}>
                  {override ? "Só neste dia" : line.origem === "permanent" ? "Permanente" : "Sem equipa"}
                </span>
              </div>
            );
          })}
        </div>
      </div>
    </div>
  );
}

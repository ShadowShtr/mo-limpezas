// ============================================================================
// Painéis de inteligência — segunda e terceira linhas do Resumo
// ============================================================================
//
// Previsão de caixa · Atrasos por faixa · Top clientes
// Receita por serviço · Eficiência da equipa
//
// 🔴 Quatro destes cinco **ainda não têm fonte** no backend actual. Ficam
//    estruturalmente completos e em `indisponivel`, que é a razão de existirem
//    já: quando a PR B ligar o pipeline canónico, troca-se a fonte e o desenho
//    fica como está.
//
//    A alternativa — enchê-los com zeros ou com números plausíveis para o ecrã
//    ficar igual à referência — produziria uma página que parece pronta e
//    mente. Um dashboard financeiro que mente é pior do que um incompleto,
//    porque ninguém desconfia dele.
// ============================================================================

"use client";

import type { ReactNode } from "react";
import { Gauge, PieChart, ReceiptText, UsersRound } from "lucide-react";

import { FinanceCard, IconCircle, SectionHeader } from "./finance-card";
import { RenderSlot, Skeleton, VazioCompacto, type Slot } from "./visual-contract";
import { fmtEur, fmtEurCompact } from "@/lib/finance-format";

// ─── Previsão de caixa ───────────────────────────────────────────────────────

export interface PrevisaoCaixa {
  /** Pontos da curva; `futuro` desenha-se a tracejado. */
  pontos: { label: string; valor: number; futuro: boolean }[];
  marcos: { label: string; valor: number }[];
}

export function FinanceCashForecast({ slot }: { slot: Slot<PrevisaoCaixa> }) {
  return (
    <FinanceCard className="h-full">
      <SectionHeader title="Previsão de caixa" />
      <RenderSlot
        slot={slot}
        esqueleto={<Skeleton h={120} />}
      >
        {(d) => {
          if (d.pontos.length === 0) return <VazioCompacto texto="Sem dados para projetar." />;
          const W = 320, H = 96;
          const max = Math.max(...d.pontos.map((p) => p.valor), 1);
          const min = Math.min(...d.pontos.map((p) => p.valor), 0);
          const x = (i: number) => (i * W) / Math.max(d.pontos.length - 1, 1);
          const y = (v: number) => H - ((v - min) / Math.max(max - min, 1)) * (H - 12) - 6;

          const solidos = d.pontos.filter((p) => !p.futuro);
          const idxCorte = solidos.length - 1;
          const linha = (pts: typeof d.pontos, desde: number) =>
            pts.map((p, k) => `${k === 0 ? "M" : "L"} ${x(desde + k)} ${y(p.valor)}`).join(" ");

          return (
            <>
              <svg viewBox={`0 0 ${W} ${H}`} className="w-full" style={{ height: 104 }} aria-hidden>
                <defs>
                  <linearGradient id="grad-forecast" x1="0" y1="0" x2="0" y2="1">
                    <stop offset="0%" stopColor="rgba(101,88,245,.14)" />
                    <stop offset="100%" stopColor="rgba(101,88,245,0)" />
                  </linearGradient>
                </defs>
                {solidos.length > 1 && (
                  <path
                    d={`${linha(solidos, 0)} L ${x(idxCorte)} ${H} L 0 ${H} Z`}
                    fill="url(#grad-forecast)"
                  />
                )}
                {solidos.length > 1 && (
                  <path d={linha(solidos, 0)} fill="none" stroke="#6558F5" strokeWidth="2.25" strokeLinecap="round" />
                )}
                {/* O futuro a tracejado — a diferença entre medido e estimado
                    tem de se ver, não se explicar numa legenda. */}
                {idxCorte >= 0 && d.pontos.length > solidos.length && (
                  <path
                    d={linha(d.pontos.slice(Math.max(idxCorte, 0)), Math.max(idxCorte, 0))}
                    fill="none"
                    stroke="#6558F5"
                    strokeWidth="2.25"
                    strokeDasharray="5 4"
                    strokeLinecap="round"
                  />
                )}
                {d.pontos.map((p, i) => (
                  <circle key={i} cx={x(i)} cy={y(p.valor)} r="3.5" fill="#fff" stroke="#6558F5" strokeWidth="2" />
                ))}
              </svg>

              <div className="mt-3 flex items-stretch">
                {d.marcos.map((m, i) => (
                  <div
                    key={m.label}
                    className={`flex-1 px-2 ${i > 0 ? "border-l border-[var(--finance-divider)]" : ""}`}
                  >
                    <p className="text-[11px] text-[var(--finance-text-muted)]">{m.label}</p>
                    <p className="text-[13px] font-semibold text-[var(--finance-text)] tabular-nums truncate">
                      {fmtEurCompact(m.valor)}
                    </p>
                  </div>
                ))}
              </div>
            </>
          );
        }}
      </RenderSlot>
    </FinanceCard>
  );
}

// ─── Atrasos por faixa ───────────────────────────────────────────────────────

export interface FaixaAging {
  label: string;
  valor: number;
}

/**
 * Aging.
 *
 * Existe para distinguir dívida recente de dívida antiga — «€ 3.420 vencido»
 * não diz se é de ontem ou de há três meses, e a acção é completamente
 * diferente nos dois casos.
 */
export function FinanceAging({ slot }: { slot: Slot<FaixaAging[]> }) {
  return (
    <FinanceCard className="h-full">
      <SectionHeader title="Atrasos por faixa" />
      <RenderSlot slot={slot} esqueleto={<Skeleton h={120} />}>
        {(faixas) => {
          if (faixas.length === 0) return <VazioCompacto texto="Nada vencido." />;
          const max = Math.max(...faixas.map((f) => f.valor), 1);
          return (
            <div className="space-y-3">
              {faixas.map((f) => (
                <div key={f.label} className="flex items-center gap-3">
                  <span className="w-[68px] shrink-0 text-[12px] text-[var(--finance-text-secondary)]">
                    {f.label}
                  </span>
                  <span className="flex-1 h-2 rounded-full bg-[var(--finance-track)] overflow-hidden">
                    <span
                      className="block h-2 rounded-full bg-[var(--finance-orange)]"
                      style={{ width: `${Math.max((f.valor / max) * 100, f.valor > 0 ? 3 : 0)}%` }}
                    />
                  </span>
                  <span className="w-[76px] shrink-0 text-right text-[12.5px] font-semibold text-[var(--finance-text)] tabular-nums">
                    {fmtEurCompact(f.valor)}
                  </span>
                </div>
              ))}
            </div>
          );
        }}
      </RenderSlot>
    </FinanceCard>
  );
}

// ─── Top clientes ────────────────────────────────────────────────────────────

export interface ClienteRank {
  id: string;
  nome: string;
  valor: number;
}

export function FinanceTopClients({
  slot,
  metrica,
  hrefDe,
}: {
  slot: Slot<ClienteRank[]>;
  metrica?: string;
  /**
   * Para onde vai um clique num cliente.
   *
   * Sem isto, o ranking é informação morta: mostra quem fatura mais e obriga a
   * ir procurar o detalhe noutro sítio. Com isto, leva ao histórico desse
   * cliente — sem duplicar informação nenhuma.
   */
  hrefDe?: (c: ClienteRank) => string;
}) {
  return (
    <FinanceCard className="h-full">
      <SectionHeader title="Top clientes" hint={metrica} />
      <RenderSlot slot={slot} esqueleto={<Skeleton h={120} />}>
        {(cs) => {
          if (cs.length === 0) return <VazioCompacto texto="Sem faturação registada." />;
          const max = Math.max(...cs.map((c) => c.valor), 1);
          return (
            <div className="space-y-3">
              {cs.map((c, i) => {
                const conteudo = (
                <div className="flex items-center gap-3">
                  <span
                    className="w-[22px] h-[22px] shrink-0 rounded-full inline-flex items-center justify-center text-[11px] font-semibold tabular-nums"
                    style={{ background: "var(--finance-primary-soft)", color: "var(--finance-primary)" }}
                  >
                    {i + 1}
                  </span>
                  <div className="flex-1 min-w-0">
                    <div className="flex items-baseline justify-between gap-2 mb-1.5">
                      <p className="text-[12.5px] text-[var(--finance-text)] truncate">{c.nome}</p>
                      <p className="text-[12.5px] font-semibold text-[var(--finance-text)] shrink-0 tabular-nums">
                        {fmtEurCompact(c.valor)}
                      </p>
                    </div>
                    <span className="block h-1.5 rounded-full bg-[var(--finance-track)] overflow-hidden">
                      <span
                        className="block h-1.5 rounded-full"
                        style={{ width: `${Math.max((c.valor / max) * 100, 2)}%`, background: "#7467F6" }}
                      />
                    </span>
                  </div>
                </div>
                );

                const href = hrefDe?.(c);
                return href ? (
                  <a
                    key={c.id}
                    href={href}
                    className="block -mx-2 px-2 py-1 rounded-[10px] transition-colors hover:bg-[var(--finance-surface-soft)]"
                  >
                    {conteudo}
                  </a>
                ) : (
                  <div key={c.id}>{conteudo}</div>
                );
              })}
            </div>
          );
        }}
      </RenderSlot>
    </FinanceCard>
  );
}

// ─── Receita por serviço ─────────────────────────────────────────────────────

export interface FatiaServico {
  nome: string;
  valor: number;
  cor: string;
}

export function FinanceRevenueByService({
  slot,
  titulo = "Receita por serviço",
}: {
  slot: Slot<FatiaServico[]>;
  /** O mesmo donut serve receita por serviço e despesas por categoria. */
  titulo?: string;
}) {
  return (
    <FinanceCard className="h-full">
      <SectionHeader title={titulo} />
      <RenderSlot slot={slot} esqueleto={<Skeleton h={150} />}>
        {(fatias) => {
          const total = fatias.reduce((s, f) => s + f.valor, 0);
          if (total <= 0) return <VazioCompacto texto="Sem receita classificada." />;

          const R = 54, r = 33, C = 64;
          let acc = 0;
          const arcos = fatias.map((f) => {
            const frac = f.valor / total;
            const a0 = acc * 2 * Math.PI - Math.PI / 2;
            acc += frac;
            const a1 = acc * 2 * Math.PI - Math.PI / 2;
            const grande = frac > 0.5 ? 1 : 0;
            const p = (ang: number, raio: number) =>
              `${C + raio * Math.cos(ang)} ${C + raio * Math.sin(ang)}`;
            return {
              ...f,
              frac,
              d: `M ${p(a0, R)} A ${R} ${R} 0 ${grande} 1 ${p(a1, R)} L ${p(a1, r)} A ${r} ${r} 0 ${grande} 0 ${p(a0, r)} Z`,
            };
          });

          return (
            <div className="flex items-center gap-5 flex-wrap">
              <svg viewBox="0 0 128 128" style={{ width: 128, height: 128 }} className="shrink-0" aria-hidden>
                {arcos.map((a) => (
                  <path key={a.nome} d={a.d} fill={a.cor} stroke="#fff" strokeWidth="2" />
                ))}
              </svg>
              <div className="flex-1 min-w-[150px] space-y-2">
                {arcos.map((a) => (
                  <div key={a.nome} className="flex items-center gap-2">
                    <span className="w-2 h-2 rounded-full shrink-0" style={{ background: a.cor }} />
                    <span className="flex-1 text-[12.5px] text-[var(--finance-text-secondary)] truncate">{a.nome}</span>
                    <span className="text-[12.5px] font-semibold text-[var(--finance-text)] tabular-nums">
                      {(a.frac * 100).toLocaleString("pt-PT", { maximumFractionDigits: 0 })}%
                    </span>
                  </div>
                ))}
              </div>
            </div>
          );
        }}
      </RenderSlot>
    </FinanceCard>
  );
}

// ─── Eficiência da equipa ────────────────────────────────────────────────────

export interface BlocoEficiencia {
  chave: "receita-hora" | "custo-hora" | "margem-hora" | "utilizacao";
  label: string;
  valor: string;
}

const ICONES_EFICIENCIA: Record<BlocoEficiencia["chave"], { icon: ReactNode; bg: string; fg: string }> = {
  "receita-hora": { icon: <UsersRound className="w-4 h-4" />,  bg: "var(--finance-primary-soft)", fg: "var(--finance-primary)" },
  "custo-hora":   { icon: <ReceiptText className="w-4 h-4" />, bg: "var(--finance-orange-soft)",  fg: "var(--finance-orange)" },
  "margem-hora":  { icon: <PieChart className="w-4 h-4" />,    bg: "var(--finance-primary-soft)", fg: "var(--finance-primary)" },
  "utilizacao":   { icon: <Gauge className="w-4 h-4" />,       bg: "var(--finance-green-soft)",   fg: "var(--finance-green)" },
};

export function FinanceTeamEfficiency({ slot }: { slot: Slot<BlocoEficiencia[]> }) {
  return (
    <FinanceCard className="h-full">
      <SectionHeader title="Eficiência da equipa" />
      <RenderSlot slot={slot} esqueleto={<Skeleton h={90} />}>
        {(blocos) => (
          <div className="flex flex-wrap sm:flex-nowrap items-stretch">
            {blocos.map((b, i) => {
              const ic = ICONES_EFICIENCIA[b.chave];
              return (
                <div
                  key={b.chave}
                  className={`flex-1 min-w-[130px] px-4 py-1 ${i > 0 ? "sm:border-l border-[var(--finance-divider)]" : ""}`}
                >
                  <IconCircle bg={ic.bg} fg={ic.fg} size={32}>{ic.icon}</IconCircle>
                  <p className="mt-2 text-[11.5px] text-[var(--finance-text-muted)]">{b.label}</p>
                  <p className="text-[17px] font-bold text-[var(--finance-text)] tabular-nums">{b.valor}</p>
                </div>
              );
            })}
          </div>
        )}
      </RenderSlot>
    </FinanceCard>
  );
}

export { fmtEur };

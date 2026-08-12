// ============================================================================
// Gráfico principal — o elemento dominante do Resumo
// ============================================================================
//
// SVG à mão, sem dependência nova. O projecto não tem biblioteca de gráficos
// (todos os existentes são SVG), e acrescentar uma a meio de um ramo de
// apresentação traria meio megabyte de bundle e risco de build para resolver
// um problema que cabe em duzentas linhas.
//
// ---------------------------------------------------------------------------
// VISUAL CONTRACT ≠ DATA CONTRACT
// ---------------------------------------------------------------------------
// Este componente não sabe se a série é diária ou mensal, e é de propósito.
// Recebe pontos com um rótulo e até três valores. Hoje recebe os 12 meses que
// a fonte legada fornece; quando a PR B ligar a série diária, **muda a fonte,
// não o desenho**.
//
// 🔴 O que ele nunca faz é inventar. Sem série, mostra-se indisponível — não
//    se desenha uma linha em zero, que pareceria um mês sem faturação.
// ============================================================================

"use client";

import { useState } from "react";

import { FinanceCard, SectionHeader } from "./finance-card";
import { RenderSlot, Skeleton, type Slot } from "./visual-contract";
import { fmtEur } from "@/lib/finance-format";

export interface PontoSerie {
  label: string;
  faturado: number | null;
  recebido: number | null;
  despesas: number | null;
}

export const SERIES = [
  { chave: "faturado" as const, nome: "Faturado", cor: "#6558F5", fill: "rgba(101,88,245,.12)" },
  { chave: "recebido" as const, nome: "Recebido", cor: "#16A35A", fill: "rgba(22,163,90,.08)" },
  { chave: "despesas" as const, nome: "Despesas", cor: "#FF6B1A", fill: "rgba(255,107,26,.08)" },
];

const H = 240;
const PAD_T = 12;
const PAD_B = 26;
const PAD_L = 52;

function eixoY(max: number): number[] {
  if (max <= 0) return [0];
  const passo = Math.pow(10, Math.floor(Math.log10(max)));
  const bruto = Math.ceil(max / passo) * passo;
  const n = 4;
  return Array.from({ length: n + 1 }, (_, i) => (bruto / n) * i);
}

function rotuloY(v: number): string {
  if (v === 0) return "0 €";
  if (v >= 1000) return `${(v / 1000).toLocaleString("pt-PT", { maximumFractionDigits: 0 })} mil €`;
  return `${v.toLocaleString("pt-PT", { maximumFractionDigits: 0 })} €`;
}

/** Curva suave que não ultrapassa os pontos (monótona por troços). */
function caminhoSuave(pts: { x: number; y: number }[]): string {
  if (pts.length === 0) return "";
  if (pts.length === 1) return `M ${pts[0].x} ${pts[0].y}`;
  let d = `M ${pts[0].x} ${pts[0].y}`;
  for (let i = 0; i < pts.length - 1; i++) {
    const p0 = pts[Math.max(i - 1, 0)];
    const p1 = pts[i];
    const p2 = pts[i + 1];
    const p3 = pts[Math.min(i + 2, pts.length - 1)];
    const c1x = p1.x + (p2.x - p0.x) / 6;
    const c1y = p1.y + (p2.y - p0.y) / 6;
    const c2x = p2.x - (p3.x - p1.x) / 6;
    const c2y = p2.y - (p3.y - p1.y) / 6;
    d += ` C ${c1x} ${c1y}, ${c2x} ${c2y}, ${p2.x} ${p2.y}`;
  }
  return d;
}

export function FinanceMainChart({
  titulo = "Evolução financeira do mês",
  hint,
  slot,
  seletor,
}: {
  titulo?: string;
  hint?: string;
  slot: Slot<PontoSerie[]>;
  /** Ex.: "Mês" ou "Dia" — descreve a granularidade **real** da série. */
  seletor?: string;
}) {
  const [hover, setHover] = useState<number | null>(null);

  return (
    <FinanceCard className="h-full">
      <SectionHeader
        title={titulo}
        hint={hint}
        right={
          <div className="flex items-center gap-3">
            <div className="hidden md:flex items-center gap-3 text-[11px] text-[var(--finance-text-secondary)]">
              {SERIES.map((s) => (
                <span key={s.chave} className="flex items-center gap-1.5">
                  <span className="w-3 h-[2.5px] rounded-full inline-block" style={{ background: s.cor }} />
                  {s.nome}
                </span>
              ))}
            </div>
            {seletor && (
              <span className="px-2.5 py-1 rounded-[10px] border border-[var(--finance-border)] text-[11.5px] font-medium text-[var(--finance-text-secondary)]">
                {seletor}
              </span>
            )}
          </div>
        }
      />

      <RenderSlot slot={slot} esqueleto={<Skeleton h={H} />}>
        {(pontos) => {
          if (pontos.length === 0) {
            return (
              <p className="py-16 text-center text-[13px] text-[var(--finance-text-muted)]">
                Sem movimentos neste período.
              </p>
            );
          }

          const W = Math.max(pontos.length * 56 + PAD_L, 520);
          const max = Math.max(
            ...pontos.flatMap((p) => [p.faturado ?? 0, p.recebido ?? 0, p.despesas ?? 0]),
            1,
          );
          const ticks = eixoY(max);
          const topo = ticks[ticks.length - 1] || 1;

          const x = (i: number) =>
            PAD_L + (pontos.length === 1 ? (W - PAD_L) / 2 : (i * (W - PAD_L - 16)) / (pontos.length - 1)) + 8;
          const y = (v: number) => PAD_T + (H - PAD_T - PAD_B) * (1 - v / topo);

          return (
            <div className="overflow-x-auto -mx-1 px-1">
              <svg
                viewBox={`0 0 ${W} ${H}`}
                className="w-full"
                style={{ minWidth: 520, height: 296 }}
                role="img"
                aria-label={titulo}
                onMouseLeave={() => setHover(null)}
              >
                <defs>
                  {SERIES.map((s) => (
                    <linearGradient key={s.chave} id={`grad-${s.chave}`} x1="0" y1="0" x2="0" y2="1">
                      <stop offset="0%" stopColor={s.fill} />
                      <stop offset="100%" stopColor={s.fill.replace(/[\d.]+\)$/, "0)")} />
                    </linearGradient>
                  ))}
                </defs>

                {/* Grelha horizontal apenas — a vertical competiria com as linhas. */}
                {ticks.map((t) => (
                  <g key={t}>
                    <line x1={PAD_L} y1={y(t)} x2={W} y2={y(t)} stroke="var(--finance-grid)" strokeWidth="1" />
                    <text
                      x={PAD_L - 10}
                      y={y(t) + 3.5}
                      textAnchor="end"
                      fontSize="10.5"
                      fill="var(--finance-text-muted)"
                    >
                      {rotuloY(t)}
                    </text>
                  </g>
                ))}

                {SERIES.map((s) => {
                  const pts = pontos
                    .map((p, i) => ({ i, v: p[s.chave], x: x(i) }))
                    .filter((p): p is { i: number; v: number; x: number } => p.v !== null)
                    .map((p) => ({ x: p.x, y: y(p.v) }));
                  if (pts.length === 0) return null;
                  const linha = caminhoSuave(pts);
                  const base = y(0);
                  return (
                    <g key={s.chave}>
                      <path d={`${linha} L ${pts[pts.length - 1].x} ${base} L ${pts[0].x} ${base} Z`} fill={`url(#grad-${s.chave})`} />
                      <path d={linha} fill="none" stroke={s.cor} strokeWidth="2.25" strokeLinecap="round" strokeLinejoin="round" />
                    </g>
                  );
                })}

                {/* Coluna sensível ao rato + ponto realçado. */}
                {pontos.map((p, i) => (
                  <g key={i}>
                    <rect
                      x={x(i) - (W - PAD_L) / (pontos.length * 2)}
                      y={0}
                      width={(W - PAD_L) / pontos.length}
                      height={H - PAD_B}
                      fill="transparent"
                      onMouseEnter={() => setHover(i)}
                    />
                    {hover === i && (
                      <>
                        <line x1={x(i)} y1={PAD_T} x2={x(i)} y2={H - PAD_B} stroke="var(--finance-primary-border)" strokeWidth="1.5" />
                        {SERIES.map((s) =>
                          p[s.chave] === null ? null : (
                            <circle key={s.chave} cx={x(i)} cy={y(p[s.chave]!)} r="4" fill="#fff" stroke={s.cor} strokeWidth="2.25" />
                          ),
                        )}
                      </>
                    )}
                    <text x={x(i)} y={H - 8} textAnchor="middle" fontSize="10.5" fill="var(--finance-text-muted)">
                      {p.label}
                    </text>
                  </g>
                ))}
              </svg>

              {/* Tooltip próprio — o `<title>` nativo do SVG é lento e feio. */}
              {hover !== null && (
                <div className="mt-3 inline-block rounded-[10px] border border-[var(--finance-border)] bg-white px-3 py-2 shadow-[0_4px_16px_rgba(16,24,40,.06)]">
                  <p className="text-[11.5px] font-semibold text-[var(--finance-text)] mb-1.5">
                    {pontos[hover].label}
                  </p>
                  {SERIES.map((s) => (
                    <p key={s.chave} className="flex items-center gap-2 text-[12px] leading-5">
                      <span className="w-1.5 h-1.5 rounded-full inline-block" style={{ background: s.cor }} />
                      <span className="text-[var(--finance-text-secondary)] w-[68px]">{s.nome}</span>
                      <span className="font-medium text-[var(--finance-text)] tabular-nums">
                        {fmtEur(pontos[hover][s.chave])}
                      </span>
                    </p>
                  ))}
                </div>
              )}
            </div>
          );
        }}
      </RenderSlot>
    </FinanceCard>
  );
}

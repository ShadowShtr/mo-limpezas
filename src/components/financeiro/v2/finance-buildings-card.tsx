"use client";

// ============================================================================
// Prédios — no lugar onde estava a Previsão de caixa
// ============================================================================
//
// Componente **próprio**, e não uma reutilização do `FinanceCashForecast`.
// Reaproveitar aquele por ter a forma certa faria com que, daqui a uns meses,
// alguém lesse «previsão de caixa» no código a desenhar uma lista de prédios —
// e um dos dois acabaria alterado pelo motivo errado.
//
// ---------------------------------------------------------------------------
// O que este card **não** é
// ---------------------------------------------------------------------------
// Prédios são uma cadeia à parte: `building_cards.monthly_value`, e mais nada.
// Não são contratos, não são clientes, não são serviços, e **nenhum valor
// daqui entra em Faturado, Recebido, Margem ou Fluxo de Caixa**.
//
// Ligar um prédio a um contrato por nome ou morada seria inferência sobre
// texto livre — o mesmo erro que este módulo recusa em todo o lado.
// ============================================================================

import { Building2 } from "lucide-react";

import { FinanceCard, SectionHeader } from "./finance-card";
import { RenderSlot, Skeleton, VazioCompacto, type Slot } from "./visual-contract";
import { fmtEur } from "@/lib/finance-format";

export interface PredioLinha {
  id: string;
  nome: string;
  morada: string | null;
  valor: number | null;
  repetido: boolean;
}

export interface PrediosDados {
  linhas: PredioLinha[];
  /** `null` quando nenhum valor é conhecido. Nunca zero por omissão. */
  totalConhecido: number | null;
  contagem: number;
  comValor: number;
  semValor: number;
  nota?: string;
}

export function FinanceBuildingsCard({ slot }: { slot: Slot<PrediosDados> }) {
  return (
    <FinanceCard className="h-full flex flex-col" padded={false}>
      <div className="px-5 pt-5">
        <SectionHeader
          title="Prédios"
          hint="Avença mensal por prédio"
          right={<Building2 className="w-4 h-4 text-[var(--finance-text-muted)]" aria-hidden />}
        />
      </div>

      <RenderSlot slot={slot} esqueleto={<div className="px-5 pb-5"><Skeleton h={160} /></div>}>
        {(d) => {
          if (d.linhas.length === 0) {
            return <div className="px-5 pb-5"><VazioCompacto texto="Nenhum prédio registado." /></div>;
          }

          return (
            <>
              {/*
                🔴 Altura fixa e scroll só aqui dentro.

                São 146 prédios. Sem isto, o card cresceria até empurrar tudo o
                que vem depois para fora do ecrã, e o Resumo deixaria de caber
                numa vista — que é a propriedade que a referência aprovada mais
                depende.
              */}
              <div className="flex-1 overflow-y-auto px-5" style={{ maxHeight: 232 }}>
                <ul className="divide-y divide-[var(--finance-divider)]">
                  {d.linhas.map((l) => (
                    <li key={l.id} className="flex items-center gap-3 py-2.5">
                      <div className="min-w-0 flex-1">
                        <p className="text-[12.5px] text-[var(--finance-text)] truncate">
                          {l.nome}
                          {l.repetido && (
                            <span
                              className="ml-1.5 px-1.5 py-0.5 rounded-full text-[10px] font-medium bg-[var(--finance-orange-soft)] text-[var(--finance-orange)]"
                              title="Este prédio aparece em mais do que um dia"
                            >
                              +1 dia
                            </span>
                          )}
                        </p>
                        {l.morada && (
                          <p className="text-[11px] text-[var(--finance-text-muted)] truncate">{l.morada}</p>
                        )}
                      </div>
                      {/*
                        `null` é «Sem valor», não «0,00 €». A avença destes
                        prédios ficou por preencher na importação, de propósito
                        — mostrar zero diria que não rendem nada.
                      */}
                      <span
                        className={`shrink-0 text-[12.5px] tabular-nums ${
                          l.valor === null
                            ? "text-[var(--finance-text-muted)] italic"
                            : "font-semibold text-[var(--finance-text)]"
                        }`}
                      >
                        {l.valor === null ? "Sem valor" : fmtEur(l.valor)}
                      </span>
                    </li>
                  ))}
                </ul>
              </div>

              {/* Rodapé fixo, fora da área rolável. */}
              <div className="shrink-0 border-t border-[var(--finance-divider)] px-5 py-3.5">
                <div className="flex items-baseline justify-between gap-3">
                  <span className="text-[12px] text-[var(--finance-text-secondary)]">
                    {d.contagem} {d.contagem === 1 ? "prédio" : "prédios"}
                    {d.semValor > 0 && (
                      <span className="text-[var(--finance-text-muted)]">
                        {" "}· {d.comValor} com valor
                      </span>
                    )}
                  </span>
                  <span className="text-[15px] font-bold text-[var(--finance-text)] tabular-nums">
                    {d.totalConhecido === null ? (
                      <span className="text-[13px] font-medium text-[var(--finance-text-muted)]">
                        Total indisponível
                      </span>
                    ) : (
                      fmtEur(d.totalConhecido)
                    )}
                  </span>
                </div>
                {d.nota && (
                  <p className="mt-1.5 text-[11px] text-[var(--finance-orange)] leading-snug">{d.nota}</p>
                )}
              </div>
            </>
          );
        }}
      </RenderSlot>
    </FinanceCard>
  );
}

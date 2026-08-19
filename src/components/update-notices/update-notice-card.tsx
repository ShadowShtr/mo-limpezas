"use client";

// ============================================================================
// AVISO DE ATUALIZAÇÃO — o cartão, um só
// ============================================================================
// 🔴 Este componente é usado por dois sítios: o popup que os utilizadores veem
//    e o preview do painel de publicação. É deliberadamente o mesmo ficheiro —
//    um preview que renderize por outro caminho acaba, mais cedo ou mais
//    tarde, a mostrar algo diferente do que sai.
// ============================================================================

import { CheckCircle2, Sparkles, Info, Wrench } from "lucide-react";
import { NOTICE_KIND_LABEL, type NoticeKind } from "@/domain/update-notices/types";

const ESTILO_POR_TIPO: Record<NoticeKind, { icon: React.ElementType; cor: string; fundo: string }> = {
  correcao:   { icon: CheckCircle2, cor: "text-emerald-600", fundo: "bg-emerald-50" },
  novidade:   { icon: Sparkles,     cor: "text-violet-600",  fundo: "bg-violet-50" },
  aviso:      { icon: Info,         cor: "text-amber-600",   fundo: "bg-amber-50" },
  manutencao: { icon: Wrench,       cor: "text-slate-600",   fundo: "bg-slate-100" },
};

function formatarData(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "";
  return d.toLocaleDateString("pt-PT", { day: "numeric", month: "short", year: "numeric" });
}

export interface UpdateNoticeCardProps {
  kind: NoticeKind;
  title: string;
  message: string;
  publishedAt?: string;
  /** «2 de 3» — só aparece quando há mais do que um por ler. */
  position?: { current: number; total: number };
}

export function UpdateNoticeCard({ kind, title, message, publishedAt, position }: UpdateNoticeCardProps) {
  const estilo = ESTILO_POR_TIPO[kind] ?? ESTILO_POR_TIPO.aviso;
  const Icon = estilo.icon;

  return (
    <div className="p-7 sm:p-8">
      <div className="flex items-start gap-4">
        <div className={`shrink-0 rounded-2xl p-2.5 ${estilo.fundo}`}>
          <Icon className={`h-5 w-5 ${estilo.cor}`} aria-hidden />
        </div>

        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
            <span className={`text-[11px] font-semibold uppercase tracking-wide ${estilo.cor}`}>
              {NOTICE_KIND_LABEL[kind] ?? "Aviso"}
            </span>
            {publishedAt && (
              <>
                <span className="text-[11px] text-slate-400" aria-hidden>·</span>
                <span className="text-[11px] text-slate-500">{formatarData(publishedAt)}</span>
              </>
            )}
            {position && position.total > 1 && (
              <span className="ml-auto text-[11px] font-medium text-slate-500">
                {position.current} de {position.total}
              </span>
            )}
          </div>

          <h2 className="mt-2 text-[19px] font-semibold leading-snug text-slate-900">
            {title}
          </h2>

          <p className="mt-2.5 whitespace-pre-line text-[14.5px] leading-relaxed text-slate-600">
            {message}
          </p>
        </div>
      </div>
    </div>
  );
}

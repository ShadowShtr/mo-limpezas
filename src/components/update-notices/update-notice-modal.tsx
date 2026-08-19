"use client";

// ============================================================================
// AVISO DE ATUALIZAÇÃO — o popup
// ============================================================================
// Abre sozinho quando há avisos por ler, e **não fecha sem confirmação**: não
// há X, clicar fora não fecha, Escape não fecha.
//
// 🔴 Isto não é hostilidade de interface. Um aviso que se fecha por engano é um
//    aviso que ninguém leu mas que o sistema considera lido — e o registo
//    passaria a dizer que a pessoa viu algo que não viu. O único caminho para
//    sair é `markNoticeAsRead` a devolver sucesso.
//
// Se a marcação falhar, o popup **fica aberto** com o erro. Fechar na mesma
// perderia a leitura em silêncio.
// ============================================================================

import { useEffect, useState } from "react";
import { Loader2, AlertCircle } from "lucide-react";
import type { NoticeForDisplay } from "@/domain/update-notices/types";
import { markNoticeAsRead } from "@/app/actions/update-notices";
import { UpdateNoticeCard } from "./update-notice-card";

interface Props {
  notices: NoticeForDisplay[];
}

export function UpdateNoticeModal({ notices }: Props) {
  const [indice, setIndice] = useState(0);
  const [aMarcar, setAMarcar] = useState(false);
  const [erro, setErro] = useState<string | null>(null);
  const [terminado, setTerminado] = useState(false);

  const aberto = !terminado && notices.length > 0 && indice < notices.length;

  // Trava o scroll do fundo enquanto o aviso está aberto — sem isto a página
  // continua a mover-se atrás do modal.
  useEffect(() => {
    if (!aberto) return;
    const anterior = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => { document.body.style.overflow = anterior; };
  }, [aberto]);

  // 🔴 Escape não fecha. É intencional: ver o cabeçalho.
  useEffect(() => {
    if (!aberto) return;
    function onKeyDown(e: KeyboardEvent) {
      if (e.key === "Escape") {
        e.preventDefault();
        e.stopPropagation();
      }
    }
    document.addEventListener("keydown", onKeyDown, true);
    return () => document.removeEventListener("keydown", onKeyDown, true);
  }, [aberto]);

  if (!aberto) return null;

  const atual = notices[indice];

  async function confirmar() {
    setErro(null);
    setAMarcar(true);
    const res = await markNoticeAsRead(atual.key);
    setAMarcar(false);

    if (!res.ok) {
      // Não avança nem fecha: a leitura não ficou registada.
      setErro(res.error ?? "Não foi possível registar a leitura. Tenta outra vez.");
      return;
    }

    if (indice + 1 < notices.length) setIndice(indice + 1);
    else setTerminado(true);
  }

  return (
    <div
      className="fixed inset-0 z-[100] flex items-center justify-center p-4"
      role="dialog"
      aria-modal="true"
      aria-labelledby="update-notice-title"
    >
      {/* Overlay leve. Sem `onClick` — clicar fora não fecha. */}
      <div className="absolute inset-0 bg-slate-900/25 backdrop-blur-[2px]" aria-hidden />

      <div
        className="relative w-full max-w-[500px] overflow-hidden rounded-[26px] border border-white/60
                   bg-white/85 shadow-[0_24px_60px_-12px_rgba(15,23,42,0.28)] backdrop-blur-xl
                   motion-safe:animate-in motion-safe:fade-in motion-safe:zoom-in-95 motion-safe:duration-200"
      >
        <div id="update-notice-title">
          <UpdateNoticeCard
            kind={atual.kind}
            title={atual.title}
            message={atual.message}
            publishedAt={atual.publishedAt}
            position={{ current: indice + 1, total: notices.length }}
          />
        </div>

        {erro && (
          <div className="mx-7 mb-1 flex items-start gap-2 rounded-xl bg-red-50 px-3 py-2.5 sm:mx-8">
            <AlertCircle className="mt-0.5 h-4 w-4 shrink-0 text-red-600" aria-hidden />
            <p className="text-[13px] leading-snug text-red-700">{erro}</p>
          </div>
        )}

        <div className="px-7 pb-7 pt-3 sm:px-8 sm:pb-8">
          <button
            type="button"
            onClick={confirmar}
            disabled={aMarcar}
            className="flex w-full items-center justify-center gap-2 rounded-2xl bg-slate-900 px-4 py-3
                       text-[15px] font-medium text-white transition-colors hover:bg-slate-800
                       disabled:opacity-60"
          >
            {aMarcar && <Loader2 className="h-4 w-4 animate-spin" aria-hidden />}
            {aMarcar ? "A guardar…" : "Entendi"}
          </button>
        </div>
      </div>
    </div>
  );
}

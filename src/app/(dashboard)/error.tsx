"use client";

import { useEffect } from "react";
import { RefreshCw } from "lucide-react";

// Barreira de erro do painel de gestão. Se uma página falhar, mostra um aviso
// recuperável (sem perder a sessão) em vez de partir o site.
export default function DashboardError({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  useEffect(() => {
    console.error("[dashboard] erro de página:", error);
  }, [error]);

  return (
    <div className="min-h-[60vh] flex items-center justify-center p-6">
      <div className="text-center max-w-sm">
        <div className="w-12 h-12 rounded-xl bg-amber-50 flex items-center justify-center mx-auto mb-4">
          <RefreshCw className="w-6 h-6 text-amber-600" />
        </div>
        <h1 className="text-lg font-bold text-[#0F172A] mb-2">Esta secção não carregou</h1>
        <p className="text-sm text-[#64748B] mb-6">
          Houve um problema temporário a carregar esta página. A tua sessão continua ativa.
        </p>
        <div className="flex items-center justify-center gap-3">
          <button
            onClick={reset}
            className="px-5 py-2.5 rounded-lg bg-[#16A34A] text-white font-semibold text-sm hover:bg-[#15803D] transition-colors"
          >
            Tentar novamente
          </button>
          <a
            href="/dashboard"
            className="px-5 py-2.5 rounded-lg border border-[#E2E8F0] text-[#0F172A] font-semibold text-sm hover:bg-[#F8FAFC] transition-colors"
          >
            Ir para o início
          </a>
        </div>
      </div>
    </div>
  );
}

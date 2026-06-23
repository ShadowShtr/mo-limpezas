"use client";

import { useEffect } from "react";

// Barreira de erro da app das colaboradoras. Recuperável, mantém a sessão.
export default function AppError({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  useEffect(() => {
    console.error("[app] erro de página:", error);
  }, [error]);

  return (
    <div className="min-h-[70vh] flex items-center justify-center p-6">
      <div className="text-center max-w-xs">
        <div className="w-12 h-12 rounded-xl bg-[#F0FDF4] flex items-center justify-center mx-auto mb-4">
          <span className="text-2xl font-bold text-[#16A34A]">↻</span>
        </div>
        <h1 className="text-base font-bold text-[#0F172A] mb-2">Não carregou</h1>
        <p className="text-sm text-[#64748B] mb-6">
          Problema temporário. Estás na mesma com sessão ativa — tenta de novo.
        </p>
        <button
          onClick={reset}
          className="w-full px-5 py-3 rounded-lg bg-[#16A34A] text-white font-semibold text-sm hover:bg-[#15803D] transition-colors"
        >
          Tentar novamente
        </button>
      </div>
    </div>
  );
}

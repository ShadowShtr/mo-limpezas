"use client";

import { useEffect } from "react";

export default function GlobalError({ error }: { error: Error & { digest?: string } }) {
  useEffect(() => {
    // Chunk load error após deploy → recarregar para buscar os novos chunks
    const msg = error?.message ?? "";
    if (
      msg.includes("ChunkLoadError") ||
      msg.includes("Loading chunk") ||
      msg.includes("Failed to fetch") ||
      msg.includes("Load failed")
    ) {
      window.location.reload();
    }
  }, [error]);

  return (
    <html lang="pt">
      <body className="min-h-screen flex items-center justify-center bg-[#F8FAFC] font-sans p-6">
        <div className="text-center max-w-sm">
          <div className="w-12 h-12 rounded-xl bg-[#F0FDF4] flex items-center justify-center mx-auto mb-4">
            <span className="text-2xl font-bold text-[#16A34A]">E</span>
          </div>
          <h1 className="text-lg font-bold text-[#0F172A] mb-2">Algo correu mal</h1>
          <p className="text-sm text-[#64748B] mb-6">
            Ocorreu um erro inesperado. Tenta recarregar a página.
          </p>
          <button
            onClick={() => window.location.reload()}
            className="px-5 py-2.5 rounded-lg bg-[#16A34A] text-white font-semibold text-sm hover:bg-[#15803D] transition-colors"
          >
            Recarregar
          </button>
        </div>
      </body>
    </html>
  );
}

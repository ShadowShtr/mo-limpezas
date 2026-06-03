"use client";

export default function Error({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  return (
    <div className="min-h-screen flex items-center justify-center bg-[#F8FAFC] p-6">
      <div className="text-center max-w-sm">
        <div className="w-12 h-12 rounded-xl bg-[#F0FDF4] flex items-center justify-center mx-auto mb-4">
          <span className="text-2xl font-bold text-[#16A34A]">E</span>
        </div>
        <h1 className="text-lg font-bold text-[#0F172A] mb-2">Erro inesperado</h1>
        <p className="text-sm text-[#64748B] mb-6">
          {error?.message ?? "Ocorreu um problema. Tenta novamente."}
        </p>
        <button
          onClick={reset}
          className="px-5 py-2.5 rounded-lg bg-[#16A34A] text-white font-semibold text-sm hover:bg-[#15803D] transition-colors"
        >
          Tentar novamente
        </button>
      </div>
    </div>
  );
}

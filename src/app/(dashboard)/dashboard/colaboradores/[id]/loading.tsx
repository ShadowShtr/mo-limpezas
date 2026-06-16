export default function ColaboradorDetailLoading() {
  return (
    <div className="animate-pulse">
      {/* Header skeleton */}
      <div className="border-b border-[var(--color-border)] bg-white px-4 py-4 sm:px-6 lg:px-8">
        <div className="h-6 w-48 bg-[var(--color-border)] rounded-md" />
        <div className="h-4 w-32 bg-[var(--color-border)] rounded-md mt-2" />
      </div>

      <div className="px-4 py-5 sm:p-6 lg:px-8 mx-auto max-w-[1200px] space-y-6">
        {/* Voltar link */}
        <div className="h-4 w-28 bg-[var(--color-border)] rounded" />

        <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
          {/* Coluna esquerda */}
          <div className="space-y-4">
            {/* Card perfil */}
            <div className="bg-white rounded-xl border border-[var(--color-border)] p-6 flex flex-col items-center gap-3">
              <div className="w-20 h-20 rounded-full bg-[var(--color-border)]" />
              <div className="h-5 w-36 bg-[var(--color-border)] rounded" />
              <div className="h-4 w-20 bg-[var(--color-border)] rounded" />
              <div className="h-6 w-16 bg-[var(--color-border)] rounded-full" />
            </div>

            {/* Contacto */}
            <div className="bg-white rounded-xl border border-[var(--color-border)] p-5 space-y-3">
              <div className="h-4 w-20 bg-[var(--color-border)] rounded" />
              <div className="h-4 w-full bg-[var(--color-border)] rounded" />
              <div className="h-4 w-3/4 bg-[var(--color-border)] rounded" />
            </div>

            {/* Férias */}
            <div className="bg-white rounded-xl border border-[var(--color-border)] p-5 space-y-2">
              <div className="h-4 w-16 bg-[var(--color-border)] rounded" />
              <div className="h-10 w-24 bg-[var(--color-border)] rounded" />
            </div>

            {/* Faltas */}
            <div className="bg-white rounded-xl border border-[var(--color-border)] p-5 space-y-3">
              <div className="h-4 w-20 bg-[var(--color-border)] rounded" />
              <div className="h-4 w-full bg-[var(--color-border)] rounded" />
              <div className="h-4 w-2/3 bg-[var(--color-border)] rounded" />
            </div>
          </div>

          {/* Coluna direita */}
          <div className="lg:col-span-2 space-y-4">
            {/* KPIs */}
            <div className="grid grid-cols-3 gap-4">
              {[0, 1, 2].map((i) => (
                <div key={i} className="bg-white rounded-xl border border-[var(--color-border)] p-4 flex flex-col items-center gap-2">
                  <div className="h-8 w-16 bg-[var(--color-border)] rounded" />
                  <div className="h-3 w-20 bg-[var(--color-border)] rounded" />
                </div>
              ))}
            </div>

            {/* Histórico */}
            <div className="bg-white rounded-xl border border-[var(--color-border)] p-5 space-y-3">
              <div className="h-5 w-40 bg-[var(--color-border)] rounded" />
              {[0, 1, 2, 3, 4].map((i) => (
                <div key={i} className="h-10 w-full bg-[var(--color-border)] rounded-lg" />
              ))}
            </div>

            {/* Documentos */}
            <div className="bg-white rounded-xl border border-[var(--color-border)] p-5 space-y-3">
              <div className="h-5 w-32 bg-[var(--color-border)] rounded" />
              {[0, 1].map((i) => (
                <div key={i} className="h-12 w-full bg-[var(--color-border)] rounded-lg" />
              ))}
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}

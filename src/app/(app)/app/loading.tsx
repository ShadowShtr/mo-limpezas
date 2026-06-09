export default function AppLoading() {
  return (
    <div className="flex flex-col gap-5 pb-2 animate-pulse">
      {/* Saudação */}
      <div className="flex items-start justify-between">
        <div className="space-y-2">
          <div className="h-3 w-20 rounded bg-[var(--color-border)]" />
          <div className="h-6 w-32 rounded bg-[var(--color-border)]" />
          <div className="h-3 w-28 rounded bg-[var(--color-border)]" />
        </div>
        <div className="h-10 w-12 rounded bg-[var(--color-border)]" />
      </div>

      {/* Barra de progresso */}
      <div className="h-1.5 w-full rounded-full bg-[var(--color-border)]" />

      {/* Título secção */}
      <div className="h-3 w-28 rounded bg-[var(--color-border)]" />

      {/* Cartões de serviço */}
      <div className="flex flex-col gap-3">
        {[0, 1, 2].map((i) => (
          <div
            key={i}
            className="bg-white rounded-2xl border border-[var(--color-border)] p-4 flex gap-3 items-start"
          >
            <div className="w-1 self-stretch rounded-full bg-[var(--color-border)]" />
            <div className="flex-1 space-y-2">
              <div className="h-4 w-2/3 rounded bg-[var(--color-border)]" />
              <div className="h-3 w-1/2 rounded bg-[var(--color-border)]" />
              <div className="h-3 w-24 rounded bg-[var(--color-border)]" />
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}

export default function Loading() {
  return (
    <div className="flex flex-col h-full overflow-hidden animate-pulse">
      {/* Header skeleton */}
      <div className="h-16 bg-white border-b border-[var(--color-border)] flex items-center px-6 gap-4 shrink-0">
        <div>
          <div className="h-5 w-28 rounded bg-[var(--color-border)]" />
          <div className="h-3 w-40 rounded bg-[var(--color-border)] mt-1.5" />
        </div>
      </div>

      {/* Week nav skeleton */}
      <div className="flex items-center gap-2 px-6 py-3 bg-white border-b border-[var(--color-border)] shrink-0">
        <div className="w-8 h-8 rounded-lg bg-[var(--color-border)]" />
        {Array.from({ length: 7 }, (_, i) => (
          <div key={i} className="w-[52px] h-[56px] rounded-lg bg-[var(--color-border)]" />
        ))}
        <div className="w-8 h-8 rounded-lg bg-[var(--color-border)]" />
        <div className="w-14 h-8 rounded-lg bg-[var(--color-border)] ml-1" />
      </div>

      {/* Team headers skeleton */}
      <div className="flex bg-white border-b border-[var(--color-border)] shrink-0">
        <div className="w-16 h-11 shrink-0 border-r border-[var(--color-border)]" />
        {Array.from({ length: 3 }, (_, i) => (
          <div key={i} className="flex-1 min-w-[180px] px-3 py-2.5 border-l border-[var(--color-border)]">
            <div className="flex items-center gap-2">
              <div className="w-2.5 h-2.5 rounded-full bg-[var(--color-border)]" />
              <div className="h-4 w-24 rounded bg-[var(--color-border)]" />
            </div>
          </div>
        ))}
      </div>

      {/* Grid skeleton */}
      <div className="flex-1 overflow-hidden">
        <div className="flex h-full">
          <div className="w-16 h-full bg-white border-r border-[var(--color-border)] shrink-0" />
          {Array.from({ length: 3 }, (_, i) => (
            <div key={i} className="flex-1 min-w-[180px] border-l border-[var(--color-border)] p-2 space-y-4">
              {Array.from({ length: 3 }, (_, j) => (
                <div
                  key={j}
                  className="rounded-lg bg-[var(--color-border)]/50"
                  style={{ height: `${60 + j * 24}px`, marginTop: `${j * 40}px` }}
                />
              ))}
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}

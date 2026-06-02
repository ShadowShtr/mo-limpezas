export default function DashboardLoading() {
  return (
    <div>
      <div className="h-16 bg-white border-b border-[var(--color-border)] flex items-center px-6">
        <div className="h-5 w-32 bg-[var(--color-border)] rounded animate-pulse" />
      </div>

      <div className="p-6 space-y-6 max-w-[1400px]">
        {/* KPIs skeleton */}
        <div className="grid grid-cols-2 lg:grid-cols-4 gap-4">
          {[...Array(4)].map((_, i) => (
            <div key={i} className="bg-white rounded-xl border border-[var(--color-border)] p-5">
              <div className="w-9 h-9 rounded-lg bg-[var(--color-border)] animate-pulse mb-3" />
              <div className="h-8 w-12 bg-[var(--color-border)] rounded animate-pulse mb-2" />
              <div className="h-3 w-24 bg-[var(--color-border)] rounded animate-pulse" />
            </div>
          ))}
        </div>

        {/* Content skeleton */}
        <div className="grid grid-cols-1 xl:grid-cols-3 gap-6">
          <div className="xl:col-span-2 bg-white rounded-xl border border-[var(--color-border)] p-5 space-y-4">
            {[...Array(5)].map((_, i) => (
              <div key={i} className="flex items-center gap-4">
                <div className="w-14 h-8 bg-[var(--color-border)] rounded animate-pulse" />
                <div className="w-1 h-10 bg-[var(--color-border)] rounded animate-pulse" />
                <div className="flex-1 space-y-1.5">
                  <div className="h-4 w-1/2 bg-[var(--color-border)] rounded animate-pulse" />
                  <div className="h-3 w-1/3 bg-[var(--color-border)] rounded animate-pulse" />
                </div>
              </div>
            ))}
          </div>
          <div className="bg-white rounded-xl border border-[var(--color-border)] p-5">
            <div className="h-4 w-24 bg-[var(--color-border)] rounded animate-pulse mb-4" />
            {[...Array(3)].map((_, i) => (
              <div key={i} className="flex gap-3 mb-4">
                <div className="w-7 h-7 bg-[var(--color-border)] rounded-lg animate-pulse shrink-0" />
                <div className="flex-1 space-y-1.5">
                  <div className="h-3 w-3/4 bg-[var(--color-border)] rounded animate-pulse" />
                  <div className="h-3 w-1/2 bg-[var(--color-border)] rounded animate-pulse" />
                </div>
              </div>
            ))}
          </div>
        </div>
      </div>
    </div>
  );
}

export default function PerfilLoading() {
  return (
    <div className="flex flex-col gap-4 pb-2 animate-pulse">
      <div className="h-7 w-16 bg-gray-200 rounded-lg" />

      {/* Identidade */}
      <div className="rounded-2xl p-5 flex items-center gap-4 bg-white/60 border border-gray-100">
        <div className="w-16 h-16 rounded-full bg-gray-200 shrink-0" />
        <div className="flex flex-col gap-2 flex-1">
          <div className="h-5 w-36 bg-gray-200 rounded" />
          <div className="h-4 w-28 bg-gray-200 rounded" />
          <div className="h-3 w-40 bg-gray-200 rounded" />
        </div>
      </div>

      {/* KPIs */}
      <div className="rounded-2xl p-4 bg-white/60 border border-gray-100">
        <div className="h-3 w-20 bg-gray-200 rounded mb-3" />
        <div className="grid grid-cols-2 gap-3">
          <div className="rounded-xl p-3 bg-gray-100 space-y-2">
            <div className="h-3 w-12 bg-gray-200 rounded" />
            <div className="h-8 w-16 bg-gray-200 rounded" />
            <div className="h-3 w-24 bg-gray-200 rounded" />
          </div>
          <div className="rounded-xl p-3 bg-gray-100 space-y-2">
            <div className="h-3 w-12 bg-gray-200 rounded" />
            <div className="h-8 w-8 bg-gray-200 rounded" />
            <div className="h-3 w-20 bg-gray-200 rounded" />
          </div>
        </div>
      </div>

      {/* Documentos */}
      <div className="rounded-2xl p-4 bg-white/60 border border-gray-100 space-y-3">
        <div className="h-4 w-24 bg-gray-200 rounded" />
        <div className="h-12 w-full bg-gray-200 rounded-xl" />
        <div className="h-12 w-full bg-gray-200 rounded-xl" />
      </div>
    </div>
  );
}

"use client";

import { useState, useTransition } from "react";
import { AlertTriangle, CheckCircle2, Loader2, Repeat2, Settings2, X } from "lucide-react";
import {
  configurePaymentRecurrence,
  prepareRecurringPaymentsMonth,
  previewRecurringPaymentsMonth,
  type LegacyUnknownRecurrence,
  type RecurrencePreview,
} from "@/app/actions/payment-recurrence";

export function PrepareRecurringMonth({ year, month }: { year: number; month: number }) {
  const [open, setOpen] = useState(false);
  const [preview, setPreview] = useState<RecurrencePreview | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [pending, start] = useTransition();

  function loadPreview() {
    start(async () => {
      const result = await previewRecurringPaymentsMonth(year, month);
      if (!result.ok) { setError(result.error); return; }
      setPreview(result.preview);
      setError(null);
      setOpen(true);
    });
  }

  function prepare() {
    if (!preview) return;
    const willCreate = preview.configured.filter((item) => item.status === "will_create").length;
    if (!window.confirm(`Preparar ${willCreate} pagamento(s) recorrente(s) para este mês?`)) return;
    start(async () => {
      const result = await prepareRecurringPaymentsMonth(year, month);
      if (!result.ok) { setError(result.error); return; }
      const refreshed = await previewRecurringPaymentsMonth(year, month);
      if (refreshed.ok) setPreview(refreshed.preview);
      setError(null);
    });
  }

  return (
    <>
      <button onClick={loadPreview} disabled={pending} className="inline-flex items-center gap-2 rounded-lg border border-[var(--finance-primary)] px-3 py-2 text-sm font-semibold text-[var(--finance-primary)] disabled:opacity-50">
        {pending ? <Loader2 className="h-4 w-4 animate-spin" /> : <Repeat2 className="h-4 w-4" />}
        Preparar mês
      </button>
      {error && !open && <p className="mt-2 text-xs text-red-700">{error}</p>}

      {open && preview && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4" role="dialog" aria-modal="true">
          <div className="max-h-[90vh] w-full max-w-3xl overflow-y-auto rounded-2xl bg-white shadow-xl">
            <div className="sticky top-0 flex items-center justify-between border-b bg-white px-5 py-4">
              <div>
                <h3 className="font-semibold">Preparar {String(month).padStart(2, "0")}/{year}</h3>
                <p className="mt-0.5 text-xs text-slate-500">Pré-visualização sem escrita. Só a confirmação cria pagamentos.</p>
              </div>
              <button onClick={() => setOpen(false)} className="rounded-lg p-1.5 hover:bg-slate-100" aria-label="Fechar"><X className="h-4 w-4" /></button>
            </div>
            <div className="space-y-5 p-5">
              {error && <div className="rounded-lg border border-red-200 bg-red-50 p-3 text-sm text-red-700">{error}</div>}

              <section>
                <h4 className="text-sm font-semibold">Recorrências configuradas</h4>
                <div className="mt-2 divide-y rounded-xl border">
                  {preview.configured.length === 0 && <p className="p-4 text-sm text-slate-500">Nenhuma recorrência configurada cai neste mês.</p>}
                  {preview.configured.map((item) => (
                    <div key={`${item.seriesId}:${item.nextDueDate}`} className="flex flex-wrap items-center justify-between gap-3 p-3">
                      <div>
                        <p className="text-sm font-medium">{item.description}</p>
                        <p className="text-xs text-slate-500">Cada {item.intervalMonths} mês(es) · próximo vencimento {item.nextDueDate}</p>
                      </div>
                      {item.status === "already_exists"
                        ? <span className="inline-flex items-center gap-1 rounded-full bg-green-50 px-2 py-1 text-xs text-green-700"><CheckCircle2 className="h-3.5 w-3.5" /> Já existe</span>
                        : <span className="rounded-full bg-violet-50 px-2 py-1 text-xs text-violet-700">Será criado</span>}
                    </div>
                  ))}
                </div>
              </section>

              <section>
                <div className="flex items-center gap-2">
                  <AlertTriangle className="h-4 w-4 text-amber-600" />
                  <h4 className="text-sm font-semibold">Legado sem periodicidade conhecida ({preview.unknown.length})</h4>
                </div>
                <p className="mt-1 text-xs text-slate-500">Estes pagamentos não são gerados até alguém configurar a periodicidade. O sistema não a infere pelo histórico.</p>
                <div className="mt-2 divide-y rounded-xl border border-amber-200">
                  {preview.unknown.length === 0 && <p className="p-4 text-sm text-slate-500">Nenhum legado pendente de configuração.</p>}
                  {preview.unknown.slice(0, 30).map((item) => (
                    <UnknownConfig key={item.id} item={item} onConfigured={loadPreview} />
                  ))}
                </div>
              </section>

              <div className="flex justify-end gap-2 border-t pt-4">
                <button onClick={() => setOpen(false)} className="rounded-lg border px-4 py-2 text-sm">Fechar</button>
                <button
                  onClick={prepare}
                  disabled={pending || preview.configured.every((item) => item.status !== "will_create")}
                  className="rounded-lg bg-[var(--finance-primary)] px-4 py-2 text-sm font-semibold text-white disabled:opacity-50"
                >
                  {pending ? "A preparar…" : "Confirmar preparação"}
                </button>
              </div>
            </div>
          </div>
        </div>
      )}
    </>
  );
}

function UnknownConfig({ item, onConfigured }: { item: LegacyUnknownRecurrence; onConfigured: () => void }) {
  const [interval, setIntervalValue] = useState("1");
  const [anchor, setAnchor] = useState(item.dueDate ?? `${item.periodYear}-${String(item.periodMonth).padStart(2, "0")}-01`);
  const [error, setError] = useState<string | null>(null);
  const [pending, start] = useTransition();

  function save() {
    start(async () => {
      const result = await configurePaymentRecurrence({ paymentId: item.id, intervalMonths: Number(interval), anchorDate: anchor });
      if (!result.ok) { setError(result.error); return; }
      setError(null);
      onConfigured();
    });
  }

  return (
    <div className="p-3">
      <div className="flex flex-wrap items-end gap-2">
        <div className="min-w-[180px] flex-1">
          <p className="text-sm font-medium">{item.description}</p>
          <p className="text-xs text-slate-500">Competência atual {String(item.periodMonth).padStart(2, "0")}/{item.periodYear}</p>
        </div>
        <label className="text-[11px] text-slate-600">Intervalo
          <select value={interval} onChange={(event) => setIntervalValue(event.target.value)} className="mt-1 block rounded-lg border px-2 py-1.5 text-xs">
            <option value="1">Mensal</option><option value="3">Trimestral</option><option value="6">Semestral</option><option value="12">Anual</option>
          </select>
        </label>
        <label className="text-[11px] text-slate-600">Data âncora
          <input type="date" value={anchor} onChange={(event) => setAnchor(event.target.value)} className="mt-1 block rounded-lg border px-2 py-1.5 text-xs" />
        </label>
        <button disabled={pending || !anchor} onClick={save} className="inline-flex items-center gap-1 rounded-lg border px-3 py-1.5 text-xs font-semibold disabled:opacity-50">
          {pending ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Settings2 className="h-3.5 w-3.5" />} Configurar
        </button>
      </div>
      {error && <p className="mt-1 text-xs text-red-700">{error}</p>}
    </div>
  );
}

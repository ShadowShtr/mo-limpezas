import Link from "next/link";
import { Bell, ArrowRight, AlertCircle } from "lucide-react";
import { getPaymentsReminder } from "@/app/actions/payments";

function fmtEur(v: number) {
  return v.toLocaleString("pt-PT", { minimumFractionDigits: 2, maximumFractionDigits: 2 }) + " €";
}

// Banner de lembrete de pagamentos por pagar do mês atual.
// Renderiza nada se não houver pendentes (ou se sem permissão).
export async function PaymentsReminderBanner() {
  // Contenção: este banner nunca pode partir a página. Qualquer falha → não mostra nada.
  let res: Awaited<ReturnType<typeof getPaymentsReminder>>;
  try {
    res = await getPaymentsReminder();
  } catch {
    return null;
  }
  if (!res.ok || res.data.count === 0) return null;
  const { count, overdueCount, total, items } = res.data;

  return (
    <Link
      href="/dashboard/financeiro/pagamentos"
      className="block rounded-xl border border-amber-200 bg-amber-50 hover:bg-amber-100/70 transition-colors p-4"
    >
      <div className="flex items-start gap-3">
        <div className="w-9 h-9 rounded-lg bg-amber-100 flex items-center justify-center shrink-0">
          <Bell className="w-4.5 h-4.5 text-amber-600" />
        </div>
        <div className="flex-1 min-w-0">
          <div className="flex items-center justify-between gap-2">
            <p className="text-sm font-semibold text-amber-900">
              {count} pagamento{count !== 1 ? "s" : ""} por pagar — {fmtEur(total)}
            </p>
            <ArrowRight className="w-4 h-4 text-amber-600 shrink-0" />
          </div>
          {overdueCount > 0 && (
            <p className="text-xs text-red-600 font-medium flex items-center gap-1 mt-0.5">
              <AlertCircle className="w-3 h-3" /> {overdueCount} já passaram da data
            </p>
          )}
          <p className="text-xs text-amber-800/80 mt-1 truncate">
            {items.map((i) => i.description).join(" · ")}
          </p>
        </div>
      </div>
    </Link>
  );
}

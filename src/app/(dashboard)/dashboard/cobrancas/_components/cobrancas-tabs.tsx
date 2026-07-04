"use client";

import { useState } from "react";
import { CalendarDays, Receipt } from "lucide-react";
import type { Invoice, UnbilledService } from "@/app/actions/invoices";
import type { DailyBillingData } from "@/app/actions/daily-billing";
import { InvoicesClient } from "./invoices-client";
import { DailyBillingClient } from "./daily-billing-client";

type Tab = "diario" | "faturas";

interface Props {
  initialInvoices: Invoice[];
  unbilledServices: UnbilledService[];
  companyId: string;
  mesParam: string;
  year: number;
  month: number;
  mesLabel: string;
  dailyDate: string;
  dailyData: DailyBillingData | null;
  dailyError: string | null;
}

export function CobrancasTabs({
  initialInvoices, unbilledServices, companyId, mesParam, year, month, mesLabel,
  dailyDate, dailyData, dailyError,
}: Props) {
  // Diário primeiro: é o ecrã de trabalho do dia a dia (lembrar de cobrar).
  const [tab, setTab] = useState<Tab>("diario");

  const TABS: { key: Tab; label: string; icon: React.ElementType }[] = [
    { key: "diario",  label: "Diário",          icon: CalendarDays },
    { key: "faturas", label: "Faturas mensais", icon: Receipt },
  ];

  return (
    <div className="space-y-5">
      <div className="flex gap-1 bg-[var(--color-background)] rounded-xl p-1 w-fit">
        {TABS.map(({ key, label, icon: Icon }) => (
          <button
            key={key}
            onClick={() => setTab(key)}
            className={`flex items-center gap-2 px-4 py-2 rounded-lg text-sm font-medium transition-colors ${
              tab === key
                ? "bg-white text-[var(--color-primary)] shadow-sm border border-[var(--color-border)]"
                : "text-[var(--color-text-sub)] hover:text-[var(--color-text-main)]"
            }`}
          >
            <Icon className="w-4 h-4" />
            {label}
          </button>
        ))}
      </div>

      {tab === "diario" && (
        <DailyBillingClient
          initialDate={dailyDate}
          initialData={dailyData}
          initialError={dailyError}
          companyId={companyId}
        />
      )}

      {tab === "faturas" && (
        <InvoicesClient
          initialInvoices={initialInvoices}
          unbilledServices={unbilledServices}
          companyId={companyId}
          mesParam={mesParam}
          year={year}
          month={month}
          mesLabel={mesLabel}
        />
      )}
    </div>
  );
}

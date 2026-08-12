"use client";

import { useState } from "react";
import { CalendarDays, Receipt, Users } from "lucide-react";
import type { Invoice, UnbilledService } from "@/app/actions/invoices";
import type { DailyBillingData } from "@/app/actions/daily-billing";
import { InvoicesClient } from "./invoices-client";
import { DailyBillingClient } from "./daily-billing-client";
import { ClientHistoryClient } from "./client-history-client";

type Tab = "diario" | "faturas" | "cliente";

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
  /** Vem de `?cliente=` — permite que Top clientes abra já no cliente certo. */
  clienteInicial?: string;
}

export function CobrancasTabs({
  initialInvoices, unbilledServices, companyId, mesParam, year, month, mesLabel,
  dailyDate, dailyData, dailyError, clienteInicial,
}: Props) {
  // Diário primeiro: é o ecrã de trabalho do dia a dia (lembrar de cobrar).
  // Se vier `?cliente=`, abre já no histórico desse cliente — é o destino de
  // um clique em Top clientes, no Resumo.
  const [tab, setTab] = useState<Tab>(clienteInicial ? "cliente" : "diario");

  const TABS: { key: Tab; label: string; icon: React.ElementType }[] = [
    { key: "diario",  label: "Diário",          icon: CalendarDays },
    { key: "faturas", label: "Faturas mensais", icon: Receipt },
    // O histórico do cliente vive aqui, e não como oitava vista do módulo:
    // uma aba nova seria um segundo sítio para falar de faturação.
    { key: "cliente", label: "Por cliente",     icon: Users },
  ];

  return (
    <div className="space-y-5">
      <div role="tablist" className="flex gap-1 w-fit">
        {TABS.map(({ key, label, icon: Icon }) => (
          <button
            key={key}
            onClick={() => setTab(key)}
            aria-selected={tab === key}
            role="tab"
            className={`flex items-center gap-2 px-3.5 py-2.5 rounded-[10px] text-[13px] font-medium transition-colors ${
              tab === key
                ? "bg-[var(--finance-primary-soft)] text-[var(--finance-primary)]"
                : "text-[var(--finance-slate)] hover:bg-[#F5F6FA] hover:text-[var(--finance-text)]"
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

      {tab === "cliente" && <ClientHistoryClient clienteInicial={clienteInicial} />}

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

export const LEGACY_FINANCE_PATHS = {
  accounts: "/dashboard/financeiro/contas",
  cashFlow: "/dashboard/financeiro/fluxo-caixa",
  payments: "/dashboard/financeiro/pagamentos",
} as const;

export type LegacyFinanceRedirectGate = {
  cashFlowRedirectEnabled: boolean;
  accountsRedirectEnabled: boolean;
  sixPendingGatePassed: boolean;
};

export const LEGACY_FINANCE_REDIRECTS_PREPARED_ONLY: LegacyFinanceRedirectGate = {
  cashFlowRedirectEnabled: false,
  accountsRedirectEnabled: false,
  sixPendingGatePassed: false,
};

function paymentsTarget(searchParams?: URLSearchParams): string {
  const query = searchParams?.toString();
  return query ? `${LEGACY_FINANCE_PATHS.payments}?${query}` : LEGACY_FINANCE_PATHS.payments;
}

export function resolveLegacyFinanceRedirect(
  pathname: string,
  gate: LegacyFinanceRedirectGate,
  searchParams?: URLSearchParams,
): string | null {
  if (pathname === LEGACY_FINANCE_PATHS.cashFlow && gate.cashFlowRedirectEnabled) {
    return paymentsTarget(searchParams);
  }

  if (
    pathname === LEGACY_FINANCE_PATHS.accounts &&
    gate.accountsRedirectEnabled &&
    gate.sixPendingGatePassed
  ) {
    return paymentsTarget(searchParams);
  }

  return null;
}

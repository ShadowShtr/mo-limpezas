import { describe, expect, it } from "vitest";
import {
  LEGACY_FINANCE_PATHS,
  LEGACY_FINANCE_REDIRECTS_PREPARED_ONLY,
  resolveLegacyFinanceRedirect,
} from "@/domain/finance/legacy-navigation";

describe("retirada preparada das vistas financeiras legacy", () => {
  it("UNI24 prepara o redirect de Fluxo e preserva os filtros", () => {
    const target = resolveLegacyFinanceRedirect(
      LEGACY_FINANCE_PATHS.cashFlow,
      { ...LEGACY_FINANCE_REDIRECTS_PREPARED_ONLY, cashFlowRedirectEnabled: true },
      new URLSearchParams("mes=2026-08&categoria=combustivel"),
    );

    expect(target).toBe(
      "/dashboard/financeiro/pagamentos?mes=2026-08&categoria=combustivel",
    );
  });

  it("UNI25 nunca retira Contas antes do gate das seis pendencias", () => {
    const beforeGate = resolveLegacyFinanceRedirect(LEGACY_FINANCE_PATHS.accounts, {
      cashFlowRedirectEnabled: true,
      accountsRedirectEnabled: true,
      sixPendingGatePassed: false,
    });
    const afterGate = resolveLegacyFinanceRedirect(LEGACY_FINANCE_PATHS.accounts, {
      cashFlowRedirectEnabled: true,
      accountsRedirectEnabled: true,
      sixPendingGatePassed: true,
    });

    expect(beforeGate).toBeNull();
    expect(afterGate).toBe(LEGACY_FINANCE_PATHS.payments);
  });

  it("mantem ambos os redirects inativos nesta branch", () => {
    expect(
      resolveLegacyFinanceRedirect(
        LEGACY_FINANCE_PATHS.cashFlow,
        LEGACY_FINANCE_REDIRECTS_PREPARED_ONLY,
      ),
    ).toBeNull();
    expect(
      resolveLegacyFinanceRedirect(
        LEGACY_FINANCE_PATHS.accounts,
        LEGACY_FINANCE_REDIRECTS_PREPARED_ONLY,
      ),
    ).toBeNull();
  });
});

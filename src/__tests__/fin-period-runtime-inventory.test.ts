import { describe, expect, it } from "vitest";
import fs from "node:fs";
import path from "node:path";

const ler = (ficheiro: string) =>
  fs.readFileSync(path.join(process.cwd(), ficheiro), "utf8");

describe("FIN_PERIOD_RUNTIME — writers e destruição de histórico", () => {
  it("o runtime financeiro publicado chama as RPCs atómicas", () => {
    const expected: Record<string, string[]> = {
      "src/app/actions/payments.ts": [
        'rpc("create_payment_atomic"',
        'rpc("update_payment_atomic"',
        'rpc("set_payment_status_atomic"',
        'rpc("delete_payment_atomic"',
      ],
      "src/app/actions/cash-flow.ts": [
        'rpc("create_cashflow_entry_atomic"',
        'rpc("update_cashflow_entry_atomic"',
        'rpc("delete_cashflow_entry_atomic"',
      ],
      "src/app/actions/daily-billing.ts": ['rpc("set_service_payment_atomic"'],
      "src/app/actions/financial-periods.ts": [
        'rpc("close_financial_period_atomic"',
        'rpc("reopen_financial_period_atomic"',
      ],
    };

    for (const [ficheiro, chamadas] of Object.entries(expected)) {
      const source = ler(ficheiro);
      for (const chamada of chamadas) expect(source).toContain(chamada);
    }
  });

  it("não existe consumidor do hard delete de clientes", () => {
    const table = ler("src/app/(dashboard)/dashboard/clientes/_components/table.tsx");
    const action = ler("src/app/actions/clientes.ts");
    expect(table).toContain("archiveCliente");
    expect(table).not.toContain("deleteCliente");
    expect(action).toContain("archive-only");
    expect(action).toContain("preservar o histórico");
  });

  it("o arquivamento recusa falhas na leitura de serviços futuros", () => {
    const action = ler("src/app/actions/clientes.ts");
    expect(action).toContain('queryFailure("archiveCliente:services", servicesError)');
  });
});

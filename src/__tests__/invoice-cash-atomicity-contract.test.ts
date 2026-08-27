import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

const ROOT = process.cwd();
const ACTION = path.join(ROOT, "src", "app", "actions", "invoices.ts");
const RPC = path.join(ROOT, "src", "lib", "finance-rpc", "invoice-status.ts");
const MIGRATION = path.join(
  ROOT,
  "supabase",
  "migrations",
  "provisional",
  "PROVISIONAL_invoice_cash_atomicity.sql",
);
const ROLLBACK = path.join(
  ROOT,
  "supabase",
  "migrations",
  "provisional",
  "PROVISIONAL_invoice_cash_atomicity.rollback.sql",
);

const read = (file: string) => fs.readFileSync(file, "utf8");

describe("CODEX-FIN-INV-001 - invoice e caixa formam uma unica mutacao", () => {
  it("REPRO: a action nao pode atualizar invoices e cash_flow_entries separadamente", () => {
    const source = read(ACTION);
    const start = source.indexOf("export async function updateInvoiceStatus");
    const end = source.indexOf("export async function deleteInvoice", start);
    const body = source.slice(start, end);

    expect(body).toContain("alterarEstadoFatura");
    expect(body).not.toMatch(/\.from\(["']invoices["']\)[\s\S]*?\.update\(/);
    expect(body).not.toMatch(/\.from\(["']cash_flow_entries["']\)/);
  });

  it("usa a RPC canonica existente, nao uma segunda funcao financeira", () => {
    expect(read(RPC)).toContain('RPC_ESTADO_FATURA = "set_invoice_status_atomic"');
    expect(read(MIGRATION)).toMatch(/CREATE OR REPLACE FUNCTION public\.set_invoice_status_atomic\s*\(/);
  });

  it("a base bloqueia os dois periodos e serializa a fatura", () => {
    const sql = read(MIGRATION);
    expect(sql).toMatch(/FOR UPDATE/);
    expect(sql.match(/is_financial_period_open/g)).toHaveLength(2);
    expect(sql).toMatch(/v_invoice_date/);
    expect(sql).toMatch(/v_cash_date/);
  });

  it("retry nao move a data de um recebimento existente", () => {
    const sql = read(MIGRATION);
    expect(sql).not.toMatch(/DO UPDATE SET[\s\S]*?date\s*=\s*EXCLUDED\.date/);
    expect(sql).toMatch(/CASHFLOW_INVOICE_MISMATCH/);
  });

  it("execucao publica continua revogada", () => {
    const sql = read(MIGRATION);
    expect(sql).toMatch(/REVOKE ALL ON FUNCTION public\.set_invoice_status_atomic[\s\S]*FROM PUBLIC/);
    expect(sql).toMatch(/GRANT EXECUTE ON FUNCTION public\.set_invoice_status_atomic[\s\S]*TO service_role/);
  });

  it("o rollback restaura a definicao canonica anterior sem abrir grants", () => {
    const sql = read(ROLLBACK);
    expect(sql).toMatch(/CREATE OR REPLACE FUNCTION public\.set_invoice_status_atomic\s*\(/);
    expect(sql).toMatch(/ON CONFLICT \(company_id, reference_type, reference_id\)/);
    expect(sql).toMatch(/REVOKE ALL ON FUNCTION public\.set_invoice_status_atomic[\s\S]*FROM PUBLIC/);
    expect(sql).toMatch(/COMMIT;/);
  });
});

describe("CODEX-FIN-INV-002 - erro de invoice_items nao vira vazio", () => {
  it("a consulta captura o erro e falha explicitamente", () => {
    const source = read(ACTION);
    expect(source).toMatch(/data:\s*billed,\s*error:\s*billedError/);
    expect(source).toMatch(
      /if \(billedError\) return queryFailure\("getUnbilledServices:invoice_items", billedError\)/,
    );
    expect(source).not.toMatch(/error:\s*billedError\.message/);
  });
});

import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { CONTRATO_SHEET_SELECT } from "@/lib/contrato-sheet-fields";

const SHEET_SOURCE = readFileSync(join(
  __dirname,
  "..",
  "app",
  "(dashboard)",
  "dashboard",
  "contratos",
  "_components",
  "sheet.tsx",
), "utf8");

// Regressão do bug: a ficha do cliente tinha uma query de "contracts" separada
// da página /dashboard/contratos, e essa cópia esqueceu fixed_price/
// fixed_monthly/apply_vat — o ContratoSheet abria com o valor da avença vazio
// e, ao gravar, apagava o valor real do contrato. Agora as duas páginas usam
// esta mesma constante; este teste garante que ela nunca perde os campos
// financeiros de que o ContratoSheet depende para não apagar dados ao editar.
describe("CONTRATO_SHEET_SELECT — campos obrigatórios para o ContratoSheet", () => {
  const REQUIRED_FIELDS = [
    "fixed_price",
    "fixed_monthly",
    "apply_vat",
    "hourly_rate", // vem via locations(...)
    "id",
    "name",
    "schedule_days",
  ];

  it.each(REQUIRED_FIELDS)("inclui o campo '%s'", (field) => {
    expect(CONTRATO_SHEET_SELECT).toContain(field);
  });

  it("locations vem com sub-select (não é a tabela inteira)", () => {
    expect(CONTRATO_SHEET_SELECT).toMatch(/locations\s*\(/);
  });

  it("envia null quando a data de fim está vazia", () => {
    expect(SHEET_SOURCE).toContain("ends_on: endsOn || null,");
    expect(SHEET_SOURCE).not.toContain("ends_on: endsOn || undefined,");
  });
});

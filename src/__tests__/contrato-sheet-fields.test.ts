import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { CONTRATO_SHEET_SELECT } from "@/lib/contrato-sheet-fields";
import { assertCriticalFieldsLoaded, CRITICAL_FIELDS } from "@/lib/critical-fields";

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

// Regressão do bug "Editar intervenção → limpar data de fim → Erro ao guardar:
// Não foi possível carregar todos os dados necessários". O ContratoSheet
// mandava `undefined` quando o campo ficava vazio, e a guarda anti-apagamento
// lê `undefined` como "a página não carregou esta coluna" e bloqueia. Vazio
// tem de virar `null` — "o utilizador apagou de propósito".
describe("data de fim vazia — guarda anti-apagamento de contracts", () => {
  const payloadBase = () =>
    Object.fromEntries(
      CRITICAL_FIELDS.contracts.map((f) => [f, null as unknown]),
    ) as Record<string, unknown>;

  it("null passa na guarda (utilizador retirou a data de fim)", () => {
    const payload = { ...payloadBase(), starts_on: "2026-01-01", ends_on: null };
    expect(assertCriticalFieldsLoaded("contracts", payload, { requireAll: true })).toEqual({ ok: true });
  });

  it("undefined continua bloqueado (coluna não carregada)", () => {
    const payload = { ...payloadBase(), starts_on: "2026-01-01", ends_on: undefined };
    const result = assertCriticalFieldsLoaded("contracts", payload, { requireAll: true });
    expect(result.ok).toBe(false);
    expect(result.ok === false && result.missing).toContain("ends_on");
  });

  it("data de fim preenchida continua a passar", () => {
    const payload = { ...payloadBase(), starts_on: "2026-01-01", ends_on: "2026-12-31" };
    expect(assertCriticalFieldsLoaded("contracts", payload, { requireAll: true })).toEqual({ ok: true });
  });

  it("ends_on é mesmo um campo crítico de contracts (senão o teste não prova nada)", () => {
    expect(CRITICAL_FIELDS.contracts).toContain("ends_on");
  });
});

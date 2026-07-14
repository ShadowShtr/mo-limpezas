import { describe, expect, it } from "vitest";
import { periodsOverlap, findOverlappingMonthlyContracts } from "@/lib/contract-overlap";

// Estes testes cobrem a lógica pura por trás de hasOverlappingMonthlyContract,
// usada em createContrato/updateContrato (src/app/actions/contratos.ts) para
// bloquear uma segunda avença mensal ativa sobreposta ao mesmo local — a causa
// do bug de duplicação de cobrança do "Parque Norte / Alvorada Principal".

describe("periodsOverlap", () => {
  it("deteta sobreposição direta entre dois períodos", () => {
    expect(periodsOverlap(
      { starts_on: "2026-01-01", ends_on: "2026-12-31" },
      { starts_on: "2026-06-01", ends_on: "2026-06-30" },
    )).toBe(true);
  });

  // Cenário 3: permite novo contrato mensal se o anterior terminou antes do
  // início do novo.
  it("não acusa sobreposição quando o contrato anterior já terminou", () => {
    expect(periodsOverlap(
      { starts_on: "2026-01-01", ends_on: "2026-06-30" },
      { starts_on: "2026-07-01", ends_on: null },
    )).toBe(false);
  });

  it("trata ends_on nulo como aberto no futuro (sobrepõe qualquer início posterior)", () => {
    expect(periodsOverlap(
      { starts_on: "2026-01-01", ends_on: null },
      { starts_on: "2030-01-01", ends_on: "2030-12-31" },
    )).toBe(true);
  });

  it("não sobrepõe quando os dois períodos são adjacentes sem gap nenhum dia (fim = início-1)", () => {
    expect(periodsOverlap(
      { starts_on: "2026-01-01", ends_on: "2026-06-30" },
      { starts_on: "2026-07-01", ends_on: "2026-12-31" },
    )).toBe(false);
  });

  it("acusa sobreposição quando os períodos partilham mesmo 1 dia", () => {
    expect(periodsOverlap(
      { starts_on: "2026-01-01", ends_on: "2026-07-01" },
      { starts_on: "2026-07-01", ends_on: "2026-12-31" },
    )).toBe(true);
  });
});

describe("findOverlappingMonthlyContracts", () => {
  const existing = [
    { id: "contract-a", starts_on: "2026-01-01", ends_on: null },
  ];

  // Cenário 4/5: createContrato/updateContrato não permitem avença mensal
  // ativa sobreposta a outra já existente para o mesmo local.
  it("encontra o contrato existente que se sobrepõe ao novo período", () => {
    const result = findOverlappingMonthlyContracts(
      existing,
      { starts_on: "2026-07-01", ends_on: null },
    );
    expect(result.map((c) => c.id)).toEqual(["contract-a"]);
  });

  // Cenário 6: updateContrato permite editar o próprio contrato sem se
  // acusar de duplicidade dele mesmo.
  it("ignora o próprio contrato quando excludeContractId corresponde", () => {
    const result = findOverlappingMonthlyContracts(
      existing,
      { starts_on: "2026-07-01", ends_on: null },
      "contract-a",
    );
    expect(result).toEqual([]);
  });

  it("continua a acusar sobreposição com OUTRO contrato mesmo excluindo o próprio id (update)", () => {
    const twoExisting = [
      { id: "contract-a", starts_on: "2026-01-01", ends_on: null },
      { id: "contract-b", starts_on: "2026-01-01", ends_on: null },
    ];
    const result = findOverlappingMonthlyContracts(
      twoExisting,
      { starts_on: "2026-07-01", ends_on: null },
      "contract-a", // a estar a editar o contract-a, mas contract-b continua sobreposto
    );
    expect(result.map((c) => c.id)).toEqual(["contract-b"]);
  });

  it("não encontra sobreposição quando não há candidatos para o local", () => {
    const result = findOverlappingMonthlyContracts(
      [],
      { starts_on: "2026-07-01", ends_on: null },
    );
    expect(result).toEqual([]);
  });
});

import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { normalizeScheduleDays, scheduleDaysEqual } from "@/lib/schedule-days";
import {
  contractWriteDivergences,
  contractWriteMismatchMessage,
  CONTRACT_CONFIRMED_FIELDS,
} from "@/lib/contract-write-confirmation";

// ============================================================================
// Incidente de 2026-09-03 — "A alteração não foi confirmada na base de dados
// (campos divergentes: schedule_days)" ao editar uma intervenção em produção.
//
// O contrato ERA gravado. O que falhava a seguir era a confirmação: o
// read-after-write comparava `JSON.stringify(enviado)` com
// `JSON.stringify(gravado)`, e o Postgres devolve o JSONB com as chaves
// noutra ordem. Mesmo conteúdo, texto diferente → erro ao utilizador e a
// sincronização dos serviços futuros nunca chegava a correr (foi assim que o
// contrato ficou com a equipa nova e os serviços com a antiga).
//
// Os dados abaixo são os do incidente real.
// ============================================================================

const TEAM = "b0810dab-8155-471a-989d-0a6797ea6401";

/** Como o formulário monta (ver buildScheduleDays em contratos/_components/sheet.tsx). */
const ENVIADO = [{
  day: "thu",
  start_time: "08:30",
  duration_min: 150,
  team_id: TEAM,
  num_people: null,
}];

/** Como o Postgres devolveu a mesma linha JSONB. */
const GRAVADO = [{
  day: "thu",
  team_id: TEAM,
  num_people: null,
  start_time: "08:30",
  duration_min: 150,
}];

describe("schedule_days — a ordem das chaves do JSONB não é divergência", () => {
  // A causa, fixada aqui para não voltar por distração: com estes dois valores
  // — o mesmo padrão, com as chaves por outra ordem — a comparação antiga
  // acusava divergência. Se este teste falhar, é porque alguém "arrumou" as
  // constantes e o caso do incidente deixou de estar representado.
  it("a comparação por texto acusaria divergência nestes dados", () => {
    expect(JSON.stringify(ENVIADO)).not.toBe(JSON.stringify(GRAVADO));
  });

  it("o caso exato do incidente é semanticamente igual", () => {
    expect(scheduleDaysEqual(ENVIADO, GRAVADO)).toBe(true);
  });

  it("normalizar põe os dois lados na mesma forma", () => {
    expect(normalizeScheduleDays(ENVIADO)).toEqual(normalizeScheduleDays(GRAVADO));
  });

  it.each([
    ["duration_min", { ...GRAVADO[0], duration_min: 120 }],
    ["start_time", { ...GRAVADO[0], start_time: "09:00" }],
    ["team_id", { ...GRAVADO[0], team_id: "1d67cd42-4ca5-4187-88d7-0c1dcdfe0b21" }],
    ["num_people", { ...GRAVADO[0], num_people: 2 }],
    ["day", { ...GRAVADO[0], day: "fri" }],
  ])("continua a detetar divergência real em %s", (_campo, alterado) => {
    expect(scheduleDaysEqual(ENVIADO, [alterado])).toBe(false);
  });

  it("equipa retirada (id passa a null) é divergência", () => {
    expect(scheduleDaysEqual(ENVIADO, [{ ...GRAVADO[0], team_id: null }])).toBe(false);
  });

  // schedule_days[0] é o padrão usado quando o dia do serviço não tem entrada
  // própria (updateFutureServiceValuesForContract) — trocar a ordem dos dias
  // muda o comportamento, logo não pode ser tratada como equivalente.
  it("a ordem dos ELEMENTOS do array continua significativa", () => {
    const qui = GRAVADO[0];
    const sex = { ...GRAVADO[0], day: "fri", start_time: "10:00" };
    expect(scheduleDaysEqual([qui, sex], [sex, qui])).toBe(false);
  });

  it("número de dias diferente é divergência", () => {
    expect(scheduleDaysEqual(ENVIADO, [...GRAVADO, { ...GRAVADO[0], day: "fri" }])).toBe(false);
  });

  it("padrão ausente dos dois lados não bloqueia a gravação", () => {
    expect(scheduleDaysEqual(null, null)).toBe(true);
    expect(scheduleDaysEqual(undefined, null)).toBe(true);
  });

  it("ausente de um lado só é divergência", () => {
    expect(scheduleDaysEqual(ENVIADO, null)).toBe(false);
    expect(scheduleDaysEqual(null, GRAVADO)).toBe(false);
  });

  it("forma inesperada não é declarada igual (fail-closed)", () => {
    expect(scheduleDaysEqual(ENVIADO, { day: "thu" })).toBe(false);
    expect(scheduleDaysEqual("[]", [])).toBe(false);
  });

  it("um campo que apareça só do lado gravado não passa em claro", () => {
    expect(scheduleDaysEqual(ENVIADO, [{ ...GRAVADO[0], inesperado: 1 }])).toBe(false);
  });

  it("dois valores igualmente inutilizáveis não inventam divergência", () => {
    const a = [{ ...ENVIADO[0], duration_min: "x" }];
    const b = [{ ...GRAVADO[0], duration_min: "x" }];
    expect(scheduleDaysEqual(a, b)).toBe(true);
  });
});

// ============================================================================
// A confirmação inteira: sem divergências, a execução segue.
// ============================================================================

/** Payload equivalente ao que o formulário envia numa edição de intervenção. */
const INPUT = {
  fixed_price: null,
  fixed_monthly: false,
  apply_vat: false,
  cleaning_type: null,
  payment_status: null,
  upholstery_type: null,
  upholstery_notes: null,
  upholstery_units: null,
  upholstery_unit_price: null,
  num_people: null,
  status: "ativo",
  schedule_days: ENVIADO,
};

/** A linha devolvida pelo .select() do UPDATE. */
const SAVED = {
  fixed_price: null,
  fixed_monthly: false,
  apply_vat: false,
  cleaning_type: null,
  payment_status: null,
  upholstery_type: null,
  upholstery_notes: null,
  upholstery_units: null,
  upholstery_unit_price: null,
  num_people: null,
  status: "ativo",
  schedule_days: GRAVADO,
};

describe("confirmação pós-gravação do contrato", () => {
  it("o incidente deixa de produzir divergência — a gravação é confirmada", () => {
    expect(contractWriteDivergences(INPUT, SAVED)).toEqual([]);
  });

  it("confirma todos os campos críticos que o update grava", () => {
    expect([...CONTRACT_CONFIRMED_FIELDS].sort()).toEqual([
      "apply_vat", "cleaning_type", "fixed_monthly", "fixed_price", "num_people",
      "payment_status", "schedule_days", "status", "upholstery_notes",
      "upholstery_type", "upholstery_unit_price", "upholstery_units",
    ]);
  });

  it("uma divergência real continua a bloquear e a nomear o campo", () => {
    const adulterado = { ...SAVED, status: "pausado" };
    expect(contractWriteDivergences(INPUT, adulterado)).toEqual(["status"]);
  });

  it("uma divergência no padrão continua a bloquear", () => {
    const adulterado = { ...SAVED, schedule_days: [{ ...GRAVADO[0], duration_min: 60 }] };
    expect(contractWriteDivergences(INPUT, adulterado)).toEqual(["schedule_days"]);
  });

  it("número gravado como texto pela base não conta como divergência", () => {
    const comoTexto = { ...SAVED, fixed_price: "120.00" };
    const comValor = { ...INPUT, fixed_price: 120 };
    expect(contractWriteDivergences(comValor, comoTexto)).toEqual([]);
  });

  it("undefined no formulário e null/false na base são a mesma ausência", () => {
    const semCampos = { ...INPUT, cleaning_type: undefined, apply_vat: undefined, fixed_price: undefined };
    expect(contractWriteDivergences(semCampos, SAVED)).toEqual([]);
  });

  it("a mensagem não promete uma reversão que não aconteceu", () => {
    const msg = contractWriteMismatchMessage(["schedule_days"]);
    expect(msg).toContain("não correspondeu ao valor esperado");
    expect(msg).toContain("schedule_days");
    expect(msg).toContain("Atualize a página");
    // O UPDATE do contrato já correu quando esta verificação acontece.
    expect(msg).not.toContain("Nada foi considerado gravado");
  });
});

// ============================================================================
// Invariantes do que corre DEPOIS da confirmação. São garantidos pelos filtros
// das queries, por isso verificam-se na fonte: um filtro removido por engano é
// exatamente o tipo de alteração que apaga trabalho já feito por quem gere.
// ============================================================================

describe("o fluxo pós-confirmação da edição de contrato", () => {
  const source = readFileSync(
    join(__dirname, "..", "app", "actions", "contratos.ts"), "utf8",
  );

  /** Só o corpo de updateContrato — createContrato chama as mesmas funções. */
  const updateContrato = (() => {
    const inicio = source.indexOf("export async function updateContrato");
    expect(inicio, "updateContrato não encontrada").toBeGreaterThan(-1);
    const seguinte = source.indexOf("\nexport async function", inicio + 1);
    return source.slice(inicio, seguinte > -1 ? seguinte : undefined);
  })();

  const pos = (needle: string) => {
    const i = updateContrato.indexOf(needle);
    expect(i, `não encontrado em updateContrato: ${needle}`).toBeGreaterThan(-1);
    return i;
  };

  it("a confirmação usa a comparação semântica e não o JSON.stringify", () => {
    expect(source).toContain("contractWriteDivergences");
    expect(source).not.toContain("JSON.stringify(saved.schedule_days");
    expect(source).not.toContain("JSON.stringify(input.schedule_days");
  });

  it("passada a confirmação, a sincronização dos serviços corre pela ordem devida", () => {
    const confirmacao = pos("contractWriteDivergences");
    expect(pos("excluded_dates")).toBeGreaterThan(confirmacao);
    expect(pos("reconcileFutureServicesForContract(")).toBeGreaterThan(confirmacao);
    expect(pos("updateFutureServiceValuesForContract(")).toBeGreaterThan(pos("reconcileFutureServicesForContract("));
    expect(pos("generateServicesForContract(")).toBeGreaterThan(pos("updateFutureServiceValuesForContract("));
    expect(pos("revalidateBusinessPaths")).toBeGreaterThan(pos("generateServicesForContract("));
  });

  it("as datas apagadas de propósito são lidas e passadas à reconciliação", () => {
    expect(source).toContain("excluded_dates: excludedDates");
  });

  it("a reconciliação não apaga ocorrências editadas à mão", () => {
    expect(source).toContain("(s) => !s.is_exception");
  });

  it("a sincronização de valores salta as ocorrências editadas à mão", () => {
    expect(source).toContain("if (service.is_exception) continue");
  });

  it("só toca no que está agendado e ainda por acontecer", () => {
    // concluído, em curso, falta, cancelado e passado ficam de fora por filtro.
    expect(source).toContain(`.eq("status", "agendado")`);
    expect(source).toContain(`.gte("scheduled_start"`);
  });

  it("declara-se como sincronização legítima para o trigger não marcar exceção", () => {
    expect(source).toContain("contract_synced_at");
  });
});

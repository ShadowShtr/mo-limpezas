// ============================================================================
// MOTOR CANÓNICO DE RECORRÊNCIA (Task T07)
// ============================================================================
// Antes desta consolidação havia três implementações da recorrência — geração
// real, preview do formulário e coluna "próxima ocorrência" — e discordavam
// entre si. Estes testes fixam a regra única.
//
// Defeitos concretos que a matriz abaixo impede de voltar:
//
// 1. MENSAL SÓ NO PRIMEIRO MÊS — o cálculo usava o mês de `rangeStart` e mais
//    nenhum, por isso um intervalo de seis meses devolvia UMA ocorrência.
//
// 2. TRANSBORDO DO DIA 31 — `new Date(2026, 1, 31)` é 3 de março. Um contrato
//    ancorado no dia 31 saltava fevereiro e aterrava no mês seguinte. Pior, o
//    preview do formulário usava `setMonth(+1)` em cadeia, o que arrastava a
//    âncora para sempre (31/01 → 03/03 → 03/04 → …).
//
// 3. PARIDADE QUINZENAL PELO RELÓGIO — a semana era calculada com
//    `getTime() / (7 * 24 * 3600 * 1000)`. A hora que o horário de verão dá ou
//    tira desloca esse quociente, e um contrato quinzenal podia inverter a
//    semana ao atravessar a última semana de março ou de outubro.
//
// 4. DIA TROCADO PELA CONVERSÃO UTC — `.toISOString().slice(0, 10)` sobre uma
//    data à meia-noite local devolve o dia ANTERIOR sempre que o processo não
//    corre em UTC.
//
// As datas usadas aqui foram confirmadas uma a uma contra o calendário real de
// 2024–2027; não são exemplos inventados.
// ============================================================================

import { describe, it, expect } from "vitest";
import {
  occurrencesInRange,
  nextOccurrences,
  shiftWeekendForward,
  type RecurrenceRule,
} from "@/domain/scheduling/recurrence-engine";

function rule(overrides: Partial<RecurrenceRule> & { frequency: string }): RecurrenceRule {
  return {
    weekdays: null,
    intervalDays: 1,
    startsOn: "2026-07-01",
    endsOn: null,
    excludedDates: [],
    ...overrides,
  };
}

const range = (start: string, end: string) => ({ start, end });

// ─── desvio de fim de semana ────────────────────────────────────────────────

describe("shiftWeekendForward", () => {
  it.each([
    ["2026-07-18", "2026-07-20", "sábado → segunda (+2)"],
    ["2026-07-19", "2026-07-20", "domingo → segunda (+1)"],
    ["2026-07-15", "2026-07-15", "quarta fica na mesma"],
    ["2026-12-31", "2026-12-31", "quinta fica na mesma"],
    ["2027-01-31", "2027-02-01", "domingo atravessa o ano/mês"],
  ])("%s → %s (%s)", (input, expected) => {
    expect(shiftWeekendForward(input)).toBe(expected);
  });
});

// ─── diário ─────────────────────────────────────────────────────────────────

describe("diário", () => {
  it("um único dia útil", () => {
    const r = rule({ frequency: "daily", startsOn: "2026-07-01" });
    expect(occurrencesInRange(r, range("2026-07-01", "2026-07-01"))).toEqual(["2026-07-01"]);
  });

  it("nunca inclui sábado nem domingo", () => {
    const r = rule({ frequency: "daily", startsOn: "2026-07-01" });
    const out = occurrencesInRange(r, range("2026-07-01", "2026-07-31"));
    expect(out).toContain("2026-07-17"); // sexta
    expect(out).not.toContain("2026-07-18"); // sábado
    expect(out).not.toContain("2026-07-19"); // domingo
    expect(out).toHaveLength(23);
  });

  it("atravessa a mudança de mês", () => {
    const r = rule({ frequency: "daily", startsOn: "2026-07-01" });
    const out = occurrencesInRange(r, range("2026-07-30", "2026-08-04"));
    // 01 e 02/08 são sábado e domingo.
    expect(out).toEqual(["2026-07-30", "2026-07-31", "2026-08-03", "2026-08-04"]);
  });

  it("atravessa a mudança de ano", () => {
    const r = rule({ frequency: "daily", startsOn: "2020-01-01" });
    const out = occurrencesInRange(r, range("2026-12-30", "2027-01-04"));
    // 02 e 03/01/2027 são sábado e domingo.
    expect(out).toEqual(["2026-12-30", "2026-12-31", "2027-01-01", "2027-01-04"]);
  });
});

// ─── semanal ────────────────────────────────────────────────────────────────

describe("semanal", () => {
  it("todas as segundas", () => {
    const r = rule({ frequency: "weekly", weekdays: [1], startsOn: "2026-07-06" });
    expect(occurrencesInRange(r, range("2026-07-01", "2026-07-31"))).toEqual([
      "2026-07-06", "2026-07-13", "2026-07-20", "2026-07-27",
    ]);
  });

  it("domingo é um dia válido e é tratado como fim da semana", () => {
    const r = rule({ frequency: "weekly", weekdays: [0], startsOn: "2026-07-01" });
    expect(occurrencesInRange(r, range("2026-07-01", "2026-07-31"))).toEqual([
      "2026-07-05", "2026-07-12", "2026-07-19", "2026-07-26",
    ]);
  });

  it("sábado explicitamente escolhido NUNCA é empurrado", () => {
    const r = rule({ frequency: "weekly", weekdays: [6], startsOn: "2026-07-04" });
    const out = occurrencesInRange(r, range("2026-07-01", "2026-07-31"));
    expect(out).toEqual(["2026-07-04", "2026-07-11", "2026-07-18", "2026-07-25"]);
  });

  it("vários dias na mesma semana saem ordenados e sem repetição", () => {
    const r = rule({ frequency: "weekly", weekdays: [3, 1, 5, 1], startsOn: "2026-07-01" });
    expect(occurrencesInRange(r, range("2026-07-06", "2026-07-12"))).toEqual([
      "2026-07-06", "2026-07-08", "2026-07-10",
    ]);
  });

  it("contrato que começa a meio da semana não gera antes do início", () => {
    // Começa quarta-feira; segunda e sexta escolhidas.
    const r = rule({ frequency: "weekly", weekdays: [1, 5], startsOn: "2026-07-08" });
    const out = occurrencesInRange(r, range("2026-07-01", "2026-07-20"));
    expect(out).toEqual(["2026-07-10", "2026-07-13", "2026-07-17", "2026-07-20"]);
  });

  it("intervalo que começa a meio da semana corta pelo início do intervalo", () => {
    const r = rule({ frequency: "weekly", weekdays: [1, 3, 5], startsOn: "2026-07-01" });
    expect(occurrencesInRange(r, range("2026-07-09", "2026-07-14"))).toEqual([
      "2026-07-10", "2026-07-13",
    ]);
  });

  it("atravessa a mudança de ano", () => {
    const r = rule({ frequency: "weekly", weekdays: [4], startsOn: "2026-01-01" });
    expect(occurrencesInRange(r, range("2026-12-24", "2027-01-08"))).toEqual([
      "2026-12-24", "2026-12-31", "2027-01-07",
    ]);
  });
});

// ─── quinzenal e 3 em 3 semanas ─────────────────────────────────────────────

describe("quinzenal / 3 em 3 semanas", () => {
  it("quinzenal salta uma semana a partir da âncora", () => {
    const r = rule({ frequency: "biweekly", weekdays: [1], startsOn: "2026-07-06" });
    expect(occurrencesInRange(r, range("2026-07-01", "2026-08-31"))).toEqual([
      "2026-07-06", "2026-07-20", "2026-08-03", "2026-08-17", "2026-08-31",
    ]);
  });

  it("a âncora é a semana do início, mesmo pedindo um intervalo posterior", () => {
    const r = rule({ frequency: "biweekly", weekdays: [1], startsOn: "2026-07-06" });
    // Intervalo parcial no meio: a paridade tem de continuar a da âncora.
    expect(occurrencesInRange(r, range("2026-08-10", "2026-08-31"))).toEqual([
      "2026-08-17", "2026-08-31",
    ]);
  });

  it("3 em 3 semanas", () => {
    const r = rule({ frequency: "triweekly", weekdays: [2], startsOn: "2026-07-07" });
    const out = occurrencesInRange(r, range("2026-07-01", "2026-09-30"));
    expect(out).toEqual(["2026-07-07", "2026-07-28", "2026-08-18", "2026-09-08", "2026-09-29"]);
    expect(out).not.toContain("2026-07-14");
    expect(out).not.toContain("2026-07-21");
  });

  it("quinzenal atravessa o ano sem perder a paridade", () => {
    const r = rule({ frequency: "biweekly", weekdays: [1], startsOn: "2026-12-07" });
    expect(occurrencesInRange(r, range("2026-12-01", "2027-01-31"))).toEqual([
      "2026-12-07", "2026-12-21", "2027-01-04", "2027-01-18",
    ]);
  });

  // ── horário de verão ──
  // Portugal muda a hora a 29/03/2026 e a 25/10/2026. Com aritmética de
  // milissegundos a paridade destes dois casos invertia-se depois da mudança.

  it("DST de março não desloca a paridade quinzenal", () => {
    const r = rule({ frequency: "biweekly", weekdays: [1], startsOn: "2026-03-02" });
    expect(occurrencesInRange(r, range("2026-03-01", "2026-04-30"))).toEqual([
      "2026-03-02", "2026-03-16", "2026-03-30", "2026-04-13", "2026-04-27",
    ]);
  });

  it("DST de outubro não desloca a paridade quinzenal", () => {
    const r = rule({ frequency: "biweekly", weekdays: [1], startsOn: "2026-10-05" });
    expect(occurrencesInRange(r, range("2026-10-01", "2026-11-30"))).toEqual([
      "2026-10-05", "2026-10-19", "2026-11-02", "2026-11-16", "2026-11-30",
    ]);
  });

  it("DST não desloca a recorrência semanal simples", () => {
    const r = rule({ frequency: "weekly", weekdays: [0], startsOn: "2026-03-01" });
    // 29/03 é o próprio domingo da mudança da hora.
    expect(occurrencesInRange(r, range("2026-03-15", "2026-04-05"))).toEqual([
      "2026-03-15", "2026-03-22", "2026-03-29", "2026-04-05",
    ]);
  });

  it("sem dias da semana escolhidos não gera nada", () => {
    const r = rule({ frequency: "biweekly", weekdays: [], startsOn: "2026-07-06" });
    expect(occurrencesInRange(r, range("2026-07-01", "2026-12-31"))).toEqual([]);
  });
});

// ─── mensal ─────────────────────────────────────────────────────────────────

describe("mensal", () => {
  it("gera em TODOS os meses do intervalo, não só no primeiro", () => {
    const r = rule({ frequency: "monthly", startsOn: "2026-07-15" });
    expect(occurrencesInRange(r, range("2026-07-01", "2026-12-31"))).toEqual([
      "2026-07-15", "2026-08-17", "2026-09-15", "2026-10-15", "2026-11-16", "2026-12-15",
    ]);
    // 15/08 é sábado → 17; 15/11 é domingo → 16.
  });

  it("dia 31: limita ao último dia do mês SEM arrastar a âncora", () => {
    const r = rule({ frequency: "monthly", startsOn: "2026-01-31" });
    expect(occurrencesInRange(r, range("2026-01-01", "2026-06-30"))).toEqual([
      "2026-02-02", // 31/01 é sábado → segunda 02/02
      "2026-03-02", // fevereiro limitado a 28 (sábado) → segunda 02/03
      "2026-03-31", // âncora INTACTA: volta ao dia 31
      "2026-04-30", // abril só tem 30
      "2026-06-01", // 31/05 é domingo → segunda 01/06
      "2026-06-30", // junho só tem 30
    ]);
  });

  it("dia 30 em fevereiro cai no dia 28", () => {
    const r = rule({ frequency: "monthly", startsOn: "2026-01-30" });
    const out = occurrencesInRange(r, range("2026-02-01", "2026-02-28"));
    expect(out).toEqual(["2026-03-02"]); // 28/02/2026 é sábado → segunda
  });

  it("dia 29 num fevereiro comum cai no dia 28", () => {
    const r = rule({ frequency: "monthly", startsOn: "2026-01-29" });
    expect(occurrencesInRange(r, range("2026-02-01", "2026-02-28"))).toEqual(["2026-03-02"]);
  });

  it("dia 29 num ano BISSEXTO acontece mesmo a 29", () => {
    const r = rule({ frequency: "monthly", startsOn: "2024-01-29" });
    expect(occurrencesInRange(r, range("2024-02-01", "2024-02-29"))).toEqual(["2024-02-29"]);
  });

  it("dia 31 num ano bissexto cai a 29 de fevereiro", () => {
    const r = rule({ frequency: "monthly", startsOn: "2024-01-31" });
    expect(occurrencesInRange(r, range("2024-02-01", "2024-02-29"))).toEqual(["2024-02-29"]);
  });

  it("dia 1 em meses que começam ao fim de semana", () => {
    const r = rule({ frequency: "monthly", startsOn: "2026-07-01" });
    expect(occurrencesInRange(r, range("2026-07-01", "2026-11-30"))).toEqual([
      "2026-07-01", "2026-08-03", "2026-09-01", "2026-10-01", "2026-11-02",
    ]);
  });

  it("dia 28 mantém-se ao longo de vários anos", () => {
    const r = rule({ frequency: "monthly", startsOn: "2026-01-28" });
    const out = occurrencesInRange(r, range("2026-12-01", "2027-03-31"));
    expect(out).toEqual(["2026-12-28", "2027-01-28", "2027-03-01", "2027-03-29"]);
    // 28/02/2027 é domingo → 01/03; 28/03/2027 é domingo → 29/03.
  });

  it("a ocorrência empurrada para o mês seguinte pertence a esse intervalo", () => {
    // Regressão: com a janela só a partir do mês do intervalo, a ocorrência de
    // 31/01 empurrada para 02/02 desaparecia ao consultar fevereiro — e a
    // reconciliação de contratos apagava o serviço por o julgar órfão.
    const r = rule({ frequency: "monthly", startsOn: "2026-01-31" });
    expect(occurrencesInRange(r, range("2026-02-01", "2026-02-28"))).toContain("2026-02-02");
  });

  it("respeita ends_on mesmo depois do desvio", () => {
    const r = rule({ frequency: "monthly", startsOn: "2026-01-17", endsOn: "2026-10-18" });
    // 17/10/2026 é sábado → o desvio cairia a 19/10, já depois do fim.
    expect(occurrencesInRange(r, range("2026-10-01", "2026-10-31"))).toEqual([]);
  });
});

// ─── personalizado ──────────────────────────────────────────────────────────

describe("personalizado (a cada N dias)", () => {
  it("intervalo de 10 dias, com desvio de fim de semana", () => {
    const r = rule({ frequency: "custom", intervalDays: 10, startsOn: "2026-07-01" });
    expect(occurrencesInRange(r, range("2026-07-01", "2026-07-31"))).toEqual([
      "2026-07-01", "2026-07-13", "2026-07-21", "2026-07-31",
    ]);
  });

  it("nunca gera o mesmo dia duas vezes quando duas bases são empurradas para lá", () => {
    // Sábado e domingo seguidos caem os dois na mesma segunda-feira.
    const r = rule({ frequency: "custom", intervalDays: 1, startsOn: "2026-07-17" });
    const out = occurrencesInRange(r, range("2026-07-17", "2026-07-21"));
    expect(out).toEqual(["2026-07-17", "2026-07-20", "2026-07-21"]);
    expect(new Set(out).size).toBe(out.length);
  });

  it("intervalo de 1 dia comporta-se como dias úteis", () => {
    const r = rule({ frequency: "custom", intervalDays: 1, startsOn: "2026-07-01" });
    const out = occurrencesInRange(r, range("2026-07-01", "2026-07-10"));
    expect(out).toEqual([
      "2026-07-01", "2026-07-02", "2026-07-03", "2026-07-06",
      "2026-07-07", "2026-07-08", "2026-07-09", "2026-07-10",
    ]);
  });

  it("intervalo inválido (0 ou negativo) é tratado como 1 dia e não entra em ciclo", () => {
    const r = rule({ frequency: "custom", intervalDays: 0, startsOn: "2026-07-01" });
    expect(occurrencesInRange(r, range("2026-07-01", "2026-07-03"))).toEqual([
      "2026-07-01", "2026-07-02", "2026-07-03",
    ]);
  });

  it("intervalo distante não percorre anos de contrato (desempenho)", () => {
    // O contrato começou em 2020 e só se pede um mês de 2026. A implementação
    // antiga iterava dia a dia desde 2020 para deitar tudo fora a seguir.
    const r = rule({ frequency: "custom", intervalDays: 3, startsOn: "2020-01-01" });
    const started = Date.now();
    const out = occurrencesInRange(r, range("2026-08-01", "2026-08-31"));
    expect(Date.now() - started).toBeLessThan(50);
    expect(out.length).toBeGreaterThan(0);
    expect(out.every((d) => d >= "2026-08-01" && d <= "2026-09-02")).toBe(true);
  });

  it("um intervalo muito à frente continua alinhado com a âncora do contrato", () => {
    const r = rule({ frequency: "custom", intervalDays: 7, startsOn: "2026-07-01" });
    const out = occurrencesInRange(r, range("2027-07-01", "2027-07-31"));
    // 01/07/2026 + 52×7 = 30/06/2027 (quarta) → a série de 2027 mantém-se à quarta.
    expect(out).toContain("2027-07-07");
    expect(out).toContain("2027-07-14");
  });
});

// ─── limites e entradas inválidas ───────────────────────────────────────────

describe("limites", () => {
  it("intervalo de um só dia", () => {
    const r = rule({ frequency: "weekly", weekdays: [1], startsOn: "2026-07-01" });
    expect(occurrencesInRange(r, range("2026-07-06", "2026-07-06"))).toEqual(["2026-07-06"]);
  });

  it("intervalo inteiramente antes do contrato", () => {
    const r = rule({ frequency: "daily", startsOn: "2026-07-01" });
    expect(occurrencesInRange(r, range("2026-05-01", "2026-06-30"))).toEqual([]);
  });

  it("intervalo inteiramente depois do fim do contrato", () => {
    const r = rule({ frequency: "daily", startsOn: "2026-01-01", endsOn: "2026-06-30" });
    expect(occurrencesInRange(r, range("2026-07-01", "2026-07-31"))).toEqual([]);
  });

  it("contrato sem fim continua a gerar", () => {
    const r = rule({ frequency: "weekly", weekdays: [1], startsOn: "2020-01-06", endsOn: null });
    expect(occurrencesInRange(r, range("2027-01-01", "2027-01-31")).length).toBe(4);
  });

  it("intervalo invertido não gera nada", () => {
    const r = rule({ frequency: "daily", startsOn: "2026-07-01" });
    expect(occurrencesInRange(r, range("2026-07-31", "2026-07-01"))).toEqual([]);
  });

  it("fim anterior ao início não gera nada", () => {
    const r = rule({ frequency: "daily", startsOn: "2026-07-31", endsOn: "2026-07-01" });
    expect(occurrencesInRange(r, range("2026-07-01", "2026-07-31"))).toEqual([]);
  });

  it.each([
    ["72026-01-01", "ano com um dígito a mais (corrupção real de produção)"],
    ["2026-02-30", "dia que não existe no mês"],
    ["2026-13-01", "mês inexistente"],
    ["2026-00-10", "mês zero"],
    ["2026-1-1", "sem zeros à esquerda"],
    ["", "vazio"],
    ["ontem", "texto"],
  ])("starts_on inválido (%s) não gera nada — %s", (starts) => {
    const r = rule({ frequency: "daily", startsOn: starts });
    expect(occurrencesInRange(r, range("2026-07-01", "2026-07-31"))).toEqual([]);
  });

  it("ends_on inválido não gera nada em vez de gerar sem limite", () => {
    const r = rule({ frequency: "daily", startsOn: "2026-07-01", endsOn: "2026-02-30" });
    expect(occurrencesInRange(r, range("2026-07-01", "2026-07-31"))).toEqual([]);
  });

  it("frequência desconhecida não gera nada", () => {
    const r = rule({ frequency: "trimestral", startsOn: "2026-07-01" });
    expect(occurrencesInRange(r, range("2026-07-01", "2026-12-31"))).toEqual([]);
  });

  it("datas excluídas nunca são recriadas", () => {
    const r = rule({
      frequency: "weekly",
      weekdays: [1],
      startsOn: "2026-07-06",
      excludedDates: ["2026-07-13", "2026-07-27"],
    });
    expect(occurrencesInRange(r, range("2026-07-01", "2026-07-31"))).toEqual([
      "2026-07-06", "2026-07-20",
    ]);
  });

  it("a exclusão aplica-se à data JÁ empurrada", () => {
    const r = rule({
      frequency: "monthly",
      startsOn: "2026-01-31",
      excludedDates: ["2026-02-02"],
    });
    expect(occurrencesInRange(r, range("2026-01-01", "2026-01-31"))).toEqual([]);
  });
});

// ─── próximas ocorrências (previews) ────────────────────────────────────────

describe("nextOccurrences", () => {
  it("devolve exatamente o número pedido", () => {
    const r = rule({ frequency: "weekly", weekdays: [1], startsOn: "2026-07-06" });
    expect(nextOccurrences(r, "2026-07-01", 3)).toEqual([
      "2026-07-06", "2026-07-13", "2026-07-20",
    ]);
  });

  it("nunca devolve datas anteriores ao ponto de partida", () => {
    const r = rule({ frequency: "daily", startsOn: "2020-01-01" });
    expect(nextOccurrences(r, "2026-07-15", 5).every((d) => d >= "2026-07-15")).toBe(true);
  });

  it("atravessa várias janelas para chegar ao número pedido (mensal)", () => {
    const r = rule({ frequency: "monthly", startsOn: "2026-07-15" });
    const out = nextOccurrences(r, "2026-07-01", 12);
    expect(out).toHaveLength(12);
    expect(out[0]).toBe("2026-07-15");
    expect(out[11]).toBe("2027-06-15");
  });

  it("pára no fim do contrato em vez de inventar ocorrências", () => {
    const r = rule({ frequency: "weekly", weekdays: [1], startsOn: "2026-07-06", endsOn: "2026-07-20" });
    expect(nextOccurrences(r, "2026-07-01", 10)).toEqual([
      "2026-07-06", "2026-07-13", "2026-07-20",
    ]);
  });

  it("contrato já terminado devolve lista vazia sem varrer o horizonte todo", () => {
    const r = rule({ frequency: "daily", startsOn: "2020-01-01", endsOn: "2021-01-01" });
    const started = Date.now();
    expect(nextOccurrences(r, "2026-07-01", 12)).toEqual([]);
    expect(Date.now() - started).toBeLessThan(50);
  });

  it("concorda com occurrencesInRange — o preview mostra o que é gerado", () => {
    const r = rule({ frequency: "monthly", startsOn: "2026-01-31" });
    const preview = nextOccurrences(r, "2026-01-01", 6);
    const real = occurrencesInRange(r, range("2026-01-01", "2026-06-30"));
    expect(preview).toEqual(real);
  });

  it("count zero ou negativo devolve vazio", () => {
    const r = rule({ frequency: "daily", startsOn: "2026-07-01" });
    expect(nextOccurrences(r, "2026-07-01", 0)).toEqual([]);
    expect(nextOccurrences(r, "2026-07-01", -3)).toEqual([]);
  });
});

// ─── invariantes (propriedades sobre toda a matriz) ─────────────────────────

const RULE_MATRIX: Array<{ nome: string; regra: RecurrenceRule }> = [
  { nome: "diário", regra: rule({ frequency: "daily", startsOn: "2026-01-05" }) },
  { nome: "semanal 1 dia", regra: rule({ frequency: "weekly", weekdays: [3], startsOn: "2026-01-07" }) },
  { nome: "semanal 3 dias", regra: rule({ frequency: "weekly", weekdays: [1, 3, 5], startsOn: "2026-01-05" }) },
  { nome: "semanal domingo", regra: rule({ frequency: "weekly", weekdays: [0], startsOn: "2026-01-04" }) },
  { nome: "quinzenal", regra: rule({ frequency: "biweekly", weekdays: [2], startsOn: "2026-01-06" }) },
  { nome: "3 em 3 semanas", regra: rule({ frequency: "triweekly", weekdays: [4], startsOn: "2026-01-01" }) },
  { nome: "mensal dia 1", regra: rule({ frequency: "monthly", startsOn: "2026-01-01" }) },
  { nome: "mensal dia 15", regra: rule({ frequency: "monthly", startsOn: "2026-01-15" }) },
  { nome: "mensal dia 29", regra: rule({ frequency: "monthly", startsOn: "2026-01-29" }) },
  { nome: "mensal dia 30", regra: rule({ frequency: "monthly", startsOn: "2026-01-30" }) },
  { nome: "mensal dia 31", regra: rule({ frequency: "monthly", startsOn: "2026-01-31" }) },
  { nome: "personalizado 3 dias", regra: rule({ frequency: "custom", intervalDays: 3, startsOn: "2026-01-02" }) },
  { nome: "personalizado 45 dias", regra: rule({ frequency: "custom", intervalDays: 45, startsOn: "2026-01-02" }) },
  { nome: "com fim", regra: rule({ frequency: "daily", startsOn: "2026-01-05", endsOn: "2026-09-30" }) },
  { nome: "com exclusões", regra: rule({ frequency: "weekly", weekdays: [1], startsOn: "2026-01-05", excludedDates: ["2026-03-02", "2026-10-26"] }) },
];

const RANGE_MATRIX = [
  range("2026-01-01", "2026-01-31"),
  range("2026-02-01", "2026-02-28"),
  range("2026-03-01", "2026-03-31"), // DST março
  range("2026-06-15", "2026-07-15"), // a meio de dois meses
  range("2026-10-01", "2026-10-31"), // DST outubro
  range("2026-12-15", "2027-01-15"), // atravessa o ano
  range("2026-01-01", "2026-12-31"), // ano inteiro
  range("2027-05-10", "2027-05-10"), // um só dia, longe do início
];

// Frequências que empurram fim de semana podem ultrapassar o fim do intervalo
// em até 2 dias — é deliberado e está documentado no motor.
const PODE_ULTRAPASSAR = new Set(["monthly", "custom"]);

describe("invariantes em toda a matriz", () => {
  for (const { nome, regra } of RULE_MATRIX) {
    for (const intervalo of RANGE_MATRIX) {
      const etiqueta = `${nome} · ${intervalo.start}→${intervalo.end}`;

      it(`${etiqueta}: ordenado, sem repetições e dentro dos limites`, () => {
        const out = occurrencesInRange(regra, intervalo);

        expect([...out].sort()).toEqual(out);
        expect(new Set(out).size).toBe(out.length);

        for (const d of out) {
          expect(d >= intervalo.start).toBe(true);
          expect(d >= regra.startsOn).toBe(true);
          if (regra.endsOn) expect(d <= regra.endsOn).toBe(true);
          expect(regra.excludedDates ?? []).not.toContain(d);
          if (PODE_ULTRAPASSAR.has(regra.frequency)) {
            // No máximo o desvio de sábado (+2 dias).
            expect(d <= addDaysSimples(intervalo.end, 2)).toBe(true);
          } else {
            expect(d <= intervalo.end).toBe(true);
          }
        }
      });

      it(`${etiqueta}: determinístico`, () => {
        expect(occurrencesInRange(regra, intervalo)).toEqual(
          occurrencesInRange(regra, intervalo),
        );
      });
    }
  }
});

/** Soma dias sem depender do módulo em teste (verificação independente). */
function addDaysSimples(date: string, days: number): string {
  const [y, m, d] = date.split("-").map(Number);
  return new Date(Date.UTC(y, m - 1, d + days)).toISOString().slice(0, 10);
}

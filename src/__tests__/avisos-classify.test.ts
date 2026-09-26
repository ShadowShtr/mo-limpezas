// ============================================================================
// A CLASSIFICAÇÃO DOS AVISOS — a parte que não pode depender do relógio
// ============================================================================
//
// 🔴 Nenhum destes ensaios usa `new Date()`. As datas entram como texto e saem
//    como grupo, e é isso que permite ensaiar a meia-noite, a viragem do mês e
//    a mudança de hora sem mexer no relógio da máquina.
// ============================================================================

import { describe, expect, it } from "vitest";
import {
  agruparPorUrgencia,
  avisoKey,
  classificar,
  ordenarAvisos,
} from "@/domain/avisos/classify";
import { dedupeKey, type AvisoItem } from "@/domain/avisos/types";

const HOJE = "2026-09-26";
const AMANHA = "2026-09-27";

const item = (patch: Partial<AvisoItem> = {}): AvisoItem => ({
  key: "pagamento:p1",
  source: "pagamento",
  itemId: "p1",
  date: HOJE,
  urgencia: "hoje",
  title: "Seguro",
  detail: "Vencimento",
  href: "/dashboard/financeiro/pagamentos",
  ...patch,
});

describe("A/B/C/D — os quatro casos da janela", () => {
  it("A: ontem é atrasado", () => {
    expect(classificar("2026-09-25", HOJE, AMANHA)).toBe("atrasado");
  });

  it("B: hoje é hoje", () => {
    expect(classificar(HOJE, HOJE, AMANHA)).toBe("hoje");
  });

  it("C: amanhã é amanhã", () => {
    expect(classificar(AMANHA, HOJE, AMANHA)).toBe("amanha");
  });

  it("D: depois de amanhã fica de fora", () => {
    expect(classificar("2026-09-28", HOJE, AMANHA)).toBeNull();
  });

  it("uma data muito antiga continua a ser apenas atrasado", () => {
    expect(classificar("2019-01-01", HOJE, AMANHA)).toBe("atrasado");
  });

  it("um futuro distante continua a ficar de fora", () => {
    expect(classificar("2030-01-01", HOJE, AMANHA)).toBeNull();
  });
});

describe("E — comparação de datas sem fuso horário", () => {
  // 🔴 O caso que mata: em Lisboa, no verão, `new Date("2026-09-01")` é 31 de
  //    Agosto às 23h00 UTC. Uma implementação que convertesse para `Date` antes
  //    de comparar diria que o dia 1 está atrasado no próprio dia 1.
  it("o primeiro dia do mês em horário de verão não escorrega para o mês anterior", () => {
    expect(classificar("2026-09-01", "2026-09-01", "2026-09-02")).toBe("hoje");
  });

  it("a viragem do mês é apenas texto", () => {
    expect(classificar("2026-08-31", "2026-09-01", "2026-09-02")).toBe("atrasado");
    expect(classificar("2026-10-01", "2026-09-30", "2026-10-01")).toBe("amanha");
  });

  it("a viragem do ano também", () => {
    expect(classificar("2026-12-31", "2027-01-01", "2027-01-02")).toBe("atrasado");
    expect(classificar("2027-01-01", "2026-12-31", "2027-01-01")).toBe("amanha");
  });

  it("a mudança de hora não tem efeito: são datas civis, não instantes", () => {
    // Último domingo de Outubro de 2026 — o dia em que o relógio recua.
    expect(classificar("2026-10-25", "2026-10-25", "2026-10-26")).toBe("hoje");
    expect(classificar("2026-10-24", "2026-10-25", "2026-10-26")).toBe("atrasado");
  });
});

describe("F — a ordem é previsível e total", () => {
  it("urgência primeiro: atrasado, hoje, amanhã", () => {
    const fora = [
      item({ key: "a", urgencia: "amanha", date: AMANHA }),
      item({ key: "b", urgencia: "hoje", date: HOJE }),
      item({ key: "c", urgencia: "atrasado", date: "2026-09-20" }),
    ];
    expect(ordenarAvisos(fora).map((i) => i.urgencia)).toEqual(["atrasado", "hoje", "amanha"]);
  });

  it("dentro da mesma urgência, a data mais antiga primeiro", () => {
    const fora = [
      item({ key: "a", urgencia: "atrasado", date: "2026-09-24" }),
      item({ key: "b", urgencia: "atrasado", date: "2026-09-10" }),
    ];
    expect(ordenarAvisos(fora).map((i) => i.date)).toEqual(["2026-09-10", "2026-09-24"]);
  });

  it("no mesmo dia, o dinheiro vem primeiro", () => {
    const fora = [
      item({ key: "lead:l1", source: "lead", itemId: "l1" }),
      item({ key: "visita:v1", source: "visita", itemId: "v1" }),
      item({ key: "tarefa:t1", source: "tarefa", itemId: "t1" }),
      item({ key: "pagamento:p1", source: "pagamento", itemId: "p1" }),
    ];
    expect(ordenarAvisos(fora).map((i) => i.source))
      .toEqual(["pagamento", "tarefa", "visita", "lead"]);
  });

  it("a ordem é estável: a mesma entrada dá sempre a mesma saída", () => {
    const lista = [
      item({ key: "pagamento:b", itemId: "b", title: "Água" }),
      item({ key: "pagamento:a", itemId: "a", title: "Água" }),
      item({ key: "pagamento:c", itemId: "c", title: "Água" }),
    ];
    const uma = ordenarAvisos(lista).map((i) => i.key);
    const outra = ordenarAvisos([...lista].reverse()).map((i) => i.key);
    expect(outra).toEqual(uma);
  });

  it("não modifica a lista que recebe", () => {
    const original = [
      item({ key: "a", urgencia: "amanha" }),
      item({ key: "b", urgencia: "atrasado" }),
    ];
    const antes = original.map((i) => i.key);
    ordenarAvisos(original);
    expect(original.map((i) => i.key)).toEqual(antes);
  });
});

describe("agrupamento e identidade", () => {
  it("devolve os três grupos, mesmo vazios", () => {
    const g = agruparPorUrgencia([item({ urgencia: "hoje" })]);
    expect(Object.keys(g).sort()).toEqual(["amanha", "atrasado", "hoje"]);
    expect(g.atrasado).toEqual([]);
    expect(g.hoje).toHaveLength(1);
  });

  it("cada grupo vem ordenado por dentro", () => {
    const g = agruparPorUrgencia([
      item({ key: "a", urgencia: "atrasado", date: "2026-09-24" }),
      item({ key: "b", urgencia: "atrasado", date: "2026-09-10" }),
    ]);
    expect(g.atrasado.map((i) => i.date)).toEqual(["2026-09-10", "2026-09-24"]);
  });

  // 🔴 Duas fontes diferentes podem ter o mesmo uuid sem que isso queira dizer
  //    nada. Se a chave fosse só o id, o React trataria as duas linhas como a
  //    mesma posição.
  it("a chave separa fontes que partilhem o mesmo id", () => {
    const mesmo = "00000000-0000-0000-0000-000000000001";
    expect(avisoKey("pagamento", mesmo)).not.toBe(avisoKey("tarefa", mesmo));
  });
});

describe("chave de dedupe", () => {
  it("é estável dentro do mesmo dia", () => {
    expect(dedupeKey(HOJE, "pagamento", "p1")).toBe(dedupeKey(HOJE, "pagamento", "p1"));
  });

  // 🔴 O caso que justifica `today` em vez da data do item: um pagamento
  //    vencido a 10/09 tem `date` fixo, mas tem de voltar a avisar todos os
  //    dias enquanto continuar por pagar.
  it("muda de um dia para o outro, para o aviso voltar", () => {
    expect(dedupeKey("2026-09-26", "pagamento", "p1"))
      .not.toBe(dedupeKey("2026-09-27", "pagamento", "p1"));
  });

  it("separa fontes e itens", () => {
    expect(dedupeKey(HOJE, "pagamento", "x")).not.toBe(dedupeKey(HOJE, "tarefa", "x"));
    expect(dedupeKey(HOJE, "tarefa", "x")).not.toBe(dedupeKey(HOJE, "tarefa", "y"));
  });
});

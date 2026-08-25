// ============================================================================
// COMPETÊNCIA MENSAL DOS PAGAMENTOS
// ============================================================================
//
// O utilizador viu, com o seletor num mês, linhas com vencimento em julho,
// agosto, novembro, fevereiro de 2027 e maio de 2027.
//
// A consulta mensal não era a culpada: `getPayments` filtra por
// `period_year`/`period_month` com igualdade exata, e sempre filtrou. O que
// estava errado era o valor que lá ia parar.
//
//     period_year:  input.year,     // ← o mês que estava aberto no ecrã
//     period_month: input.month,    //   quando alguém carregou em "guardar"
//
// E `updatePayment` alterava o `due_date` sem tocar na competência: 15/07 para
// 15/08 deixava a linha em julho, com data de agosto à frente.
//
// Medido em produção a 2026-08-25: **29 de 84** pagamentos com vencimento
// tinham competência diferente do mês do vencimento — incluindo as três
// ocorrências do seguro trimestral, todas debaixo do mesmo mês.
//
// Os casos A–G abaixo são os que a ordem pediu, pela mesma ordem.
// ============================================================================
import { describe, it, expect } from "vitest";
import fs from "node:fs";
import path from "node:path";
import {
  competenceFromDueDate,
  resolveCompetence,
  competenceChanged,
  competenceCorrectionFor,
  competenceKey,
} from "@/domain/finance/payment-competence";

const ROOT = path.join(__dirname, "..", "..");
const ler = (p: string) => fs.readFileSync(path.join(ROOT, p), "utf8").replace(/\r\n/g, "\n");

/** O mês que estava aberto no ecrã — nunca deve ganhar a um vencimento. */
const NO_ECRA = { year: 2026, month: 6 };

describe("competência derivada do vencimento", () => {
  it("A. vencimento 11/07/2026 não pertence a junho", () => {
    const c = resolveCompetence({ dueDate: "2026-07-11", fallback: NO_ECRA });
    expect(competenceKey(c)).toBe("2026-07");
    expect(competenceKey(c)).not.toBe("2026-06");
  });

  it("B. vencimento 11/07/2026 pertence a julho", () => {
    expect(competenceFromDueDate("2026-07-11")).toEqual({ year: 2026, month: 7 });
  });

  it("C. 🔴 criado em junho com vencimento 03/08/2026 → agosto", () => {
    // O caso que o utilizador viu: o mês aberto não decide nada.
    const c = resolveCompetence({ dueDate: "2026-08-03", fallback: NO_ECRA });
    expect(competenceKey(c)).toBe("2026-08");
  });

  it("D. 🔴 editar 03/08 para 03/09 muda a competência", () => {
    const antes = competenceFromDueDate("2026-08-03")!;
    const depois = competenceFromDueDate("2026-09-03")!;

    expect(competenceChanged(antes, depois)).toBe(true);
    expect(competenceKey(depois)).toBe("2026-09");
  });

  it("E. 🔴 recorrência trimestral: cada ocorrência no seu mês", () => {
    // Allianz Seguro, 83,56 €, de três em três meses. Em produção as três
    // ocorrências futuras estavam todas debaixo de 2026-07.
    const ocorrencias = ["2026-08-03", "2026-11-03", "2027-02-03", "2027-05-03"];
    const meses = ocorrencias.map((d) => competenceKey(competenceFromDueDate(d)!));

    expect(meses).toEqual(["2026-08", "2026-11", "2027-02", "2027-05"]);
    // Nenhuma delas cai em junho, que era onde apareciam todas juntas.
    expect(meses).not.toContain("2026-06");
    // E são quatro meses distintos, não um só.
    expect(new Set(meses).size).toBe(4);
  });

  it("F. vencido e por pagar continua a pertencer ao seu mês", () => {
    // Estar em atraso é um estado, não uma mudança de competência. Um
    // pagamento de agosto não passa a aparecer em setembro por continuar
    // pendente.
    const c = competenceFromDueDate("2026-08-03")!;
    expect(competenceKey(c)).toBe("2026-08");

    // A correção só olha para a data — o estado não entra na conta.
    expect(
      competenceCorrectionFor({ due_date: "2026-08-03", period_year: 2026, period_month: 8 }),
    ).toBeNull();
  });

  it("G. sem vencimento, fica o mês do registo", () => {
    // IVA, Segurança Social, algumas rendas: não têm data, e o mês em que
    // foram registados é a única informação temporal que existe.
    expect(resolveCompetence({ dueDate: null, fallback: NO_ECRA })).toEqual(NO_ECRA);
    expect(resolveCompetence({ dueDate: undefined, fallback: NO_ECRA })).toEqual(NO_ECRA);
    // E nunca fica sem mês nenhum.
    expect(competenceKey(resolveCompetence({ dueDate: null, fallback: NO_ECRA }))).toMatch(
      /^\d{4}-\d{2}$/,
    );
  });
});

describe("datas que não se deixam interpretar", () => {
  it("uma data malformada não inventa um mês", () => {
    // Este projeto já teve um `starts_on` com o ano `72026` a rebentar páginas.
    // Um `Number("7202")` silencioso seria a mesma armadilha noutro sítio.
    for (const má of ["72026-01-01", "2026-13-01", "2026-00-05", "2026-08", "", "ontem", "2026/08/03"]) {
      expect(competenceFromDueDate(má), má).toBeNull();
    }
  });

  it("uma data malformada cai no mês do registo, não em silêncio", () => {
    expect(resolveCompetence({ dueDate: "2026-13-01", fallback: NO_ECRA })).toEqual(NO_ECRA);
  });

  it("o primeiro dia do mês não escorrega para o mês anterior", () => {
    // `new Date("2026-08-01")` é meia-noite UTC; lido em Lisboa no verão, dá
    // 31 de julho. Por isso a regra não passa por `Date`.
    expect(competenceFromDueDate("2026-08-01")).toEqual({ year: 2026, month: 8 });
    expect(competenceFromDueDate("2026-01-01")).toEqual({ year: 2026, month: 1 });
    expect(competenceFromDueDate("2026-12-31")).toEqual({ year: 2026, month: 12 });
  });
});

describe("diagnóstico de linhas já existentes", () => {
  it("aponta a correção de uma linha divergente", () => {
    // O caso real: SERVISYNC, vencimento 09/11/2026, competência 2026-06.
    expect(
      competenceCorrectionFor({ due_date: "2026-11-09", period_year: 2026, period_month: 6 }),
    ).toEqual({ year: 2026, month: 11 });
  });

  it("não toca em linhas já corretas", () => {
    expect(
      competenceCorrectionFor({ due_date: "2026-06-15", period_year: 2026, period_month: 6 }),
    ).toBeNull();
  });

  it("🔴 não toca em linhas sem vencimento", () => {
    // Não há de onde derivar. Uma correção automática que lhes mexesse estaria
    // a inventar o mês a que pertencem.
    expect(
      competenceCorrectionFor({ due_date: null, period_year: 2026, period_month: 6 }),
    ).toBeNull();
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// Guardas permanentes — a regra tem de estar ligada onde escreve
// ═══════════════════════════════════════════════════════════════════════════

describe("as actions usam a regra, não o mês do ecrã", () => {
  const actions = () => ler("src/app/actions/payments.ts");

  it("createPayment deriva a competência do vencimento", () => {
    const fonte = actions();
    expect(fonte).toMatch(/resolveCompetence\(/);
    // O que lá estava antes: gravar o mês aberto no ecrã, cru.
    expect(fonte).not.toMatch(/period_year:\s*input\.year/);
    expect(fonte).not.toMatch(/period_month:\s*input\.month/);
  });

  it("🔴 updatePayment recalcula a competência ao mudar a data", () => {
    const fonte = actions();
    const i = fonte.indexOf("export async function updatePayment");
    expect(i).toBeGreaterThan(-1);
    const corpo = fonte.slice(i, fonte.indexOf("\n}\n", i));

    expect(corpo).toMatch(/competenceFromDueDate\(/);
    expect(corpo).toMatch(/period_year/);
  });

  it("a consulta mensal continua a filtrar por competência exata", () => {
    // Não era ela a culpada, e não pode ser afrouxada para "corrigir" o
    // sintoma — trocar isto por um intervalo de datas deixaria de fora os
    // pagamentos sem vencimento.
    const fonte = actions();
    expect(fonte).toMatch(/\.eq\("period_year",\s*year\)/);
    expect(fonte).toMatch(/\.eq\("period_month",\s*month\)/);
  });

  it("editar move a linha, não cria outra", () => {
    // Um `insert` no caminho de edição significaria duas linhas para o mesmo
    // facto económico — e o anexo, a conciliação e a auditoria ficariam na
    // linha velha.
    const fonte = actions();
    const i = fonte.indexOf("export async function updatePayment");
    const corpo = fonte.slice(i, fonte.indexOf("\n}\n", i));

    expect(corpo).not.toMatch(/\.insert\(/);
    expect(corpo).not.toMatch(/\.delete\(/);
  });
});

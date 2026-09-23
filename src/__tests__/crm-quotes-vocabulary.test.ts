// ============================================================================
// Orçamentos — o vocabulário do runtime bate com o contrato da base
// ============================================================================
//
// Análise determinística: lê o SQL da 103 e compara-o com `src/lib/crm/quotes.ts`.
// Sem base de dados e sem rede.
//
// 🔴 O defeito que esta suite trava não é hipotético.
//
//    Uma lista de estados a mais no runtime oferece ao utilizador um botão que
//    a base recusa — e o erro só aparece DEPOIS de ele carregar. Uma a menos
//    esconde um caminho legítimo: foi o que aconteceu quando `enviado` foi
//    retirado das transições «porque só o email o pode marcar», e o orçamento
//    ficava preso em rascunho para sempre.
//
//    Por isso a comparação é de CONJUNTOS, nos dois sentidos. «Nenhum estado a
//    mais» sozinho não apanharia o segundo caso.
// ============================================================================

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import {
  allowedQuoteTransitions,
  decimalPlaces,
  hasMaxDecimalPlaces,
  QUOTE_ARITHMETIC_DECIMAL_PLACES,
  QUOTE_DISCOUNT_MAX_DECIMAL_PLACES,
  QUOTE_ITEM_MAX_DECIMAL_PLACES,
  canReviseQuote,
  canTransitionQuote,
  isQuoteFinal,
  isQuoteStatus,
  QUOTE_PRICING_KINDS,
  QUOTE_REVISABLE_STATUSES,
  QUOTE_STATUSES,
  QUOTE_STATUS_LABELS,
  QUOTE_TRANSITIONS,
  QUOTE_UNITS,
  quoteNumberRoot,
  totaisDoOrcamento,
  type QuoteStatus,
} from "@/lib/crm/quotes";

const ROOT = process.cwd();
const SQL_103 = readFileSync(join(ROOT, "supabase/migrations/103_crm_orcamentos.sql"), "utf8");

/** Os valores de um `CHECK (<coluna> IN ('a', 'b', …))` da migration. */
function valoresDoCheck(coluna: string): string[] {
  const m = SQL_103.match(new RegExp(`CHECK\\s*\\(${coluna}\\s+IN\\s*\\(([^)]*)\\)`));
  if (!m) throw new Error(`CHECK de ${coluna} não encontrado na 103`);
  return [...m[1].matchAll(/'([^']+)'/g)].map((x) => x[1]);
}

describe("estados — a lista é a do CHECK da 103", () => {
  it("🔴 os mesmos valores, nos dois sentidos", () => {
    expect([...QUOTE_STATUSES].sort()).toEqual(valoresDoCheck("status").sort());
  });

  it("cada estado tem etiqueta", () => {
    for (const s of QUOTE_STATUSES) {
      expect(QUOTE_STATUS_LABELS[s], `${s} sem etiqueta`).toBeTruthy();
    }
    // E nenhuma etiqueta a mais: uma chave órfã é um estado que já não existe.
    expect(Object.keys(QUOTE_STATUS_LABELS).sort()).toEqual([...QUOTE_STATUSES].sort());
  });

  it("isQuoteStatus recusa o que não está na lista", () => {
    expect(isQuoteStatus("rascunho")).toBe(true);
    expect(isQuoteStatus("enviada")).toBe(false);
    expect(isQuoteStatus(null)).toBe(false);
    expect(isQuoteStatus(3)).toBe(false);
  });
});

describe("transições — a matriz é a de set_crm_quote_status", () => {
  /** A matriz como a RPC a escreve, lida do próprio SQL. */
  const matrizSql = new Map<string, string[]>();
  for (const m of SQL_103.matchAll(
    /v_atual\.status\s*=\s*'(\w+)'\s*AND\s*p_status\s+IN\s*\(([^)]*)\)/g,
  )) {
    matrizSql.set(m[1], [...m[2].matchAll(/'([^']+)'/g)].map((x) => x[1]).sort());
  }

  it("a matriz foi lida (senão o resto deste bloco não prova nada)", () => {
    expect(matrizSql.size).toBeGreaterThan(0);
  });

  it("🔴 origem a origem, os mesmos destinos", () => {
    for (const [origem, destinos] of matrizSql) {
      expect(isQuoteStatus(origem), `${origem} não é um estado conhecido`).toBe(true);
      expect(
        [...allowedQuoteTransitions(origem as QuoteStatus)].sort(),
        `destinos de ${origem} divergem do SQL`,
      ).toEqual(destinos);
    }
  });

  it("🔴 nenhuma origem no runtime que o SQL não tenha", () => {
    // O outro sentido: uma origem inventada aqui ofereceria botões que a base
    // recusa com QUOTE_TRANSITION_NOT_ALLOWED.
    for (const s of QUOTE_STATUSES) {
      if (allowedQuoteTransitions(s).length === 0) continue;
      expect(matrizSql.has(s), `${s} tem destinos no runtime e nenhum no SQL`).toBe(true);
    }
  });

  it("🔴 rascunho → enviado está disponível MANUALMENTE", () => {
    // O envio por email é a 103-B2. Sem esta transição, um orçamento entregue
    // por PDF ficava eternamente «rascunho».
    expect(canTransitionQuote("rascunho", "enviado")).toBe(true);
    expect(matrizSql.get("rascunho")).toContain("enviado");
  });

  it("aceite e anulado são finais", () => {
    expect(isQuoteFinal("aceite")).toBe(true);
    expect(isQuoteFinal("anulado")).toBe(true);
    expect(isQuoteFinal("rascunho")).toBe(false);
  });

  it("🔴 nada volta a rascunho", () => {
    // Um documento que já saiu não regressa a rascunho: a correção é uma
    // revisão nova, com número próprio.
    for (const s of QUOTE_STATUSES) {
      expect(canTransitionQuote(s, "rascunho"), `${s} → rascunho devia ser recusado`).toBe(false);
    }
  });

  it("a matriz declara todos os estados como chave", () => {
    expect(Object.keys(QUOTE_TRANSITIONS).sort()).toEqual([...QUOTE_STATUSES].sort());
  });
});

describe("revisão — o que a RPC aceita", () => {
  it("🔴 rascunho NÃO é revisável, e a RPC diz porquê", () => {
    expect(SQL_103).toContain("QUOTE_DRAFT_EDIT_IN_PLACE");
    expect(QUOTE_REVISABLE_STATUSES as readonly string[]).not.toContain("rascunho");
    expect(canReviseQuote({ status: "rascunho", superseded_by_id: null })).toBe(false);
  });

  it("aceite e anulado não se revêem — a RPC recusa-os", () => {
    expect(SQL_103).toContain("QUOTE_ACCEPTED_IMMUTABLE");
    expect(SQL_103).toContain("QUOTE_VOIDED_IMMUTABLE");
    expect(canReviseQuote({ status: "aceite", superseded_by_id: null })).toBe(false);
    expect(canReviseQuote({ status: "anulado", superseded_by_id: null })).toBe(false);
  });

  it("enviado, recusado e expirado revêem-se", () => {
    for (const s of ["enviado", "recusado", "expirado"]) {
      expect(canReviseQuote({ status: s, superseded_by_id: null }), s).toBe(true);
    }
  });

  it("🔴 um já substituído não se revê outra vez", () => {
    expect(SQL_103).toContain("QUOTE_ALREADY_SUPERSEDED");
    expect(canReviseQuote({ status: "enviado", superseded_by_id: "outro-id" })).toBe(false);
  });
});

describe("unidades e tipo de preço — os CHECK da 103", () => {
  it("unidades", () => {
    expect([...QUOTE_UNITS].sort()).toEqual(valoresDoCheck("unit").sort());
  });

  it("tipo de preço", () => {
    expect([...QUOTE_PRICING_KINDS].sort()).toEqual(valoresDoCheck("pricing_kind").sort());
  });
});

describe("totais — a mesma aritmética das RPC", () => {
  it("🔴 arredonda por LINHA, e não só no fim", () => {
    // Duas linhas de 1,5 × 0,33 = 0,495. Cada uma arredonda para 0,50 antes de
    // somar, e o subtotal é 1,00. Somar primeiro daria 0,99 — um cêntimo que o
    // ecrã mostraria e a base não confirmaria.
    const t = totaisDoOrcamento(
      [
        { quantity: 1.5, unit_price: 0.33 },
        { quantity: 1.5, unit_price: 0.33 },
      ],
      { discountPct: 0, applyVat: false, vatRate: 0 },
    );
    expect(t.subtotal).toBe(1);
  });

  it("🔴 NÃO quantiza a entrada antes de multiplicar", () => {
    // A RPC calcula `round(quantidade × preço, 2)` sobre o JSONB — os valores
    // COMO FORAM ESCRITOS. 3 × 0,335 = 1,005 → 1,01.
    //
    // A coluna `unit_price numeric(10,2)` quantiza o preço que GUARDA (0,34),
    // mas não o que entrou na conta. Arredondar primeiro daria 3 × 0,34 = 1,02
    // — um cêntimo a mais do que o documento. Medido contra Postgres real em
    // `crm-quote-runtime-parity.pg.test.ts`.
    const t = totaisDoOrcamento(
      [{ quantity: 3, unit_price: 0.335 }],
      { discountPct: 0, applyVat: false, vatRate: 0 },
    );
    expect(t.subtotal).toBe(1.01);
  });

  it("🔴 o IVA incide na BASE, não no subtotal", () => {
    // 100 com 10% de desconto = base 90; IVA 23% de 90 = 20.70, e não 23.
    const t = totaisDoOrcamento(
      [{ quantity: 1, unit_price: 100 }],
      { discountPct: 10, applyVat: true, vatRate: 23 },
    );
    expect(t.subtotal).toBe(100);
    expect(t.base).toBe(90);
    expect(t.vatAmount).toBe(20.7);
    expect(t.total).toBe(110.7);
  });

  it("sem IVA quando a taxa é zero ou não se aplica", () => {
    expect(totaisDoOrcamento([{ quantity: 1, unit_price: 50 }], { applyVat: false, vatRate: 23 }).vatAmount).toBe(0);
    expect(totaisDoOrcamento([{ quantity: 1, unit_price: 50 }], { applyVat: true, vatRate: 0 }).vatAmount).toBe(0);
    // Taxa desconhecida (as definições não carregaram) não inventa imposto.
    expect(totaisDoOrcamento([{ quantity: 1, unit_price: 50 }], { applyVat: true, vatRate: null }).vatAmount).toBe(0);
  });

  it("🔴 o meio arredonda para cima, como o round() do Postgres", () => {
    // `Math.round(8.615 * 100) / 100` dá 8.61 e a base dá 8.62: 8.615 não é
    // representável em binário e o produto cai abaixo do meio.
    const t = totaisDoOrcamento(
      [{ quantity: 1, unit_price: 8.615 }],
      { discountPct: 0, applyVat: false, vatRate: 0 },
    );
    expect(t.subtotal).toBe(8.62);
  });

  it("lista vazia dá zeros, e não NaN", () => {
    const t = totaisDoOrcamento([], { discountPct: 10, applyVat: true, vatRate: 23 });
    expect(t).toEqual({ subtotal: 0, base: 0, vatAmount: 0, total: 0 });
  });

  it("um desconto de 100% deixa a base a zero", () => {
    const t = totaisDoOrcamento(
      [{ quantity: 2, unit_price: 75 }],
      { discountPct: 100, applyVat: true, vatRate: 23 },
    );
    expect(t.subtotal).toBe(150);
    expect(t.base).toBe(0);
    expect(t.total).toBe(0);
  });
});

describe("🔴 o domínio decimal", () => {
  it("conta as casas da representação decimal", () => {
    expect(decimalPlaces(1)).toBe(0);
    expect(decimalPlaces(1.2)).toBe(1);
    expect(decimalPlaces(1.23)).toBe(2);
    expect(decimalPlaces(1.123456)).toBe(6);
    expect(decimalPlaces(0.000001)).toBe(6);
    expect(decimalPlaces(1.1234567)).toBe(7);
  });

  it("🔴 a notação exponencial conta como casas, não como zero", () => {
    // `String(0.000000051)` é "5.1e-8". Contar o que vem depois de um ponto
    // que não existe daria zero casas, e o valor mais perigoso de todos
    // passava como se fosse inteiro.
    expect(String(0.000000051)).toContain("e");
    expect(decimalPlaces(0.000000051)).toBe(9);
    expect(decimalPlaces(0.000001051)).toBe(9);
  });

  it("um expoente positivo consome casas", () => {
    expect(decimalPlaces(1.5e3)).toBe(0);   // 1500
    expect(decimalPlaces(1e21)).toBe(0);
  });

  it("um valor não finito não tem representação decimal", () => {
    expect(hasMaxDecimalPlaces(Number.NaN, 2)).toBe(false);
    expect(hasMaxDecimalPlaces(Number.POSITIVE_INFINITY, 2)).toBe(false);
  });

  it("🔴 `max` é obrigatório — não há default silencioso", () => {
    // Havia aqui um default de 6 (a escala da ARITMÉTICA) e foi assim que as
    // linhas ficaram a aceitar seis casas quando as colunas guardam duas:
    // quem escreveu `hasMaxDecimalPlaces(v)` julgou estar a validar o domínio
    // e estava a validar outra coisa.
    expect(hasMaxDecimalPlaces.length).toBe(2);
  });

  it("🔴 as linhas aceitam DUAS casas — é o que numeric(10,2) guarda", () => {
    for (const bom of [1, 1.2, 1.23, 0.33, 0.34, 999.99]) {
      expect(hasMaxDecimalPlaces(bom, QUOTE_ITEM_MAX_DECIMAL_PLACES), `${bom}`).toBe(true);
    }
    for (const mau of [1.234, 1.005, 0.335, 1.234567, 0.000001]) {
      expect(hasMaxDecimalPlaces(mau, QUOTE_ITEM_MAX_DECIMAL_PLACES), `${mau}`).toBe(false);
    }
  });

  it("o desconto também: numeric(5,2)", () => {
    for (const bom of [3, 3.1, 3.14, 100]) {
      expect(hasMaxDecimalPlaces(bom, QUOTE_DISCOUNT_MAX_DECIMAL_PLACES), `${bom}`).toBe(true);
    }
    for (const mau of [3.141, 3.141592, 0.001]) {
      expect(hasMaxDecimalPlaces(mau, QUOTE_DISCOUNT_MAX_DECIMAL_PLACES), `${mau}`).toBe(false);
    }
  });

  it("os limites vêm da COLUNA, não da aritmética", () => {
    expect(QUOTE_ITEM_MAX_DECIMAL_PLACES).toBe(2);      // numeric(10,2)
    expect(QUOTE_DISCOUNT_MAX_DECIMAL_PLACES).toBe(2);  // numeric(5,2)
    // A escala da aritmética é maior, e é só um detalhe de cálculo.
    expect(QUOTE_ARITHMETIC_DECIMAL_PLACES).toBe(6);
    const src = readFileSync(join(ROOT, "src/lib/crm/quotes.ts"), "utf8");
    expect(src).toContain("1_000_000");
  });

  it("🔴 não se mede com `value * 1e6`", () => {
    // A multiplicação em binário introduz precisamente o erro que se quer
    // medir: `1.000001 * 1e6` dá 1000000.9999999999 — não é inteiro.
    expect(Number.isInteger(1.000001 * 1e6)).toBe(false);
    expect(decimalPlaces(1.000001)).toBe(6);

    // Sem comentários: o cabeçalho de `quotes.ts` MENCIONA esta forma para
    // explicar porque é que não a usa.
    const src = readFileSync(join(ROOT, "src/lib/crm/quotes.ts"), "utf8")
      .replace(/\/\*[\s\S]*?\*\//g, "")
      .replace(/(^|[^:])\/\/.*$/gm, "$1");
    expect(src).not.toMatch(/isInteger\([^)]*\*\s*1e6/);
  });

  it("🔴 dentro do domínio aceite, o valor escrito é o valor gravado", () => {
    // É a propriedade que o limite de 2 casas compra: `unit_price` cabe na
    // coluna sem perder nada, e `line_total` fecha com ele.
    const t = totaisDoOrcamento(
      [{ quantity: 3, unit_price: 0.34 }],
      { discountPct: 0, applyVat: false, vatRate: 0 },
    );
    expect(t.subtotal).toBe(1.02);   // = 3 × 0,34, que é o que o PDF mostra

    // Fora do domínio isso deixava de ser verdade — e é por isso que é
    // recusado, não arredondado.
    const fora = totaisDoOrcamento(
      [{ quantity: 3, unit_price: 0.335 }],
      { discountPct: 0, applyVat: false, vatRate: 0 },
    );
    expect(fora.subtotal).toBe(1.01);  // a coluna guardaria 0,34 → 1,02
    expect(hasMaxDecimalPlaces(0.335, QUOTE_ITEM_MAX_DECIMAL_PLACES)).toBe(false);
  });
});

describe("o número e a sua raiz", () => {
  it("a raiz é o número sem o sufixo de revisão", () => {
    expect(quoteNumberRoot("ORC2026/001")).toBe("ORC2026/001");
    expect(quoteNumberRoot("ORC2026/001-R1")).toBe("ORC2026/001");
    expect(quoteNumberRoot("ORC2026/012-R11")).toBe("ORC2026/012");
  });

  it("🔴 a RPC deriva o número da COLUNA, nunca do texto por regexp", () => {
    // `'/(\d+)$'` não casa com `ORC2026/001-R1` e reemitiria o 001.
    expect(SQL_103).toContain("quote_seq");
    expect(SQL_103).not.toMatch(/regexp_match\([^)]*quote_number/);
  });
});

describe("o módulo de constantes não é um ficheiro de server actions", () => {
  it("nada de \"use server\" em src/lib/crm/quotes.ts", () => {
    // Um `"use server"` que exporte um objeto compila e rebenta em runtime —
    // foi o que bloqueou as notificações do calendário a 2026-06-08.
    const src = readFileSync(join(ROOT, "src/lib/crm/quotes.ts"), "utf8");
    expect(src).not.toMatch(/^\s*"use server"/);
  });
});

// ============================================================================
// CRM — o vocabulário dos orçamentos, e a promessa de que não diverge da base
// ============================================================================
//
// As transições de estado estão escritas em dois sítios: na RPC
// `set_crm_quote_status` (a autoridade) e em `src/lib/crm/quotes.ts` (para a
// interface só oferecer o que vai passar).
//
// 🔴 Duplicação deliberada, e por isso perigosa. Se a lista do código ficar
//    mais permissiva do que a da RPC, a interface oferece um botão que dá erro;
//    se ficar mais restritiva, esconde uma transição que era legítima. Este
//    ficheiro compara as duas e falha se alguém mexer só numa.
// ============================================================================

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import {
  QUOTE_STATUSES,
  QUOTE_STATUS_LABELS,
  QUOTE_STATUS_COLORS,
  QUOTE_UNITS,
  QUOTE_UNIT_LABELS,
  QUOTE_PRICING_KINDS,
  QUOTE_PRICING_KIND_LABELS,
  QUOTE_DEFAULT_VALIDITY_DAYS,
  allowedQuoteTransitions,
  canTransitionQuote,
  isEditableInPlace,
  isExpired,
  isQuoteStatus,
  isRevisable,
  type QuoteStatus,
} from "@/lib/crm/quotes";

const ROOT = process.cwd();
const SQL = readFileSync(join(ROOT, "supabase/migrations/103_crm_orcamentos.sql"), "utf8");

/** O SQL sem comentários — para medir o que a migration FAZ, não o que explica. */
function sqlSemComentarios(): string {
  return SQL.split("\n")
    .filter((l) => !l.trimStart().startsWith("--"))
    .join("\n");
}

function valoresDoCheck(coluna: string): string[] {
  const re = new RegExp(`\\b${coluna}\\b[\\s\\S]{0,300}?IN \\(([^)]*)\\)`, "m");
  const m = SQL.match(re);
  if (!m) throw new Error(`CHECK de ${coluna} não encontrado na 103`);
  return [...m[1].matchAll(/'([^']+)'/g)].map((x) => x[1]);
}

describe("CRM orçamentos — paridade com a migration 103", () => {
  it("os estados são exactamente os do CHECK", () => {
    expect([...QUOTE_STATUSES].sort()).toEqual(valoresDoCheck("status").sort());
  });

  it("as unidades das linhas são exactamente as do CHECK", () => {
    expect([...QUOTE_UNITS].sort()).toEqual(valoresDoCheck("unit").sort());
  });

  it("a natureza do preço é exactamente a do CHECK", () => {
    expect([...QUOTE_PRICING_KINDS].sort()).toEqual(valoresDoCheck("pricing_kind").sort());
  });
});

describe("🔴 CRM orçamentos — as transições do código e as da RPC coincidem", () => {
  /**
   * Lê as transições que `set_crm_quote_status` permite.
   *
   * A RPC escreve-as como uma condição só:
   *
   *     (v_atual.status = 'rascunho' AND p_status IN ('enviado', 'anulado'))
   *  OR (v_atual.status = 'enviado'  AND p_status IN (...))
   *
   * Se a forma dessa condição mudar ao ponto de isto deixar de casar, o teste
   * falha por não encontrar nada — que é o comportamento certo.
   */
  function transicoesDaRpc(): Map<string, string[]> {
    const mapa = new Map<string, string[]>();
    const re = /v_atual\.status = '(\w+)' AND p_status IN \(([^)]*)\)/g;
    for (const m of SQL.matchAll(re)) {
      mapa.set(m[1], [...m[2].matchAll(/'([^']+)'/g)].map((x) => x[1]));
    }
    return mapa;
  }

  const daRpc = transicoesDaRpc();

  it("a RPC declara transições — e o teste sabe lê-las", () => {
    expect(daRpc.size).toBeGreaterThan(0);
  });

  it("cada estado com transições na RPC tem as mesmas no código", () => {
    for (const [origem, destinos] of daRpc) {
      expect(isQuoteStatus(origem), `${origem} não é um estado conhecido`).toBe(true);
      expect(
        [...allowedQuoteTransitions(origem as QuoteStatus)].sort(),
        `transições de ${origem} divergem entre o código e a RPC`,
      ).toEqual([...destinos].sort());
    }
  });

  it("os estados que o código dá como terminais não aparecem na RPC", () => {
    for (const s of QUOTE_STATUSES) {
      if (allowedQuoteTransitions(s).length > 0) continue;
      expect(daRpc.has(s), `${s} é terminal no código mas transita na RPC`).toBe(false);
    }
  });

  it("🔴 aceite e anulado são terminais", () => {
    // Um aceite é a base de um acordo; um anulado acabou. Qualquer um deles a
    // transitar seria uma forma de reescrever o passado.
    expect(allowedQuoteTransitions("aceite")).toHaveLength(0);
    expect(allowedQuoteTransitions("anulado")).toHaveLength(0);
    for (const destino of QUOTE_STATUSES) {
      expect(canTransitionQuote("aceite", destino)).toBe(false);
      expect(canTransitionQuote("anulado", destino)).toBe(false);
    }
  });

  it("um rascunho só pode ser enviado ou anulado", () => {
    expect([...allowedQuoteTransitions("rascunho")].sort()).toEqual(["anulado", "enviado"]);
  });
});

describe("CRM orçamentos — editar e rever", () => {
  it("🔴 só o rascunho se edita em cima", () => {
    expect(isEditableInPlace("rascunho")).toBe(true);
    for (const s of QUOTE_STATUSES) {
      if (s === "rascunho") continue;
      expect(isEditableInPlace(s), `${s} não devia ser editável em cima`).toBe(false);
    }
  });

  it("revê-se o que já saiu de casa e ainda está em jogo", () => {
    expect(isRevisable("enviado")).toBe(true);
    expect(isRevisable("recusado")).toBe(true);
    expect(isRevisable("expirado")).toBe(true);

    // Um rascunho edita-se; um aceite é imutável; um anulado acabou.
    expect(isRevisable("rascunho")).toBe(false);
    expect(isRevisable("aceite")).toBe(false);
    expect(isRevisable("anulado")).toBe(false);
  });

  it("editável em cima e revisável são mutuamente exclusivos", () => {
    for (const s of QUOTE_STATUSES) {
      expect(isEditableInPlace(s) && isRevisable(s), `${s} é as duas coisas`).toBe(false);
    }
  });

  it("a RPC recusa rever um rascunho e um aceite", () => {
    expect(SQL).toContain("QUOTE_DRAFT_EDIT_IN_PLACE");
    expect(SQL).toContain("QUOTE_ACCEPTED_IMMUTABLE");
  });
});

describe("CRM orçamentos — a validade", () => {
  it("um enviado fora de prazo mostra-se como expirado", () => {
    expect(isExpired("enviado", "2026-01-01", "2026-09-15")).toBe(true);
  });

  it("dentro do prazo, não", () => {
    expect(isExpired("enviado", "2026-12-31", "2026-09-15")).toBe(false);
    // No próprio dia ainda vale: a validade é até ao fim desse dia.
    expect(isExpired("enviado", "2026-09-15", "2026-09-15")).toBe(false);
  });

  it("só um enviado expira — um rascunho por enviar não está a correr prazo", () => {
    for (const s of QUOTE_STATUSES) {
      if (s === "enviado") continue;
      expect(isExpired(s, "2020-01-01", "2026-09-15"), `${s} não devia expirar`).toBe(false);
    }
  });

  it("🔴 nada escreve 'expirado' na base — é derivado na leitura", () => {
    // O estado existe no CHECK e está reservado para um cron futuro. A
    // migration di-lo por escrito, para ninguém procurar o cron que não existe.
    expect(SQL).toMatch(/nada escreve `'expirado'` ainda|Nada escreve 'expirado'/i);
    expect(SQL).not.toMatch(/SET status = 'expirado'/);
  });

  it("a validade por omissão é de 30 dias", () => {
    expect(QUOTE_DEFAULT_VALIDITY_DAYS).toBe(30);
  });
});

describe("CRM orçamentos — cada valor tem etiqueta", () => {
  it("estados, unidades e tipos de preço", () => {
    expect(Object.keys(QUOTE_STATUS_LABELS).sort()).toEqual([...QUOTE_STATUSES].sort());
    expect(Object.keys(QUOTE_STATUS_COLORS).sort()).toEqual([...QUOTE_STATUSES].sort());
    expect(Object.keys(QUOTE_UNIT_LABELS).sort()).toEqual([...QUOTE_UNITS].sort());
    expect(Object.keys(QUOTE_PRICING_KIND_LABELS).sort()).toEqual([...QUOTE_PRICING_KINDS].sort());
  });

  it("em português, e não no valor cru", () => {
    expect(QUOTE_STATUS_LABELS.rascunho).toBe("Rascunho");
    expect(QUOTE_UNIT_LABELS.m2).toBe("m²");
    expect(QUOTE_PRICING_KIND_LABELS.mensal).toBe("Avença mensal");
  });
});

describe("CRM orçamentos — a fronteira com o financeiro", () => {
  const ACTIONS = readFileSync(join(ROOT, "src/app/actions/crm-orcamentos.ts"), "utf8");

  it("🔴 nunca escreve em faturas, caixa, serviços ou contratos", () => {
    for (const tabela of ["invoices", "invoice_items", "cash_flow_entries", "services", "contracts"]) {
      expect(ACTIONS, `os orçamentos não podem tocar em ${tabela}`)
        .not.toContain(`.from("${tabela}")`);
    }
  });

  it("🔴 a RPC não invoca o protocolo de período financeiro", () => {
    // Um orçamento não é documento fiscal: orçamentar num mês fechado é
    // legítimo, e chamar o protocolo aqui impediria-o sem razão.
    //
    // Mede-se o SQL sem comentários: o cabeçalho da migration NOMEIA a função
    // precisamente para explicar porque é que não a chama, e procurar o nome
    // no ficheiro inteiro acusaria essa explicação como se fosse uma chamada.
    expect(sqlSemComentarios()).not.toContain("assert_financial_period_dates_open_locked");

    // E a explicação tem de continuar lá — é o que impede alguém de a
    // acrescentar por analogia com a emissão de faturas.
    expect(SQL).toContain("assert_financial_period_dates_open_locked");
  });

  it("🔴 a chave do advisory lock não colide com a das faturas", () => {
    // Ambas são a forma de um argumento e partilham espaço de lock: sem o
    // discriminador, emitir uma fatura bloquearia quem emitisse um orçamento.
    expect(SQL).toContain("':orc:'");
  });

  it("🔴 a numeração vem da coluna, não de um regexp sobre o texto", () => {
    // `ORC2026/001-R1` não casa com `/(\d+)$`: o MAX daria NULL e o próximo
    // orçamento reemitiria o 001.
    expect(SQL).toContain("MAX(q.quote_seq)");
    expect(SQL).not.toMatch(/regexp_match\(\s*\w*\.?quote_number/);
  });
});

describe("CRM orçamentos — o que nunca vai para o cliente", () => {
  const PDF = readFileSync(
    join(ROOT, "src/app/(dashboard)/dashboard/crm/orcamentos/_components/quote-pdf.ts"),
    "utf8",
  );

  it("🔴 as notas internas não entram no PDF", () => {
    // É o campo onde se escreve «este cliente regateia». Ir para o cliente é
    // um problema, e o tipo de problema que só se descobre depois.
    const semComentarios = PDF.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/.*$/gm, "$1");
    expect(semComentarios).not.toContain("internal_notes");
  });

  it("o PDF apresenta os totais, não os recalcula", () => {
    const semComentarios = PDF.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/.*$/gm, "$1");
    expect(semComentarios).not.toContain("computeQuoteTotals");
    expect(semComentarios).toContain("quote.total");
  });
});

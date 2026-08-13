// ============================================================================
// Validação de dinheiro — testada a executar
// ============================================================================
//
// Este ficheiro existe por causa de um erro concreto, e da razão por que ele
// passou.
//
// A primeira versão do validador vivia dentro de um ficheiro `"use server"`,
// que não se pode importar. Por isso "testei-o" por inspecção do texto:
// confirmei que a linha `Math.round(valor * 100) !== valor * 100` estava lá.
//
// A linha estava lá. E rejeitava dinheiro normal:
//
//     0.29  × 100  →    28.999999999999996   → recusado
//     10.12 × 100  →  1011.9999999999999     → recusado
//     19.99 × 100  →  1998.9999999999998     → recusado
//     1.10  × 100  →   110.00000000000001    → recusado
//
// Um teste que verifica que o código existe não verifica que o código está
// certo. Só a execução o faz.
// ============================================================================

import { describe, it, expect } from "vitest";
import fs from "node:fs";
import path from "node:path";

import { paraCentimos, validarValorMonetario } from "@/domain/finance-v2/money";

// ─── 1. Os valores que a versão anterior recusava ───────────────────────────

describe("🔴 valores monetários que o binário não representa exactamente", () => {
  // Cada um destes falhava. São todos dinheiro perfeitamente vulgar.
  const VALIDOS = [0.29, 10.12, 19.99, 1.1, 0.01, 0.1, 2.675, 1234.56, 0, 999999.99];

  for (const v of VALIDOS) {
    if (v === 2.675) continue; // três decimais — ver o bloco seguinte
    it(`aceita ${v}`, () => {
      const r = validarValorMonetario(v);
      expect(r.ok, `${v} devia ser aceite`).toBe(true);
      if (r.ok) expect(r.valor).toBeCloseTo(v, 10);
    });
  }

  it("🔴 devolve o valor normalizado, sem o ruído do float", () => {
    // Guardar 0,28999999999999998 na base seria arrastar o ruído para todas as
    // somas seguintes.
    const r = validarValorMonetario(0.29);
    expect(r.ok && r.valor).toBe(0.29);
    expect(String(r.ok && r.valor)).toBe("0.29");
  });

  it("a prova de que o problema era real", () => {
    // Se algum dia alguém voltar à comparação exacta, este teste explica
    // porquê em três linhas.
    expect(0.29 * 100).not.toBe(29);
    expect(Math.round(0.29 * 100)).toBe(29);
    expect(validarValorMonetario(0.29).ok).toBe(true);
  });
});

// ─── 2. O que tem de ser recusado ───────────────────────────────────────────

describe("o que não é dinheiro válido", () => {
  it("três decimais", () => {
    for (const v of [2.675, 0.001, 19.999, 1.005]) {
      const r = validarValorMonetario(v);
      expect(r.ok, `${v} tinha de ser recusado`).toBe(false);
      if (!r.ok) expect(r.error).toMatch(/dois decimais/);
    }
  });

  it("negativos", () => {
    const r = validarValorMonetario(-1);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toMatch(/negativo/);
  });

  it("🔴 NaN e infinitos", () => {
    // `NaN` propaga-se por qualquer soma que o toque, e o total do card ficaria
    // `NaN €` sem nada indicar de onde veio.
    for (const v of [NaN, Infinity, -Infinity]) {
      const r = validarValorMonetario(v);
      expect(r.ok, `${v} tinha de ser recusado`).toBe(false);
      if (!r.ok) expect(r.error).toMatch(/número/);
    }
  });

  it("não-números que cheguem por um pedido feito à mão", () => {
    // Uma server action é um endpoint: o `<input>` não é a última defesa.
    for (const v of ["10" as unknown as number, {} as unknown as number, [] as unknown as number]) {
      expect(validarValorMonetario(v).ok).toBe(false);
    }
  });
});

// ─── 3. Ausência ≠ zero ─────────────────────────────────────────────────────

describe("🔴 null é «por preencher», não zero", () => {
  it("null e undefined são válidos e devolvem null", () => {
    for (const v of [null, undefined]) {
      const r = validarValorMonetario(v);
      expect(r.ok).toBe(true);
      if (r.ok) expect(r.valor).toBeNull();
    }
  });

  it("zero é zero, e é diferente de null", () => {
    // Um prédio com avença de 0 € é uma afirmação; um sem valor é ignorância.
    const zero = validarValorMonetario(0);
    const nulo = validarValorMonetario(null);
    expect(zero.ok && zero.valor).toBe(0);
    expect(nulo.ok && nulo.valor).toBeNull();
    expect(zero).not.toEqual(nulo);
  });
});

// ─── 4. Opções ───────────────────────────────────────────────────────────────

describe("opções", () => {
  it("negativos podem ser permitidos quando fazem sentido", () => {
    expect(validarValorMonetario(-50, { permitirNegativo: true }).ok).toBe(true);
  });

  it("a mensagem usa o nome do campo", () => {
    const r = validarValorMonetario(-1, { nome: "A avença mensal" });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toMatch(/^A avença mensal/);
  });
});

// ─── 5. Cêntimos ────────────────────────────────────────────────────────────

describe("paraCentimos", () => {
  it("converte sem arrastar o ruído", () => {
    expect(paraCentimos(0.29)).toBe(29);
    expect(paraCentimos(19.99)).toBe(1999);
    expect(paraCentimos(10.12)).toBe(1012);
  });

  it("🔴 somar cêntimos é exacto; somar floats não é", () => {
    // A razão de a função existir: 0.1 + 0.2 !== 0.3 em vírgula flutuante.
    const floats = 0.1 + 0.2;
    expect(floats).not.toBe(0.3);
    expect((paraCentimos(0.1) + paraCentimos(0.2)) / 100).toBe(0.3);
  });
});

// ─── 6. Numeração de faturas ─────────────────────────────────────────────────
//
// A lógica vive dentro de `nextInvoiceNumber`, num ficheiro `"use server"` que
// não se importa. Estes testes replicam a **regra** e verificam que o ficheiro
// a implementa — o que é menos do que executá-la, e é dito aqui em vez de
// ficar implícito.

describe("🔴 numeração de faturas", () => {
  /** A mesma derivação que `nextInvoiceNumber` faz. */
  function proximo(existentes: string[]): number {
    let maior = 0;
    for (const n of existentes) {
      const m = /\/(\d+)$/.exec(n ?? "");
      if (!m) continue;
      const v = Number(m[1]);
      if (Number.isFinite(v) && v > maior) maior = v;
    }
    return maior + 1;
  }

  it("segue o maior número usado, não a contagem", () => {
    // Contar não é numerar: apagar uma fatura fazia a contagem descer e a
    // seguinte reutilizava um número já emitido. E a compensação que apaga
    // cabeçalhos órfãos tornou as remoções parte do funcionamento normal.
    expect(proximo(["F2026/001", "F2026/002", "F2026/003"])).toBe(4);
    expect(proximo(["F2026/001", "F2026/003"]), "o 002 foi apagado").toBe(4);
  });

  it("🔴 aguenta passar de 999 — a ordenação por texto não aguentava", () => {
    // `"F2026/999" > "F2026/1000"` em ordem lexicográfica. Ordenar por texto e
    // ficar com o primeiro repetiria o 1000.
    expect(proximo(["F2026/999", "F2026/1000"])).toBe(1001);
    expect(["F2026/999", "F2026/1000"].sort().reverse()[0]).toBe("F2026/999");
  });

  it("ignora números fora do formato em vez de partir a sequência", () => {
    expect(proximo(["F2026/001", "manual-antigo", "F2026/004"])).toBe(5);
    expect(Number.isFinite(proximo(["lixo"]))).toBe(true);
    expect(proximo(["lixo"])).toBe(1);
  });

  it("ano sem faturas começa em 1", () => {
    expect(proximo([])).toBe(1);
  });

  it("o ficheiro implementa esta regra, e verifica o erro da consulta", () => {
    const src = fs.readFileSync(path.join(process.cwd(), "src/app/actions/invoices.ts"), "utf8");
    const i = src.indexOf("async function nextInvoiceNumber");
    const corpo = src.slice(i, i + 2200);

    // `count ?? 0` transformava uma consulta falhada em zero, e a fatura
    // seguinte nascia por cima de uma que já existia.
    expect(corpo, "a contagem voltou").not.toMatch(/count: "exact"/);
    expect(corpo, "erro da consulta ignorado").toMatch(/if \(error\) return \{ ok: false/);
    expect(corpo, "máximo numérico").toMatch(/if \(Number\.isFinite\(n\) && n > maior\) maior = n;/);
    // Ordenar por texto voltaria a partir aos 1000.
    expect(corpo).not.toMatch(/\.order\("invoice_number"/);
  });

  it("🔴 a concorrência continua por resolver, e está escrita", () => {
    // Duas execuções simultâneas podem ler o mesmo máximo. A garantia tem de
    // ser da base — índice único em (company_id, invoice_number) — e essa
    // migration vem depois da 071, a seguir ao ensaio.
    const src = fs.readFileSync(path.join(process.cwd(), "src/app/actions/invoices.ts"), "utf8");
    const i = src.indexOf("async function nextInvoiceNumber");
    const cabecalho = src.slice(Math.max(i - 2000, 0), i);
    expect(cabecalho, "o risco tem de estar documentado").toMatch(/concorr[êe]ncia/i);
    expect(cabecalho).toMatch(/índice único|indice unico/i);
  });
});

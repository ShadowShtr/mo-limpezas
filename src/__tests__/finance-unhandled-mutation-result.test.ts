// ============================================================================
// FINANCEIRO — nenhuma mutação pode ter o resultado descartado
// ============================================================================
// Origem (2026-08-18, relato de utilizador em produção): «marco o pagamento
// como pago e não atualiza». A base, a RPC e a invalidação de cache estavam
// todas correctas. O handler do cliente fazia:
//
//     await setPaymentStatus(...);   // resultado descartado
//     reload();
//
// A action é fail-closed e devolvia `{ ok: false, error }` — mês fechado, sem
// permissão, erro da RPC. Esse erro morria ali. O `reload()` relia o estado
// real, que não tinha mudado, e a linha voltava a aparecer exactamente como
// estava. Sem mensagem nenhuma.
//
// 🔴 A REGRA QUE ESTE FICHEIRO IMPÕE
//
//    Toda a mutação financeira chamada pela UI tem de ter o resultado
//    explicitamente consumido. `await accao(...)` seguido de `reload()` é um
//    erro arquitectural, não um lapso daquele botão.
//
//    O padrão correcto:
//
//        const res = await accao(...);
//        if (!res.ok) { mostrarErro(res.error); return; }
//        reload();
//
// O guard varre as superfícies financeiras e falha se encontrar uma chamada a
// uma mutação cujo retorno não é atribuído nem verificado. Vale para marcar
// pago, excluir, editar, fechar mês, reabrir, conciliar, criar lançamento,
// faturar, categorias e payroll — não só para o botão que deu origem a isto.
// ============================================================================

import { describe, it, expect } from "vitest";
import fs from "node:fs";
import path from "node:path";

const RAIZ = process.cwd();

/**
 * As mutações financeiras — actions que escrevem e devolvem `{ ok, error? }`.
 * Leituras (`get*`, `search*`) ficam de fora: descartar o retorno de uma
 * leitura é inútil, mas não engole um erro de escrita.
 */
const MUTACOES_FINANCEIRAS = [
  // payments
  "createPayment", "updatePayment", "setPaymentStatus", "deletePayment",
  "uploadPaymentAttachment", "deletePaymentAttachment",
  // cash-flow
  "createCashFlowEntry", "updateCashFlowEntry", "deleteCashFlowEntry",
  // invoices
  "generateInvoices", "updateInvoiceStatus", "deleteInvoice",
  // financial-periods
  "closeFinancialPeriod", "reopenFinancialPeriod",
  // expense-categories
  "createSuggestedExpenseCategories",
  // bank-reconciliation
  "createBankAccount", "confirmMatch", "rejectMatch", "manualMatch",
  "ignoreTransaction", "createEntryFromTransaction", "deleteImport",
  "recalcSuggestions",
  // payroll
  "calculateAndSavePayroll", "adjustPayrollRecord", "approvePayrollRecords",
  "markPayrollPaid",
  // anexos (metadata, mas o erro tem de aparecer na mesma)
  "addAttachment", "removeAttachment",
];

/** Superfícies que consomem estas mutações. */
const DIRETORIOS = [
  "src/app/(dashboard)/dashboard/financeiro",
  "src/app/(dashboard)/dashboard/cobrancas",
  "src/app/(dashboard)/dashboard/folha-pagamento",
  "src/components/financeiro",
  "src/components/attachments",
];

function varrer(dir: string, out: string[] = []): string[] {
  const abs = path.join(RAIZ, dir);
  if (!fs.existsSync(abs)) return out;
  for (const e of fs.readdirSync(abs, { withFileTypes: true })) {
    const rel = path.join(dir, e.name);
    if (e.isDirectory()) varrer(rel, out);
    else if (/\.tsx?$/.test(e.name)) out.push(rel);
  }
  return out;
}

/** Remove comentários — uma nota que cite o padrão antigo não é uma chamada. */
function semComentarios(src: string): string {
  return src
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .split("\n")
    .map((l) => {
      const t = l.trim();
      return t.startsWith("//") || t.startsWith("*") ? "" : l;
    })
    .join("\n");
}

/**
 * Uma chamada tem o resultado descartado quando `await accao(` aparece no
 * início de uma instrução — sem `const x =`, sem `return`, sem fazer parte de
 * uma expressão maior.
 */
function chamadasDescartadas(src: string, accao: string): string[] {
  const limpo = semComentarios(src);
  const achados: string[] = [];

  for (const linha of limpo.split("\n")) {
    const idx = linha.indexOf(`await ${accao}(`);
    if (idx < 0) continue;

    const antes = linha.slice(0, idx).trim();
    // Formas legítimas: atribuição, retorno, parte de expressão.
    const consumido =
      /(const|let|var)\s+[\w{}[\],\s:]+=\s*$/.test(antes) ||
      /=\s*$/.test(antes) ||
      /return\s*$/.test(antes) ||
      /\(\s*$/.test(antes) ||
      /\[\s*$/.test(antes) ||
      /,\s*$/.test(antes) ||
      /(\?|:)\s*$/.test(antes) ||
      /(&&|\|\|)\s*$/.test(antes) ||
      /^\s*(if|while)\s*\(\s*!?\s*$/.test(antes);

    if (!consumido) achados.push(linha.trim());
  }
  return achados;
}

const FICHEIROS = DIRETORIOS.flatMap((d) => varrer(d)).filter((f) => !f.includes("__tests__"));

describe("🔴 UNHANDLED_MUTATION_RESULT — regra permanente do Financeiro", () => {
  it("há superfícies financeiras para auditar", () => {
    // Se isto falhar, o guard está a varrer o vazio e não prova nada.
    expect(FICHEIROS.length).toBeGreaterThan(5);
  });

  it("nenhuma mutação financeira tem o resultado descartado", () => {
    const culpados: string[] = [];

    for (const ficheiro of FICHEIROS) {
      const src = fs.readFileSync(path.join(RAIZ, ficheiro), "utf8");
      for (const accao of MUTACOES_FINANCEIRAS) {
        for (const linha of chamadasDescartadas(src, accao)) {
          culpados.push(`${ficheiro.split(path.sep).join("/")} → ${linha}`);
        }
      }
    }

    expect(
      culpados,
      "o resultado tem de ser lido: const res = await accao(...); if (!res.ok) { … return; }",
    ).toEqual([]);
  });
});

// ── O guard apanha mesmo? ───────────────────────────────────────────────────
//
// Um guard que nunca viu o defeito não prova nada. Estes casos exercitam o
// detector com o código real que causou o incidente.

describe("o detector reconhece o padrão que causou o bug", () => {
  it("apanha `await accao(...)` seguido de reload", () => {
    const mau = `
      function toggleStatus(p) {
        startTransition(async () => {
          await setPaymentStatus(p.id, "pago");
          reload();
        });
      }`;
    expect(chamadasDescartadas(mau, "setPaymentStatus")).toHaveLength(1);
  });

  it("aceita o padrão corrigido", () => {
    const bom = `
      function toggleStatus(p) {
        startTransition(async () => {
          const res = await setPaymentStatus(p.id, "pago");
          if (!res.ok) { setError(res.error); return; }
          reload();
        });
      }`;
    expect(chamadasDescartadas(bom, "setPaymentStatus")).toEqual([]);
  });

  it("aceita retorno directo", () => {
    const bom = `async function x() { return await deletePayment(id); }`;
    expect(chamadasDescartadas(bom, "deletePayment")).toEqual([]);
  });

  it("aceita dentro de expressão", () => {
    const bom = `const [a, b] = await Promise.all([await closeFinancialPeriod(x), y]);`;
    expect(chamadasDescartadas(bom, "closeFinancialPeriod")).toEqual([]);
  });

  it("ignora o padrão citado dentro de um comentário", () => {
    const comentado = `
      // Antes fazia: await setPaymentStatus(...); reload();
      const res = await setPaymentStatus(p.id, "pago");`;
    expect(chamadasDescartadas(comentado, "setPaymentStatus")).toEqual([]);
  });

  it("apanha noutras mutações, não só em pagamentos", () => {
    for (const accao of ["deleteCashFlowEntry", "closeFinancialPeriod", "confirmMatch", "markPayrollPaid"]) {
      const mau = `async function f() { await ${accao}(id); reload(); }`;
      expect(chamadasDescartadas(mau, accao), `${accao} não foi apanhada`).toHaveLength(1);
    }
  });
});

// ============================================================================
// Financeiro V2 — a camada de apresentação não mexeu na semântica
// ============================================================================
//
// A regra desta ronda foi: **a UI pode mudar, a semântica não.** Redesenhar
// sete vistas com mais de 5000 linhas de cliente em pouco tempo tem um risco
// muito concreto e muito banal — um botão que passa a parecer bem e deixa de
// chamar o que chamava.
//
// Estes testes tratam disso, e só disso:
//
//   1. cada acção visível continua ligada à action que sempre chamou;
//   2. nada passou a escrever durante o render;
//   3. os avisos honestos da PR C sobreviveram ao redesenho.
//
// Não testam aparência. Cor e espaçamento vêem-se; um handler desligado, não.
// ============================================================================

import { describe, it, expect } from "vitest";
import fs from "node:fs";
import path from "node:path";

import { stripComments } from "@/lib/finance-write-surface";

const ROOT = process.cwd();
const ler = (rel: string): string => fs.readFileSync(path.join(ROOT, rel), "utf8");
const codigo = (rel: string): string => stripComments(ler(rel));

const V = {
  resumo: "src/app/(dashboard)/dashboard/financeiro/_components/financial-dashboard-client.tsx",
  pagamentos: "src/app/(dashboard)/dashboard/financeiro/pagamentos/_components/payments-client.tsx",
  contas: "src/app/(dashboard)/dashboard/financeiro/contas/_components/contas-client.tsx",
  fluxo: "src/app/(dashboard)/dashboard/financeiro/fluxo-caixa/_components/cash-flow-client.tsx",
  cobrancas: "src/app/(dashboard)/dashboard/cobrancas/_components/invoices-client.tsx",
  diaria: "src/app/(dashboard)/dashboard/cobrancas/_components/daily-billing-client.tsx",
  folha: "src/app/(dashboard)/dashboard/folha-pagamento/_components/payroll-client.tsx",
  folhaSheet: "src/app/(dashboard)/dashboard/folha-pagamento/_components/payroll-edit-sheet.tsx",
  conciliacao: "src/app/(dashboard)/dashboard/financeiro/conciliacao/_components/reconciliation-client.tsx",
};

const PAGINAS = [
  "src/app/(dashboard)/dashboard/financeiro/page.tsx",
  "src/app/(dashboard)/dashboard/financeiro/pagamentos/page.tsx",
  "src/app/(dashboard)/dashboard/financeiro/contas/page.tsx",
  "src/app/(dashboard)/dashboard/financeiro/fluxo-caixa/page.tsx",
  "src/app/(dashboard)/dashboard/financeiro/conciliacao/page.tsx",
  "src/app/(dashboard)/dashboard/cobrancas/page.tsx",
  "src/app/(dashboard)/dashboard/folha-pagamento/page.tsx",
];

// ─── 1. As sete vistas continuam montáveis ───────────────────────────────────

describe("Financeiro V2 — as sete vistas continuam de pé", () => {
  it("cada página existe, é servidor e monta a casca", () => {
    for (const p of PAGINAS) {
      const src = codigo(p);
      expect(src, `${p} deixou de montar a FinanceShell`).toMatch(/<FinanceShell/);
      expect(src, `${p} virou componente de cliente`).not.toMatch(/^\s*["']use client["']/m);
    }
  });

  it("cada página passa o período à casca", () => {
    for (const p of PAGINAS) {
      expect(codigo(p), `${p} não passa o período`).toMatch(/period=\{period\}/);
    }
  });
});

// ─── 2. As acções continuam ligadas ──────────────────────────────────────────
//
// O risco real de um redesenho rápido: o botão fica bonito e deixa de chamar o
// que chamava. Cada linha desta tabela é uma funcionalidade que já existia.

const ACCOES: [keyof typeof V, string[]][] = [
  // 2026-08-18: `uploadPaymentAttachment`/`deletePaymentAttachment` saíram da
  // vista, substituídas por `listAttachments` + o AttachmentsField (que chama
  // `addAttachment`/`removeAttachment`). Não é uma acção arrumada num
  // redesenho: é a mesma capacidade a passar de um anexo para N, pela
  // migration 074. As actions legadas continuam a existir em payments.ts para
  // o caminho antigo. Ver docs/ATTACHMENTS-MULTIPLE.md.
  // 2026-08-19: `listAttachments` também saiu. O AttachmentsField passou a ser
  // dono da própria leitura — os pais deixaram de a carregar e de a passar por
  // prop, que era o que fazia o anexo desaparecer ao reabrir o registo
  // (`useState(prop)` só lê na montagem). A capacidade continua: anexar, abrir
  // e remover vivem no componente, em `src/app/actions/attachments.ts`.
  // Ver docs/ATTACHMENTS-MULTIPLE.md e attachments-async-hydration.test.tsx.
  ["pagamentos", ["createPayment", "updatePayment", "deletePayment", "setPaymentStatus",
                  "getPayments"]],
  ["contas", ["createCashFlowEntry", "updateCashFlowEntry", "deleteCashFlowEntry"]],
  ["fluxo", ["createCashFlowEntry", "updateCashFlowEntry", "deleteCashFlowEntry"]],
  ["cobrancas", ["generateInvoices", "updateInvoiceStatus", "deleteInvoice"]],
  ["diaria", ["setServicePayment"]],
  ["folha", ["calculateAndSavePayroll", "approvePayrollRecords", "markPayrollPaid"]],
  ["folhaSheet", ["adjustPayrollRecord"]],
  ["conciliacao", ["confirmMatch", "rejectMatch", "manualMatch", "ignoreTransaction",
                   "createEntryFromTransaction", "deleteImport", "recalcSuggestions"]],
];

/**
 * O inventário das acções visíveis, por vista.
 *
 * 🔴 Este número é um cliquet. Se uma action desaparecer de uma vista porque
 * o botão foi "arrumado" num redesenho, o teste falha e obriga a justificar a
 * remoção no diff — que é exactamente o risco de refazer sete ecrãs depressa.
 */
const VISIBLE_ACTION_BINDINGS = ACCOES.reduce((n, [, as]) => n + as.length, 0);

describe("Financeiro V2 — nenhuma acção ficou decorativa", () => {
  it("🔴 VISIBLE_ACTION_BINDINGS mantém-se", () => {
    // 28, não 26: a contagem inclui `recalcSuggestions` (que só foi
    // reconhecida como escrita quando o detector passou a seguir imports) e
    // `getPayments`, que a vista continua a chamar — agora como leitura pura.
    //
    // 2026-08-18: 27, não 28. Pagamentos trocou duas actions de anexo único
    // (`uploadPaymentAttachment`, `deletePaymentAttachment`) por uma —
    // `listAttachments` —, porque o upload e a remoção passaram a viver no
    // AttachmentsField, que é um componente e não uma chamada directa nesta
    // vista. Nenhuma capacidade foi perdida: anexar e remover continuam
    // disponíveis, agora para N ficheiros em vez de um. Ver
    // docs/ATTACHMENTS-MULTIPLE.md e a nota em ACCOES.
    // 2026-08-19: 26, não 27. `listAttachments` saiu da vista de Pagamentos —
    // o AttachmentsField passou a carregar a própria lista. Nenhuma capacidade
    // foi perdida: ler, anexar e remover continuam disponíveis, agora todas
    // dentro do componente partilhado. Ver a nota em ACCOES.
    expect(VISIBLE_ACTION_BINDINGS).toBe(26);
  });

  for (const [vista, actions] of ACCOES) {
    it(`${vista}: continua a chamar as suas ${actions.length} actions`, () => {
      const src = codigo(V[vista]);
      for (const a of actions) {
        expect(src, `${vista} deixou de chamar ${a}`).toMatch(new RegExp(`\\b${a}\\s*\\(`));
      }
    });
  }

  it("recolher no «⋯» não é remover", () => {
    // A regra dos botões manda tirar acções raras do topo. O que não pode é a
    // acção desaparecer com o botão.
    const cob = codigo(V.cobrancas);
    for (const capacidade of ["PDF", "CSV"]) {
      expect(cob, `${capacidade} desapareceu de Cobranças`).toMatch(new RegExp(capacidade, "i"));
    }
  });
});

// ─── 3. Renderizar continua a não escrever ───────────────────────────────────

describe("Financeiro V2 — o redesenho não trouxe escrita para o render", () => {
  it("nenhuma das sete páginas de servidor faz mutação directa", () => {
    for (const p of PAGINAS) {
      expect(codigo(p), `${p} escreve no render`).not.toMatch(/\.(insert|update|upsert|delete|rpc)\s*\(/);
    }
  });

  it("a Folha continua sem recalcular ao abrir", () => {
    const src = codigo("src/app/(dashboard)/dashboard/folha-pagamento/page.tsx");
    expect(src).not.toMatch(/ensurePayrollCalculated|calculateAndSavePayroll/);
  });

  it("a casca continua sem montar o banner de lembretes", () => {
    expect(codigo("src/components/financeiro/finance-shell.tsx")).not.toMatch(/PaymentsReminderBanner/);
  });

  it("🔴 nenhuma vista ganhou um gerador de mês", () => {
    for (const v of Object.values(V)) {
      expect(codigo(v), `${v} ganhou geração de mês`).not.toMatch(/ensureMonth|Gerar\s+m[êe]s/i);
    }
  });
});

// ─── 4. Trocar de aba é filtro local ─────────────────────────────────────────

describe("Pagamentos — as abas Fixos/Variáveis são filtro local", () => {
  it("o estado da aba não vai à base nem muda o mês", () => {
    const src = codigo(V.pagamentos);
    expect(src, "a aba tem de ser estado local").toMatch(/useState<"fixos" \| "variaveis">/);

    // O corpo do handler da aba é `setAba` e mais nada. Se trocar de aba
    // chamasse `reload()` ou `getPayments`, uma apresentação com o dedo no
    // separador faria ida à base a cada clique.
    const trecho = src.slice(src.indexOf("<LocalTabs"), src.indexOf("<LocalTabs") + 400);
    expect(trecho).toMatch(/onChange=\{setAba\}/);
    expect(trecho).not.toMatch(/reload|getPayments|router/);
  });

  it("as duas listas continuam ambas alcançáveis", () => {
    const src = codigo(V.pagamentos);
    expect(src).toMatch(/data\.fixos/);
    expect(src).toMatch(/data\.variaveis/);
    expect(src).toMatch(/label: "Fixos"/);
    expect(src).toMatch(/label: "Variáveis"/);
  });
});

// ─── 5. As datas mostram o ano ───────────────────────────────────────────────

describe("Pagamentos — a data mostra o ano", () => {
  it("🔴 `03 mai. 2027` deixou de se parecer com `03 mai. 2026`", () => {
    // Num incidente em que quatro vencimentos trimestrais foram esmagados numa
    // data só, esconder o ano escondia exactamente a diferença que importava.
    const src = codigo(V.pagamentos);
    const fmt = src.slice(src.indexOf("function fmtDate"), src.indexOf("function fmtDate") + 320);
    expect(fmt).toMatch(/year:\s*"numeric"/);
  });

  it("é só apresentação — nada foi gravado de forma diferente", () => {
    const src = codigo(V.pagamentos);
    const fmt = src.slice(src.indexOf("function fmtDate"), src.indexOf("function fmtDate") + 320);
    expect(fmt, "formatar não pode escrever").not.toMatch(/update|insert|due_date\s*=/);
  });
});

// ─── 6. O vazio continua honesto ─────────────────────────────────────────────

describe("Financeiro V2 — o redesenho não apagou os avisos honestos", () => {
  it("um mês sem linhas continua a dizer-se não preparado", () => {
    const src = ler(V.pagamentos);
    expect(src).toContain("Mês ainda não preparado");
    expect(src).toContain("Ainda não existem pagamentos fixos neste mês.");
    expect(src).toContain("Ainda não existem pagamentos variáveis neste mês.");
  });

  it("os KPIs continuam condicionados a existirem linhas", () => {
    expect(codigo(V.pagamentos)).toMatch(
      /data\.fixos\.length\s*>\s*0\s*\|\|\s*data\.variaveis\.length\s*>\s*0/,
    );
  });

  it("🔴 o primitivo de KPI não sabe transformar ausência em zero", () => {
    // `value: string | null` — e `null` desenha «Indisponível». Não há caminho
    // que produza `0 €` a partir de «não sei».
    const prim = ler("src/components/financeiro/v2/primitives.tsx");
    expect(prim).toMatch(/value:\s*string\s*\|\s*null/);
    expect(prim).toContain("Indisponível");
    expect(prim, "um zero por omissão reabriria a leitura mais cara")
      .not.toMatch(/value\s*(\?\?|\|\|)\s*0|value\s*=\s*0/);
  });
});

// ─── 7. Uma só navegação ─────────────────────────────────────────────────────

describe("Financeiro V2 — não há dois sistemas de navegação", () => {
  it("o Resumo não repõe os cartões de atalho", () => {
    const src = codigo(V.resumo);
    const links = [...src.matchAll(/href="\/dashboard\/(financeiro|cobrancas|folha-pagamento)/g)];
    expect(links, "a barra do módulo já leva a estes sítios").toEqual([]);
  });

  it("nenhuma vista financeira traz o seu próprio seletor de mês", () => {
    for (const v of Object.values(V)) {
      expect(codigo(v), `${v} tem um segundo seletor de período`).not.toMatch(/type="month"/);
    }
  });
});

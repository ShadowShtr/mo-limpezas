// ============================================================================
// Financeiro V2 — PR A · casca, período e render read-only
// ============================================================================
//
// 🚨 Offline. Não liga ao Supabase, não faz rede, não lê `.env`.
//
// O teste que interessa é o da Parte C: **abrir uma página ou mudar de período
// não escreve nada**. Era falso até esta ronda — `folha-pagamento/page.tsx`
// chamava `ensurePayrollCalculated` durante o render, que faz
// `.upsert(payroll_records)`. Com navegação por abas, clicar numa aba passaria
// a poder gravar.
//
// As outras partes existem para que essa não passe por acidente.

import { describe, it, expect } from "vitest";
import fs from "node:fs";
import path from "node:path";

import {
  FINANCE_PERIOD_PARAM,
  currentFinancePeriod,
  financePeriodBounds,
  formatFinancePeriod,
  parseFinancePeriod,
  shiftFinancePeriod,
  withFinancePeriod,
} from "@/lib/finance-period";

const ROOT = process.cwd();
const ler = (rel: string) => fs.readFileSync(path.join(ROOT, rel), "utf8");

/** Sem comentários — para não medir a documentação em vez do código. */
const codigo = (src: string) =>
  src.replace(/\/\*[\s\S]*?\*\//g, " ").replace(/^[ \t]*\/\/.*$/gm, " ");

// ---------------------------------------------------------------------------
// Parte A — o período
// ---------------------------------------------------------------------------

describe("Financeiro V2 — período do módulo", () => {
  it("lê `YYYY-MM` da URL", () => {
    const p = parseFinancePeriod("2026-08");
    expect(p).toEqual({ year: 2026, month: 8, key: "2026-08" });
  });

  it("qualquer entrada inválida degrada para o mês corrente, sem lançar", () => {
    // Uma URL adulterada não pode partir a página nem gerar consultas absurdas.
    const agora = currentFinancePeriod();
    for (const mau of [
      undefined, null, "", "  ", "agosto", "2026", "2026-13", "2026-00",
      "0001-01", "9999-12", "2026-8", "26-08", "2026-08-01", "../../etc",
    ]) {
      expect(parseFinancePeriod(mau as string | undefined)).toEqual(agora);
    }
  });

  it("aceita a forma de array que o Next dá a um parâmetro repetido", () => {
    expect(parseFinancePeriod(["2026-03", "2026-04"])).toEqual(
      { year: 2026, month: 3, key: "2026-03" },
    );
  });

  it("preserva o período ao construir rotas, sem perder outros parâmetros", () => {
    const p = parseFinancePeriod("2026-08");
    expect(withFinancePeriod("/dashboard/financeiro", p))
      .toBe("/dashboard/financeiro?mes=2026-08");
    // É isto que faz o mês sobreviver a sair do Resumo e chegar ao Fluxo.
    expect(withFinancePeriod("/dashboard/cobrancas?tab=diaria", p))
      .toContain("tab=diaria");
    expect(withFinancePeriod("/dashboard/cobrancas?tab=diaria", p))
      .toContain(`${FINANCE_PERIOD_PARAM}=2026-08`);
    // Substitui, não duplica.
    const jaTem = withFinancePeriod("/x?mes=2020-01", p);
    expect(jaTem.match(/mes=/g)).toHaveLength(1);
    expect(jaTem).toContain("mes=2026-08");
  });

  it("desloca meses atravessando o ano", () => {
    const jan = parseFinancePeriod("2026-01");
    expect(shiftFinancePeriod(jan, -1).key).toBe("2025-12");
    expect(shiftFinancePeriod(parseFinancePeriod("2026-12"), 1).key).toBe("2027-01");
    expect(shiftFinancePeriod(jan, -13).key).toBe("2024-12");
  });

  it("não sai dos limites defensivos", () => {
    const min = parseFinancePeriod("2020-01");
    expect(shiftFinancePeriod(min, -1)).toEqual(min);
  });

  it("dá os limites do mês, incluindo fevereiro bissexto", () => {
    expect(financePeriodBounds(parseFinancePeriod("2026-02")))
      .toEqual({ start: "2026-02-01", end: "2026-02-28" });
    expect(financePeriodBounds(parseFinancePeriod("2024-02")))
      .toEqual({ start: "2024-02-01", end: "2024-02-29" });
    expect(financePeriodBounds(parseFinancePeriod("2026-08")))
      .toEqual({ start: "2026-08-01", end: "2026-08-31" });
  });

  it("formata em português", () => {
    expect(formatFinancePeriod(parseFinancePeriod("2026-08"))).toBe("Agosto 2026");
    expect(formatFinancePeriod(parseFinancePeriod("2026-03"))).toBe("Março 2026");
  });

  it("o mês corrente vem de Lisboa, não de `new Date()` do processo", () => {
    // Em produção o processo corre em UTC. Ler o mês por `new Date()` faz o
    // módulo mudar de mês à hora errada na viragem, em horário de verão.
    expect(codigo(ler("src/lib/finance-period.ts"))).toMatch(/todayInLisbon/);
    expect(codigo(ler("src/lib/finance-period.ts"))).not.toMatch(/new Date\(\)/);
  });
});

// ---------------------------------------------------------------------------
// Parte B — uma só navegação
// ---------------------------------------------------------------------------

const PAGINAS_FINANCEIRAS = [
  "src/app/(dashboard)/dashboard/financeiro/page.tsx",
  "src/app/(dashboard)/dashboard/financeiro/pagamentos/page.tsx",
  "src/app/(dashboard)/dashboard/financeiro/contas/page.tsx",
  "src/app/(dashboard)/dashboard/financeiro/fluxo-caixa/page.tsx",
  "src/app/(dashboard)/dashboard/financeiro/conciliacao/page.tsx",
  "src/app/(dashboard)/dashboard/cobrancas/page.tsx",
  "src/app/(dashboard)/dashboard/folha-pagamento/page.tsx",
];

describe("Financeiro V2 — uma só navegação", () => {
  it("as sete vistas usam a casca do módulo", () => {
    for (const p of PAGINAS_FINANCEIRAS) {
      expect(codigo(ler(p)), `${p}: falta FinanceShell`).toMatch(/FinanceShell/);
    }
  });

  it("as sete vistas resolvem o período pelo helper único", () => {
    for (const p of PAGINAS_FINANCEIRAS) {
      expect(codigo(ler(p)), `${p}: deve usar parseFinancePeriod`).toMatch(/parseFinancePeriod/);
    }
  });

  it("nenhuma página financeira volta a inventar o mês com `new Date()`", () => {
    // Era isto que punha o Resumo em Agosto, as Contas no mês corrente e a
    // Folha noutro, tudo no mesmo ecrã.
    for (const p of PAGINAS_FINANCEIRAS) {
      expect(codigo(ler(p)), `${p}: o período vem da URL`).not.toMatch(/new Date\(\)/);
    }
  });

  it("a barra lateral deixou de repetir as páginas financeiras", () => {
    // Medir as ENTRADAS do menu, não o texto do ficheiro: `isActive()` menciona
    // legitimamente /dashboard/cobrancas e /dashboard/folha-pagamento para
    // marcar "Financeiro" como activo em todo o módulo. Uma asserção sobre o
    // ficheiro inteiro confundiria essa menção com uma entrada de menu.
    const sidebar = codigo(ler("src/components/layout/sidebar.tsx"));
    const entradas = [...sidebar.matchAll(/\{\s*href:\s*"([^"]+)"/g)].map((m) => m[1]);

    for (const rota of [
      "/dashboard/financeiro/pagamentos",
      "/dashboard/financeiro/contas",
      "/dashboard/financeiro/fluxo-caixa",
      "/dashboard/financeiro/conciliacao",
      "/dashboard/cobrancas",
      "/dashboard/folha-pagamento",
    ]) {
      expect(entradas, `a barra lateral não deve ter entrada para ${rota}`).not.toContain(rota);
    }
    expect(entradas).toContain("/dashboard/financeiro");
    // Relatórios estava dentro do grupo Financeiro; ao colapsá-lo ficaria sem
    // entrada nenhuma se não fosse promovida.
    expect(entradas, "Relatórios não pode ficar órfã").toContain("/dashboard/relatorios");
  });

  it("o Resumo já não tem os cartões de atalho nem o botão Atualizar", () => {
    const resumo = codigo(ler(
      "src/app/(dashboard)/dashboard/financeiro/_components/financial-dashboard-client.tsx",
    ));
    expect(resumo, "os atalhos eram a segunda navegação").not.toMatch(/from "next\/link"/);
    expect(resumo).not.toMatch(/Atualizar/);
    expect(resumo).not.toMatch(/handleRefresh/);
  });

  it("Contas já não tem os atalhos para Cobranças e Folha", () => {
    const contas = codigo(ler(
      "src/app/(dashboard)/dashboard/financeiro/contas/_components/contas-client.tsx",
    ));
    expect(contas).not.toMatch(/Ver cobranças/);
    expect(contas).not.toMatch(/Ver folha/);
  });
});

// ---------------------------------------------------------------------------
// Parte C — 🔴 navegar e visualizar é read-only
// ---------------------------------------------------------------------------

const ESCRITA = /\.(insert|update|upsert|delete|rpc)\s*\(/;

/** Actions que escrevem, mesmo quando o nome não o diz. */
const ACTIONS_QUE_ESCREVEM = [
  "ensurePayrollCalculated",     // → runPayrollCalculation → upsert(payroll_records)
  "calculateAndSavePayroll",     // idem
  "recalcSuggestions",           // → generateSuggestions → upsert
  "generateInvoices",
  "setServicePayment",
  "createPayment", "updatePayment", "deletePayment", "setPaymentStatus",
  "createCashFlowEntry", "updateCashFlowEntry", "deleteCashFlowEntry",
  "approvePayrollRecords", "markPayrollPaid", "adjustPayrollRecord",
];

describe("Financeiro V2 — render das sete vistas é read-only", () => {
  it("🔴 nenhuma página chama uma action que escreve durante o render", () => {
    const infractoras: string[] = [];
    for (const p of PAGINAS_FINANCEIRAS) {
      const src = codigo(ler(p));
      for (const action of ACTIONS_QUE_ESCREVEM) {
        if (new RegExp(`\\b${action}\\s*\\(`).test(src)) infractoras.push(`${p} → ${action}`);
      }
    }
    expect(
      infractoras,
      "abrir uma página, mudar de aba ou mudar de mês nunca pode escrever",
    ).toEqual([]);
  });

  it("🔴 nenhuma página financeira faz uma mutação directa", () => {
    const infractoras = PAGINAS_FINANCEIRAS.filter((p) => ESCRITA.test(codigo(ler(p))));
    expect(infractoras).toEqual([]);
  });

  it("a Folha deixou de calcular no render e passou a dizê-lo", () => {
    const page = codigo(ler("src/app/(dashboard)/dashboard/folha-pagamento/page.tsx"));
    expect(page, "o gatilho automático saiu").not.toMatch(/ensurePayrollCalculated/);
    // Continua a saber que falta calcular — só não o faz sozinho.
    expect(page).toMatch(/needsCalculation/);
    expect(page).toMatch(/getPayrollRecords/);
  });

  it("o cálculo da folha continua a existir, agora como acção explícita", () => {
    const client = codigo(ler(
      "src/app/(dashboard)/dashboard/folha-pagamento/_components/payroll-client.tsx",
    ));
    expect(client).toMatch(/calculateAndSavePayroll/);
    expect(client).toMatch(/Recalcular folha/);
    expect(client).toMatch(/needsCalculation/);
  });

  it("o motor da folha não foi tocado", () => {
    // Este PR retira um gatilho. Não mexe em fórmulas nem em persistência.
    const payroll = ler("src/app/actions/payroll.ts");
    for (const fn of [
      "runPayrollCalculation", "calculateAndSavePayroll", "ensurePayrollCalculated",
      "approvePayrollRecords", "markPayrollPaid", "adjustPayrollRecord",
    ]) {
      expect(payroll, `${fn} deve continuar a existir`).toContain(fn);
    }
  });

  it("a navegação do módulo é feita de links, não de acções", () => {
    const nav = codigo(ler("src/components/financeiro/finance-nav.tsx"));
    expect(nav).not.toMatch(ESCRITA);
    expect(nav).not.toMatch(/onClick/);
    expect(nav).toMatch(/<Link/);
  });

  it("o seletor de período só troca a rota", () => {
    const picker = codigo(ler("src/components/financeiro/finance-period-picker.tsx"));
    expect(picker).not.toMatch(ESCRITA);
    for (const action of ACTIONS_QUE_ESCREVEM) {
      expect(picker, `o seletor não pode chamar ${action}`).not.toContain(action);
    }
    expect(picker).toMatch(/router\.replace/);
  });
});

// ---------------------------------------------------------------------------
// Parte D — o orçamento de escrita vive noutro ficheiro
// ---------------------------------------------------------------------------
//
// Estava aqui, e comparava head com base por `git diff --name-only <ramo>`.
// Passava localmente e **falhava no CI**: o checkout é do SHA da PR, com
// profundidade 1, e o ramo base não existe nesse clone.
//
//     fatal: ambiguous argument 'fix/t17b3-action-query-errors'
//
// Resultado: o invariante mais importante da ronda nunca correu no ambiente
// que interessa. Foi reescrito como cliquet determinístico, sem git, em
// `financeiro-v2-write-budget.test.ts` — com inventário versionado por
// ficheiro, verificação nos dois sentidos, e testes do próprio mecanismo.

// ---------------------------------------------------------------------------
// Parte E — 🔴 Pagamentos está isolada do período global
// ---------------------------------------------------------------------------
//
// `getPayments` → `ensureMonth` → `.insert(rows)`. Abrir um mês em Pagamentos
// **gera** os pagamentos fixos desse mês. É anterior ao Financeiro V2 e está
// bloqueado pelo incidente — mas o período global tornaria o gatilho um clique
// nas setas ‹ ›.
//
// Estes testes provam que a casca não amplia a exposição.

describe("Financeiro V2 — Pagamentos isolada do período global", () => {
  const NAV = "src/components/financeiro/finance-nav.tsx";
  const SHELL = "src/components/financeiro/finance-shell.tsx";
  const PAGAMENTOS = "src/app/(dashboard)/dashboard/financeiro/pagamentos/page.tsx";

  it("a lista de vistas isoladas tem exactamente Pagamentos", () => {
    const nav = codigo(ler(NAV));
    const bloco = nav.slice(nav.indexOf("PERIOD_ISOLATED_VIEWS"));
    const rotas = [...bloco.slice(0, 400).matchAll(/"(\/dashboard\/[^"]+)"/g)].map((m) => m[1]);
    expect(rotas).toEqual(["/dashboard/financeiro/pagamentos"]);
  });

  it("A/B: a navegação não transporta o mês para Pagamentos", () => {
    // Sair do Resumo ou do Fluxo em Setembro e clicar em Pagamentos não pode
    // levar `?mes=2026-09` — isso materializaria Setembro.
    const nav = codigo(ler(NAV));
    expect(nav, "o destino tem de depender do isolamento").toMatch(/isPeriodIsolated\(href\)/);
    expect(nav).toMatch(/isPeriodIsolated\(href\)\s*\?\s*href\s*:\s*withFinancePeriod/);
  });

  it("C/D: a casca não desenha seletor nem setas numa vista isolada", () => {
    const shell = codigo(ler(SHELL));
    expect(shell).toMatch(/periodIsolated/);
    // O seletor (que contém as setas ‹ ›) só é renderizado no ramo não-isolado.
    expect(shell).toMatch(/periodIsolated\s*\?[\s\S]{0,400}?:\s*\(\s*<FinancePeriodPicker/);
  });

  it("a página de Pagamentos declara-se isolada", () => {
    expect(codigo(ler(PAGAMENTOS))).toMatch(/periodIsolated/);
  });

  it("E: as outras seis vistas continuam a receber o período", () => {
    const nav = codigo(ler(NAV));
    for (const rota of [
      "/dashboard/financeiro",
      "/dashboard/financeiro/contas",
      "/dashboard/financeiro/fluxo-caixa",
      "/dashboard/cobrancas",
      "/dashboard/folha-pagamento",
      "/dashboard/financeiro/conciliacao",
    ]) {
      // Estão em FINANCE_VIEWS e não na lista de isoladas.
      expect(nav).toContain(`"${rota}"`);
    }
    const bloco = nav.slice(nav.indexOf("PERIOD_ISOLATED_VIEWS"), nav.indexOf("PERIOD_ISOLATED_VIEWS") + 400);
    for (const rota of [
      "/dashboard/financeiro/contas",
      "/dashboard/financeiro/fluxo-caixa",
      "/dashboard/cobrancas",
      "/dashboard/folha-pagamento",
      "/dashboard/financeiro/conciliacao",
    ]) {
      expect(bloco, `${rota} não é isolada`).not.toContain(rota);
    }
  });

  it("o seletor legado da própria vista não foi tocado", () => {
    // Removê-lo tiraria a única forma de navegar meses em Pagamentos. Não é
    // deste PR, e mexer-lhe seria mudar comportamento sob diagnóstico.
    const client = codigo(ler(
      "src/app/(dashboard)/dashboard/financeiro/pagamentos/_components/payments-client.tsx",
    ));
    expect(client).toMatch(/type="month"/);
    expect(client).toMatch(/handleMonthChange/);
  });
});

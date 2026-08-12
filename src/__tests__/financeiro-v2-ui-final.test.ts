// ============================================================================
// Financeiro V2 — a UI aprovada, verificada estruturalmente
// ============================================================================
//
// Estes testes não verificam aparência. Cor e espaçamento vêem-se num
// screenshot; o que não se vê é um painel que perdeu a ligação aos dados, ou
// um componente que aprendeu a desenhar zero quando não sabe.
//
// Verificam três coisas:
//
//   1. os blocos da hierarquia aprovada existem e estão pela ordem certa;
//   2. `null` não consegue virar `0` — por construção, não por convenção;
//   3. as acções continuam todas ligadas.
// ============================================================================

import { describe, it, expect } from "vitest";
import fs from "node:fs";
import path from "node:path";

import { stripComments } from "@/lib/finance-write-surface";

const ROOT = process.cwd();
const ler = (rel: string): string => fs.readFileSync(path.join(ROOT, rel), "utf8");
const codigo = (rel: string): string => stripComments(ler(rel));

const RESUMO = "src/app/(dashboard)/dashboard/financeiro/_components/financial-dashboard-client.tsx";
const V2 = "src/components/financeiro/v2";

// ─── 1. Tokens ───────────────────────────────────────────────────────────────

describe("Financeiro V2 — o sistema de cor é central", () => {
  const css = ler("src/app/globals.css");

  it("os tokens do módulo existem, todos", () => {
    for (const t of [
      "--finance-bg", "--finance-surface", "--finance-border", "--finance-divider",
      "--finance-text", "--finance-text-secondary", "--finance-text-muted",
      "--finance-primary", "--finance-primary-soft", "--finance-primary-border",
      "--finance-green", "--finance-green-soft",
      "--finance-orange", "--finance-orange-soft",
      "--finance-red", "--finance-red-soft",
      "--finance-track", "--finance-grid",
    ]) {
      expect(css, `${t} em falta`).toContain(t);
    }
  });

  it("violeta é a cor estrutural do módulo", () => {
    expect(css).toMatch(/--finance-primary:\s*#6558F5/i);
  });

  it("as séries dos gráficos têm cor fixa — a mesma coisa é sempre a mesma cor", () => {
    expect(css).toMatch(/--finance-series-faturado:\s*#6558F5/i);
    expect(css).toMatch(/--finance-series-recebido:\s*#16A35A/i);
    expect(css).toMatch(/--finance-series-despesas:\s*#FF6B1A/i);
  });

  it("🔴 o tema geral da aplicação não foi tocado — continua verde", () => {
    // O violeta é do Financeiro. Trocar a cor primária global mudaria o
    // calendário, os colaboradores e tudo o resto, que não é desta ronda.
    expect(css).toMatch(/--color-primary:\s*#22C55E/i);
  });
});

// ─── 2. `null` não vira zero, por construção ────────────────────────────────

describe("Financeiro V2 — ausência de dado não é zero", () => {
  it("🔴 o contrato visual não tem forma de exprimir um valor em falta", () => {
    // `dados` só existe no estado `pronto`. Um painel não consegue, nem por
    // descuido, desenhar zero quando o que tem é ausência — teria de mudar de
    // estado, e isso lê-se no diff.
    const src = codigo(`${V2}/visual-contract.tsx`);
    expect(src).toMatch(/estado:\s*"indisponivel"/);
    expect(src).toMatch(/estado:\s*"pronto";\s*dados:\s*T/);
    expect(src, "só o estado pronto transporta dados").not.toMatch(/estado:\s*"indisponivel";\s*dados/);
  });

  it("o formatador devolve travessão, nunca 0,00 €", () => {
    const src = codigo("src/lib/finance-format.ts");
    expect(src).toMatch(/v === null \|\| v === undefined[\s\S]{0,40}return "—"/);
  });

  it("nenhum painel usa `?? 0` para tapar um valor em falta", () => {
    for (const f of fs.readdirSync(path.join(ROOT, V2))) {
      if (!f.endsWith(".tsx")) continue;
      const src = codigo(`${V2}/${f}`);
      expect(src, `${f} tapa ausência com zero`).not.toMatch(/(valor|value|dados|total)\s*\?\?\s*0\b/);
    }
  });

  it("o KPI aceita explicitamente o estado indisponível", () => {
    expect(codigo(`${V2}/finance-kpi-card.tsx`)).toMatch(/Indisponivel/);
  });
});

// ─── 3. Os blocos da hierarquia aprovada ────────────────────────────────────

describe("Financeiro V2 — a hierarquia aprovada está montada", () => {
  const src = codigo(RESUMO);

  const BLOCOS = [
    "FinanceAlertStrip",
    "FinanceKpiGrid",
    "FinanceMainChart",
    "FinanceAttentionPanel",
    "FinanceCashForecast",
    "FinanceAging",
    "FinanceTopClients",
    "FinanceRevenueByService",
    "FinanceTeamEfficiency",
  ];

  it("todos os blocos existem no Resumo", () => {
    for (const b of BLOCOS) expect(src, `${b} em falta`).toContain(`<${b}`);
  });

  it("🔴 estão pela ordem certa: alertas → KPIs → gráfico → atenção → inteligência", () => {
    // A ordem é a decisão de design mais importante desta página: o que exige
    // acção vem antes do que descreve o passado.
    const posicoes = BLOCOS.map((b) => ({ b, i: src.indexOf(`<${b}`) }));
    for (const p of posicoes) expect(p.i, `${p.b} não encontrado`).toBeGreaterThan(-1);
    const ordenadas = [...posicoes].sort((a, z) => a.i - z.i).map((p) => p.b);
    expect(ordenadas).toEqual(BLOCOS);
  });

  it("são cinco KPIs, nem mais nem menos", () => {
    const dentro = src.slice(src.indexOf("<FinanceKpiGrid"), src.indexOf("</FinanceKpiGrid>"));
    expect((dentro.match(/<FinanceKpiCard/g) ?? []).length).toBe(5);
  });

  it("o gráfico é dominante — dois terços contra um da coluna de atenção", () => {
    expect(src).toMatch(/xl:grid-cols-3/);
    expect(src).toMatch(/xl:col-span-2/);
  });

  it("o resumo do calendário abre a página, e mantém o detalhe ao clicar", () => {
    // Esteve no fim, e voltou ao topo a pedido do dono. Faz sentido: num mês
    // sem faturação emitida, é a única secção com números a sério.
    //
    // O que não pode voltar é o cartão antigo, pesado e com o seu próprio
    // sistema de cor.
    expect(src).not.toMatch(/<PeriodCard/);
    expect(src, "o detalhe ao clicar tem de sobreviver").toMatch(/<PeriodBreakdown/);
    const iOperacional = src.indexOf("PERIODOS_OPERACIONAIS.map");
    const iKpis = src.indexOf("<FinanceKpiGrid");
    expect(iOperacional).toBeGreaterThan(-1);
    expect(iOperacional, "o calendário vem antes dos KPIs").toBeLessThan(iKpis);
  });
});

// ─── 4. O que não tem fonte diz que não tem ─────────────────────────────────

describe("Financeiro V2 — os painéis sem fonte não inventam", () => {
  const src = codigo(RESUMO);

  it("🔴 previsão e eficiência continuam indisponíveis", () => {
    // A lista encolhe à medida que as fontes existem. `FinanceAging` saiu
    // quando o motor passou a repartir faturas vencidas por idade; o donut
    // saiu quando deixou de mostrar receita por serviço e passou a mostrar
    // despesas por categoria, que têm fonte real.
    for (const bloco of ["FinanceCashForecast", "FinanceTeamEfficiency"]) {
      const i = src.indexOf(`<${bloco}`);
      const trecho = src.slice(i, i + 300);
      expect(trecho, `${bloco} devia estar indisponível`).toMatch(/estado:\s*"indisponivel"/);
    }
  });

  it("🔴 o donut mostra despesas por categoria, não receita por serviço", () => {
    // Classificar receita por serviço exigiria adivinhar pela descrição. A
    // classificação de despesas existe desde sempre em `category`.
    const i = src.indexOf("<FinanceRevenueByService");
    const trecho = src.slice(i, i + 700);
    expect(trecho).toMatch(/titulo="Despesas por categoria"/);
    expect(trecho).toMatch(/snapshot\?\.expensesByCategory\.estado === "AVAILABLE"/);
    expect(trecho, "e tem saída para indisponível").toMatch(/estado:\s*"indisponivel"/);
  });

  it("o componente de receita por serviço fica em STANDBY, não apagado", () => {
    // Volta quando os serviços tiverem classificação verdadeira. Apagá-lo
    // obrigaria a reescrevê-lo do zero nessa altura.
    const prim = ler(`${V2}/finance-intelligence.tsx`);
    expect(prim).toContain("FinanceRevenueByService");
    expect(prim, "o título tem de ser configurável").toMatch(/titulo\s*=\s*"Receita por serviço"/);
  });

  it("aging e top clientes vêm do snapshot, com estado", () => {
    // O padrão importa: `estado === "AVAILABLE"` antes de desenhar, e
    // `indisponivel` em qualquer outro caso. Sem o teste do estado, um bloco
    // em ERROR desenharia barras vazias que se leriam como "nada vencido".
    for (const bloco of ["FinanceAging", "FinanceTopClients"]) {
      const i = src.indexOf(`<${bloco}`);
      const trecho = src.slice(i, i + 700);
      expect(trecho, `${bloco} não consulta o snapshot`).toMatch(/snapshot\?\.\w+\.estado === "AVAILABLE"/);
      expect(trecho, `${bloco} não tem saída para indisponível`).toMatch(/estado:\s*"indisponivel"/);
    }
  });

  it("🔴 «Recebido» tem fonte própria — nunca a receita faturada", () => {
    // Preenchê-lo com o faturado seria afirmar que está tudo cobrado. Vem das
    // entradas de caixa confirmadas, e de mais lado nenhum.
    const i = src.indexOf('label="Recebido"');
    expect(i).toBeGreaterThan(-1);
    const trecho = src.slice(i, i + 260);
    expect(trecho).toMatch(/slotDeMedida\(snapshot\?\.kpis\.recebido\)/);
    expect(trecho).not.toMatch(/currentMonthRevenue|faturado/);
  });

  it("🔴 os cinco KPIs vêm todos do motor, nenhum do legado", () => {
    // `getFinancialDashboard` ignora o período: se um KPI ainda o lesse, o
    // seletor de mês voltaria a mentir sobre esse número.
    const grid = src.slice(src.indexOf("<FinanceKpiGrid"), src.indexOf("</FinanceKpiGrid>"));
    expect((grid.match(/slotDeMedida\(snapshot\?\.kpis\./g) ?? []).length).toBe(5);
    expect(grid, "nenhum KPI pode ler o loader legado").not.toMatch(/data\.currentMonth|data\.pendingRevenue/);
  });

  it("a série «recebido» do gráfico é null, não zero", () => {
    expect(src).toMatch(/recebido:\s*null/);
  });

  it("os rótulos acompanham a fonte, e não o contrário", () => {
    // "Custos (Salários)" era honesto enquanto a fonte era só a folha. Agora
    // cobre saídas de caixa — fornecedores, despesas, avarias — e manter o
    // parêntesis passaria a ser a mentira oposta.
    expect(src).toContain('label="Custos"');
    expect(src).toContain('label="Faturado"');
    expect(src).not.toContain('label="Receita"');
  });

  it("não existe Meta mensal nem Atividade recente inventadas", () => {
    expect(src).not.toMatch(/Meta mensal|Atividade recente|em constru/i);
  });
});

// ─── 5. Navegação e período ─────────────────────────────────────────────────

describe("Financeiro V2 — uma navegação, um período", () => {
  it("a barra tem exactamente as sete vistas, pela ordem", () => {
    const nav = codigo("src/components/financeiro/finance-nav.tsx");
    const rotas = [...nav.matchAll(/href:\s*"(\/dashboard\/[^"]+)"/g)].map((m) => m[1]);
    expect(rotas).toEqual([
      "/dashboard/financeiro",
      "/dashboard/financeiro/pagamentos",
      "/dashboard/financeiro/contas",
      "/dashboard/financeiro/fluxo-caixa",
      "/dashboard/cobrancas",
      "/dashboard/folha-pagamento",
      "/dashboard/financeiro/conciliacao",
    ]);
  });

  it("nenhuma vista está isolada do período global", () => {
    const nav = codigo("src/components/financeiro/finance-nav.tsx");
    const bloco = nav.slice(nav.indexOf("PERIOD_ISOLATED_VIEWS"));
    expect([...bloco.slice(0, 300).matchAll(/"(\/dashboard\/[^"]+)"/g)].map((m) => m[1])).toEqual([]);
  });

  it("não sobrou nenhum segundo seletor de mês em vista financeira", () => {
    for (const f of [
      RESUMO,
      "src/app/(dashboard)/dashboard/financeiro/pagamentos/_components/payments-client.tsx",
      "src/app/(dashboard)/dashboard/financeiro/fluxo-caixa/_components/cash-flow-client.tsx",
      "src/app/(dashboard)/dashboard/cobrancas/_components/invoices-client.tsx",
    ]) {
      expect(codigo(f), `${f} tem um segundo seletor`).not.toMatch(/type="month"/);
    }
  });
});

// ─── 6. A UI não sabe o que é uma tabela ────────────────────────────────────

describe("Financeiro V2 — os primitivos não tocam em dados", () => {
  it("nenhum componente visual conhece Supabase, tabelas ou actions", () => {
    for (const f of fs.readdirSync(path.join(ROOT, V2))) {
      if (!f.endsWith(".tsx")) continue;
      const src = codigo(`${V2}/${f}`);
      expect(src, `${f} importa Supabase`).not.toMatch(/@\/lib\/supabase|createClient|createAdminClient/);
      expect(src, `${f} chama uma action`).not.toMatch(/@\/app\/actions/);
      // `.from("tabela")` — com o nome da tabela. `Array.from({…})` não conta,
      // e confundir os dois daria um falso positivo em qualquer gráfico.
      expect(src, `${f} conhece uma tabela`).not.toMatch(/\.from\s*\(\s*["'`]/);
    }
  });

  it("também não fazem contas financeiras", () => {
    // Uma percentagem calculada na UI é uma segunda fonte de verdade, e as
    // duas divergem no dia em que a regra mudar num sítio só.
    for (const f of ["finance-kpi-card.tsx", "finance-alert-strip.tsx", "finance-attention-panel.tsx"]) {
      const src = codigo(`${V2}/${f}`);
      expect(src, `${f} calcula IVA ou margem`).not.toMatch(/\*\s*0\.23|\/\s*1\.23|margem\s*=/i);
    }
  });
});

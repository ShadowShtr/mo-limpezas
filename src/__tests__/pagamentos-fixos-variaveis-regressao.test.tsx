// @vitest-environment jsdom
// ============================================================================
// REGRESSÃO PÓS-#117 — fixos/variáveis, categorias e o CTA de Cobranças
// ============================================================================
//
// O proprietário validou a vista unificada em produção e encontrou o que os
// testes não cobriam. Nenhum destes defeitos era de dados: eram de LEITURA —
// informação que existia e deixou de estar ao alcance de quem gere.
//
//   1. FIXOS / VARIÁVEIS
//      A vista anterior tinha dois separadores com contagem. A unificada
//      dissolveu-os num select de "origem", ao lado de Folha e Cobrança. O
//      `row.origin` nunca se perdeu — perdeu-se a pergunta respondida num
//      clique: «o que se repete todos os meses?».
//
//   2. CATEGORIAS
//      O filtro listava apenas o catálogo ACTIVO. Uma linha com categoria
//      desactivada — ou o catálogo indisponível, que devolve `[]` sem falhar —
//      mostrava o nome na tabela e não o tinha no filtro.
//
//   3. «MÊS POR PREPARAR»
//      A vista anterior distinguia «ninguém lançou nada» de «não há nada a
//      pagar». Totais a 0,00 € afirmam o segundo quando só se sabe o primeiro.
//
// 🔴 Os testes exercitam o DOM. O bug era visual/funcional: um teste sobre o
//    modelo teria continuado verde durante toda a regressão.
// ============================================================================

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import fs from "node:fs";
import path from "node:path";
import {
  buildFinanceLedger,
  type FinanceLedgerCashflowSource,
  type FinanceLedgerPaymentSource,
} from "@/domain/finance/ledger";
import {
  categoryFilterOptions,
  categoryKey,
  categorySlices,
  filterFinanceLedger,
  financeLedgerCounts,
  mesPorPreparar,
} from "@/domain/finance/ledger-presentation";

vi.mock("next/navigation", () => ({
  useRouter: () => ({ refresh: () => {}, push: () => {}, replace: () => {} }),
}));

const ROOT = process.cwd();
const ler = (rel: string) => fs.readFileSync(path.join(ROOT, rel), "utf8");

let container: HTMLDivElement;
let root: Root;

beforeEach(() => {
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
});

const pagamento = (patch: Partial<FinanceLedgerPaymentSource> = {}): FinanceLedgerPaymentSource => ({
  id: "p1", kind: "fixo", description: "Renda", amount: 500,
  due_date: "2026-08-05", status: "pendente", period_year: 2026, period_month: 8,
  paid_at: null, direct_debit: true, notes: null,
  expense_category_id: "cat-a", category_name: "Instalações",
  created_at: "2026-08-01T10:00:00Z", updated_at: "2026-08-01T10:00:00Z", ...patch,
});

const movimento = (patch: Partial<FinanceLedgerCashflowSource> = {}): FinanceLedgerCashflowSource => ({
  id: "c1", type: "saida", amount: 80, description: "Combustível", category: "despesa",
  date: "2026-08-12", reference_type: null, reference_id: null, status: "confirmado",
  notes: null, expense_category_id: "cat-b", category_name: "Deslocações",
  created_at: "2026-08-12T10:00:00Z", ...patch,
});

/** O mês real: dois fixos, um variável e um movimento manual. */
const mesCompleto = () => buildFinanceLedger({
  payments: [
    pagamento({ id: "p1", kind: "fixo", description: "Renda" }),
    pagamento({ id: "p2", kind: "fixo", description: "Seguro", amount: 120 }),
    pagamento({ id: "p3", kind: "variavel", description: "Material extra", amount: 45, status: "pago", paid_at: "2026-08-14T10:00:00Z" }),
  ],
  cashflows: [movimento()],
});

async function mostrar(
  rows: ReturnType<typeof buildFinanceLedger>,
  categories: Array<{ id: string; name: string }> = [],
) {
  const { UnifiedPaymentsClient } = await import(
    "@/app/(dashboard)/dashboard/financeiro/pagamentos/_components/unified-payments-client"
  );
  await act(async () => {
    root.render(
      <UnifiedPaymentsClient
        rows={rows}
        error={null}
        categories={categories}
        companyId="11111111-1111-4111-8111-111111111111"
        year={2026}
        month={8}
      />,
    );
  });
  return container;
}

// ═══════════════════════════════════════════════════════════════════════════
// 1. FIXOS E VARIÁVEIS
// ═══════════════════════════════════════════════════════════════════════════
describe("1. fixos e variáveis voltam a ser separadores", () => {
  it("🔴 os separadores Fixos e Variáveis existem no ecrã", async () => {
    const el = await mostrar(mesCompleto());
    const texto = el.textContent ?? "";
    expect(texto).toContain("Fixos");
    expect(texto).toContain("Variáveis");
  });

  it("🔴 cada separador traz a sua contagem, como a vista antiga", () => {
    const counts = financeLedgerCounts(mesCompleto());
    expect(counts.fixos).toBe(2);
    expect(counts.variaveis).toBe(1);
    expect(counts.manuais).toBe(1);
    expect(counts.todos).toBe(4);
  });

  it("🔴 o filtro Fixos mostra só os fixos — e todos eles", () => {
    const fixos = filterFinanceLedger(mesCompleto(), "fixos");
    expect(fixos.map((r) => r.description).sort()).toEqual(["Renda", "Seguro"]);
  });

  it("🔴 o filtro Variáveis mostra só os variáveis", () => {
    const variaveis = filterFinanceLedger(mesCompleto(), "variaveis");
    expect(variaveis.map((r) => r.description)).toEqual(["Material extra"]);
  });

  it("um movimento manual não é fixo nem variável", () => {
    const manuais = filterFinanceLedger(mesCompleto(), "manuais");
    expect(manuais.map((r) => r.description)).toEqual(["Combustível"]);
    expect(filterFinanceLedger(mesCompleto(), "fixos").some((r) => r.is_manual)).toBe(false);
  });

  it("🔴 NENHUMA linha se perde: todos + manuais cobrem o mês inteiro", () => {
    const rows = mesCompleto();
    // "todos" é o conjunto completo — nenhum filtro esconde dados do período.
    expect(filterFinanceLedger(rows, "todos")).toHaveLength(4);
    const porTipo = new Set([
      ...filterFinanceLedger(rows, "fixos"),
      ...filterFinanceLedger(rows, "variaveis"),
      ...filterFinanceLedger(rows, "manuais"),
    ].map((r) => r.row_id));
    expect(porTipo.size).toBe(4);
  });

  it("🔴 há atalhos para criar já com o tipo certo", async () => {
    const el = await mostrar(mesCompleto());
    const texto = el.textContent ?? "";
    expect(texto).toContain("Novo fixo");
    expect(texto).toContain("Novo variável");
  });

  it("a coluna Origem continua a distinguir Fixo de Variável", async () => {
    const el = await mostrar(mesCompleto());
    const texto = el.textContent ?? "";
    expect(texto).toContain("Fixo");
    expect(texto).toContain("Variável");
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// 2. CATEGORIAS
// ═══════════════════════════════════════════════════════════════════════════
describe("2. categorias não perdem informação", () => {
  it("🔴 uma categoria fora do catálogo activo continua filtrável", () => {
    const rows = mesCompleto();
    // O catálogo só conhece uma das duas categorias usadas pelas linhas.
    const opcoes = categoryFilterOptions(rows, [{ id: "cat-a", name: "Instalações" }]);
    const ids = opcoes.map((o) => o.id);
    expect(ids).toContain("cat-a");
    expect(ids).toContain("cat-b"); // veio das linhas, não do catálogo
  });

  it("🔴 catálogo indisponível (lista vazia) não esvazia o filtro", () => {
    const opcoes = categoryFilterOptions(mesCompleto(), []);
    expect(opcoes.length).toBeGreaterThan(0);
    expect(opcoes.map((o) => o.name)).toContain("Instalações");
    expect(opcoes.map((o) => o.name)).toContain("Deslocações");
  });

  it("o catálogo continua a ser a fonte do nome quando o tem", () => {
    // Se o catálogo renomeou a categoria, é esse o nome que se oferece.
    const opcoes = categoryFilterOptions(mesCompleto(), [{ id: "cat-a", name: "Instalações (2026)" }]);
    expect(opcoes.find((o) => o.id === "cat-a")?.name).toBe("Instalações (2026)");
  });

  it("uma categoria sem nome resolvido não desaparece do filtro", () => {
    const rows = buildFinanceLedger({
      payments: [pagamento({ expense_category_id: "cat-x", category_name: null })],
      cashflows: [],
    });
    const opcoes = categoryFilterOptions(rows, []);
    expect(opcoes.map((o) => o.id)).toContain("cat-x");
  });

  // ── Categoria LEGADA (texto, sem expense_category_id) ─────────────────────
  //
  // 🔴 `cash_flow_entries` tem duas gerações de categoria: a estruturada
  //    (`expense_category_id` → `expense_categories`) e a legada, texto livre
  //    em `cash_flow_entries.category`. O ledger já mostrava a legada na
  //    tabela; o filtro e o gráfico não a conheciam.
  const legada = (id: string, categoria: string, amount: number): FinanceLedgerCashflowSource => ({
    ...movimento({ id, amount }),
    category: categoria,
    expense_category_id: null,
    category_name: null,
  });

  it("🔴 uma categoria LEGADA é filtrável — antes era invisível", () => {
    const rows = buildFinanceLedger({ payments: [], cashflows: [legada("c1", "despesa", 80)] });
    // A tabela mostrava «despesa»; o filtro devolvia [] e a linha caía em
    // «Sem categoria». Duas leituras da mesma coisa, a discordar.
    expect(rows[0].category_name).toBe("despesa");
    const opcoes = categoryFilterOptions(rows, []);
    expect(opcoes.map((o) => o.name)).toContain("despesa");
  });

  it("🔴 DUAS legadas distintas não colapsam numa fatia só", () => {
    // Medido antes da correcção: 80 € de «despesa» + 50 € de «fornecedor»
    // apareciam como 130 € de «fornecedor» — dinheiro atribuído à categoria
    // errada, num ecrã que existe para dizer onde o dinheiro foi parar.
    const rows = buildFinanceLedger({
      payments: [],
      cashflows: [legada("c1", "despesa", 80), legada("c2", "fornecedor", 50)],
    });
    const fatias = categorySlices(rows, { year: 2026, month: 8 }, "caixa");
    expect(fatias).toHaveLength(2);
    expect(fatias.find((f) => f.name === "despesa")?.amount_cents).toBe(8_000);
    expect(fatias.find((f) => f.name === "fornecedor")?.amount_cents).toBe(5_000);
  });

  it("🔴 tabela, filtro e gráfico usam a MESMA identidade", () => {
    const rows = buildFinanceLedger({
      payments: [],
      cashflows: [legada("c1", "despesa", 80), legada("c2", "fornecedor", 50)],
    });
    const chaves = rows.map(categoryKey);
    // Uma chave por categoria real — nem a mais, nem a menos.
    expect(new Set(chaves).size).toBe(2);
    // E cada chave do filtro corresponde a linhas reais.
    for (const opcao of categoryFilterOptions(rows, [])) {
      expect(rows.some((row) => categoryKey(row) === opcao.id)).toBe(true);
    }
  });

  it("estruturada e legada não colidem no mesmo espaço de chaves", () => {
    const rows = buildFinanceLedger({
      payments: [pagamento({ expense_category_id: "despesa", category_name: "Instalações" })],
      cashflows: [legada("c1", "despesa", 80)],
    });
    // Um id estruturado com o mesmo texto de uma legada continua distinto.
    expect(new Set(rows.map(categoryKey)).size).toBe(2);
  });

  it("«sem categoria» continua a ser um estado único, não uma opção duplicada", () => {
    const rows = buildFinanceLedger({
      payments: [pagamento({ expense_category_id: null, category_name: null })],
      cashflows: [],
    });
    expect(categoryKey(rows[0])).toBe("uncategorized");
    // Já existe como opção fixa do filtro — não se repete nas derivadas.
    expect(categoryFilterOptions(rows, []).map((o) => o.id)).not.toContain("uncategorized");
  });

  it("🔴 o nome da categoria aparece na tabela", async () => {
    const el = await mostrar(mesCompleto(), [{ id: "cat-a", name: "Instalações" }]);
    expect(el.textContent ?? "").toContain("Instalações");
  });

  it("sem categoria continua a ser um estado válido, não um erro", async () => {
    const rows = buildFinanceLedger({
      payments: [pagamento({ expense_category_id: null, category_name: null })],
      cashflows: [],
    });
    const el = await mostrar(rows);
    expect(el.textContent ?? "").toContain("Sem categoria");
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// 3. MÊS POR PREPARAR
// ═══════════════════════════════════════════════════════════════════════════
describe("3. «mês por preparar» ≠ «nada a pagar»", () => {
  it("🔴 um mês sem pagamentos avisa em vez de mostrar 0,00 € como verdade", async () => {
    const el = await mostrar(buildFinanceLedger({ payments: [], cashflows: [] }));
    expect(el.textContent ?? "").toContain("Mês ainda não preparado");
  });

  it("um mês com pagamentos NÃO mostra esse aviso", async () => {
    const el = await mostrar(mesCompleto());
    expect(el.textContent ?? "").not.toContain("Mês ainda não preparado");
  });

  it("um mês só com movimentos manuais continua por preparar", () => {
    // Há caixa, mas nenhuma obrigação lançada: a distinção mantém-se.
    const rows = buildFinanceLedger({ payments: [], cashflows: [movimento()] });
    expect(mesPorPreparar(rows)).toBe(true);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// 4. COBRANÇAS — CTA no Diário
// ═══════════════════════════════════════════════════════════════════════════
describe("4. Cobranças > Diário tem CTA de adicionar", () => {
  const DIARIO = ler("src/app/(dashboard)/dashboard/cobrancas/_components/daily-billing-client.tsx");

  it("🔴 o botão «Adicionar cobrança» existe", () => {
    expect(DIARIO).toContain("Adicionar cobrança");
  });

  it("🔴 cria AQUI — sem sair do ecrã para o calendário", () => {
    // A primeira versão navegava para `/dashboard/calendario?date=...`.
    // Chegava lá, mas transformava «adicionar» numa viagem, e quem está a
    // fechar o dia perdia o contexto.
    expect(DIARIO).toContain("<ServiceCreateSheet");
    expect(DIARIO).not.toMatch(/\/dashboard\/calendario\?date=/);
  });

  it("🔴 o formulário abre no DIA EM VISTA, não em «hoje»", () => {
    // Quem está a fechar o dia 12 cria para o dia 12.
    expect(DIARIO).toMatch(/date=\{new Date\(`\$\{date\}T12:00:00`\)\}/);
  });

  it("🔴 reutiliza o componente canónico — não duplica o formulário", () => {
    // Uma linha do Diário É um serviço agendado. Criar aqui um registo solto
    // produziria cobrança sem serviço — dinheiro num sítio, trabalho noutro.
    // O `ServiceCreateSheet` é o mesmo que o calendário e a ficha de cliente
    // já usam: um caminho de criação, não três cópias dele.
    expect(DIARIO).toMatch(/from "\.\.\/\.\.\/calendario\/_components\/service-create-sheet"/);
    // E nenhuma escrita directa a `services` nasceu aqui.
    expect(DIARIO).not.toMatch(/from\("services"\)[\s\S]{0,120}?\.insert\(/);
  });

  it("depois de criar, a lista do dia é recarregada", () => {
    // Sem isto o serviço novo só apareceria ao mudar de dia e voltar.
    expect(DIARIO).toMatch(/onCreated=\{[^}]*refresh\(\)/);
  });

  it("os restantes modos do ecrã não foram tocados", () => {
    // Navegação de dia, atualizar e registo de pagamento continuam.
    expect(DIARIO).toContain("Dia anterior");
    expect(DIARIO).toContain("Dia seguinte");
    expect(DIARIO).toContain("setServicePayment");
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// 5. NADA REGREDIU NOS CAMINHOS ATÓMICOS
// ═══════════════════════════════════════════════════════════════════════════
describe("5. os caminhos de escrita continuam intactos", () => {
  it("🔴 payments.ts não foi tocado por esta correcção", () => {
    const source = ler("src/app/actions/payments.ts");
    expect(source).toContain("update_payment_atomic");
    expect(source).toContain("delete_payment_atomic");
  });

  it("🔴 cash-flow.ts mantém as RPCs atómicas", () => {
    const source = ler("src/app/actions/cash-flow.ts");
    expect(source).toContain("update_cashflow_entry_atomic");
    expect(source).toContain("delete_cashflow_entry_atomic");
  });

  it("a protecção de integridade da ronda anterior continua", async () => {
    const rows = buildFinanceLedger({
      payments: [pagamento({ id: "p9", amount: 500 })],
      cashflows: [movimento({ id: "c9", amount: 300, reference_type: "fixed_variable_payment", reference_id: "p9" })],
    });
    expect(rows[0].integrity_issue).toBe("linked_amount_mismatch");
    const el = await mostrar(rows);
    expect(el.textContent ?? "").toContain("Valor do pagamento diferente do movimento de caixa");
  });
});

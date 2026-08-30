"use server";

import { createAdminClient } from "@/lib/supabase/admin";
import {
  resolverCategoriaEfetiva, idsDePagamentoAResolver,
  type CategoriaDoPagamento,
} from "@/domain/finance-v2/effective-expense-category";
import { createClient } from "@/lib/supabase/server";
import { requireProfile } from "@/lib/auth-guard";
import { isValidCashFlowAmount } from "@/lib/cash-flow-integrity";
import { estaPorReceber } from "@/domain/finance-v2/aggregate";
import { todayInLisbon } from "@/lib/lisbon-time";
import { isValidIsoDateString } from "@/lib/utils";
import { revalidatePath } from "next/cache";
import {
  assertFinancialPeriodOpen,
  assertPeriodosAbertosParaMudancaDeData,
  type ClientePeriodo,
} from "@/lib/finance-period-guard";

export type CashFlowType = "entrada" | "saida";
export type CashFlowCategory = "faturacao" | "salario" | "despesa" | "fornecedor" | "outro";
export type CashFlowStatus = "pendente" | "confirmado";

export interface CashFlowEntry {
  id: string;
  type: CashFlowType;
  amount: number;
  description: string;
  category: CashFlowCategory | null;
  date: string;
  reference_id: string | null;
  reference_type: "invoice" | "payroll" | null;
  status: CashFlowStatus;
  notes: string | null;
  created_at: string;
  /** Categoria estruturada da 071, quando o movimento tem uma. */
  expense_category_id?: string | null;
  expense_category_name?: string | null;
  expense_category_color?: string | null;
}

export interface CashFlowFilters {
  year: number;
  month: number;
  type?: CashFlowType;
  status?: CashFlowStatus;
}

export async function getCashFlowEntries(
  _companyId: string,
  filters: CashFlowFilters,
): Promise<{ ok: true; entries: CashFlowEntry[]; balance: number; entradas: number; saidas: number; pendentes: number } | { ok: false; error: string }> {
  const guard = await requireProfile({ roles: ["admin", "gestor"] });
  if (!guard.ok) return { ok: false, error: guard.error };
  const { admin } = guard;
  const companyId = guard.profile.company_id;
  const start = `${filters.year}-${String(filters.month).padStart(2, "0")}-01`;
  // getDate() lê o dia em hora local (sem round-trip por toISOString/UTC, que
  // desloca o resultado 1 dia para trás em hora de verão de Lisboa).
  const monthEndDay = new Date(filters.year, filters.month, 0).getDate();
  const end = `${filters.year}-${String(filters.month).padStart(2, "0")}-${String(monthEndDay).padStart(2, "0")}`;

  // Mesmo padrão das Contas: pede-se a categoria estruturada e recua-se sem
  // ela **só** quando a base ainda não a tem.
  const consulta = (colunas: string) => {
    let q = admin
      .from("cash_flow_entries")
      .select(colunas)
      .eq("company_id", companyId)
      .gte("date", start)
      .lte("date", end)
      .order("date", { ascending: false })
      .order("created_at", { ascending: false });
    if (filters.type) q = q.eq("type", filters.type);
    if (filters.status) q = q.eq("status", filters.status);
    return q;
  };

  let { data, error } = await consulta("*, expense_categories(name, color_token)");
  if (error && categoriaAindaNaoExiste(error)) {
    console.error(
      "[fluxo-caixa] categoria estruturada indisponível.", error.code, error.message,
    );
    ({ data, error } = await consulta("*"));
  }
  if (error) return { ok: false, error: error.message };

  type LinhaCaixa = CashFlowEntry & {
    expense_categories?: { name: string; color_token: string | null }
      | { name: string; color_token: string | null }[] | null;
  };
  const linhas = (data ?? []) as unknown as LinhaCaixa[];

  // ── A mesma regra do resumo, no mesmo sítio ───────────────────────────────
  //
  // 🔴 Uma saída nascida de um pagamento é classificada pelo pagamento. Se a
  //    lista usasse a categoria do movimento e o donut usasse a do pagamento,
  //    voltávamos a ter duas verdades sobre o mesmo facto — que é o defeito
  //    que isto remove. Ver `effective-expense-category.ts`.
  const paraClassificar = linhas.map((r) => ({
    reference_type: r.reference_type,
    reference_id: r.reference_id,
    categoriaEstruturada:
      (Array.isArray(r.expense_categories) ? r.expense_categories[0] : r.expense_categories)?.name ?? null,
    categoriaEstruturadaCor:
      (Array.isArray(r.expense_categories) ? r.expense_categories[0] : r.expense_categories)?.color_token ?? null,
    categoriaLegada: r.category,
  }));

  const idsPagamento = idsDePagamentoAResolver(paraClassificar);
  const categoriaPorPagamento = new Map<string, CategoriaDoPagamento>();

  if (idsPagamento.length > 0) {
    const { data: pgs, error: erroPg } = await admin
      .from("fixed_variable_payments")
      .select("id, expense_categories(name, color_token)")
      .eq("company_id", companyId)
      .in("id", idsPagamento);

    // Falhar a ler não pode virar «nenhum tem categoria»: isso mostraria uma
    // lista plausível e errada. Falha fechada.
    if (erroPg) return { ok: false, error: erroPg.message };

    for (const pg of (pgs ?? []) as unknown as {
      id: string;
      expense_categories?: { name: string; color_token: string | null }
        | { name: string; color_token: string | null }[] | null;
    }[]) {
      const c = Array.isArray(pg.expense_categories) ? pg.expense_categories[0] : pg.expense_categories;
      categoriaPorPagamento.set(pg.id, { nome: c?.name ?? null, cor: c?.color_token ?? null });
    }
  }

  const entries: CashFlowEntry[] = linhas.map((r, i) => {
    const doPagamento = r.reference_id ? categoriaPorPagamento.get(r.reference_id) ?? null : null;
    const efetiva = resolverCategoriaEfetiva(paraClassificar[i], doPagamento);
    return {
      ...r,
      expense_category_name: efetiva.nome,
      expense_category_color: efetiva.cor,
    };
  });
  const confirmed = entries.filter((e) => e.status === "confirmado");
  const entradas  = confirmed.filter((e) => e.type === "entrada").reduce((s, e) => s + e.amount, 0);
  const saidas    = confirmed.filter((e) => e.type === "saida").reduce((s, e) => s + e.amount, 0);
  const pendentes = entries.filter((e) => e.status === "pendente").reduce((s, e) => s + e.amount, 0);
  const balance   = Math.round((entradas - saidas) * 100) / 100;

  return { ok: true, entries, balance, entradas, saidas, pendentes };
}

export async function createCashFlowEntry(
  companyId: string,
  data: {
    type: CashFlowType;
    amount: number;
    description: string;
    category: CashFlowCategory;
    date: string;
    status: CashFlowStatus;
    notes?: string;
    /**
     * Categoria estruturada. Opcional de propósito: o histórico não tem, e
     * obrigar aqui impediria de registar uma despesa numa base onde a 071
     * ainda não foi aplicada.
     */
    expenseCategoryId?: string | null;
  },
): Promise<{ ok: boolean; error?: string }> {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return { ok: false, error: "NÃ£o autenticado." };

  const admin = createAdminClient();
  const { data: profile } = await admin
    .from("profiles")
    .select("company_id, role")
    .eq("id", user.id)
    .single();
  if (!profile || !["admin", "gestor"].includes(profile.role) || profile.company_id !== companyId) {
    return { ok: false, error: "Sem permissÃ£o." };
  }
  if (!isValidCashFlowAmount(data.amount) || !data.description.trim()) {
    return { ok: false, error: "Dados invÃ¡lidos." };
  }

  // 🔴 A data autoritativa é `data.date` — a data do movimento, não hoje. Um
  //    movimento lançado hoje com data de Julho pertence a Julho, e é Julho que
  //    tem de estar aberto.
  const periodo = await assertFinancialPeriodOpen({
    cliente: admin as unknown as ClientePeriodo,
    companyId: profile.company_id,
    data: data.date,
  });
  if (!periodo.ok) return { ok: false, error: periodo.error };

  // 🔴 `expenseCategoryId` tem de sair do spread.
  //
  // `...data` copia as chaves tal como estão, e a base não tem nenhuma coluna
  // com esse nome — o insert seria recusado inteiro por um campo que só existe
  // no vocabulário do TypeScript.
  //
  // E só se envia `expense_category_id` quando **há** categoria: enquanto a
  // 071 não estiver aplicada a coluna não existe, e mandá-la a `null` faria
  // falhar todas as despesas manuais, incluindo as que não querem categoria
  // nenhuma.
  const { expenseCategoryId, ...colunas } = data;

  const linha = {
    company_id: profile.company_id,
    ...colunas,
    ...(expenseCategoryId ? { expense_category_id: expenseCategoryId } : {}),
    created_by: user.id,
  };

  // 🔴 O cast é por a 071 não estar aplicada, e é deliberadamente estreito.
  //
  //    `database.ts` é gerado do esquema **real**, onde `expense_category_id`
  //    ainda não existe. Acrescentá-lo à mão faria os tipos afirmarem que a
  //    coluna existe — e o resto do código deixava de ter como saber que não.
  //    Quando a coluna faltar, é a base que recusa, com o erro verdadeiro.
  // 🔴 O cast fica no argumento, e a chamada continua a **parecer** o que é.
  //
  //    A primeira versão embrulhava o `.insert` numa variável para lhe mudar o
  //    tipo — e com isso o detector de capacidade de escrita deixou de
  //    reconhecer esta action como escrita. O cliquet acusou duas capacidades
  //    «removidas» que estavam bem vivas.
  //
  //    Uma escrita que se disfarça de outra coisa é exactamente o que aquele
  //    inventário existe para impedir. `as never` mantém a forma `.insert(...)`
  //    à vista de quem lê e de quem analisa.
  const { error } = await admin
    .from("cash_flow_entries")
    .insert(linha as unknown as never);

  if (error) return { ok: false, error: error.message };
  revalidatePath("/dashboard/financeiro/fluxo-caixa");
  revalidatePath("/dashboard/financeiro/contas");
  // A vista unificada de Pagamentos mostra tambem os movimentos de caixa: sem
  // isto, criar/editar/eliminar um movimento deixava esse ecra a mostrar o
  // snapshot anterior ate um refresh manual.
  revalidatePath("/dashboard/financeiro/pagamentos");
  return { ok: true };
}

/**
 * Traduz o código técnico das RPC atómicas para a frase que a pessoa lê.
 *
 * 🔴 A mensagem do PostgreSQL não vai para o ecrã: traz o nome da função, o
 *    `ERRCODE` e por vezes o conteúdo da linha. Um código desconhecido dá a
 *    frase genérica em vez de revelar o interior.
 */
function mensagemDeMovimento(erro: string): string {
  if (erro.includes("CASHFLOW_RECONCILED")) {
    return "Este movimento foi conciliado com o extrato bancário e já não pode "
      + "ser alterado. Reverta a conciliação primeiro.";
  }
  if (erro.includes("CASHFLOW_MANAGED_BY_ORIGIN")) {
    return "Este movimento é gerido na sua origem e não pode ser editado aqui.";
  }
  if (erro.includes("CASHFLOW_FIELD_NOT_EDITABLE")) {
    return "Um dos campos enviados não pode ser alterado neste movimento.";
  }
  if (erro.includes("CASHFLOW_NOT_FOUND")) return "Movimento não encontrado.";
  return "Não foi possível alterar o movimento. Nada foi alterado.";
}

export async function updateCashFlowEntry(
  id: string,
  data: {
    status?: CashFlowStatus;
    description?: string;
    amount?: number;
    notes?: string | null;
    /** Data do movimento. Corrigi-la é metade das correcções reais. */
    date?: string;
    /** Categoria estruturada. `null` remove-a — «Sem categoria» é uma escolha. */
    expenseCategoryId?: string | null;
  },
): Promise<{ ok: boolean; error?: string }> {
  const supabase = await createClient();
  const admin    = createAdminClient();

  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return { ok: false, error: "Não autenticado." };

  const { data: profile } = await admin
    .from("profiles")
    .select("company_id, role")
    .eq("id", user.id)
    .single();
  if (!profile || !["admin", "gestor"].includes(profile.role)) {
    return { ok: false, error: "Sem permissão." };
  }

  if (data.amount !== undefined && !isValidCashFlowAmount(data.amount)) {
    return { ok: false, error: "Valor invalido." };
  }
  if (data.description !== undefined && !data.description.trim()) {
    return { ok: false, error: "Descricao invalida." };
  }
  // 🔴 A mesma validação de data do resto da aplicação. Foi um `starts_on`
  //    corrompido (`"72026-01-01"`, ano com um dígito a mais) que rebentou a
  //    ficha de um cliente real em Julho.
  if (data.date !== undefined && !isValidIsoDateString(data.date)) {
    return { ok: false, error: "Data inválida." };
  }

  // ─── Guarda de período, com o caso da mudança de data ──────────────────────
  //
  // 🔴 Os **dois** períodos têm de estar abertos quando a data muda.
  //
  //    Mover um movimento de Julho para Agosto retira dinheiro de Julho e
  //    põe-no em Agosto. Validar só o destino deixava um caminho aberto para
  //    alterar um mês fechado: bastava editar a data de uma linha de Julho
  //    fechado para Setembro aberto, e os totais de Julho mudavam.
  const { data: atual, error: erroAtual } = await admin
    .from("cash_flow_entries")
    .select("date")
    .eq("id", id)
    .eq("company_id", profile.company_id)
    .maybeSingle();

  if (erroAtual) {
    return { ok: false, error: "Não foi possível confirmar o período do movimento. Nada foi alterado." };
  }
  if (!atual) return { ok: false, error: "Movimento não encontrado." };

  const dataAntiga = String(atual.date);
  const periodo =
    data.date !== undefined && data.date !== dataAntiga
      ? await assertPeriodosAbertosParaMudancaDeData({
          cliente: admin as unknown as ClientePeriodo,
          companyId: profile.company_id,
          dataAntiga,
          dataNova: data.date,
        })
      : await assertFinancialPeriodOpen({
          cliente: admin as unknown as ClientePeriodo,
          companyId: profile.company_id,
          data: dataAntiga,
        });
  if (!periodo.ok) return { ok: false, error: periodo.error };

  // O nome camelCase não existe na base — separa-se, como no create.
  // `null` é enviado de propósito: é assim que se **retira** a categoria.
  const { expenseCategoryId, ...colunas } = data;
  const patch = {
    ...colunas,
    ...(expenseCategoryId !== undefined ? { expense_category_id: expenseCategoryId } : {}),
  };

  // 🔴 A escrita final passa pela RPC atómica.
  //
  //    O `update` directo lia o estado num pedido e escrevia noutro. Entre os
  //    dois cabia uma confirmação de conciliação: A lê «não conciliado», B
  //    confirma, A altera — e a conciliação fica a afirmar uma coisa que já
  //    não é verdade.
  //
  //    `update_cashflow_entry_atomic` tranca a linha do movimento e revalida
  //    com ela na mão: recusa se entretanto ficou conciliado, e recusa se o
  //    movimento tem origem (é gerido por ela, não à mão). As guardas de
  //    período acima continuam onde estavam — dão a mensagem com o nome do mês,
  //    que a base não sabe dar.
  const { error } = await admin.rpc("update_cashflow_entry_atomic", {
    p_company_id: profile.company_id,
    p_entry_id: id,
    p_patch: patch,
  });
  if (error) return { ok: false, error: mensagemDeMovimento(error.message) };
  revalidatePath("/dashboard/financeiro/fluxo-caixa");
  revalidatePath("/dashboard/financeiro/contas");
  // A vista unificada de Pagamentos mostra tambem os movimentos de caixa: sem
  // isto, criar/editar/eliminar um movimento deixava esse ecra a mostrar o
  // snapshot anterior ate um refresh manual.
  revalidatePath("/dashboard/financeiro/pagamentos");
  return { ok: true };
}

export async function deleteCashFlowEntry(id: string): Promise<{ ok: boolean; error?: string }> {
  const supabase = await createClient();
  const admin    = createAdminClient();

  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return { ok: false, error: "Não autenticado." };

  const { data: profile } = await admin
    .from("profiles")
    .select("company_id, role")
    .eq("id", user.id)
    .single();
  if (!profile || !["admin", "gestor"].includes(profile.role)) {
    return { ok: false, error: "Sem permissão." };
  }

  // Apagar um movimento altera os totais do mês a que ele pertence — a data
  // autoritativa é a da própria linha.
  const { data: atual, error: erroAtual } = await admin
    .from("cash_flow_entries")
    .select("date")
    .eq("id", id)
    .eq("company_id", profile.company_id)
    .maybeSingle();

  if (erroAtual) {
    return { ok: false, error: "Não foi possível confirmar o período do movimento. Nada foi apagado." };
  }
  if (!atual) return { ok: true }; // já não existe — nada a apagar

  const periodo = await assertFinancialPeriodOpen({
    cliente: admin as unknown as ClientePeriodo,
    companyId: profile.company_id,
    data: String(atual.date),
  });
  if (!periodo.ok) return { ok: false, error: periodo.error };

  // 🔴 Só se apagam movimentos manuais — e agora pela RPC atómica.
  //
  //    O `.is("reference_type", null)` no `delete` protegia contra apagar um
  //    movimento com origem, mas não contra a corrida: entre a guarda de
  //    período e o `delete` cabia uma confirmação de conciliação, e apagar um
  //    movimento conciliado leva a correspondência à frente pelo
  //    `ON DELETE CASCADE` — apaga a prova e deixa a transacção bancária a
  //    dizer que está reconciliada contra uma linha que já não existe.
  //
  //    `delete_cashflow_entry_atomic` tranca a linha, recusa se tiver origem e
  //    recusa se estiver conciliada. Apagar o que já não existe continua a ser
  //    sucesso, como antes.
  const { error } = await admin.rpc("delete_cashflow_entry_atomic", {
    p_company_id: profile.company_id,
    p_entry_id: id,
  });

  if (error) return { ok: false, error: mensagemDeMovimento(error.message) };
  revalidatePath("/dashboard/financeiro/fluxo-caixa");
  revalidatePath("/dashboard/financeiro/contas");
  // A vista unificada de Pagamentos mostra tambem os movimentos de caixa: sem
  // isto, criar/editar/eliminar um movimento deixava esse ecra a mostrar o
  // snapshot anterior ate um refresh manual.
  revalidatePath("/dashboard/financeiro/pagamentos");
  return { ok: true };
}

/** A forma crua de uma despesa, com ou sem a parte que a 071 acrescenta. */
type LinhaDespesaCrua = {
  id: string;
  description: string;
  amount: number;
  category: string | null;
  date: string;
  notes: string | null;
  expense_category_id?: string | null;
  expense_categories?: { name: string; color_token: string | null }
    | { name: string; color_token: string | null }[]
    | null;
};

/**
 * O erro diz que a 071 falta — ou diz outra coisa?
 *
 * 🔴 Só os códigos de objecto inexistente contam. Um erro de RLS, de rede ou
 *    de timeout tratado como «falta migrar» esconderia um problema real atrás
 *    de uma explicação tranquilizadora, e a lista de despesas apareceria
 *    incompleta sem ninguém saber porquê.
 */
function categoriaAindaNaoExiste(erro: { code?: string; message?: string } | null): boolean {
  if (!erro) return false;
  if (["42P01", "42703", "PGRST200", "PGRST205"].includes(erro.code ?? "")) return true;
  return /expense_categor/i.test(erro.message ?? "")
    && /does not exist|could not find|no relationship/i.test(erro.message ?? "");
}

export interface PendingExpense {
  id: string;
  description: string;
  amount: number;
  /** Categoria legada (`despesa`/`fornecedor`/`avaria`). Continua a existir. */
  category: string;
  /**
   * Categoria estruturada da 071. `null` para tudo o que foi lançado antes —
   * e continua `null`, porque adivinhar a categoria de 444 movimentos antigos
   * a partir da descrição seria inventar contabilidade.
   */
  expense_category_id: string | null;
  expense_category_name: string | null;
  expense_category_color: string | null;
  date: string;
  notes: string | null;
}

/**
 * Contas a receber e a pagar, **do período pedido**.
 *
 * 🔴 Recebia só `_companyId` e devolvia tudo, de todos os meses. O seletor
 *    dizia «Agosto 2026» e a página respondia sobre a história inteira — o
 *    mesmo defeito que `getFinancialDashboard` tinha, no outro separador.
 *
 * Cada bloco filtra pelo que faz sentido para si, e não por uma data só:
 *
 *   faturas   `period_start` — o **período contabilístico**, o mesmo critério
 *             que o dashboard usa. Filtrar por `due_date` faria uma fatura de
 *             Julho que vence a 5 de Agosto aparecer em Agosto aqui e em Julho
 *             no Resumo, e as duas áreas discordariam sobre o mesmo documento;
 *   salários  `period_year`/`period_month` — a folha é de um mês, não de um dia;
 *   despesas  `date` do movimento.
 *
 * Sem período (`undefined`), devolve tudo — o comportamento antigo, para quem
 * ainda o chame assim.
 */
export async function getAccountsData(input?: { year: number; month: number }): Promise<{
  ok: true;
  toReceive: { id: string; invoice_number: string; client_name: string; total: number; due_date: string | null; status: string }[];
  toPay: { id: string; collaborator_name: string; net_salary: number; period: string; status: string }[];
  expenses: PendingExpense[];
} | { ok: false; error: string }> {
  const guard = await requireProfile({ roles: ["admin", "gestor"] });
  if (!guard.ok) return { ok: false, error: guard.error };
  const { admin } = guard;
  const companyId = guard.profile.company_id;

  const periodo = input
    ? {
        inicio: `${input.year}-${String(input.month).padStart(2, "0")}-01`,
        fim: `${input.year}-${String(input.month).padStart(2, "0")}-${String(
          new Date(Date.UTC(input.year, input.month, 0)).getUTCDate(),
        ).padStart(2, "0")}`,
      }
    : null;

  // ───────────────────────────────────────────────────────────────────────────
  // 🔴 A consulta é uma rede larga; quem decide é `estaPorReceber`
  //
  // O filtro fino vive numa função partilhada com o KPI «Em aberto» do
  // dashboard, e não aqui. Havia duas definições de "por receber" e não davam
  // o mesmo número:
  //
  //   · esta consulta olhava só para o estado, e contava como dívida uma
  //     fatura `pendente` com `paid_at` preenchido — dinheiro que já entrou;
  //   · e filtrava por `period_start` em SQL, o que **exclui** as faturas com
  //     `period_start` nulo. Essas não iam para o mês errado: desapareciam de
  //     todos os meses, enquanto no dashboard contavam pelo vencimento.
  //
  // Por isso o SQL só faz uma pré-selecção que nunca deixa de fora uma linha
  // que o predicado incluiria — `period_start` nulo entra — e a decisão é uma
  // só, no mesmo sítio para as duas páginas.
  // ───────────────────────────────────────────────────────────────────────────
  let invoicesQ = admin
    .from("invoices")
    .select("id, invoice_number, client_id, total, due_date, paid_at, period_start, status, clients(name)")
    .eq("company_id", companyId)
    .in("status", ["pendente", "vencido"]);
  if (periodo) {
    invoicesQ = invoicesQ.or(
      `and(period_start.gte.${periodo.inicio},period_start.lte.${periodo.fim}),` +
        `and(period_start.is.null,due_date.gte.${periodo.inicio},due_date.lte.${periodo.fim})`,
    );
  }

  let payrollQ = admin
    .from("payroll_records")
    .select("id, collaborator_id, net_salary, period_year, period_month, status, profiles!collaborator_id(full_name)")
    .eq("company_id", companyId)
    .eq("status", "aprovado");
  if (input) payrollQ = payrollQ.eq("period_year", input.year).eq("period_month", input.month);

  // ───────────────────────────────────────────────────────────────────────────
  // Despesas — com a categoria estruturada quando a base já a tem
  //
  // A 071 não está aplicada. Pedir `expense_categories(...)` numa base que não
  // a tem devolve erro, e este bloco tem de distinguir dois casos que se
  // parecem: «a coluna ainda não existe» e «a consulta falhou».
  //
  // 🔴 O recuo é **só** para o primeiro. O segundo devolve erro — devolver
  //    lista vazia mostraria «A Pagar (Despesas): 0,00 €», que é
  //    indistinguível de um mês sem despesas nenhumas.
  // ───────────────────────────────────────────────────────────────────────────
  const COLUNAS_BASE = "id, description, amount, category, date, notes";
  const COLUNAS_COM_CATEGORIA = `${COLUNAS_BASE}, expense_category_id, expense_categories(name, color_token)`;

  const consultaDespesas = (colunas: string) => {
    let q = admin
      .from("cash_flow_entries")
      .select(colunas)
      .eq("company_id", companyId)
      .eq("type", "saida")
      .eq("status", "pendente")
      .is("reference_type", null);
    if (periodo) q = q.gte("date", periodo.inicio).lte("date", periodo.fim);
    return q.order("date", { ascending: true });
  };

  const expensesQ = consultaDespesas(COLUNAS_COM_CATEGORIA);

  const [invoicesRes, payrollRes, expensesRes] = await Promise.all([
    invoicesQ.order("due_date", { ascending: true }),
    payrollQ.order("period_year", { ascending: false }).order("period_month", { ascending: false }),
    expensesQ,
  ]);

  if (invoicesRes.error) return { ok: false, error: invoicesRes.error.message };
  if (payrollRes.error)  return { ok: false, error: payrollRes.error.message };
  // 🔴 Faltava. Uma falha a carregar despesas devolvia lista vazia e o cartão
  //    "A Pagar (Despesas)" mostrava 0,00 € — indistinguível de um mês sem
  //    despesas nenhumas.
  // A coluna/tabela da 071 ainda não existe: repete-se sem ela. Qualquer outro
  // erro continua a ser erro.
  let despesasCruas = expensesRes.data;
  if (expensesRes.error) {
    if (!categoriaAindaNaoExiste(expensesRes.error)) {
      return { ok: false, error: expensesRes.error.message };
    }
    // 🔴 O recuo deixa de ser silencioso.
    //
    //    Quando isto acontece, as despesas chegam **sem** nome de categoria, o
    //    donut e o filtro deixam de as encontrar, e não há nada no ecrã a
    //    explicar porquê. Já custou uma sessão de diagnóstico: a lista
    //    aparecia vazia e a suspeita caiu sobre o filtro, que estava certo.
    //
    //    A causa mais provável não é a migration em falta — é o cache de
    //    esquema do PostgREST, que não conhece a relação nova até recarregar
    //    (`NOTIFY pgrst, 'reload schema'`).
    console.error(
      "[contas] categoria estruturada indisponível; despesas carregadas sem ela.",
      expensesRes.error.code, expensesRes.error.message,
    );
    const semCategoria = await consultaDespesas(COLUNAS_BASE);
    if (semCategoria.error) return { ok: false, error: semCategoria.error.message };
    despesasCruas = semCategoria.data;
  }

  const ctxFatura = {
    companyId,
    year: input?.year ?? 0,
    month: input?.month ?? 0,
    periodStart: periodo?.inicio ?? "0000-01-01",
    periodEnd: periodo?.fim ?? "9999-12-31",
    todayLisbon: todayInLisbon(),
  };

  const toReceive = (invoicesRes.data ?? [])
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    .filter((r: any) =>
      estaPorReceber(
        {
          id: r.id, status: r.status, total: r.total ?? 0, dueDate: r.due_date,
          paidAt: r.paid_at, periodStart: r.period_start,
          clientId: r.client_id, clientName: r.clients?.name ?? null,
        },
        ctxFatura,
      ),
    )
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    .map((r: any) => ({
      id: r.id,
      invoice_number: r.invoice_number,
      client_name: r.clients?.name ?? "—",
      total: r.total,
      due_date: r.due_date,
      status: r.status,
    }));

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const toPay = (payrollRes.data ?? []).map((r: any) => ({
    id: r.id,
    collaborator_name: r.profiles?.full_name ?? "—",
    net_salary: r.net_salary,
    period: `${r.period_month}/${r.period_year}`,
    status: r.status,
  }));

  const expenses: PendingExpense[] = ((despesasCruas ?? []) as unknown as LinhaDespesaCrua[]).map((r) => {
    // O PostgREST devolve a relação como objecto ou como lista de um, conforme
    // a cardinalidade que infere. Aceitam-se as duas formas — assumir uma
    // delas dava categoria `null` sem erro nenhum a dizer porquê.
    const cat = Array.isArray(r.expense_categories) ? r.expense_categories[0] : r.expense_categories;
    return {
      id: r.id,
      description: r.description,
      amount: r.amount,
      category: r.category ?? "outro",
      expense_category_id: r.expense_category_id ?? null,
      expense_category_name: cat?.name ?? null,
      expense_category_color: cat?.color_token ?? null,
      date: r.date,
      notes: r.notes ?? null,
    };
  });

  return { ok: true, toReceive, toPay, expenses };
}

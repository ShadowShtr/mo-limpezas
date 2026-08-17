"use server";

// ============================================================================
// FECHAMENTO MENSAL — server actions
// ============================================================================
//
// Fechar um mês diz "os números deste período estão estabilizados". A partir
// daí, escritas financeiras nesse mês são recusadas até alguém o reabrir, com
// motivo registado.
//
// A tabela `public.financial_periods` já existe (migration 071, aplicada em
// produção). Não foi criada migration nenhuma para este trabalho — o schema
// tinha tudo o que era preciso, incluindo o `UNIQUE (company_id, year, month)`
// que resolve dois gestores a fechar ao mesmo tempo e o CHECK que exige motivo
// na reabertura.
//
// ---------------------------------------------------------------------------
// O checklist não é a autoridade
// ---------------------------------------------------------------------------
// O modal mostra um checklist antes de fechar. Esse checklist é informativo: o
// `closeFinancialPeriod` **volta a calcular** os bloqueadores no momento da
// escrita e recusa se houver algum.
//
// Não é desconfiança do próprio ecrã — é que entre abrir o modal e clicar em
// "Fechar mês" passam segundos ou minutos, e nesse intervalo a base pode ter
// mudado. Aceitar o checklist enviado pelo cliente seria aceitar uma fotografia
// do passado como autorização para escrever no presente. E um cliente
// modificado poderia simplesmente afirmar "zero bloqueadores".
// ============================================================================

import { revalidatePath } from "next/cache";

import { requireProfile } from "@/lib/auth-guard";
import { auditLog } from "@/lib/audit";
// ⚠️ `ClientePeriodo` é a forma mínima que a guarda declara. O `AdminClient`
//    real satisfaz-na, mas os tipos gerados do PostgREST são profundos e
//    verificá-los contra ela faz o compilador rebentar com TS2589 («Type
//    instantiation is excessively deep»). O cast é sobre o *cliente*, não sobre
//    os dados: cada campo lido continua validado com `typeof` dentro de
//    `interpretarLinhaPeriodo`.
import { lerEstadoPeriodo, type ClientePeriodo } from "@/lib/finance-period-guard";
import {
  ACAO_PERIODO_FECHADO,
  ACAO_PERIODO_REABERTO,
  agregarChecklist,
  interpretarLinhaPeriodo,
  itemContagem,
  itemFalhaDeLeitura,
  nomePeriodo,
  validarMotivoReabertura,
  validarPeriodo,
  type EstadoPeriodoLido,
  type ItemChecklist,
} from "@/domain/finance-v2/financial-period";

// ⚠️ As constantes de acção de auditoria vivem em
//    `@/domain/finance-v2/financial-period`, não aqui: um ficheiro
//    `"use server"` só pode exportar funções async. Exportá-las daqui dava
//    «A "use server" file can only export async functions, found string» no
//    build — o mesmo erro que em Junho bloqueou as notificações do calendário.

/**
 * Fechar ou reabrir muda badges e controlos em todo o módulo financeiro — um
 * facto só, visível em sete ecrãs. Revalidar apenas a página atual deixaria os
 * outros a mostrar um estado que já não é verdade.
 */
function revalidarFinanceiro() {
  for (const rota of [
    "/dashboard/financeiro",
    "/dashboard/financeiro/pagamentos",
    "/dashboard/financeiro/contas",
    "/dashboard/financeiro/fluxo-caixa",
    "/dashboard/financeiro/conciliacao",
    "/dashboard/cobrancas",
    "/dashboard/folha-pagamento",
  ]) {
    revalidatePath(rota);
  }
}

// ─── Leitura ─────────────────────────────────────────────────────────────────

export type EstadoPeriodoResposta = EstadoPeriodoLido & {
  year: number;
  month: number;
  /** Nome legível de quem fechou. Nunca o perfil inteiro. */
  closedByName: string | null;
};

/**
 * Estado de um período. **READ ONLY** — não cria linha para representar
 * "aberto" (ausência já é aberto, ver a 073) e não escreve nada.
 *
 * Chamada no render do Financeiro. Se escrevesse, todo o `render = zero write`
 * do Financeiro V2 caía por aqui.
 */
export async function getFinancialPeriodStatus(entrada: { year: number; month: number }): Promise<
  { ok: true; periodo: EstadoPeriodoResposta } | { ok: false; error: string }
> {
  const guard = await requireProfile();
  if (!guard.ok) return { ok: false, error: guard.error };
  const { admin, profile } = guard;

  const v = validarPeriodo(entrada);
  if (!v.ok) return { ok: false, error: v.error };

  const r = await lerEstadoPeriodo(admin as unknown as ClientePeriodo, profile.company_id, v.periodo);
  if (!r.ok) return { ok: false, error: r.error };

  // Nome de quem fechou, e só o nome. `closed_by` é um uuid de profile; expor
  // o perfil inteiro à UI seria dar morada e telefone a um ecrã que só quer
  // escrever "fechado por Mónica".
  let closedByName: string | null = null;
  if (r.estado.closedBy) {
    const { data } = await admin
      .from("profiles")
      .select("full_name")
      .eq("id", r.estado.closedBy)
      .eq("company_id", profile.company_id)
      .maybeSingle();
    closedByName = (data?.full_name as string | undefined) ?? null;
  }

  return {
    ok: true,
    periodo: { ...r.estado, year: v.periodo.year, month: v.periodo.month, closedByName },
  };
}

// ─── Checklist ───────────────────────────────────────────────────────────────

export type ChecklistResposta = {
  itens: ItemChecklist[];
  bloqueadores: ItemChecklist[];
  avisos: ItemChecklist[];
  podeFechar: boolean;
};

/**
 * Conta o que vale a pena ver antes de fechar. **READ ONLY** — abrir o modal
 * não altera nada, cancelar não altera nada.
 *
 * Cada fonte é contada com `head: true` (só o total, sem trazer linhas). Uma
 * falha de leitura vira **bloqueador**: fechar um mês sem saber o que lá está
 * é o único caso em que a resposta certa é indiscutivelmente "não".
 */
export async function getFinancialCloseChecklist(entrada: { year: number; month: number }): Promise<
  { ok: true; checklist: ChecklistResposta } | { ok: false; error: string }
> {
  const guard = await requireProfile({ roles: ["admin", "gestor"] });
  if (!guard.ok) return { ok: false, error: guard.error };
  const { admin, profile } = guard;

  const v = validarPeriodo(entrada);
  if (!v.ok) return { ok: false, error: v.error };
  const { year, month } = v.periodo;

  // Limites do mês como datas civis — sem `Date`, sem UTC. `31` funciona para
  // qualquer mês porque a comparação é lexicográfica sobre `YYYY-MM-DD` e a
  // base guarda datas, não timestamps: `2026-02-31` nunca existe como valor,
  // e `<= '2026-02-31'` inclui `2026-02-28` como se quer.
  const mm = String(month).padStart(2, "0");
  const inicio = `${year}-${mm}-01`;
  const fim = `${year}-${mm}-31`;

  const itens: ItemChecklist[] = [];

  async function contar(
    chave: string,
    rotulo: string,
    detalhe: string,
    construir: () => PromiseLike<{ count: number | null; error: { message: string } | null }>,
  ) {
    try {
      const { count, error } = await construir();
      if (error) {
        itens.push(itemFalhaDeLeitura(chave, rotulo, error.message));
        return;
      }
      itens.push(itemContagem(chave, rotulo, count ?? 0, detalhe));
    } catch (e) {
      itens.push(itemFalhaDeLeitura(chave, rotulo, e instanceof Error ? e.message : "Erro de leitura."));
    }
  }

  await contar(
    "faturas_rascunho",
    "Faturas em rascunho",
    "Ficam como rascunho depois de fechar — não são emitidas automaticamente.",
    () =>
      admin
        .from("invoices")
        .select("id", { count: "exact", head: true })
        .eq("company_id", profile.company_id)
        .eq("status", "rascunho")
        .gte("period_start", inicio)
        .lte("period_start", fim),
  );

  await contar(
    "despesas_sem_categoria",
    "Despesas sem categoria",
    "Continuam a contar nos totais, mas ficam fora da análise por categoria.",
    () =>
      admin
        .from("cash_flow_entries")
        .select("id", { count: "exact", head: true })
        .eq("company_id", profile.company_id)
        .eq("type", "saida")
        .is("expense_category_id", null)
        .gte("date", inicio)
        .lte("date", fim),
  );

  await contar(
    "movimentos_por_conciliar",
    "Movimentos bancários por conciliar",
    "Ficam por conciliar. A conciliação não altera os totais do mês.",
    () =>
      admin
        .from("bank_transactions")
        .select("id", { count: "exact", head: true })
        .eq("company_id", profile.company_id)
        // ⚠️ Esta tabela foge à convenção das outras: a coluna é
        //    `transaction_date`, não `date`, e o estado é `"pending"` em
        //    inglês, não `"pendente"`. Ver `bank_transactions` em
        //    src/types/database.ts.
        .eq("status", "pending")
        .gte("transaction_date", inicio)
        .lte("transaction_date", fim),
  );

  await contar(
    "pagamentos_pendentes",
    "Pagamentos pendentes",
    "Não poderão ser marcados como pagos enquanto o mês estiver fechado.",
    () =>
      admin
        .from("fixed_variable_payments")
        .select("id", { count: "exact", head: true })
        .eq("company_id", profile.company_id)
        .eq("status", "pendente")
        .eq("period_year", year)
        .eq("period_month", month),
  );

  return { ok: true, checklist: agregarChecklist(itens) };
}

// ─── Fechar ──────────────────────────────────────────────────────────────────

export async function closeFinancialPeriod(entrada: { year: number; month: number }): Promise<
  { ok: true; status: "closed"; jaEstavaFechado: boolean } | { ok: false; error: string; code?: string }
> {
  const guard = await requireProfile({ roles: ["admin", "gestor"] });
  if (!guard.ok) return { ok: false, error: guard.error };
  const { admin, profile } = guard;

  const v = validarPeriodo(entrada);
  if (!v.ok) return { ok: false, error: v.error };
  const periodo = v.periodo;

  // Estado actual primeiro: fechar um mês já fechado é um no-op, não um erro,
  // e não deve mexer no `closed_at` original (perder-se-ia a data real do
  // fecho por causa de um duplo-clique).
  const atual = await lerEstadoPeriodo(admin as unknown as ClientePeriodo, profile.company_id, periodo);
  if (!atual.ok) {
    return {
      ok: false,
      code: "FINANCIAL_PERIOD_STATE_UNKNOWN",
      error: "Não foi possível confirmar o estado do período. Nada foi alterado.",
    };
  }
  if (atual.estado.status === "closed") {
    return { ok: true, status: "closed", jaEstavaFechado: true };
  }

  // 🔴 Bloqueadores recalculados aqui, no servidor, no momento da escrita.
  //    O checklist do modal não é aceite como prova.
  const checklist = await getFinancialCloseChecklist(periodo);
  if (!checklist.ok) return { ok: false, error: checklist.error };
  if (!checklist.checklist.podeFechar) {
    const nomes = checklist.checklist.bloqueadores.map((b) => b.rotulo).join("; ");
    return {
      ok: false,
      code: "FINANCIAL_PERIOD_BLOCKED",
      error: `Não foi possível fechar ${nomePeriodo(periodo)}: ${nomes}.`,
    };
  }

  // `closed_at` é `now()` da base e `closed_by` é o perfil da sessão — nenhum
  // dos dois vem do browser. Um `closed_by` aceite do cliente permitia
  // atribuir o fecho a outra pessoa.
  const linha = {
    company_id: profile.company_id,
    year: periodo.year,
    month: periodo.month,
    status: "closed" as const,
    closed_at: new Date().toISOString(),
    closed_by: profile.id,
    // Fechar de novo limpa a marca de reabertura anterior: o que fica registado
    // é o estado corrente, e o histórico completo vive em `audit_logs`.
    reopened_at: null,
    reopened_by: null,
    reopen_reason: null,
    updated_at: new Date().toISOString(),
  };

  // `UNIQUE (company_id, year, month)` (071) serializa dois fechos
  // simultâneos: o segundo colide e o `onConflict` resolve para o mesmo
  // estado final em vez de rebentar com um erro de constraint que a gestora
  // não saberia interpretar.
  const { data, error } = await admin
    .from("financial_periods")
    .upsert(linha, { onConflict: "company_id,year,month" })
    .select("status, closed_at, closed_by, reopened_at, reopen_reason")
    .maybeSingle();

  if (error) return { ok: false, error: error.message };

  const final = interpretarLinhaPeriodo(data);
  if (final.status !== "closed") {
    return { ok: false, error: "O período não ficou fechado. Nada foi dado como concluído." };
  }

  await auditLog({
    companyId: profile.company_id,
    actorId: profile.id,
    action: ACAO_PERIODO_FECHADO,
    entityType: "financial_period",
    entityId: `${periodo.year}-${String(periodo.month).padStart(2, "0")}`,
    // Só identidade do período e do actor. Nenhum valor financeiro: quem fechou
    // e quando é o que importa auditar, e os números vivem nas suas tabelas.
    meta: { year: periodo.year, month: periodo.month },
  }, admin);

  revalidarFinanceiro();
  return { ok: true, status: "closed", jaEstavaFechado: false };
}

// ─── Reabrir ─────────────────────────────────────────────────────────────────

export async function reopenFinancialPeriod(entrada: {
  year: number;
  month: number;
  reason: string;
}): Promise<
  { ok: true; status: "open"; jaEstavaAberto: boolean } | { ok: false; error: string; code?: string }
> {
  const guard = await requireProfile({ roles: ["admin", "gestor"] });
  if (!guard.ok) return { ok: false, error: guard.error };
  const { admin, profile } = guard;

  const v = validarPeriodo(entrada);
  if (!v.ok) return { ok: false, error: v.error };
  const periodo = v.periodo;

  // Motivo validado antes de tocar na base — mensagem clara em vez de uma
  // violação do CHECK `financial_periods_reopen_needs_reason` traduzida a
  // posteriori. A garantia continua a ser da base.
  const m = validarMotivoReabertura(entrada.reason);
  if (!m.ok) return { ok: false, error: m.error };

  const atual = await lerEstadoPeriodo(admin as unknown as ClientePeriodo, profile.company_id, periodo);
  if (!atual.ok) {
    return {
      ok: false,
      code: "FINANCIAL_PERIOD_STATE_UNKNOWN",
      error: "Não foi possível confirmar o estado do período. Nada foi alterado.",
    };
  }

  // Já aberto — não há nada para reabrir. Não criar linha só para registar uma
  // reabertura que não aconteceu: ficaria um `reopened_at` sem `closed_at`
  // correspondente, um estado que não quer dizer nada.
  if (atual.estado.status === "open") {
    return { ok: true, status: "open", jaEstavaAberto: true };
  }

  const { data, error } = await admin
    .from("financial_periods")
    .update({
      status: "open",
      reopened_at: new Date().toISOString(),
      reopened_by: profile.id,
      reopen_reason: m.motivo,
      updated_at: new Date().toISOString(),
    })
    .eq("company_id", profile.company_id)
    .eq("year", periodo.year)
    .eq("month", periodo.month)
    .select("status, closed_at, closed_by, reopened_at, reopen_reason")
    .maybeSingle();

  if (error) return { ok: false, error: error.message };

  const final = interpretarLinhaPeriodo(data);
  if (final.status !== "open") {
    return { ok: false, error: "O período não ficou reaberto. Nada foi dado como concluído." };
  }

  await auditLog({
    companyId: profile.company_id,
    actorId: profile.id,
    action: ACAO_PERIODO_REABERTO,
    entityType: "financial_period",
    entityId: `${periodo.year}-${String(periodo.month).padStart(2, "0")}`,
    // O motivo é o ponto da auditoria: seis meses depois, é o que explica
    // porque é que os números daquele mês mudaram.
    meta: { year: periodo.year, month: periodo.month, reason: m.motivo },
  }, admin);

  revalidarFinanceiro();
  return { ok: true, status: "open", jaEstavaAberto: false };
}

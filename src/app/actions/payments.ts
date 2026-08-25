"use server";

import { requireProfile } from "@/lib/auth-guard";
import { createAdminClient } from "@/lib/supabase/admin";
import { revalidatePath } from "next/cache";
import { todayInLisbon } from "@/lib/lisbon-time";
import {
  assertFinancialPeriodOpen,
  lerEstadoPeriodo,
  type ClientePeriodo,
} from "@/lib/finance-period-guard";
import { mensagemPeriodoFechado } from "@/domain/finance-v2/financial-period";
import {
  desmarcarPagamentoPago,
  marcarPagamentoPago,
} from "@/lib/finance-rpc/payment-cashflow";
import {
  PAYMENT_ATTACHMENTS_BUCKET,
  MAX_PAYMENT_ATTACHMENT_BYTES,
  buildPaymentAttachmentPath,
  isPaymentAttachmentPathInCompany,
} from "@/lib/payment-attachments";

type AdminClient = ReturnType<typeof createAdminClient>;

// ─── Tipos ────────────────────────────────────────────────────────────────────

export type PaymentKind = "fixo" | "variavel";
export type PaymentStatus = "pago" | "pendente";

export interface Payment {
  id: string;
  kind: PaymentKind;
  description: string;
  amount: number | null;
  due_date: string | null;
  direct_debit: boolean | null;
  status: PaymentStatus;
  recurring: boolean;
  period_year: number;
  period_month: number;
  paid_at: string | null;
  notes: string | null;
  sort_order: number;
  attachment_url: string | null;
  attachment_name: string | null;
  attachment_size: number | null;
  attachment_mime: string | null;
}

export interface PaymentsData {
  year: number;
  month: number;
  fixos: Payment[];
  variaveis: Payment[];
  totalPendente: number;
  totalPago: number;
  countPendente: number;
  countOverdue: number;
}

const COLS = "id, kind, description, amount, due_date, direct_debit, status, recurring, period_year, period_month, paid_at, notes, sort_order, attachment_url, attachment_name, attachment_size, attachment_mime";

// A materialização de mês (clonar os fixos do mês anterior) vivia aqui, e era
// chamada pelas duas funções de leitura abaixo. Está desligada e em quarentena
// em `src/lib/payments-month-materialization.ts`, com a explicação completa.

// ─── Leitura ──────────────────────────────────────────────────────────────────

export async function getPayments(year: number, month: number): Promise<{ ok: true; data: PaymentsData } | { ok: false; error: string }> {
  const guard = await requireProfile({ roles: ["admin", "gestor"] });
  if (!guard.ok) return { ok: false, error: guard.error };
  const { admin } = guard;
  const companyId = guard.profile.company_id;

  // ───────────────────────────────────────────────────────────────────────────
  // 🔴 Aqui estava `await ensureMonth(admin, companyId, year, month)`.
  //
  // Uma função chamada `getPayments` **materializava o mês**: clonava os fixos
  // recorrentes do mês anterior mais recente e inseria-os. Abrir a página, ou
  // mudar de mês, criava dados.
  //
  // A 2026-08-03, às 11:56:02, foi assim que os 15 fixos de Agosto nasceram —
  // todos no mesmo segundo, todos com `source_id`. E com eles veio a perda:
  // `shiftDate` guarda o dia e força o mês de destino, sem saber que um
  // pagamento pode ser trimestral. Quatro vencimentos que eram 03/08, 03/11,
  // 03/02 e 03/05 passaram a ser todos **03/08**. A informação de que aqueles
  // pagamentos se venciam em Novembro, Fevereiro e Maio deixou de existir na
  // linha de Agosto.
  //
  // Ler deixou de escrever. A função está preservada em quarentena, em
  // `src/lib/payments-month-materialization.ts`, e não volta enquanto o modelo
  // não souber distinguir mensal de trimestral. Ver
  // `docs/incidents/2026-08-11-pagamentos-materializacao-implicita.md`.
  //
  // Um mês sem fixos passa a mostrar-se como **não preparado** — que é a
  // verdade. Zero linhas não é zero euros.
  // ───────────────────────────────────────────────────────────────────────────

  const { data, error } = await admin
    .from("fixed_variable_payments")
    .select(COLS)
    .eq("company_id", companyId)
    .eq("period_year", year)
    .eq("period_month", month)
    .order("kind", { ascending: true })
    .order("sort_order", { ascending: true })
    .order("description", { ascending: true });
  if (error) return { ok: false, error: error.message };

  const all = (data ?? []) as Payment[];
  const fixos = all.filter((p) => p.kind === "fixo");
  const variaveis = all.filter((p) => p.kind === "variavel");
  const today = todayInLisbon();
  const totalPendente = all.filter((p) => p.status === "pendente").reduce((s, p) => s + (p.amount ?? 0), 0);
  const totalPago = all.filter((p) => p.status === "pago").reduce((s, p) => s + (p.amount ?? 0), 0);
  const countPendente = all.filter((p) => p.status === "pendente").length;
  const countOverdue = all.filter((p) => p.status === "pendente" && p.due_date && p.due_date < today).length;

  return {
    ok: true,
    data: {
      year, month, fixos, variaveis,
      totalPendente: Math.round(totalPendente * 100) / 100,
      totalPago: Math.round(totalPago * 100) / 100,
      countPendente, countOverdue,
    },
  };
}

// Lembrete para o dashboard: pendentes do mês atual.
export interface PaymentsReminder {
  count: number;
  overdueCount: number;
  total: number;
  items: { id: string; description: string; amount: number | null; due_date: string | null; overdue: boolean }[];
}

export async function getPaymentsReminder(): Promise<{ ok: true; data: PaymentsReminder } | { ok: false; error: string }> {
  const guard = await requireProfile({ roles: ["admin", "gestor"] });
  if (!guard.ok) return { ok: false, error: guard.error };
  const { admin } = guard;
  const companyId = guard.profile.company_id;

  const [year, month] = todayInLisbon().split("-").map(Number);

  // 🔴 Aqui estava `await ensureMonth(...)` — e este era o caminho mais largo
  // de todos: o banner é renderizado no Dashboard, a página de entrada depois
  // do login. Bastava um admin ou gestor abrir a aplicação para o mês corrente
  // ser materializado. Um lembrete não pode criar aquilo que lembra.
  //
  // Se o mês ainda não tiver pagamentos, o lembrete não mostra nada — que é a
  // resposta honesta: não há nada registado a pagar.

  const { data, error } = await admin
    .from("fixed_variable_payments")
    .select("id, description, amount, due_date")
    .eq("company_id", companyId)
    .eq("period_year", year)
    .eq("period_month", month)
    .eq("status", "pendente")
    .order("due_date", { ascending: true });
  if (error) return { ok: false, error: error.message };

  const today = todayInLisbon();
  const rows = data ?? [];
  const items = rows.map((r) => ({
    id: r.id, description: r.description, amount: r.amount, due_date: r.due_date,
    overdue: !!r.due_date && r.due_date < today,
  }));
  const total = rows.reduce((s, r) => s + (r.amount ?? 0), 0);
  return {
    ok: true,
    data: {
      count: items.length,
      overdueCount: items.filter((i) => i.overdue).length,
      total: Math.round(total * 100) / 100,
      items: items.slice(0, 6),
    },
  };
}

// ─── Escrita ──────────────────────────────────────────────────────────────────

function revalidate() {
  revalidatePath("/dashboard/financeiro/pagamentos");
  revalidatePath("/dashboard/financeiro");
  revalidatePath("/dashboard");
}

/**
 * Marcar um pagamento como pago mexe em duas tabelas — e em quatro ecrãs.
 *
 * Sem as Contas e o Fluxo de Caixa aqui, a saída de caixa nova só apareceria
 * ao fim de uma navegação completa, e quem acabou de marcar o pagamento
 * concluiria que não tinha funcionado.
 */
function revalidateCaixa() {
  revalidate();
  revalidatePath("/dashboard/financeiro/contas");
  revalidatePath("/dashboard/financeiro/fluxo-caixa");
}

export interface PaymentInput {
  kind: PaymentKind;
  description: string;
  amount: number | null;
  due_date: string | null;
  direct_debit: boolean | null;
  notes: string | null;
  year: number;
  month: number;
}

export async function createPayment(input: PaymentInput): Promise<{ ok: boolean; error?: string }> {
  const guard = await requireProfile({ roles: ["admin", "gestor"] });
  if (!guard.ok) return { ok: false, error: guard.error };
  const { admin, profile } = guard;
  if (!input.description.trim()) return { ok: false, error: "Descrição obrigatória." };
  if (input.amount !== null && (!Number.isFinite(input.amount) || input.amount < 0)) return { ok: false, error: "Valor inválido." };

  const { data: maxRow } = await admin
    .from("fixed_variable_payments")
    .select("sort_order")
    .eq("company_id", profile.company_id)
    .eq("period_year", input.year)
    .eq("period_month", input.month)
    .eq("kind", input.kind)
    .order("sort_order", { ascending: false })
    .limit(1);
  const sort_order = (maxRow?.[0]?.sort_order ?? 0) + 1;

  const { error } = await admin.from("fixed_variable_payments").insert({
    company_id: profile.company_id,
    kind: input.kind,
    description: input.description.trim(),
    amount: input.amount,
    due_date: input.due_date,
    direct_debit: input.direct_debit,
    status: "pendente",
    recurring: input.kind === "fixo",
    period_year: input.year,
    period_month: input.month,
    notes: input.notes,
    sort_order,
    created_by: profile.id,
  });
  if (error) return { ok: false, error: error.message };
  revalidate();
  return { ok: true };
}

export async function updatePayment(
  id: string,
  patch: { description?: string; amount?: number | null; due_date?: string | null; direct_debit?: boolean | null; notes?: string | null },
): Promise<{ ok: boolean; error?: string }> {
  const guard = await requireProfile({ roles: ["admin", "gestor"] });
  if (!guard.ok) return { ok: false, error: guard.error };
  const { admin, profile } = guard;
  if (patch.description !== undefined && !patch.description.trim()) return { ok: false, error: "Descrição inválida." };
  if (patch.amount !== undefined && patch.amount !== null && (!Number.isFinite(patch.amount) || patch.amount < 0)) return { ok: false, error: "Valor inválido." };

  const { error } = await admin
    .from("fixed_variable_payments")
    .update({ ...patch, updated_at: new Date().toISOString() })
    .eq("id", id)
    .eq("company_id", profile.company_id);
  if (error) return { ok: false, error: error.message };
  revalidate();
  return { ok: true };
}

// ============================================================================
// Marcar como pago — e o dinheiro sair do caixa, na mesma transacção
// ============================================================================
//
// 🔴 O que estava errado, e esteve errado durante todo o tempo em que este
//    sistema esteve em uso real:
//
//    Isto alterava `fixed_variable_payments` e **mais nada**. O dinheiro saía
//    da conta da empresa e o Fluxo de Caixa não sabia — os Custos do mês
//    ficavam por baixo do real e a Margem por cima. E é a Margem que se usa
//    para decidir.
//
// A escrita passou para a base (`mark_payment_paid`, migration 073): ou entram
// o estado do pagamento e o movimento de caixa, ou não entra nada. Fazê-lo em
// dois pedidos daqui resolveria metade — o primeiro passa, o segundo falha, e
// fica um pagamento pago sem movimento nenhum, que é exactamente a divergência
// que se queria evitar.
//
// Nada nesta função escreve em `cash_flow_entries`. Se a RPC não existir, isto
// falha fechado a dizer que falta a migration, em vez de seguir pelo caminho
// antigo — um fallback silencioso faria a aplicação parecer actualizada e
// continuar a produzir o mesmo erro, sem ninguém notar.
// ============================================================================

/**
 * Período de um pagamento, a partir do próprio registo.
 *
 * Um pagamento não tem data civil única — tem `period_year`/`period_month`, que
 * é o mês a que pertence. É esse que decide, e não o mês que está no ecrã.
 *
 * Devolve `null` quando pode prosseguir. Falha fechada.
 */
async function bloquearSePagamentoEmPeriodoFechado(
  admin: AdminClient,
  companyId: string,
  paymentId: string,
): Promise<{ ok: false; error: string } | null> {
  const { data, error } = await admin
    .from("fixed_variable_payments")
    .select("period_year, period_month")
    .eq("id", paymentId)
    .eq("company_id", companyId)
    .maybeSingle();

  if (error) {
    return { ok: false, error: "Não foi possível confirmar o período do pagamento. Nada foi alterado." };
  }
  if (!data) return { ok: false, error: "Pagamento não encontrado." };

  const periodo = { year: Number(data.period_year), month: Number(data.period_month) };
  const estado = await lerEstadoPeriodo(admin as unknown as ClientePeriodo, companyId, periodo);
  if (!estado.ok) {
    return {
      ok: false,
      error: "Não foi possível confirmar se o período financeiro está aberto. Nada foi alterado.",
    };
  }
  if (estado.estado.status === "closed") {
    return { ok: false, error: mensagemPeriodoFechado(periodo) };
  }
  return null;
}

export async function setPaymentStatus(id: string, status: PaymentStatus): Promise<{ ok: boolean; error?: string }> {
  const guard = await requireProfile({ roles: ["admin", "gestor"] });
  if (!guard.ok) return { ok: false, error: guard.error };
  const { admin, profile } = guard;

  // ─── Guarda de período ──────────────────────────────────────────────────────
  //
  // A 073 já recusa um mês fechado do lado da base (levanta
  // `FINANCIAL_PERIOD_CLOSED`, e `interpretarErro` traduz isso). Esta guarda
  // corre **antes** para dar a mensagem com o nome do mês em vez de a deduzir
  // de um erro de plpgsql — a garantia continua a ser da base, e nada aqui
  // substitui a RPC.
  //
  // 🔴 A data autoritativa difere entre marcar e desmarcar:
  //
  //    · marcar como pago → a data do movimento que vai nascer, `todayInLisbon()`;
  //    · voltar a pendente → o período do pagamento em si (`period_year`/
  //      `period_month`), porque o movimento a remover é o que lá está, não um
  //      que se crie hoje. Usar hoje aqui deixava reverter um pagamento de
  //      Julho fechado só porque Agosto está aberto.
  if (status === "pago") {
    const hoje = todayInLisbon();
    const p = await assertFinancialPeriodOpen({
      cliente: admin as unknown as ClientePeriodo,
      companyId: profile.company_id,
      data: hoje,
    });
    if (!p.ok) return { ok: false, error: p.error };

    const r = await marcarPagamentoPago(admin, {
      companyId: profile.company_id,
      paymentId: id,
      // A data do movimento é hoje **em Lisboa**. O processo corre em UTC na
      // Vercel, e `new Date()` na primeira hora do dia dava o dia anterior.
      paidOn: hoje,
    });
    if (!r.ok) return { ok: false, error: r.error };
    revalidateCaixa();
    return { ok: true };
  }

  if (status === "pendente") {
    const bloqueio = await bloquearSePagamentoEmPeriodoFechado(admin, profile.company_id, id);
    if (bloqueio) return bloqueio;

    const r = await desmarcarPagamentoPago(admin, {
      companyId: profile.company_id,
      paymentId: id,
    });
    if (!r.ok) return { ok: false, error: r.error };
    revalidateCaixa();
    return { ok: true };
  }

  // Outros estados (`cancelado`, …) não geram nem removem caixa: mudam só o
  // estado do pagamento. Um cancelamento depois de pago teria de decidir o que
  // fazer ao movimento, e essa decisão não se toma por omissão.
  const { error } = await admin
    .from("fixed_variable_payments")
    .update({ status, updated_at: new Date().toISOString() })
    .eq("id", id)
    .eq("company_id", profile.company_id);
  if (error) return { ok: false, error: error.message };
  revalidate();
  return { ok: true };
}

export async function deletePayment(id: string): Promise<{ ok: boolean; error?: string }> {
  const guard = await requireProfile({ roles: ["admin", "gestor"] });
  if (!guard.ok) return { ok: false, error: guard.error };
  const { admin, profile } = guard;
  const { error } = await admin
    .from("fixed_variable_payments")
    .delete()
    .eq("id", id)
    .eq("company_id", profile.company_id);
  if (error) return { ok: false, error: error.message };
  revalidate();
  return { ok: true };
}

// ─── Anexo (fatura/recibo) ────────────────────────────────────────────────────

async function ensureAttachmentsBucket(admin: AdminClient) {
  const { error } = await admin.storage.getBucket(PAYMENT_ATTACHMENTS_BUCKET);
  if (error) {
    await admin.storage.createBucket(PAYMENT_ATTACHMENTS_BUCKET, {
      public: false,
      fileSizeLimit: MAX_PAYMENT_ATTACHMENT_BYTES,
    });
  }
}

export async function uploadPaymentAttachment(
  paymentId: string,
  formData: FormData,
): Promise<{ ok: true; url: string; name: string } | { ok: false; error: string }> {
  const guard = await requireProfile({ roles: ["admin", "gestor"] });
  if (!guard.ok) return { ok: false, error: guard.error };
  const { admin, profile } = guard;

  const { data: payment } = await admin
    .from("fixed_variable_payments")
    .select("id, attachment_url")
    .eq("id", paymentId)
    .eq("company_id", profile.company_id)
    .single();
  if (!payment) return { ok: false, error: "Pagamento não encontrado." };

  const file = formData.get("file") as File | null;
  if (!file) return { ok: false, error: "Ficheiro em falta." };
  if (file.size > MAX_PAYMENT_ATTACHMENT_BYTES) {
    return { ok: false, error: "Ficheiro demasiado grande (máx 20 MB)." };
  }

  await ensureAttachmentsBucket(admin);

  const path = buildPaymentAttachmentPath({ companyId: profile.company_id, paymentId, fileName: file.name });
  const { error: uploadError } = await admin.storage
    .from(PAYMENT_ATTACHMENTS_BUCKET)
    .upload(path, file, { contentType: file.type, upsert: false });
  if (uploadError) return { ok: false, error: uploadError.message };

  // 🔴 NÃO remover aqui o anexo anterior.
  //
  // Até 2026-08-18 este bloco apagava do storage o ficheiro que já estivesse
  // anexado, antes de gravar o novo — sem recuperação. Desde a 074 um registo
  // aceita N anexos (`src/app/actions/attachments.ts`), e adicionar nunca
  // remove: a remoção só acontece por acção explícita do utilizador, ou como
  // compensação do upload que acabou de falhar.
  //
  // Esta action mantém-se para o caminho legado da coluna `attachment_url`; o
  // ficheiro anterior, se existir, fica no bucket e continua acessível.


  const { error: dbError } = await admin
    .from("fixed_variable_payments")
    .update({
      // 🔴 Aqui estava `urlData.publicUrl`. O bucket é privado, e esse URL
      //    devolve HTTP 400 — nunca funcionou, e ficou gravado em 17 linhas.
      //    Passa a guardar-se o caminho do objeto, que é a identidade estável.
      //    `getAttachmentUrl` interpreta as duas formas, por isso as linhas
      //    antigas continuam a abrir sem serem tocadas.
      attachment_url: path,
      attachment_name: file.name,
      attachment_size: file.size,
      attachment_mime: file.type,
      updated_at: new Date().toISOString(),
    })
    .eq("id", paymentId)
    .eq("company_id", profile.company_id);
  if (dbError) return { ok: false, error: dbError.message };

  revalidate();
  // Devolve o caminho, não um URL. Quem quiser abrir pede um URL assinado a
  // `getAttachmentUrl` — um URL guardado é a origem do defeito que esta ronda
  // corrige.
  return { ok: true, url: path, name: file.name };
}

export async function deletePaymentAttachment(paymentId: string): Promise<{ ok: boolean; error?: string }> {
  const guard = await requireProfile({ roles: ["admin", "gestor"] });
  if (!guard.ok) return { ok: false, error: guard.error };
  const { admin, profile } = guard;

  const { data: payment } = await admin
    .from("fixed_variable_payments")
    .select("attachment_url")
    .eq("id", paymentId)
    .eq("company_id", profile.company_id)
    .single();
  if (!payment) return { ok: false, error: "Pagamento não encontrado." };

  if (payment.attachment_url) {
    const bucketPrefix = `/${PAYMENT_ATTACHMENTS_BUCKET}/`;
    const path = payment.attachment_url.includes(bucketPrefix)
      ? decodeURIComponent(payment.attachment_url.split(bucketPrefix)[1])
      : null;
    if (path && isPaymentAttachmentPathInCompany(path, profile.company_id)) {
      await admin.storage.from(PAYMENT_ATTACHMENTS_BUCKET).remove([path]);
    }
  }

  const { error } = await admin
    .from("fixed_variable_payments")
    .update({ attachment_url: null, attachment_name: null, attachment_size: null, attachment_mime: null, updated_at: new Date().toISOString() })
    .eq("id", paymentId)
    .eq("company_id", profile.company_id);
  if (error) return { ok: false, error: error.message };

  revalidate();
  return { ok: true };
}

export async function getSignedPaymentAttachmentUrl(
  fileUrl: string,
): Promise<{ ok: true; url: string } | { ok: false; error: string }> {
  if (!fileUrl) return { ok: false, error: "URL do ficheiro em falta." };
  const guard = await requireProfile({ roles: ["admin", "gestor"] });
  if (!guard.ok) return { ok: false, error: guard.error };
  const { admin, profile } = guard;

  const bucketPrefix = `/${PAYMENT_ATTACHMENTS_BUCKET}/`;
  const storagePath = fileUrl.includes(bucketPrefix) ? fileUrl.split(bucketPrefix)[1] : null;
  if (!storagePath) return { ok: true, url: fileUrl };

  const decodedPath = decodeURIComponent(storagePath);
  if (!isPaymentAttachmentPathInCompany(decodedPath, profile.company_id)) {
    return { ok: false, error: "Sem permissão para aceder a este ficheiro." };
  }

  const { data, error } = await admin.storage
    .from(PAYMENT_ATTACHMENTS_BUCKET)
    .createSignedUrl(decodedPath, 60 * 5);
  if (error || !data) return { ok: false, error: error?.message ?? "Erro ao gerar link." };

  return { ok: true, url: data.signedUrl };
}

"use server";

import { createAdminClient } from "@/lib/supabase/admin";
import { createClient } from "@/lib/supabase/server";
import { requireProfile } from "@/lib/auth-guard";
import { criarFaturaComLinhas } from "@/lib/finance-rpc/invoice-creation";
import { getMissingCashFlowReferenceIds, isValidCashFlowAmount } from "@/lib/cash-flow-integrity";
import { findDuplicateMonthlyContractsByLocation } from "@/lib/invoice-duplicates";
import { revalidatePath } from "next/cache";
import { todayInLisbon, addDaysToDateString, toLisbonTimestamp } from "@/lib/lisbon-time";
import {
  assertFinancialPeriodOpen,
  lerEstadoPeriodo,
  type ClientePeriodo,
} from "@/lib/finance-period-guard";
import { mensagemPeriodoFechado } from "@/domain/finance-v2/financial-period";

// ─── Tipos ────────────────────────────────────────────────────────────────────

export interface InvoiceItem {
  id: string;
  service_id: string | null;
  description: string;
  quantity: number;
  unit_price: number;
  total: number;
  sort_order: number;
}

export interface Invoice {
  id: string;
  client_id: string;
  client_name: string;
  client_phone: string | null;
  invoice_number: string;
  invoice_date: string;
  due_date: string | null;
  period_start: string | null;
  period_end: string | null;
  subtotal: number;
  vat_rate: number;
  vat_amount: number;
  total: number;
  status: "rascunho" | "pendente" | "pago" | "vencido" | "cancelado";
  paid_at: string | null;
  payment_method: string | null;
  notes: string | null;
  items: InvoiceItem[];
}

function monthRange(year: number, month: number) {
  const start = `${year}-${String(month).padStart(2, "0")}-01`;
  const end   = new Date(Date.UTC(year, month, 0)).toISOString().split("T")[0];
  return { start, end };
}

// ─── Numeração de faturas ─────────────────────────────────────────────────────
//
// 🔴 `nextInvoiceNumber` foi removida. A numeração passou para dentro da 072
//    (`create_invoice_with_items`), sob `pg_advisory_xact_lock` por empresa e
//    ano, com `UNIQUE(company_id, invoice_number)` por baixo como rede.
//
//    A versão que aqui estava lia o maior número e somava um. Estava certa
//    quanto ao maior — contar em vez de olhar para o máximo reutilizava
//    números de faturas apagadas — mas duas execuções simultâneas lêem o mesmo
//    máximo e escolhem o mesmo número. Nenhuma verificação feita em JavaScript
//    ganha essa corrida; a garantia tem de ser da base.
//
//    Os testes desta regra vivem agora sobre o SQL da 072, que é onde a regra
//    está.

// ─── Gerar documentos de cobrança ─────────────────────────────────────────────

export async function generateInvoices(
  _companyId: string,
  year: number,
  month: number,
): Promise<{ ok: true; invoices: Invoice[] } | { ok: false; error: string }> {
  const guard = await requireProfile({ roles: ["admin", "gestor"] });
  if (!guard.ok) return { ok: false, error: guard.error };
  const { admin } = guard;
  const companyId = guard.profile.company_id;
  const { start, end } = monthRange(year, month);

  // Gerar cobranças cria documentos financeiros do mês pedido — aqui o período
  // vem directamente do argumento, sem ambiguidade.
  //
  // ⚠️ Isto **não** liga a RPC da 072 (`create_invoice_with_items`). A criação
  //    atómica continua por activar até haver prova de serialização concorrente
  //    — ver `src/lib/finance-rpc/invoice-creation.ts`.
  const estadoPeriodo = await lerEstadoPeriodo(
    admin as unknown as ClientePeriodo,
    companyId,
    { year, month },
  );
  if (!estadoPeriodo.ok) {
    return { ok: false, error: "Não foi possível confirmar se o período está aberto. Nada foi gerado." };
  }
  if (estadoPeriodo.estado.status === "closed") {
    return { ok: false, error: mensagemPeriodoFechado({ year, month }) };
  }

  // Configurações
  //
  // 🔴 O erro conta. Uma falha aqui caía no `?? 23` e faturava tudo com a taxa
  //    por omissão — que pode não ser a da empresa. Um IVA errado numa fatura
  //    emitida é um problema fiscal, não um detalhe de apresentação.
  //
  //    `PGRST116` (nenhuma linha) continua a ser aceite: uma empresa sem
  //    configurações usa as omissões de propósito. O que não se aceita é uma
  //    consulta que rebentou.
  const { data: settings, error: settingsErr } = await admin
    .from("company_settings")
    .select("vat_rate, invoice_prefix")
    .eq("company_id", companyId)
    .single();
  if (settingsErr && settingsErr.code !== "PGRST116") {
    return { ok: false, error: settingsErr.message };
  }

  const vatRate     = settings?.vat_rate    ?? 23;
  const prefix      = settings?.invoice_prefix ?? "F";
  const vatFactor   = vatRate / 100;

  // Serviços concluídos no período
  const { data: services, error: sErr } = await admin
    .from("services")
    .select("id, location_id, calculated_value, manual_value, scheduled_start, actual_start, actual_end, apply_vat")
    .eq("company_id", companyId)
    .eq("status", "concluido")
    .gte("scheduled_start", toLisbonTimestamp(start, "00:00"))
    .lt("scheduled_start", toLisbonTimestamp(addDaysToDateString(end, 1), "00:00"));

  if (sErr) return { ok: false, error: sErr.message };

  // 🔴 A guarda de saída antecipada mudou de sítio.
  //
  // Estava aqui um `if (!services?.length) return { ok: true, invoices: [] }`,
  // **antes** de as avenças mensais serem sequer carregadas. Uma avença é uma
  // linha mensal fixa que existe independentemente de haver serviços
  // concluídos — é isso que a torna uma avença.
  //
  // O efeito era silencioso e caro: num mês sem nenhum serviço fechado,
  // gerar cobranças devolvia «0 faturas» e ninguém era faturado, apesar de
  // haver contratos ativos a render. E é exactamente a situação da base hoje:
  // 1508 serviços, todos por concluir.
  //
  // A saída antecipada continua a existir — mas só quando não há **nada** para
  // faturar, nem serviços nem avenças. Ver a guarda depois de
  // `activeMonthlyContracts`.
  const serviceLocationIds = [...new Set((services ?? []).map((s) => s.location_id).filter(Boolean))];

  // Locais com preço fixo que têm contratos activos no período
  // ───────────────────────────────────────────────────────────────────────────
  // 🔴 A partir daqui, **nenhum erro de consulta é ignorado**.
  //
  // Estas queries usavam `const { data } = await …` e deitavam o erro fora.
  // Numa função que gera faturação, isso tem uma consequência muito concreta:
  // se a consulta das avenças falhar, `activeMonthlyContracts` fica vazio e a
  // função devolve **sucesso com zero faturas**. Ninguém é faturado nesse mês,
  // e o ecrã diz que correu bem.
  //
  // É o mesmo padrão de «falha vira zero» que o motor de leitura passou meses
  // a eliminar — aqui custava dinheiro por cobrar em vez de um número errado.
  // ───────────────────────────────────────────────────────────────────────────
  const { data: fixedLocations, error: fixedLocErr } = await admin
    .from("locations")
    .select("id, name, client_id, hourly_rate, fixed_price, pricing_type")
    .eq("company_id", companyId)
    .eq("pricing_type", "fixed")
    .eq("active", true);
  if (fixedLocErr) return { ok: false, error: fixedLocErr.message };

  // Verificar quais têm contrato activo no período
  const fixedLocationIds = (fixedLocations ?? []).map((l) => l.id);
  let activeFixedLocationIds: string[] = [];
  if (fixedLocationIds.length > 0) {
    const { data: activeContracts, error: activeContractsErr } = await admin
      .from("contracts")
      .select("location_id")
      .eq("company_id", companyId)
      .eq("status", "ativo")
      .lte("starts_on", end)
      .or(`ends_on.is.null,ends_on.gte.${start}`)
      .in("location_id", fixedLocationIds);
    if (activeContractsErr) return { ok: false, error: activeContractsErr.message };
    activeFixedLocationIds = [...new Set((activeContracts ?? []).map((c) => c.location_id))];
  }

  // Contratos com faturação por VALOR FIXO MENSAL (avença) ativos no período.
  // Cada um gera uma linha mensal única, independente do nº de serviços.
  const { data: monthlyContracts, error: monthlyErr } = await admin
    .from("contracts")
    .select("id, location_id, fixed_price, apply_vat")
    .eq("company_id", companyId)
    .eq("status", "ativo")
    .eq("fixed_monthly", true)
    .lte("starts_on", end)
    .or(`ends_on.is.null,ends_on.gte.${start}`);

  // Se esta falhar, todas as avenças desaparecem e a função diria «zero
  // faturas» com ar de sucesso. É o caso que mais custa dinheiro.
  if (monthlyErr) return { ok: false, error: monthlyErr.message };

  const activeMonthlyContracts = (monthlyContracts ?? []).filter(
    (c) => c.fixed_price != null && c.fixed_price > 0,
  );
  const monthlyContractLocationIds = activeMonthlyContracts.map((c) => c.location_id);

  // Agora sim: nada para faturar é nada em ambas as fontes.
  if (!services?.length && activeMonthlyContracts.length === 0) {
    return { ok: true, invoices: [] };
  }

  const allLocationIds = [
    ...new Set([...serviceLocationIds, ...activeFixedLocationIds, ...monthlyContractLocationIds]),
  ];
  const { data: locations, error: locErr } = await admin
    .from("locations")
    .select("id, name, client_id, hourly_rate, fixed_price, pricing_type")
    .in("id", allLocationIds);
  if (locErr) return { ok: false, error: locErr.message };

  const locationMap = Object.fromEntries(
    (locations ?? []).map((l) => [l.id, l]),
  );

  const clientIds = [...new Set((locations ?? []).map((l) => l.client_id).filter(Boolean))];

  const { data: clients, error: cliErr } = await admin
    .from("clients")
    .select("id, name, nif, email, vat_exempt")
    .in("id", clientIds);
  if (cliErr) return { ok: false, error: cliErr.message };

  const clientMap = Object.fromEntries(
    (clients ?? []).map((c) => [c.id, c]),
  );

  // Detetar contratos de avença mensal duplicados: mais de um contrato ativo
  // fixed_monthly para o mesmo local no período gera duas linhas idênticas na
  // mesma fatura (valor duplicado). Em vez de escolher um e ignorar o outro
  // silenciosamente, bloqueia toda a geração — os dados têm de ser corrigidos
  // primeiro (ver diagnóstico em scripts/diagnose-duplicate-monthly-contracts.sql).
  const duplicateGroups = findDuplicateMonthlyContractsByLocation(activeMonthlyContracts);

  if (duplicateGroups.length > 0) {
    const details = duplicateGroups.map(({ location_id }) => {
      const loc = locationMap[location_id];
      const client = loc?.client_id ? clientMap[loc.client_id] : null;
      return `o local "${loc?.name ?? location_id}" do cliente "${client?.name ?? "desconhecido"}"`;
    });
    const list = details.length === 1
      ? details[0]
      : details.slice(0, -1).join(", ") + " e " + details[details.length - 1];
    return {
      ok: false,
      error: `Existem contratos de avença mensal duplicados para ${list}. Corrija os contratos antes de gerar cobranças.`,
    };
  }

  // Verificar faturas já existentes para este período (não duplicar)
  //
  // 🔴 Se esta falhar e o erro for ignorado, `existingClientIds` fica vazio e
  //    a função gera **faturas duplicadas** para clientes que já as tinham.
  const { data: existing, error: existingErr } = await admin
    .from("invoices")
    .select("id, client_id")
    .eq("company_id", companyId)
    .eq("period_start", start)
    .eq("period_end", end);

  if (existingErr) return { ok: false, error: existingErr.message };

  const existingClientIds = new Set((existing ?? []).map((e) => e.client_id));

  // Locais cobertos por um contrato de avença mensal — o contrato tem prioridade
  // e trata a faturação; os serviços destes locais (valor 0) não entram por-serviço.
  const monthlyLocationSet = new Set(monthlyContractLocationIds);

  // Agrupar serviços por cliente (excluindo locais com preço fixo — tratados à parte)
  //
  // `services` pode agora ser vazio: desde que a guarda de saída antecipada
  // passou a exigir também zero avenças, um mês só com avenças chega aqui sem
  // nenhum serviço concluído. O `?? []` é explícito de propósito — não quero
  // que isto dependa de estreitamento de tipos em código que gera faturas.
  const servicosDoPeriodo = services ?? [];
  const byClient = new Map<string, typeof servicosDoPeriodo>();
  for (const s of servicosDoPeriodo) {
    const loc = locationMap[s.location_id];
    if (!loc?.client_id) continue;
    if (loc.pricing_type === "fixed") continue; // preço fixo: linha separada
    if (monthlyLocationSet.has(s.location_id)) continue; // avença mensal: linha única
    if (existingClientIds.has(loc.client_id)) continue; // já tem fatura
    if (!byClient.has(loc.client_id)) byClient.set(loc.client_id, []);
    byClient.get(loc.client_id)!.push(s);
  }

  // Locais com preço fixo activos → adicionar ao mapa de clientes
  // (salta os que já são cobertos por um contrato de avença mensal).
  for (const locId of activeFixedLocationIds) {
    const loc = locationMap[locId];
    if (!loc?.client_id || !loc.fixed_price) continue;
    if (monthlyLocationSet.has(locId)) continue;
    if (existingClientIds.has(loc.client_id)) continue;
    // Registo sintético para o preço fixo
    if (!byClient.has(loc.client_id)) byClient.set(loc.client_id, []);
    // Adiciona um serviço sintético (id = locId para ser identificável)
    byClient.get(loc.client_id)!.push({
      id: `fixed:${locId}`,
      location_id: locId,
      calculated_value: loc.fixed_price,
      manual_value: null,
      scheduled_start: `${start}T00:00:00`,
      actual_start: null,
      actual_end: null,
      apply_vat: true,
    });
  }

  // Contratos de avença mensal → uma linha fixa por contrato, com o IVA do contrato.
  for (const c of activeMonthlyContracts) {
    const loc = locationMap[c.location_id];
    if (!loc?.client_id) continue;
    if (existingClientIds.has(loc.client_id)) continue;
    if (!byClient.has(loc.client_id)) byClient.set(loc.client_id, []);
    byClient.get(loc.client_id)!.push({
      id: `monthly:${c.id}`,
      location_id: c.location_id,
      calculated_value: c.fixed_price,
      manual_value: null,
      scheduled_start: `${start}T00:00:00`,
      actual_start: null,
      actual_end: null,
      apply_vat: c.apply_vat === true,
    });
  }

  if (!byClient.size) return getInvoices(companyId, year, month);

  // Criar fatura por cliente
  const invoiceDate = todayInLisbon();
  const dueDate     = addDaysToDateString(invoiceDate, 30);

  for (const [clientId, svcs] of byClient) {
    // 🔴 O número deixou de ser escolhido aqui.
    //
    // Era lido o máximo e somado um. Duas gerações simultâneas lêem o mesmo
    // máximo e escolhem o mesmo número — nenhuma verificação em JavaScript
    // ganha essa corrida. Passou para dentro da 072, sob lock consultivo por
    // empresa e ano, com um índice único por baixo como rede.
    const clientData = clientMap[clientId];
    const isVatExempt = (clientData as { vat_exempt?: boolean })?.vat_exempt === true;

    // Base tributável: só os serviços com apply_vat (e cliente não isento)
    // contribuem para o IVA. Permite serviços com e sem IVA na mesma fatura.
    let taxedBase = 0;
    const items = svcs
      .sort((a, b) => a.scheduled_start.localeCompare(b.scheduled_start))
      .map((s, idx) => {
        const loc   = locationMap[s.location_id];
        // Linhas sintéticas de avença: preço fixo do local ("fixed:") ou
        // contrato de valor fixo mensal ("monthly:"). Ambas faturam 1 linha/mês.
        const isFixed = (s.id as string).startsWith("fixed:") || (s.id as string).startsWith("monthly:");
        const value = s.manual_value ?? s.calculated_value ?? 0;
        const serviceHasVat = (s as { apply_vat?: boolean }).apply_vat !== false;
        if (!isVatExempt && serviceHasVat) taxedBase += value;

        let description: string;
        if (isFixed) {
          const mLabel = new Date(s.scheduled_start).toLocaleDateString("pt-PT", { month: "long", year: "numeric" });
          description = `${loc?.name ?? "Serviço"} — Avença mensal ${mLabel}`;
        } else {
          const date  = new Date(s.scheduled_start).toLocaleDateString("pt-PT");
          let durationMin = 0;
          if (s.actual_start && s.actual_end) {
            durationMin = Math.round(
              (new Date(s.actual_end).getTime() - new Date(s.actual_start).getTime()) / 60000,
            );
          }
          const durLabel = durationMin > 0
            ? ` (${Math.floor(durationMin / 60)}h${durationMin % 60 > 0 ? String(durationMin % 60).padStart(2, "0") : ""})`
            : "";
          description = `${date} — ${loc?.name ?? "Serviço"}${durLabel}`;
        }

        return {
          service_id:  isFixed ? null : s.id,
          description,
          quantity:    1,
          unit_price:  value,
          total:       value,
          sort_order:  idx,
        };
      });

    const subtotal  = Math.round(items.reduce((s, i) => s + i.total, 0) * 100) / 100;
    const vatAmount = Math.round(taxedBase * vatFactor * 100) / 100;
    const total     = Math.round((subtotal + vatAmount) * 100) / 100;

    // ─────────────────────────────────────────────────────────────────────────
    // Cabeçalho e linhas, numa só transacção (072)
    //
    // Antes eram dois pedidos com compensação: se as linhas falhassem, apagava-
    // -se o cabeçalho. Funcionava enquanto a compensação corresse — e se o
    // processo morresse entre os dois, ficava um documento sem linhas, com
    // subtotal e total certos e o ar de uma fatura normal na lista.
    //
    // A transacção é da base. Ou entram os dois, ou não entra nada.
    // ─────────────────────────────────────────────────────────────────────────
    const criada = await criarFaturaComLinhas(admin, {
      companyId, clientId, prefix, year,
      invoiceDate, dueDate,
      periodStart: start, periodEnd: end,
      subtotal,
      vatRate: vatAmount > 0 ? vatRate : 0,
      vatAmount,
      total,
      items,
    });

    // 🔴 Não se salta em silêncio. Estava aqui um `continue`: uma fatura que
    //    falhasse desaparecia sem rasto e a função devolvia sucesso com menos
    //    faturas do que devia, sem ninguém saber quais faltavam.
    if (!criada.ok) {
      const nome = clientMap[clientId]?.name ?? "cliente";
      return { ok: false, error: `${nome}: ${criada.error}` };
    }
  }

  revalidatePath("/dashboard/cobrancas");
  return getInvoices(companyId, year, month);
}

// ─── Ler faturas ──────────────────────────────────────────────────────────────

export async function getInvoices(
  _companyId: string,
  year: number,
  month: number,
): Promise<{ ok: true; invoices: Invoice[] } | { ok: false; error: string }> {
  const guard = await requireProfile({ roles: ["admin", "gestor"] });
  if (!guard.ok) return { ok: false, error: guard.error };
  const { admin } = guard;
  const companyId = guard.profile.company_id;
  const { start, end } = monthRange(year, month);

  const { data, error } = await admin
    .from("invoices")
    .select(`
      id, client_id, invoice_number, invoice_date, due_date,
      period_start, period_end, subtotal, vat_rate, vat_amount, total,
      status, paid_at, payment_method, notes,
      clients ( name, phone ),
      invoice_items ( id, service_id, description, quantity, unit_price, total, sort_order )
    `)
    .eq("company_id", companyId)
    .eq("period_start", start)
    .eq("period_end", end)
    .order("invoice_number");

  if (error) return { ok: false, error: error.message };

  const invoices: Invoice[] = (data ?? []).map((row) => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const c = (row as any).clients as { name: string; phone: string | null } | null;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const rawItems = (row as any).invoice_items as InvoiceItem[] ?? [];
    return {
      id:             row.id,
      client_id:      row.client_id,
      client_name:    c?.name ?? "—",
      client_phone:   c?.phone ?? null,
      invoice_number: row.invoice_number,
      invoice_date:   row.invoice_date,
      due_date:       row.due_date ?? null,
      period_start:   row.period_start ?? null,
      period_end:     row.period_end ?? null,
      subtotal:       row.subtotal,
      vat_rate:       row.vat_rate,
      vat_amount:     row.vat_amount,
      total:          row.total,
      status:         row.status as Invoice["status"],
      paid_at:        row.paid_at ?? null,
      payment_method: row.payment_method ?? null,
      notes:          row.notes ?? null,
      items:          [...rawItems].sort((a, b) => a.sort_order - b.sort_order),
    };
  });

  return { ok: true, invoices };
}

// ─── Atualizar estado ─────────────────────────────────────────────────────────

export async function updateInvoiceStatus(
  id: string,
  status: Invoice["status"],
  paymentMethod?: string,
): Promise<{ ok: boolean; error?: string }> {
  const supabase = await createClient();
  const admin    = createAdminClient();

  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return { ok: false, error: "Nao autenticado." };

  const { data: profile } = await admin
    .from("profiles")
    .select("company_id, role")
    .eq("auth_user_id", user.id)
    .single();
  if (!profile || !["admin", "gestor"].includes(profile.role)) {
    return { ok: false, error: "Sem permissao." };
  }

  const { data: inv } = await admin
    .from("invoices")
    .select("company_id, total, invoice_number, client_id, status, paid_at, invoice_date")
    .eq("id", id)
    .eq("company_id", profile.company_id)
    .single();

  if (!inv) return { ok: false, error: "Fatura nao encontrada." };

  // 🔴 A data autoritativa é `invoice_date` — a data de emissão do documento,
  //    que é o que o determina o mês a que a fatura pertence. Não `period_start`
  //    (o período de serviço facturado pode atravessar meses) e não hoje.
  const periodo = await assertFinancialPeriodOpen({
    cliente: admin as unknown as ClientePeriodo,
    companyId: profile.company_id,
    data: String(inv.invoice_date),
  });
  if (!periodo.ok) return { ok: false, error: periodo.error };

  const update: { status: string; paid_at?: string | null; payment_method?: string | null } = { status };
  if (status === "pago") {
    update.paid_at = inv.paid_at ?? new Date().toISOString();
    update.payment_method = paymentMethod ?? null;
  } else {
    update.paid_at = null;
    update.payment_method = null;
  }

  const { error } = await admin
    .from("invoices")
    .update(update)
    .eq("id", id)
    .eq("company_id", profile.company_id);

  if (error) return { ok: false, error: error.message };

  if (status === "pago" && isValidCashFlowAmount(inv.total)) {
    const { data: existingRefs } = await admin
      .from("cash_flow_entries")
      .select("reference_id")
      .eq("company_id", profile.company_id)
      .eq("reference_type", "invoice")
      .eq("reference_id", id);

    const missingIds = getMissingCashFlowReferenceIds([id], (existingRefs ?? []).map((r) => r.reference_id));
    if (missingIds.length > 0) {
      const { data: clientData } = await admin.from("clients").select("name").eq("id", inv.client_id).single();
      const { error: cashErr } = await admin.from("cash_flow_entries").insert({
        company_id: inv.company_id,
        type: "entrada",
        amount: inv.total,
        description: `Fatura ${inv.invoice_number} - ${(clientData as { name?: string })?.name ?? "Cliente"}`,
        category: "faturacao",
        date: todayInLisbon(),
        reference_id: id,
        reference_type: "invoice",
        status: "confirmado",
      });
      if (cashErr) return { ok: false, error: cashErr.message };
    }
  }

  if (status !== "pago") {
    await admin
      .from("cash_flow_entries")
      .delete()
      .eq("company_id", profile.company_id)
      .eq("reference_type", "invoice")
      .eq("reference_id", id);
  }

  revalidatePath("/dashboard/cobrancas");
  revalidatePath("/dashboard/financeiro");
  return { ok: true };
}

// ─── Eliminar rascunho ────────────────────────────────────────────────────────

export async function deleteInvoice(
  id: string,
): Promise<{ ok: boolean; error?: string }> {
  const supabase = await createClient();
  const admin    = createAdminClient();

  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return { ok: false, error: "Não autenticado." };

  const { data: profile } = await admin
    .from("profiles")
    .select("company_id, role")
    .eq("auth_user_id", user.id)
    .single();
  if (!profile || !["admin", "gestor"].includes(profile.role)) {
    return { ok: false, error: "Sem permissão." };
  }

  // Apagar um rascunho altera o que o mês tem por facturar.
  const { data: inv, error: erroInv } = await admin
    .from("invoices")
    .select("invoice_date")
    .eq("id", id)
    .eq("company_id", profile.company_id)
    .maybeSingle();

  if (erroInv) {
    return { ok: false, error: "Não foi possível confirmar o período da fatura. Nada foi apagado." };
  }
  if (!inv) return { ok: true }; // já não existe

  const periodo = await assertFinancialPeriodOpen({
    cliente: admin as unknown as ClientePeriodo,
    companyId: profile.company_id,
    data: String(inv.invoice_date),
  });
  if (!periodo.ok) return { ok: false, error: periodo.error };

  const { error } = await admin
    .from("invoices")
    .delete()
    .eq("id", id)
    .eq("company_id", profile.company_id)
    .eq("status", "rascunho"); // só eliminar rascunhos

  if (error) return { ok: false, error: error.message };
  revalidatePath("/dashboard/cobrancas");
  return { ok: true };
}

// ─── Serviços concluídos sem fatura ──────────────────────────────────────────

export interface UnbilledService {
  id: string;
  reference_number: string;
  client_name: string;
  location_name: string;
  scheduled_start: string;
  actual_end: string | null;
  value: number;
}

export async function getUnbilledServices(
  _companyId?: string,
): Promise<{ ok: true; services: UnbilledService[] } | { ok: false; error: string }> {
  const guard = await requireProfile({ roles: ["admin", "gestor"] });
  if (!guard.ok) return { ok: false, error: guard.error };
  const { admin } = guard;
  const companyId = guard.profile.company_id;

  // Serviços concluídos dos últimos 60 dias
  const since = new Date();
  since.setDate(since.getDate() - 60);
  const sinceStr = since.toISOString().split("T")[0];

  const { data: services, error: sErr } = await admin
    .from("services")
    .select("id, reference_number, scheduled_start, actual_end, calculated_value, manual_value, locations(name, client_id, clients(name))")
    .eq("company_id", companyId)
    .eq("status", "concluido")
    .gte("scheduled_start", `${sinceStr}T00:00:00`)
    .order("scheduled_start", { ascending: false });

  if (sErr) return { ok: false, error: sErr.message };
  if (!services?.length) return { ok: true, services: [] };

  // IDs de serviços que já têm invoice_item
  const serviceIds = services.map((s) => s.id);
  const { data: billed } = await admin
    .from("invoice_items")
    .select("service_id")
    .in("service_id", serviceIds);

  const billedIds = new Set((billed ?? []).map((b) => b.service_id));

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const unbilled: UnbilledService[] = (services as any[])
    .filter((s) => !billedIds.has(s.id))
    .map((s) => ({
      id:               s.id,
      reference_number: s.reference_number ?? `#${s.id.slice(0, 6)}`,
      client_name:      s.locations?.clients?.name ?? "—",
      location_name:    s.locations?.name ?? "—",
      scheduled_start:  s.scheduled_start,
      actual_end:       s.actual_end ?? null,
      value:            s.manual_value ?? s.calculated_value ?? 0,
    }));

  return { ok: true, services: unbilled };
}

"use server";

// ============================================================================
// CRM — da lead ao cliente
// ============================================================================
//
// 🔴 O CRM continua a não escrever em `contracts` nem em `services`. Esta
//    action cria o cliente e o local, fecha a lead, e devolve o URL do
//    formulário de contrato JÁ PRÉ-PREENCHIDO. Quem grava o contrato é o
//    gestor, depois de o rever — nada entra no calendário sem uma pessoa
//    decidir. Foi decisão explícita do dono.
//
// 🔴 `createClienteComLocal` é reutilizada tal como está. Reimplementá-la aqui
//    daria duas formas de criar um cliente, que divergiriam com o tempo.
// ============================================================================

import {
  ACTION_ERROR_CODES,
  actionFailure,
  actionSuccess,
  internalFailure,
  type ActionResult,
} from "@/lib/action-result";
import { AUTH_GUARD_CODES, requireProfile } from "@/lib/auth-guard";
import { auditLog } from "@/lib/audit";
import { invalidateBusinessState } from "@/lib/revalidate-business";
import { logQueryFailure } from "@/lib/query-error";
import {
  leadParaClienteComLocal,
  porqueNaoConverte,
  type LeadParaConverter,
} from "@/lib/crm/lead-to-cliente";
import { createClienteComLocal } from "@/app/actions/clientes";

export interface ResultadoConversao {
  clientId: string;
  locationId: string;
  /** Para onde levar o gestor a seguir, com o formulário pré-preenchido. */
  redirectTo: string;
}

function recusa(code: string): ActionResult<never> {
  if (code === AUTH_GUARD_CODES.UNAUTHENTICATED) {
    return actionFailure(ACTION_ERROR_CODES.UNAUTHENTICATED, "Não autenticado.");
  }
  if (code === AUTH_GUARD_CODES.PROFILE_NOT_FOUND) {
    return actionFailure(ACTION_ERROR_CODES.NOT_FOUND, "Perfil não encontrado.");
  }
  return actionFailure(ACTION_ERROR_CODES.FORBIDDEN, "Sem permissão para converter leads.");
}

/**
 * Converte a lead em cliente + local e devolve para onde ir a seguir.
 *
 * `quoteId` é opcional: há negócios fechados por telefone, sem orçamento
 * nenhum. Quando existe, os seus valores pré-preenchem o contrato e o
 * orçamento passa a apontar para o cliente.
 *
 * ── Sobre a atomicidade, com honestidade ───────────────────────────────────
 *
 * Isto são dois passos: criar o cliente (action existente, com o seu próprio
 * rollback manual) e fechar a lead (RPC da 104). Não são uma transação só.
 *
 * Se o segundo falhar, fica um cliente real criado — visível, sem dinheiro
 * pendurado e sem nada agendado — e a lead por converter. A guarda
 * `converted_client_id IS NULL` na RPC torna a repetição segura, e a mensagem
 * diz o que aconteceu em vez de esconder.
 *
 * É uma degradação aceitável. A alternativa — reimplementar a criação do
 * cliente em SQL para ter uma transação só — daria duas formas de criar um
 * cliente, e essa é a espécie de duplicação que este projeto já pagou caro.
 */
export async function converterLeadEmCliente(
  leadId: string,
  opts?: { quoteId?: string | null },
): Promise<ActionResult<ResultadoConversao>> {
  const guard = await requireProfile({ roles: ["admin", "gestor"] });
  if (!guard.ok) return recusa(guard.code);

  const { admin, profile } = guard;

  // ── 1. A lead ─────────────────────────────────────────────────────────────
  const { data: lead, error: erroLead } = await admin
    .from("crm_leads")
    .select(
      "id, name, lead_type, contact_name, email, phone, nif, address, lat, lng, service_type, stage, converted_client_id",
    )
    .eq("company_id", profile.company_id)
    .eq("id", leadId)
    .maybeSingle();

  if (erroLead) {
    logQueryFailure("converterLeadEmCliente.lead", erroLead);
    return internalFailure("converterLeadEmCliente", erroLead, ACTION_ERROR_CODES.PERSISTENCE);
  }
  if (!lead) return actionFailure(ACTION_ERROR_CODES.NOT_FOUND, "Lead não encontrada.");

  // A guarda também está na RPC; aqui devolve-se uma frase útil em vez de
  // deixar chegar ao passo que cria o cliente.
  if (lead.converted_client_id) {
    return actionFailure(
      ACTION_ERROR_CODES.CONFLICT,
      "Esta lead já foi convertida em cliente.",
    );
  }

  // ── 2. O orçamento aceite, se houver ──────────────────────────────────────
  interface OrcamentoAceite {
    id: string;
    pricing_kind: string;
    total: number;
    subtotal: number;
    vat_amount: number;
    apply_vat: boolean;
    proposed_frequency: string | null;
    status: string;
    visit_id: string | null;
  }

  let itens: { unit: string; unit_price: number }[] | undefined;
  let moradaDaVisita: string | null = null;
  let orcamento: OrcamentoAceite | null = null;

  if (opts?.quoteId) {
    const { data: q } = await admin
      .from("crm_quotes")
      .select("id, pricing_kind, total, subtotal, vat_amount, apply_vat, proposed_frequency, status, visit_id")
      .eq("company_id", profile.company_id)
      .eq("id", opts.quoteId)
      .maybeSingle();

    if (!q) return actionFailure(ACTION_ERROR_CODES.NOT_FOUND, "Orçamento não encontrado.");

    // 🔴 Só um orçamento aceite converte. Converter a partir de um rascunho
    //    criaria um cliente com base num preço que ninguém aprovou.
    if (q.status !== "aceite") {
      return actionFailure(
        ACTION_ERROR_CODES.BUSINESS_RULE,
        "Só um orçamento aceite pode dar origem a um cliente. Marque-o como aceite primeiro.",
      );
    }

    orcamento = q as unknown as OrcamentoAceite;

    const { data: linhas } = await admin
      .from("crm_quote_items")
      .select("unit, unit_price")
      .eq("company_id", profile.company_id)
      .eq("quote_id", q.id);

    itens = (linhas ?? []) as { unit: string; unit_price: number }[];

    // A morada apurada na visita ganha à da lead: a lead costuma ter a sede,
    // a visita tem o sítio onde se vai limpar.
    if (q.visit_id) {
      const { data: visita } = await admin
        .from("crm_visits")
        .select("address")
        .eq("company_id", profile.company_id)
        .eq("id", q.visit_id)
        .maybeSingle();
      moradaDaVisita = visita?.address ?? null;
    }
  }

  // ── 3. O que impede avançar ───────────────────────────────────────────────
  const dadosLead = lead as unknown as LeadParaConverter;
  const impedimento = porqueNaoConverte(dadosLead, { items: itens, visitAddress: moradaDaVisita });
  if (impedimento) {
    return actionFailure(ACTION_ERROR_CODES.BUSINESS_RULE, impedimento);
  }

  // ── 4. Criar cliente + local, pela action que já existe ───────────────────
  const entrada = leadParaClienteComLocal(dadosLead, {
    items: itens,
    visitAddress: moradaDaVisita,
  });

  const criado = await createClienteComLocal(profile.company_id, entrada);

  if (!criado.ok || !criado.clientId || !criado.locationId) {
    // A action antiga devolve `{ ok, error }`; traduz-se para o formato novo
    // sem deixar passar a mensagem crua da base.
    logQueryFailure("converterLeadEmCliente.createCliente", { message: criado.error ?? "" });
    return actionFailure(
      ACTION_ERROR_CODES.PERSISTENCE,
      "Não foi possível criar o cliente a partir desta lead.",
    );
  }

  // ── 5. Fechar a lead, numa transação ──────────────────────────────────────
  try {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const { error } = await (admin as any).rpc("link_crm_lead_conversion", {
      p_company_id: profile.company_id,
      p_lead_id: leadId,
      p_client_id: criado.clientId,
      p_location_id: criado.locationId,
      p_quote_id: orcamento?.id ?? null,
      p_actor: profile.id,
    });

    if (error) {
      const msg = error.message ?? "";
      if (msg.includes("LEAD_ALREADY_CONVERTED")) {
        // O cliente foi criado por esta chamada, mas outra ganhou a corrida.
        // Dizer isto é melhor do que fingir que correu bem: há um cliente a
        // mais, e quem está no ecrã tem de saber.
        return actionFailure(
          ACTION_ERROR_CODES.CONFLICT,
          "Esta lead foi convertida entretanto. Verifique a lista de Clientes — pode ter ficado um registo repetido.",
        );
      }
      return internalFailure("converterLeadEmCliente.rpc", new Error(msg), ACTION_ERROR_CODES.PERSISTENCE);
    }
  } catch (err) {
    return internalFailure("converterLeadEmCliente.rpc", err, ACTION_ERROR_CODES.PERSISTENCE);
  }

  await auditLog({
    companyId: profile.company_id,
    actorId: profile.id,
    action: "crm_lead_converted",
    entityType: "crm_lead",
    entityId: leadId,
    after: { client_id: criado.clientId, location_id: criado.locationId, quote_id: orcamento?.id ?? null },
  }, admin);

  // A conversão muda o funil, os clientes e os locais — os três domínios.
  invalidateBusinessState({
    domains: ["leads", "clients", "locations"],
    clientId: criado.clientId,
  });

  return actionSuccess({
    clientId: criado.clientId,
    locationId: criado.locationId,
    redirectTo: destinoAposConversao({
      clientId: criado.clientId,
      locationId: criado.locationId,
      orcamento,
    }),
  });
}

/**
 * Para onde levar o gestor depois de converter.
 *
 * Uma avença mensal vira contrato recorrente; um trabalho pontual vira um
 * serviço no calendário. Sem orçamento, vai para a ficha do cliente — não há
 * valores para pré-preencher coisa nenhuma, e inventá-los seria pior do que
 * deixar o gestor escolher.
 *
 * 🔴 Em nenhum destes casos se grava alguma coisa. O URL abre um formulário
 *    com os campos já postos; quem carrega em gravar é uma pessoa.
 */
function destinoAposConversao(args: {
  clientId: string;
  locationId: string;
  orcamento: { id: string; pricing_kind: string } | null;
}): string {
  const { clientId, locationId, orcamento } = args;

  if (!orcamento) return `/dashboard/clientes/${clientId}`;

  const params = new URLSearchParams({
    novo: "1",
    clienteId: clientId,
    localId: locationId,
    orcamentoId: orcamento.id,
  });

  return orcamento.pricing_kind === "mensal"
    ? `/dashboard/contratos?${params.toString()}`
    : `/dashboard/calendario?${params.toString()}`;
}

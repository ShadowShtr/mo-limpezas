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
// 🔴 O cliente e o local são criados DENTRO da RPC, na mesma transação da
//    conversão. A versão anterior chamava `createClienteComLocal` primeiro —
//    e essas duas linhas ficavam COMMITADAS antes de a RPC correr.
//
//    Isso não era uma conversão atómica: se a RPC falhasse, ficava um cliente
//    órfão; e em concorrência, dois pedidos criavam dois clientes antes de
//    qualquer um chegar à RPC. A RPC era idempotente; o FLUXO não era.
//
//    A duplicação com `createClienteComLocal` é assumida e pequena — `clients`
//    e `locations` não têm regra de negócio na criação além de `trim` e
//    defaults. O que essa action tem a mais (auth, revalidação) é da camada de
//    aplicação, e continua a ser feito aqui.
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

export interface ResultadoConversao {
  clientId: string;
  locationId: string;
  /** Para onde levar o gestor a seguir, com o formulário pré-preenchido. */
  redirectTo: string;
}

/** Traduz os erros da RPC de conversão para frases que se leem. */
function erroDaConversao(contexto: string, err: unknown): ActionResult<never> {
  const msg = err instanceof Error ? err.message : String(err);

  if (msg.includes("QUOTE_LEAD_MISMATCH")) {
    return actionFailure(
      ACTION_ERROR_CODES.BUSINESS_RULE,
      "Esse orçamento é de outra lead. Escolha o orçamento aceite desta.",
    );
  }
  if (msg.includes("QUOTE_NOT_ACCEPTED")) {
    return actionFailure(
      ACTION_ERROR_CODES.BUSINESS_RULE,
      "Só um orçamento aceite pode dar origem a um cliente. Marque-o como aceite primeiro.",
    );
  }
  if (msg.includes("QUOTE_NOT_FOUND")) {
    return actionFailure(ACTION_ERROR_CODES.NOT_FOUND, "Orçamento não encontrado.");
  }
  if (msg.includes("LEAD_NOT_FOUND")) {
    return actionFailure(ACTION_ERROR_CODES.NOT_FOUND, "Lead não encontrada.");
  }
  if (msg.includes("CONVERSION_ADDRESS_REQUIRED")) {
    return actionFailure(
      ACTION_ERROR_CODES.BUSINESS_RULE,
      "Falta a morada do local. Acrescente-a à lead antes de a converter em cliente.",
    );
  }

  return internalFailure(contexto, err, ACTION_ERROR_CODES.PERSISTENCE);
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
 * ── Atomicidade ────────────────────────────────────────────────────────────
 *
 * 🔴 UMA transação. `convert_crm_lead_atomic` bloqueia a lead, valida o
 *    orçamento, cria o cliente e o local, fecha a lead, aponta o orçamento e
 *    escreve a timeline — tudo dentro dela. Qualquer erro reverte tudo.
 *
 *    Os passos 1 a 3 aqui em cima são LEITURAS: servem para dar mensagens que
 *    se entendem antes de chamar a RPC. Nenhum deles escreve. As mesmas
 *    validações estão dentro da RPC, que é a autoridade — estas só evitam que
 *    o utilizador receba um código de erro em vez de uma frase.
 *
 *    Dois pedidos simultâneos: o segundo espera no lock, encontra a lead já
 *    convertida e devolve os ids existentes sem ter criado nada.
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

  // ── 4. Converter — cliente, local e lead numa transação só ────────────────
  const entrada = leadParaClienteComLocal(dadosLead, {
    items: itens,
    visitAddress: moradaDaVisita,
  });

  let resultado: { client_id: string; location_id: string; ja_convertida: boolean };

  try {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const { data, error } = await (admin as any).rpc("convert_crm_lead_atomic", {
      p_company_id: profile.company_id,
      p_lead_id: leadId,
      p_actor: profile.id,
      p_quote_id: orcamento?.id ?? null,
      p_location_name: entrada.locationName,
      p_address: entrada.address,
      p_service_type: entrada.serviceType,
      p_hourly_rate: entrada.hourlyRate,
      p_lat: entrada.lat ?? null,
      p_lng: entrada.lng ?? null,
    });

    if (error) return erroDaConversao("converterLeadEmCliente", new Error(error.message));

    const linha = Array.isArray(data) ? data[0] : data;
    if (!linha?.client_id) {
      return internalFailure(
        "converterLeadEmCliente",
        new Error("RPC sem resultado"),
        ACTION_ERROR_CODES.PERSISTENCE,
      );
    }
    resultado = linha;
  } catch (err) {
    return erroDaConversao("converterLeadEmCliente", err);
  }

    await auditLog({
    companyId: profile.company_id,
    actorId: profile.id,
    action: "crm_lead_converted",
    entityType: "crm_lead",
    entityId: leadId,
    after: {
      client_id: resultado.client_id,
      location_id: resultado.location_id,
      quote_id: orcamento?.id ?? null,
      ja_convertida: resultado.ja_convertida,
    },
  }, admin);

  // A conversão muda o funil, os clientes e os locais — os três domínios.
  invalidateBusinessState({
    domains: ["leads", "clients", "locations"],
    clientId: resultado.client_id,
  });

  return actionSuccess({
    clientId: resultado.client_id,
    locationId: resultado.location_id,
    redirectTo: destinoAposConversao({
      clientId: resultado.client_id,
      locationId: resultado.location_id,
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

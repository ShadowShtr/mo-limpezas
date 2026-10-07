"use server";

// ============================================================================
// CRM — ganhar uma lead associando-a a um cliente que já existe (108)
// ============================================================================
//
// A irmã de `convertAcceptedQuote` (104). Lá nasce um cliente novo; aqui o
// cliente é um que JÁ EXISTE, escolhido por quem fecha o negócio — para as
// leads que eram clientes antes de entrar no funil.
//
// 🔴 A RPC É A AUTORIDADE, exactamente como na 104. Esta action:
//
//   1. valida a forma dos ids (antes de qualquer query);
//   2. autentica e tira a empresa e o actor da SESSÃO, nunca do browser;
//   3. lê do servidor a proveniência do orçamento (`source_lead_id`);
//   4. chama `link_crm_lead_to_existing_client` uma vez e traduz a resposta.
//
// Que o cliente e o local pertencem à empresa, que o local é desse cliente,
// que o orçamento está aceite e vivo, a concorrência e a idempotência — tudo
// isso a RPC decide sob lock. Repetir aqui seria uma segunda verdade, e uma
// verificação sem lock nem sequer é verdade no instante da escrita.
//
// 🔴 O cliente NÃO é alterado. Nenhuma escrita em `clients`, nem aqui nem na
//    RPC: os dados da lead não sobrescrevem a ficha de quem já é cliente.
// ============================================================================

import { z } from "zod";

import {
  ACTION_ERROR_CODES,
  actionFailure,
  actionSuccess,
  internalFailure,
  type ActionErrorCode,
  type ActionResult,
} from "@/lib/action-result";
import { AUTH_GUARD_CODES, requireProfile } from "@/lib/auth-guard";
import { auditLog } from "@/lib/audit";
import { invalidateBusinessState } from "@/lib/revalidate-business";
import { logQueryFailure } from "@/lib/query-error";

export interface LinkResult {
  clientId: string;
  locationId: string;
  alreadyConverted: boolean;
}

export interface LocalDoCliente {
  id: string;
  name: string;
  address: string;
}

function recusa(code: string): ActionResult<never> {
  if (code === AUTH_GUARD_CODES.UNAUTHENTICATED) {
    return actionFailure(ACTION_ERROR_CODES.UNAUTHENTICATED, "Não autenticado.");
  }
  if (code === AUTH_GUARD_CODES.PROFILE_NOT_FOUND) {
    return actionFailure(ACTION_ERROR_CODES.NOT_FOUND, "Perfil não encontrado.");
  }
  return actionFailure(ACTION_ERROR_CODES.FORBIDDEN, "Sem permissão para fechar leads.");
}

/**
 * As sentinelas da 108 (e as que partilha com a 104), em frases. O texto cru
 * do Supabase nunca chega ao ecrã: vai para o log.
 */
const SENTINELAS: ReadonlyArray<readonly [string, ActionErrorCode, string]> = [
  ["LEAD_ALREADY_CONVERTED", ACTION_ERROR_CODES.CONFLICT,
    "Esta lead já foi fechada com outro cliente ou local. Nada foi alterado."],
  ["LINK_CLIENT_NOT_FOUND", ACTION_ERROR_CODES.NOT_FOUND, "Cliente não encontrado."],
  ["LINK_LOCATION_NOT_FOUND", ACTION_ERROR_CODES.NOT_FOUND, "Local não encontrado."],
  ["LINK_LOCATION_CLIENT_MISMATCH", ACTION_ERROR_CODES.CONFLICT,
    "Esse local não pertence ao cliente escolhido."],
  ["LINK_LOCATION_INACTIVE", ACTION_ERROR_CODES.BUSINESS_RULE,
    "Esse local está desativado. Escolha outro ou crie um local novo."],
  ["LEAD_NOT_FOUND", ACTION_ERROR_CODES.NOT_FOUND, "Lead não encontrada."],
  ["QUOTE_NOT_FOUND", ACTION_ERROR_CODES.NOT_FOUND, "Orçamento não encontrado."],
  ["QUOTE_NOT_ACCEPTED", ACTION_ERROR_CODES.BUSINESS_RULE,
    "Este orçamento ainda não está aceite."],
  ["QUOTE_ALREADY_SUPERSEDED", ACTION_ERROR_CODES.CONFLICT,
    "Este orçamento foi substituído por uma revisão mais recente. Recarregue."],
  ["QUOTE_LEAD_MISMATCH", ACTION_ERROR_CODES.CONFLICT,
    "O estado deste orçamento mudou. Recarregue antes de continuar."],
  ["QUOTE_RECIPIENT_MISMATCH", ACTION_ERROR_CODES.CONFLICT,
    "O estado deste orçamento mudou. Recarregue antes de continuar."],
  ["CONVERSION_VISIT_MISMATCH", ACTION_ERROR_CODES.CONFLICT,
    "A visita ligada ao orçamento já não corresponde a esta lead. Verifique os dados."],
  ["CONVERSION_ADDRESS_REQUIRED", ACTION_ERROR_CODES.BUSINESS_RULE,
    "Falta uma morada na lead ou na visita para criar o local. Escolha um local que o cliente já tenha, ou registe a morada."],
  ["CONVERSION_STATE_DIVERGED", ACTION_ERROR_CODES.CONFLICT,
    "O estado desta lead está inconsistente. Nada foi alterado; verifique os dados."],
  ["ACTOR_NOT_IN_COMPANY", ACTION_ERROR_CODES.FORBIDDEN, "Sem permissão para fechar leads."],
];

/** A RPC não existe: a 108 ainda não foi aplicada nesta base. */
function rpcAusente(texto: string): boolean {
  return /PGRST202|Could not find the function|link_crm_lead_to_existing_client.*does not exist/i
    .test(texto);
}

function erroDaRpc(message: string | undefined): ActionResult<never> {
  const texto = message ?? "";
  logQueryFailure("linkLeadToExistingClient", { message: texto || "sem mensagem" });

  if (rpcAusente(texto)) {
    // Falha fechada e legível: o código chegou antes da migration.
    return actionFailure(
      ACTION_ERROR_CODES.BUSINESS_RULE,
      "Esta opção ainda não está ativa. Por agora, use «Converter em cliente».",
    );
  }

  for (const [sentinela, code, frase] of SENTINELAS) {
    if (texto.includes(sentinela)) return actionFailure(code, frase);
  }

  // `CONVERSION_QUOTE_REQUIRED` e `LINK_CLIENT_REQUIRED` caem aqui de
  // propósito: os ids já foram validados, por isso são defeito nosso.
  return internalFailure(
    "linkLeadToExistingClient",
    new Error(texto),
    ACTION_ERROR_CODES.PERSISTENCE,
  );
}

/**
 * Fecha a lead do orçamento em «ganho», associada a um cliente que já existe.
 *
 * `locationId` nulo cria um local novo com a morada da visita/lead; um id
 * reaproveita um local que esse cliente já tem.
 */
export async function linkLeadToExistingClient(
  quoteId: string,
  clientId: string,
  locationId: string | null,
): Promise<ActionResult<LinkResult>> {
  const ids = z
    .object({ quoteId: z.uuid(), clientId: z.uuid(), locationId: z.uuid().nullable() })
    .safeParse({ quoteId, clientId, locationId });
  if (!ids.success) {
    return actionFailure(ACTION_ERROR_CODES.VALIDATION, "Dados inválidos.");
  }

  const guard = await requireProfile({ roles: ["admin", "gestor"] });
  if (!guard.ok) return recusa(guard.code);

  const { admin, profile } = guard;

  // Só a proveniência — a única coisa que a RPC não descobre sozinha.
  const { data: quote, error } = await admin
    .from("crm_quotes")
    .select("source_lead_id")
    .eq("company_id", profile.company_id)
    .eq("id", quoteId)
    .maybeSingle();

  if (error) {
    logQueryFailure("linkLeadToExistingClient:quote", error);
    return internalFailure("linkLeadToExistingClient", error, ACTION_ERROR_CODES.PERSISTENCE);
  }
  if (!quote) {
    return actionFailure(ACTION_ERROR_CODES.NOT_FOUND, "Orçamento não encontrado.");
  }
  if (!quote.source_lead_id) {
    return actionFailure(
      ACTION_ERROR_CODES.BUSINESS_RULE,
      "Este orçamento foi criado diretamente para um cliente e não fecha nenhuma lead.",
    );
  }

  try {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const { data, error: erroRpc } = await (admin as any).rpc("link_crm_lead_to_existing_client", {
      p_company_id: profile.company_id,
      p_lead_id: quote.source_lead_id,
      p_actor: profile.id,
      p_quote_id: quoteId,
      p_client_id: clientId,
      p_location_id: locationId,
    });

    if (erroRpc) return erroDaRpc(erroRpc.message);

    const linha = Array.isArray(data) ? data[0] : data;

    // 🔴 Contrato inteiro, ou nada — como na 104. Uma resposta que não se
    //    percebe não pode valer como «associação real» e ser auditada.
    const resposta = z
      .object({ client_id: z.uuid(), location_id: z.uuid(), ja_convertida: z.boolean() })
      .safeParse(linha);

    if (!resposta.success) {
      return internalFailure(
        "linkLeadToExistingClient",
        new Error(`resposta da RPC fora do contrato: ${resposta.error.message}`),
        ACTION_ERROR_CODES.PERSISTENCE,
      );
    }

    const { client_id: clienteRpc, location_id: localRpc } = resposta.data;
    const alreadyConverted = resposta.data.ja_convertida;

    // 🔴 O cliente devolvido tem de ser o pedido. A RPC garante-o; se um dia
    //    não garantir, isto não passa em silêncio.
    if (clienteRpc !== clientId) {
      return internalFailure(
        "linkLeadToExistingClient",
        new Error("a RPC devolveu um cliente diferente do pedido"),
        ACTION_ERROR_CODES.PERSISTENCE,
      );
    }

    if (!alreadyConverted) {
      await auditLog({
        companyId: profile.company_id,
        actorId: profile.id,
        action: "crm_lead_linked_existing_client",
        entityType: "crm_lead",
        entityId: String(quote.source_lead_id),
        after: { quote_id: quoteId, client_id: clienteRpc, location_id: localRpc },
      }, admin);
    }

    invalidateBusinessState({
      domains: ["leads", "clients", "locations"],
      clientId: clienteRpc,
    });

    return actionSuccess({ clientId: clienteRpc, locationId: localRpc, alreadyConverted });
  } catch (err) {
    return internalFailure("linkLeadToExistingClient", err, ACTION_ERROR_CODES.PERSISTENCE);
  }
}

/** Os locais activos de um cliente, para escolher onde fica o serviço. */
export async function getClientLocationsForLink(
  clientId: string,
): Promise<ActionResult<LocalDoCliente[]>> {
  if (!z.uuid().safeParse(clientId).success) {
    return actionFailure(ACTION_ERROR_CODES.VALIDATION, "Cliente inválido.");
  }

  const guard = await requireProfile({ roles: ["admin", "gestor"] });
  if (!guard.ok) return recusa(guard.code);

  const { admin, profile } = guard;

  const { data, error } = await admin
    .from("locations")
    .select("id, name, address")
    .eq("company_id", profile.company_id)
    .eq("client_id", clientId)
    .eq("active", true)
    .order("name");

  if (error) {
    logQueryFailure("getClientLocationsForLink", error);
    return internalFailure("getClientLocationsForLink", error, ACTION_ERROR_CODES.PERSISTENCE);
  }

  return actionSuccess((data ?? []) as LocalDoCliente[]);
}

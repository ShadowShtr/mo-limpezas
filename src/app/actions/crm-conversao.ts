"use server";

// ============================================================================
// CRM — converter uma lead em cliente e local
// ============================================================================
//
// 🔴 Só funções assíncronas. As constantes e os helpers puros vivem em
//    `src/lib/crm/quotes.ts`.
//
// ---------------------------------------------------------------------------
// 🔴 A RPC É A AUTORIDADE. Esta action não decide nada.
// ---------------------------------------------------------------------------
//
// `convert_crm_lead_atomic` (104) valida, sob `FOR UPDATE` e numa só
// transação: o estado do orçamento, a revisão viva, o destinatário actual, a
// visita, a morada, a concorrência e a idempotência. Cria o cliente, o local,
// fecha a lead, muda o destinatário do orçamento e escreve a timeline — tudo
// ou nada.
//
// Duplicar aqui qualquer uma dessas regras seria criar um segundo sítio onde
// a verdade vive. Os dois divergiriam ao primeiro ajuste, e o que o ecrã
// dissesse deixaria de corresponder ao que a base faria. Pior: uma
// verificação feita AQUI acontece antes do lock, por isso nem sequer é
// verdadeira no momento em que a escrita ocorre.
//
// Esta action faz três coisas, e mais nada:
//
//   1. autentica e descobre a empresa e o actor (nunca vêm do browser);
//   2. lê do servidor a PROVENIÊNCIA do orçamento (`source_lead_id`);
//   3. chama a RPC uma vez e traduz o que ela responder.
//
// ---------------------------------------------------------------------------
// 🔴 O que NÃO acontece aqui, e é deliberado
// ---------------------------------------------------------------------------
//
//   · nenhum contrato, serviço, factura ou movimento de caixa. Converter
//     identidade comercial e agendar trabalho são duas decisões, e a segunda
//     é de uma pessoa, com um formulário à frente;
//   · nenhuma escrita directa em `crm_leads`, `crm_quotes`, `clients`,
//     `locations` ou `crm_lead_interactions`. Zero. Tudo passa pela RPC.
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

export interface ConversionResult {
  clientId: string;
  locationId: string;
  alreadyConverted: boolean;
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
 * Traduz as sentinelas da 104 em mensagens que se entendem.
 *
 * 🔴 O `error.message` cru do Supabase NUNCA chega ao ecrã: expõe nomes de
 *    tabelas e restrições a quem não tem nada com isso, e não ajuda ninguém.
 *    O detalhe vai para o log; o utilizador recebe a frase.
 */
const SENTINELAS: ReadonlyArray<readonly [string, ActionErrorCode, string]> = [
  ["LEAD_NOT_FOUND", ACTION_ERROR_CODES.NOT_FOUND, "Lead não encontrada."],
  ["QUOTE_NOT_FOUND", ACTION_ERROR_CODES.NOT_FOUND, "Orçamento não encontrado."],
  ["QUOTE_NOT_ACCEPTED", ACTION_ERROR_CODES.BUSINESS_RULE,
    "Este orçamento ainda não está aceite."],
  ["QUOTE_ALREADY_SUPERSEDED", ACTION_ERROR_CODES.CONFLICT,
    "Este orçamento foi substituído por uma revisão mais recente. Recarregue."],
  ["QUOTE_LEAD_MISMATCH", ACTION_ERROR_CODES.CONFLICT,
    "O estado deste orçamento mudou. Recarregue antes de converter."],
  ["QUOTE_RECIPIENT_MISMATCH", ACTION_ERROR_CODES.CONFLICT,
    "O estado deste orçamento mudou. Recarregue antes de converter."],
  ["CONVERSION_VISIT_MISMATCH", ACTION_ERROR_CODES.CONFLICT,
    "A visita ligada ao orçamento já não corresponde a esta lead. Verifique os dados antes de converter."],
  ["CONVERSION_ADDRESS_REQUIRED", ACTION_ERROR_CODES.BUSINESS_RULE,
    "Falta uma morada válida na lead ou na visita. Registe a morada e tente novamente."],
  ["CONVERSION_STATE_DIVERGED", ACTION_ERROR_CODES.CONFLICT,
    "O estado da conversão está inconsistente. Nada foi alterado; verifique os dados antes de tentar novamente."],
  ["ACTOR_NOT_IN_COMPANY", ACTION_ERROR_CODES.FORBIDDEN,
    "Sem permissão para converter leads."],
];

function erroDaRpc(message: string | undefined): ActionResult<never> {
  const texto = message ?? "";
  logQueryFailure("convertAcceptedQuote", { message: texto || "sem mensagem" });

  for (const [sentinela, code, frase] of SENTINELAS) {
    if (texto.includes(sentinela)) return actionFailure(code, frase);
  }

  // 🔴 `CONVERSION_QUOTE_REQUIRED` cai aqui de propósito.
  //
  //    A RPC levanta-a quando `p_quote_id` é NULL — e esta action só a chama
  //    com um `quoteId` já validado como UUID. Numa chamada válida daqui, essa
  //    sentinela é impossível; se aparecer, é defeito do nosso lado, não do
  //    utilizador. Dizer-lhe «faltou indicar o orçamento» seria culpá-lo por
  //    um erro que ele não cometeu e que não sabe corrigir.
  return internalFailure(
    "convertAcceptedQuote",
    new Error(texto),
    ACTION_ERROR_CODES.PERSISTENCE,
  );
}

/**
 * Converte um orçamento aceite no cliente e no local que ele justifica.
 *
 * 🔴 A entrada pública é UM id, e só. `companyId` e `actorId` vêm da sessão:
 *    o admin client faz bypass de RLS, por isso uma empresa vinda do browser
 *    seria a porta para converter leads de outra empresa. `leadId` também não
 *    entra — é derivado no servidor, a partir do próprio documento.
 */
export async function convertAcceptedQuote(
  quoteId: string,
): Promise<ActionResult<ConversionResult>> {
  // 🔴 Antes de qualquer query ou RPC: um id malformado é recusado já.
  if (!z.uuid().safeParse(quoteId).success) {
    return actionFailure(ACTION_ERROR_CODES.VALIDATION, "Orçamento inválido.");
  }

  const guard = await requireProfile({ roles: ["admin", "gestor"] });
  if (!guard.ok) return recusa(guard.code);

  const { admin, profile } = guard;

  // 🔴 SELECT MÍNIMO: só `source_lead_id`.
  //
  //    É tentador trazer também `status`, `superseded_by_id`, `lead_id` e
  //    `client_id` «para validar antes». Não se faz: seria começar a duplicar
  //    as regras da RPC, e uma leitura sem lock nem sequer é verdade no
  //    instante da escrita. O que se lê aqui é a única coisa que a RPC não
  //    consegue descobrir sozinha a partir do que o browser envia.
  //
  // 🔴 `source_lead_id`, nunca `lead_id`. A conversão põe `lead_id` a NULL;
  //    só a proveniência sobrevive, e é ela que faz a repetição encontrar a
  //    mesma lead e responder de forma idempotente.
  const { data: quote, error } = await admin
    .from("crm_quotes")
    .select("source_lead_id")
    .eq("company_id", profile.company_id)
    .eq("id", quoteId)
    .maybeSingle();

  if (error) {
    logQueryFailure("convertAcceptedQuote:quote", error);
    return internalFailure("convertAcceptedQuote", error, ACTION_ERROR_CODES.PERSISTENCE);
  }
  if (!quote) {
    return actionFailure(ACTION_ERROR_CODES.NOT_FOUND, "Orçamento não encontrado.");
  }

  if (!quote.source_lead_id) {
    // Nasceu já de um cliente. Não há lead nenhuma para ganhar, e a RPC não
    // é chamada — não é um erro do sistema, é um orçamento de outra natureza.
    return actionFailure(
      ACTION_ERROR_CODES.BUSINESS_RULE,
      "Este orçamento foi criado diretamente para um cliente e não converte uma lead.",
    );
  }

  try {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const { data, error: erroRpc } = await (admin as any).rpc("convert_crm_lead_atomic", {
      p_company_id: profile.company_id,
      p_lead_id: quote.source_lead_id,
      p_actor: profile.id,
      p_quote_id: quoteId,
    });

    if (erroRpc) return erroDaRpc(erroRpc.message);

    const linha = Array.isArray(data) ? data[0] : data;

    // 🔴 A resposta da RPC é validada POR INTEIRO antes de qualquer efeito.
    //
    //    A versão anterior verificava os dois ids e depois fazia
    //    `linha.ja_convertida === true`. Isso lê bem e falha aberto: com
    //    `undefined`, `null` ou um tipo inesperado — drift de contrato, uma
    //    RPC substituída, um overload novo — a expressão dá `false` em
    //    silêncio, e `false` é precisamente o ramo que AUDITA a conversão.
    //
    //    Ou seja: uma resposta que não se percebe passaria a valer como
    //    «conversão real confirmada», e ficava registada como tal. Uma
    //    coerção de boolean não é uma leitura; é um palpite com aspecto de
    //    leitura.
    //
    //    UNKNOWN_STATE = FAIL_CLOSED: ou a resposta cumpre o contrato
    //    inteiro, ou não há sucesso, auditoria nem invalidação.
    const resposta = z
      .object({
        client_id: z.uuid(),
        location_id: z.uuid(),
        ja_convertida: z.boolean(),
      })
      .safeParse(linha);

    if (!resposta.success) {
      return internalFailure(
        "convertAcceptedQuote",
        new Error(`resposta da RPC fora do contrato: ${resposta.error.message}`),
        ACTION_ERROR_CODES.PERSISTENCE,
      );
    }

    const { client_id: clientId, location_id: locationId } = resposta.data;
    const alreadyConverted = resposta.data.ja_convertida;

    // 🔴 Auditar SÓ a conversão real.
    //
    //    Um duplo clique ou um retry não é uma segunda conversão — é a mesma,
    //    vista outra vez. Gravar `crm_lead_converted` também no caminho
    //    idempotente encheria a auditoria de eventos que nunca aconteceram, e
    //    quem contasse conversões contaria cliques.
    //
    //    A timeline de negócio já foi escrita pela RPC, dentro da transação.
    //    `audit_logs` é complementar, não é a história do cliente.
    if (!alreadyConverted) {
      await auditLog({
        companyId: profile.company_id,
        actorId: profile.id,
        action: "crm_lead_converted",
        entityType: "crm_lead",
        entityId: String(quote.source_lead_id),
        after: { quote_id: quoteId, client_id: clientId, location_id: locationId },
      }, admin);
    }

    // Em QUALQUER sucesso, incluindo o idempotente: quem repetiu pode estar a
    // ver uma lista que ficou desactualizada noutro separador.
    invalidateBusinessState({
      domains: ["leads", "clients", "locations"],
      clientId,
    });

    return actionSuccess({ clientId, locationId, alreadyConverted });
  } catch (err) {
    return internalFailure("convertAcceptedQuote", err, ACTION_ERROR_CODES.PERSISTENCE);
  }
}

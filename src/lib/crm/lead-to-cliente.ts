// ============================================================================
// CRM — da lead ao cliente: o mapeamento dos campos
// ============================================================================
//
// 🔴 Sem `"use server"`: função pura, testável sem base de dados. Ver a nota
//    em `stages.ts`.
//
// Isto existe porque a conversão é o momento em que mais se perde informação
// por descuido: o comercial escreveu tudo na lead, e se a criação do cliente
// não trouxer esses campos, alguém vai ter de os escrever outra vez — e não
// vai. `createClienteComLocal` é reutilizado tal como está; o que faltava era
// a tradução entre os dois vocabulários, e é ela que vive aqui.
// ============================================================================

/** O que a conversão precisa de saber de uma lead. */
export interface LeadParaConverter {
  name: string;
  lead_type: "individual" | "empresa";
  contact_name: string | null;
  email: string | null;
  phone: string | null;
  nif: string | null;
  address: string | null;
  lat?: number | null;
  lng?: number | null;
  service_type: string | null;
}

/** O que o orçamento aceite acrescenta, quando existe. */
export interface OrcamentoParaConverter {
  /** Linhas com `unit = 'hora'` dão o preço/hora do local. */
  items?: { unit: string; unit_price: number }[];
  /** A morada apurada na visita tem precedência sobre a da lead. */
  visitAddress?: string | null;
}

/** A forma que `createClienteComLocal` espera. */
export interface ClienteComLocalInput {
  name: string;
  type: "individual" | "empresa";
  phone?: string;
  email?: string;
  nif?: string;
  locationName: string;
  address: string;
  hourlyRate: number | null;
  serviceType: string;
  lat?: number | null;
  lng?: number | null;
}

/**
 * O preço/hora a inscrever no local.
 *
 * Sai da linha do orçamento cobrada à hora. Se o orçamento for todo a preço
 * fixo, devolve `null` em vez de inventar um valor: um preço/hora errado no
 * local entraria no cálculo de cada serviço gerado dali em diante, e ninguém
 * ligaria o engano à conversão que o produziu.
 *
 * Com várias linhas à hora — raro, mas possível — vale a primeira: é a
 * principal, e o gestor confirma tudo no formulário antes de gravar.
 */
export function precoHoraDoOrcamento(
  items: { unit: string; unit_price: number }[] | undefined,
): number | null {
  const linha = (items ?? []).find((i) => i.unit === "hora" && i.unit_price > 0);
  return linha ? linha.unit_price : null;
}

/**
 * Traduz a lead (e o orçamento aceite) para a entrada de
 * `createClienteComLocal`.
 *
 * Decisões que valem a pena explicar:
 *
 *   · **o nome do local é o nome da lead.** Não há melhor candidato no momento
 *     da conversão, e um local sem nome é pior do que um com nome repetido —
 *     aparece em branco no calendário e na escala. Renomeia-se depois na ficha
 *     do local, se fizer falta;
 *
 *   · **a morada da visita tem precedência.** A lead costuma ter a morada da
 *     sede; a visita tem a do sítio onde se vai limpar, que é a que interessa
 *     ao mapa, ao GPS e ao clock-in;
 *
 *   · **`service_type` cai em `limpeza_regular`** quando a lead não o disser.
 *     É o valor por omissão de `locations.service_type`, e é o tipo de trabalho
 *     mais comum da empresa.
 */
export function leadParaClienteComLocal(
  lead: LeadParaConverter,
  orcamento?: OrcamentoParaConverter,
): ClienteComLocalInput {
  const morada = (orcamento?.visitAddress?.trim() || lead.address?.trim() || "").trim();

  return {
    name: lead.name.trim(),
    type: lead.lead_type,
    // Campos vazios viajam como `undefined`, não como string vazia: é o que
    // `createClienteComLocal` converte em NULL na base.
    phone: lead.phone?.trim() || undefined,
    email: lead.email?.trim() || undefined,
    nif: lead.nif?.trim() || undefined,
    locationName: lead.name.trim(),
    address: morada,
    hourlyRate: precoHoraDoOrcamento(orcamento?.items),
    serviceType: lead.service_type || "limpeza_regular",
    lat: lead.lat ?? null,
    lng: lead.lng ?? null,
  };
}

/**
 * O que impede a conversão de avançar.
 *
 * 🔴 A morada é obrigatória e não tem valor por omissão possível.
 *    `locations.address` é NOT NULL, e um local sem morada não se encontra no
 *    mapa, não dá para navegar até lá e não valida o GPS do clock-in. Melhor
 *    parar aqui, com uma frase que diz o que falta, do que criar um cliente
 *    que já nasce partido.
 */
export function porqueNaoConverte(
  lead: LeadParaConverter,
  orcamento?: OrcamentoParaConverter,
): string | null {
  if (!lead.name.trim()) return "A lead não tem nome.";

  const morada = orcamento?.visitAddress?.trim() || lead.address?.trim() || "";
  if (!morada) {
    return "Falta a morada do local. Acrescente-a à lead antes de a converter em cliente.";
  }

  return null;
}

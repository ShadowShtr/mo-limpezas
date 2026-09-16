// ============================================================================
// CRM — de onde veio a lead, e o motivo por que se perdeu
// ============================================================================
//
// 🔴 Sem `"use server"`: são constantes, e um ficheiro de server actions não
//    pode exportar objetos. Ver a nota em `stages.ts`.
//
// Os valores coincidem à letra com os CHECK de `crm_leads.source` e
// `crm_leads.lost_reason` na migration 101 — `crm-stages.test.ts` verifica-o.
//
// ---------------------------------------------------------------------------
// Porque é que estes dois são listas fechadas e não texto livre
// ---------------------------------------------------------------------------
//
// Porque a pergunta que justificam é uma contagem. «De onde vem o trabalho?» e
// «porque é que perdemos?» só se respondem agrupando, e texto livre não
// agrupa: "recomendação", "Recomendacao", "veio pela D. Maria" e "amigo de um
// cliente" são quatro linhas num relatório que devia ter uma.
//
// O detalhe que se perde ao fechar a lista tem sítio próprio: `source_detail`
// e `lost_reason_notes`, ambos livres, ao lado do valor contável.
// ============================================================================

export const LEAD_SOURCES = [
  "recomendacao",
  "website",
  "telefone",
  "email",
  "whatsapp",
  "redes_sociais",
  "passagem",
  "parceiro",
  "outro",
] as const;

export type LeadSource = (typeof LEAD_SOURCES)[number];

export function isLeadSource(value: unknown): value is LeadSource {
  return typeof value === "string" && (LEAD_SOURCES as readonly string[]).includes(value);
}

export const LEAD_SOURCE_LABELS: Record<LeadSource, string> = {
  recomendacao: "Recomendação",
  website: "Site",
  telefone: "Telefone",
  email: "Email",
  whatsapp: "WhatsApp",
  redes_sociais: "Redes sociais",
  // Quem vê a carrinha, a farda ou o cartão e liga. É uma origem real e mais
  // comum do que parece — sem entrada própria acabaria toda em "Outro".
  passagem: "Passagem / viu-nos",
  parceiro: "Parceiro",
  outro: "Outro",
};

// ── Motivo de perda ─────────────────────────────────────────────────────────

export const LEAD_LOST_REASONS = [
  "preco",
  "sem_resposta",
  "escolheu_concorrente",
  "adiou",
  "fora_de_area",
  "servico_nao_prestado",
  "outro",
] as const;

export type LeadLostReason = (typeof LEAD_LOST_REASONS)[number];

export function isLeadLostReason(value: unknown): value is LeadLostReason {
  return typeof value === "string" && (LEAD_LOST_REASONS as readonly string[]).includes(value);
}

export const LEAD_LOST_REASON_LABELS: Record<LeadLostReason, string> = {
  preco: "Preço",
  // Distinto de "escolheu concorrente": um silêncio não é uma derrota conhecida,
  // e as duas pedem respostas diferentes — uma é seguimento, a outra é proposta.
  sem_resposta: "Não respondeu",
  escolheu_concorrente: "Escolheu outra empresa",
  adiou: "Adiou a decisão",
  fora_de_area: "Fora da área de serviço",
  servico_nao_prestado: "Serviço que não fazemos",
  outro: "Outro",
};

// ── Natureza do valor estimado ──────────────────────────────────────────────
//
// 🔴 300 € de pós-obra pontual e 300 €/mês de avença não são o mesmo número, e
//    um funil que os somasse numa coluna só mentiria sempre para cima. O valor
//    nunca viaja sem esta etiqueta.

export const LEAD_VALUE_KINDS = ["mensal", "pontual"] as const;

export type LeadValueKind = (typeof LEAD_VALUE_KINDS)[number];

export function isLeadValueKind(value: unknown): value is LeadValueKind {
  return typeof value === "string" && (LEAD_VALUE_KINDS as readonly string[]).includes(value);
}

export const LEAD_VALUE_KIND_LABELS: Record<LeadValueKind, string> = {
  mensal: "Por mês",
  pontual: "Valor único",
};

// ── Tipo de interação no diário de contactos ────────────────────────────────

export const LEAD_INTERACTION_KINDS = [
  "chamada",
  "email",
  "whatsapp",
  "reuniao",
  "visita",
  "nota",
  "proposta_enviada",
  "sistema",
] as const;

export type LeadInteractionKind = (typeof LEAD_INTERACTION_KINDS)[number];

export function isLeadInteractionKind(value: unknown): value is LeadInteractionKind {
  return typeof value === "string"
    && (LEAD_INTERACTION_KINDS as readonly string[]).includes(value);
}

export const LEAD_INTERACTION_KIND_LABELS: Record<LeadInteractionKind, string> = {
  chamada: "Chamada",
  email: "Email",
  whatsapp: "WhatsApp",
  reuniao: "Reunião",
  visita: "Visita",
  nota: "Nota",
  proposta_enviada: "Orçamento enviado",
  sistema: "Registo automático",
};

/**
 * As que uma pessoa escolhe ao registar um contacto à mão.
 *
 * `sistema` fica de fora: é escrita pelas próprias actions (mudança de estado,
 * orçamento enviado, conversão) e oferecê-la no formulário deixaria alguém
 * forjar à mão um registo que devia ser prova do que o sistema fez.
 */
export const MANUAL_INTERACTION_KINDS: readonly LeadInteractionKind[] =
  LEAD_INTERACTION_KINDS.filter((k) => k !== "sistema");

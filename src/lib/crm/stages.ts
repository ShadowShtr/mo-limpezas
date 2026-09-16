// ============================================================================
// CRM — os estados do funil, as suas transições e o que cada uma exige
// ============================================================================
//
// 🔴 Este ficheiro NÃO tem `"use server"`, e é deliberado. Um ficheiro com
//    essa diretiva só pode exportar funções assíncronas; exportar daqui um
//    objeto de etiquetas compila e rebenta em runtime — foi exatamente o que
//    aconteceu a 2026-06-08 com `CANCEL_TYPE_LABELS`, e bloqueou todas as
//    notificações do calendário.
//
// Os valores têm de coincidir, à letra, com o CHECK de `crm_leads.stage` na
// migration 101. A base é a última linha de defesa, não a primeira — mas se as
// duas listas divergirem, a interface oferece um estado que a base recusa, e o
// utilizador leva com um erro que não percebe. `crm-stages.test.ts` compara as
// duas e falha se alguém acrescentar um estado só de um lado.
// ============================================================================

export const LEAD_STAGES = [
  "novo",
  "contactado",
  "visita_agendada",
  "orcamento_enviado",
  "ganho",
  "perdido",
] as const;

export type LeadStage = (typeof LEAD_STAGES)[number];

export function isLeadStage(value: unknown): value is LeadStage {
  return typeof value === "string" && (LEAD_STAGES as readonly string[]).includes(value);
}

export const LEAD_STAGE_LABELS: Record<LeadStage, string> = {
  novo: "Novo",
  contactado: "Contactado",
  visita_agendada: "Visita agendada",
  orcamento_enviado: "Orçamento enviado",
  ganho: "Ganho",
  perdido: "Perdido",
};

/**
 * Cor de cada coluna do quadro.
 *
 * Nomes, não códigos: o quadro das Tarefas já guarda cores assim
 * (`company_settings.kanban_columns`), e manter o mesmo vocabulário evita ter
 * dois sistemas de cor a discordar sobre o que é "âmbar".
 */
export const LEAD_STAGE_COLORS: Record<LeadStage, string> = {
  novo: "slate",
  contactado: "blue",
  visita_agendada: "amber",
  orcamento_enviado: "violet",
  ganho: "green",
  perdido: "red",
};

/**
 * Quanto vale, em expectativa, uma lead parada em cada estado.
 *
 * 🔴 Derivado do estado, e não um campo por lead. Numa empresa desta dimensão
 *    ninguém mantém uma percentagem à mão em cada oportunidade — e um campo
 *    que ninguém mantém é pior do que campo nenhum, porque dá um número com
 *    ar de verdade. O peso vem do sítio onde a lead está, que se atualiza
 *    sozinho quando alguém a arrasta.
 *
 * Os valores não são uma previsão contabilística: servem para ordenar o funil
 * e para dar uma ideia de grandeza. Nunca entram em nada financeiro.
 */
export const LEAD_STAGE_WEIGHTS: Record<LeadStage, number> = {
  novo: 0.1,
  contactado: 0.25,
  visita_agendada: 0.45,
  orcamento_enviado: 0.65,
  ganho: 1,
  perdido: 0,
};

/** Os estados em que a lead já não está em jogo. */
export const CLOSED_STAGES: readonly LeadStage[] = ["ganho", "perdido"];

export function isClosedStage(stage: LeadStage): boolean {
  return CLOSED_STAGES.includes(stage);
}

/**
 * Para onde cada estado pode ir.
 *
 * O funil não é uma escada: uma lead contactada pode ir direta a orçamento sem
 * visita (há trabalhos que se orçamentam por telefone), e uma que estava
 * perdida pode voltar se o cliente reaparecer meses depois. O que **não** se
 * permite:
 *
 *   · sair de `ganho` — a conversão já criou um cliente real; "desganhar"
 *     deixaria esse cliente sem a história que o explica. Corrige-se no
 *     cliente, não na lead;
 *   · ir para o próprio estado — arrastar um cartão para a coluna onde já
 *     está não é uma mudança, e registá-la encheria a timeline de ruído.
 */
/**
 * 🔴 Exportada de propósito, e não por conveniência de import.
 *
 * A mesma matriz existe em SQL, dentro de `move_crm_lead_stage_atomic` (101) —
 * a RPC é a autoridade, porque é o único ponto por onde todos os caminhos de
 * escrita passam. Duas cópias da mesma regra divergem em silêncio a menos que
 * alguém as compare; `crm-stage-reorder.pg.test.ts` percorre as 36 combinações
 * FROM×TO contra o Postgres real e falha se discordarem.
 *
 * Exportar isto é o que torna essa comparação possível.
 */
export const TRANSICOES: Record<LeadStage, readonly LeadStage[]> = {
  novo: ["contactado", "visita_agendada", "orcamento_enviado", "ganho", "perdido"],
  contactado: ["novo", "visita_agendada", "orcamento_enviado", "ganho", "perdido"],
  visita_agendada: ["contactado", "orcamento_enviado", "ganho", "perdido"],
  orcamento_enviado: ["visita_agendada", "contactado", "ganho", "perdido"],
  // Terminal. Ver a nota acima.
  ganho: [],
  perdido: ["novo", "contactado", "visita_agendada", "orcamento_enviado"],
};

export function canTransition(from: LeadStage, to: LeadStage): boolean {
  return TRANSICOES[from].includes(to);
}

/** Os destinos possíveis a partir de um estado — para a interface só oferecer esses. */
export function allowedTransitions(from: LeadStage): readonly LeadStage[] {
  return TRANSICOES[from];
}

/**
 * O que um estado exige para poder ser assumido.
 *
 * Espelha os CHECK da 101 (`crm_leads_perdida_exige_motivo`,
 * `crm_leads_ganha_exige_data`, `crm_leads_conversao_so_se_ganha`). Existe
 * para a interface poder pedir o motivo **antes** de gravar, em vez de deixar
 * a base recusar e mostrar um erro técnico a quem só queria arrastar um cartão.
 */
export function requiresLostReason(stage: LeadStage): boolean {
  return stage === "perdido";
}

export function requiresConversion(stage: LeadStage): boolean {
  return stage === "ganho";
}

// ============================================================================
// AVISOS DE VENCIMENTO — vocabulário
// ============================================================================
//
// Quatro superfícies do produto têm prazos e nenhuma delas avisava: um
// pagamento vence, uma tarefa tem data, uma lead tem próxima acção marcada, uma
// visita está agendada. Quem gere tinha de ir a quatro ecrãs perguntar «falta
// alguma coisa?».
//
// 🔴 Este ficheiro não sabe o que é Supabase nem o que é React, e é isso que o
//    torna útil: a MESMA classificação serve o modal e o cron. Enquanto a regra
//    vivia dentro de quem a usava, o sino e o ecrã podiam discordar sobre o que
//    é «atrasado» — e discordar sobre uma dívida é pior do que não avisar.
// ============================================================================

/** De onde nasce o aviso. */
export type AvisoSource = "pagamento" | "tarefa" | "lead" | "visita";

/** Quão urgente. Só existem três — ver `classify.ts` para o porquê. */
export type AvisoUrgencia = "atrasado" | "hoje" | "amanha";

export interface AvisoItem {
  /**
   * Identidade estável da linha: `{source}:{itemId}`.
   *
   * 🔴 Não é o `itemId` sozinho. Um pagamento e uma tarefa podem partilhar o
   *    mesmo uuid sem que isso queira dizer nada, e uma chave de React
   *    duplicada faz o React reutilizar o nó errado — nome de um com a data do
   *    outro, num ecrã que existe para dizer o que está em atraso.
   */
  key: string;
  source: AvisoSource;
  itemId: string;
  /** Data civil de Lisboa, `YYYY-MM-DD`. Nunca um instante. */
  date: string;
  urgencia: AvisoUrgencia;
  title: string;
  detail: string;
  href: string;
}

/** A ordem por que os grupos se leem — a mais urgente primeiro. */
export const URGENCIA_ORDEM: readonly AvisoUrgencia[] = ["atrasado", "hoje", "amanha"];

export const URGENCIA_LABEL: Record<AvisoUrgencia, string> = {
  atrasado: "Atrasados",
  hoje: "Hoje",
  amanha: "Amanhã",
};

/**
 * O tipo de notificação do sino para cada fonte.
 *
 * 🔴 Um tipo por FONTE, nunca por urgência. O tipo é a identidade — o que a
 *    notificação É — e «atrasado» é o estado em que estava no dia em que foi
 *    criada. Um `deadline_payment_overdue` faria a lista de tipos crescer com o
 *    calendário e obrigaria quem lê o sino a aprender doze etiquetas para
 *    quatro assuntos. A urgência vive no conteúdo e em `data.urgencia`.
 *
 *    Vive aqui, e não dentro do cron, porque o rótulo em `notifications-bell`
 *    tem de falar destes mesmos quatro valores. Duas listas separadas
 *    divergiriam, e o sintoma seria uma notificação a mostrar `deadline_task`
 *    em bruto a quem a recebe.
 */
export const NOTIFICATION_TYPE: Record<AvisoSource, string> = {
  pagamento: "deadline_payment",
  tarefa: "deadline_task",
  lead: "deadline_lead",
  visita: "deadline_visit",
};

/**
 * A chave determinística que impede o mesmo aviso de sair duas vezes no mesmo
 * dia: `{hoje}:{fonte}:{item}`.
 *
 * 🔴 O primeiro campo é o DIA DA EXECUÇÃO, não a data do item.
 *
 *    É uma diferença fácil de trocar e com consequência grave. Um pagamento
 *    vencido a 10/09 que continue por pagar tem `date = "2026-09-10"` todos os
 *    dias — se fosse essa a chave, seria avisado uma vez e nunca mais, que é o
 *    contrário do que um lembrete de dívida deve fazer. Com `today`, a chave
 *    muda à meia-noite e o aviso volta enquanto a dívida existir.
 *
 *    E no mesmo dia a chave é estável, que é o que corta o duplicado quando o
 *    cron corre outra vez — por retry ou por engano.
 */
export function dedupeKey(today: string, source: AvisoSource, itemId: string): string {
  return `${today}:${source}:${itemId}`;
}

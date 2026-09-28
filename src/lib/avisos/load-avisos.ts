import type { createAdminClient } from "@/lib/supabase/admin";
import { CLOSED_STAGES } from "@/lib/crm/stages";
import { VISIT_OPEN_STATUS } from "@/lib/crm/visits";
import {
  addDaysToDateString,
  inicioDoDiaEmLisboa,
  lisbonDateOf,
} from "@/lib/lisbon-time";
import { avisoKey, classificar, ordenarAvisos } from "@/domain/avisos/classify";
import type { AvisoItem } from "@/domain/avisos/types";

type AdminClient = ReturnType<typeof createAdminClient>;

// ============================================================================
// O LOADER — uma fonte, duas superfícies
// ============================================================================
//
// Server-side: recebe o cliente administrativo por argumento e nunca o cria.
// É o que o mantém ensaiável sem rede e o que impede este módulo de ir parar
// ao bundle do browser — não há aqui nenhuma chave nem nenhum `process.env`.
// (O projecto não usa o pacote `server-only`; nem `supabase/admin.ts` o usa.)
//
// 🔴 Este ficheiro existe para que o modal e o cron não possam divergir.
//
//    A alternativa era escrever as quatro consultas na Server Action e outra
//    vez na rota do cron. Começariam iguais e deixariam de o ser à primeira
//    correcção que alguém fizesse só num dos lados — e o sintoma seria o pior
//    possível: o ecrã a dizer que há três coisas por fazer e o sino a avisar de
//    duas, sem ninguém saber qual está certo.
//
//    Aqui vivem as consultas, a normalização, a classificação, os links e a
//    ordem. Quem chama recebe uma lista pronta e não decide nada.
//
// 🔴 O recorte temporal é feito na BASE, não em JavaScript.
//
//    Cortar na consulta evita trazer o histórico todo para filtrar no processo
//    — o que funcionaria hoje, com poucos registos, e passaria a ser um
//    problema calado quando deixasse de ser verdade.
// ============================================================================

/** Uma fonte falhou. Ver `carregarAvisos` para o que se faz com isto. */
export class AvisosSourceError extends Error {
  constructor(public readonly source: string, mensagem: string) {
    super(`[avisos] fonte "${source}" falhou: ${mensagem}`);
    this.name = "AvisosSourceError";
  }
}

interface Ctx {
  admin: AdminClient;
  companyId: string;
  today: string;
  tomorrow: string;
}

// ── Pagamentos ──────────────────────────────────────────────────────────────
//
// 🔴 O aviso nasce do `due_date`, NÃO da competência.
//
//    São duas perguntas diferentes e o produto já as separa: a competência diz
//    a que mês a despesa pertence (e pode ser Outubro), o vencimento diz quando
//    tem de ser paga (e pode ser amanhã). Avisar pela competência mandaria
//    lembretes sobre o mês, não sobre a dívida.
async function pagamentos(ctx: Ctx): Promise<AvisoItem[]> {
  const { data, error } = await ctx.admin
    .from("fixed_variable_payments")
    .select("id, description, due_date, amount")
    .eq("company_id", ctx.companyId)
    .eq("status", "pendente")
    .not("due_date", "is", null)
    .lte("due_date", ctx.tomorrow);

  if (error) throw new AvisosSourceError("pagamentos", error.message);

  return normalizar(data ?? [], ctx, (row) => {
    const valor = typeof row.amount === "number"
      ? ` · ${row.amount.toFixed(2).replace(".", ",")} €`
      : "";
    return {
      source: "pagamento" as const,
      itemId: String(row.id),
      date: String(row.due_date),
      title: String(row.description ?? "Pagamento"),
      detail: `Vencimento${valor}`,
      href: "/dashboard/financeiro/pagamentos",
    };
  });
}

// ── Tarefas ─────────────────────────────────────────────────────────────────
//
// 🔴 Por concluir é `completed_at IS NULL`, e NÃO `status <> concluido`.
//
//    O estado das tarefas é livre porque o quadro aceita colunas
//    personalizadas: uma empresa pode ter «Em revisão», «Bloqueado», «A
//    aguardar cliente». Qualquer lista fixa de nomes deixaria de fora as
//    colunas que ainda não existem — e o defeito só apareceria na empresa que
//    inventasse a coluna seguinte, muito depois de isto ser escrito.
//
//    `completed_at` é o único contrato estável: ou a tarefa foi dada por
//    concluída e tem instante, ou não tem.
async function tarefas(ctx: Ctx): Promise<AvisoItem[]> {
  const { data, error } = await ctx.admin
    .from("management_tasks")
    .select("id, title, due_date")
    .eq("company_id", ctx.companyId)
    .is("completed_at", null)
    .not("due_date", "is", null)
    .lte("due_date", ctx.tomorrow);

  if (error) throw new AvisosSourceError("tarefas", error.message);

  return normalizar(data ?? [], ctx, (row) => ({
    source: "tarefa" as const,
    itemId: String(row.id),
    date: String(row.due_date),
    title: String(row.title ?? "Tarefa"),
    detail: "Prazo da tarefa",
    href: "/dashboard/tarefas",
  }));
}

// ── Leads ───────────────────────────────────────────────────────────────────
//
// 🔴 `next_action_at` é uma DATA civil, apesar de o sufixo sugerir instante
//    (101_crm_leads.sql: `next_action_at date`). Entra no domínio sem qualquer
//    conversão de fuso — e é preciso que assim seja: tratá-la como timestamp
//    introduziria o desvio de um dia que o resto deste ficheiro evita.
async function leads(ctx: Ctx): Promise<AvisoItem[]> {
  const { data, error } = await ctx.admin
    .from("crm_leads")
    .select("id, name, next_action_at, next_action_note")
    .eq("company_id", ctx.companyId)
    .not("next_action_at", "is", null)
    .lte("next_action_at", ctx.tomorrow)
    .not("stage", "in", `(${CLOSED_STAGES.join(",")})`);

  if (error) throw new AvisosSourceError("leads", error.message);

  return normalizar(data ?? [], ctx, (row) => ({
    source: "lead" as const,
    itemId: String(row.id),
    date: String(row.next_action_at),
    title: String(row.name ?? "Lead"),
    detail: String(row.next_action_note ?? "").trim() || "Próxima acção comercial",
    href: `/dashboard/crm/${String(row.id)}`,
  }));
}

// ── Visitas ─────────────────────────────────────────────────────────────────
//
// 🔴 Aqui `scheduled_start` é `timestamptz`, e é a única das quatro fontes que
//    obriga a pensar em fuso.
//
//    Cortar a string nos primeiros dez caracteres lê a data em UTC. Uma visita
//    às 00h30 de dia 8 em Lisboa é, no verão, `2026-07-07T23:30:00Z` — o atalho
//    diria «dia 7», e o aviso de hoje falaria de ontem. A janela é construída
//    com os instantes de início de dia EM LISBOA, e a data que vai para o
//    domínio é convertida com `lisbonDateOf`.
//
// 🔴 Nesta versão as visitas são HOJE + AMANHÃ, sem atrasadas.
//
//    Uma visita passada que continua agendada não é necessariamente dívida:
//    pode ser apenas um registo que ninguém fechou. Os outros três são estados
//    inequívocos — uma conta por pagar, uma tarefa por concluir, uma acção por
//    fazer. Trazer visitas velhas para «Atrasados» encheria o aviso de ruído
//    administrativo e ensinaria a ignorá-lo, que é como um aviso morre.
async function visitas(ctx: Ctx): Promise<AvisoItem[]> {
  const depoisDeAmanha = addDaysToDateString(ctx.tomorrow, 1);

  const { data, error } = await ctx.admin
    .from("crm_visits")
    .select("id, scheduled_start, address")
    .eq("company_id", ctx.companyId)
    .eq("status", VISIT_OPEN_STATUS)
    .gte("scheduled_start", inicioDoDiaEmLisboa(ctx.today))
    .lt("scheduled_start", inicioDoDiaEmLisboa(depoisDeAmanha));

  if (error) throw new AvisosSourceError("visitas", error.message);

  return normalizar(data ?? [], ctx, (row) => ({
    source: "visita" as const,
    itemId: String(row.id),
    date: lisbonDateOf(String(row.scheduled_start)),
    title: String(row.address ?? "").trim() || "Visita comercial",
    detail: "Visita agendada",
    href: "/dashboard/crm/visitas",
  }));
}

/**
 * Aplica a classificação e descarta o que cai fora da janela.
 *
 * 🔴 A consulta recorta e o domínio volta a decidir. Não é redundância inútil:
 *    a consulta responde «o que vale a pena trazer», o domínio responde «a que
 *    grupo pertence». A segunda passagem é o que impede uma linha limite —
 *    trazida por uma comparação de base de dados ligeiramente diferente da
 *    nossa — de aparecer sem grupo.
 */
function normalizar<T>(
  linhas: T[],
  ctx: Ctx,
  mapear: (row: T) => Omit<AvisoItem, "key" | "urgencia">,
): AvisoItem[] {
  const itens: AvisoItem[] = [];
  for (const linha of linhas) {
    const base = mapear(linha);
    const urgencia = classificar(base.date, ctx.today, ctx.tomorrow);
    if (!urgencia) continue;
    itens.push({ ...base, urgencia, key: avisoKey(base.source, base.itemId) });
  }
  return itens;
}

/**
 * Os avisos de uma empresa para um dia.
 *
 * 🔴 LANÇA se qualquer fonte falhar, e isso é deliberado.
 *
 *    Devolver três fontes como se a quarta estivesse vazia seria afirmar «não
 *    há visitas amanhã» quando o que se sabe é «não consegui perguntar». Num
 *    aviso sobre prazos, essa diferença é a diferença entre estar em dia e
 *    julgar que se está.
 *
 *    Quem chama decide o que fazer com a falha: a Server Action engole e
 *    devolve lista vazia (o dashboard não pode cair por causa de lembretes), o
 *    cron conta como erro e devolve resposta não-success.
 */
export async function carregarAvisos(
  admin: AdminClient,
  companyId: string,
  today: string,
): Promise<AvisoItem[]> {
  const ctx: Ctx = { admin, companyId, today, tomorrow: addDaysToDateString(today, 1) };

  const [p, t, l, v] = await Promise.all([
    pagamentos(ctx),
    tarefas(ctx),
    leads(ctx),
    visitas(ctx),
  ]);

  return ordenarAvisos([...p, ...t, ...l, ...v]);
}

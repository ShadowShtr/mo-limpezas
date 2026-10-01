import type { createAdminClient } from "@/lib/supabase/admin";
import { CLOSED_STAGES } from "@/lib/crm/stages";
import { VISIT_OPEN_STATUS } from "@/lib/crm/visits";
import {
  addDaysToDateString,
  inicioDoDiaEmLisboa,
  lisbonDateOf,
} from "@/lib/lisbon-time";
import { avisoKey, classificar, ordenarAvisos } from "@/domain/avisos/classify";
import {
  JANELA_SINO,
  type AvisoItem,
  type AvisoSource,
  type JanelaAvisos,
} from "@/domain/avisos/types";

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
  /** Primeiro dia que ainda conta como atrasado. `null` = sem limite (sino). */
  desde: string | null;
  /** Último dia do futuro que entra (inclusivo). Amanhã no sino, +15 no quadro. */
  ate: string;
}

/**
 * Aplica a janela a uma consulta, pela coluna de data da fonte.
 *
 * O recorte é feito na BASE — ver o comentário de topo — e é o mesmo em todas
 * as fontes para nenhuma ter uma ideia própria de «até quando».
 */
function janela<Q extends { lte(c: string, v: string): Q; gte(c: string, v: string): Q }>(
  q: Q,
  coluna: string,
  ctx: Ctx,
): Q {
  const comFim = q.lte(coluna, ctx.ate);
  return ctx.desde ? comFim.gte(coluna, ctx.desde) : comFim;
}

const euros = (v: unknown): string =>
  typeof v === "number" ? ` · ${v.toFixed(2).replace(".", ",")} €` : "";

/**
 * Nomes por id, para o título do aviso. Uma consulta por fonte, não uma por
 * linha. Se falhar, a fonte inteira falha — um aviso sem saber de quem é não
 * serve, e mostrá-lo com «?» esconderia o erro.
 */
async function nomesPorId(
  ctx: Ctx,
  fonte: AvisoSource,
  tabela: "clients" | "profiles",
  coluna: "name" | "full_name",
  ids: string[],
): Promise<Map<string, string>> {
  const mapa = new Map<string, string>();
  const unicos = [...new Set(ids.filter(Boolean))];
  if (unicos.length === 0) return mapa;
  const { data, error } = await ctx.admin
    .from(tabela)
    .select(`id, ${coluna}`)
    .eq("company_id", ctx.companyId)
    .in("id", unicos);
  if (error) throw new AvisosSourceError(fonte, error.message);
  for (const linha of (data ?? []) as unknown as Record<string, unknown>[]) {
    mapa.set(String(linha.id), String(linha[coluna] ?? "").trim());
  }
  return mapa;
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
  const { data, error } = await janela(
    ctx.admin
      .from("fixed_variable_payments")
      .select("id, description, due_date, amount")
      .eq("company_id", ctx.companyId)
      .eq("status", "pendente")
      .not("due_date", "is", null),
    "due_date",
    ctx,
  );

  if (error) throw new AvisosSourceError("pagamentos", error.message);

  return normalizar(data ?? [], ctx, (row) => ({
    source: "pagamento" as const,
    itemId: String(row.id),
    date: String(row.due_date),
    title: String(row.description ?? "Pagamento"),
    detail: `Vencimento${euros(row.amount)}`,
    href: "/dashboard/financeiro/pagamentos",
  }));
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
  const { data, error } = await janela(
    ctx.admin
      .from("management_tasks")
      .select("id, title, due_date")
      .eq("company_id", ctx.companyId)
      .is("completed_at", null)
      .not("due_date", "is", null),
    "due_date",
    ctx,
  );

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
  const { data, error } = await janela(
    ctx.admin
      .from("crm_leads")
      .select("id, name, next_action_at, next_action_note")
      .eq("company_id", ctx.companyId)
      .not("next_action_at", "is", null)
      .not("stage", "in", `(${CLOSED_STAGES.join(",")})`),
    "next_action_at",
    ctx,
  );

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
// 🔴 As visitas começam HOJE, sem atrasadas — no sino até amanhã, no quadro
//    até ao fim da janela.
//
//    Uma visita passada que continua agendada não é necessariamente dívida:
//    pode ser apenas um registo que ninguém fechou. Os outros três são estados
//    inequívocos — uma conta por pagar, uma tarefa por concluir, uma acção por
//    fazer. Trazer visitas velhas para «Atrasados» encheria o aviso de ruído
//    administrativo e ensinaria a ignorá-lo, que é como um aviso morre.
async function visitas(ctx: Ctx): Promise<AvisoItem[]> {
  const diaSeguinteAoFim = addDaysToDateString(ctx.ate, 1);

  const { data, error } = await ctx.admin
    .from("crm_visits")
    .select("id, scheduled_start, address")
    .eq("company_id", ctx.companyId)
    .eq("status", VISIT_OPEN_STATUS)
    .gte("scheduled_start", inicioDoDiaEmLisboa(ctx.today))
    .lt("scheduled_start", inicioDoDiaEmLisboa(diaSeguinteAoFim));

  if (error) throw new AvisosSourceError("visitas", error.message);

  return normalizarSemAtrasados(data ?? [], ctx, (row) => ({
    source: "visita" as const,
    itemId: String(row.id),
    date: lisbonDateOf(String(row.scheduled_start)),
    title: String(row.address ?? "").trim() || "Visita comercial",
    detail: "Visita agendada",
    href: "/dashboard/crm/visitas",
  }));
}

// ── Cobranças a receber (2026-10-01, só quadro) ─────────────────────────────
//
// `pendente` e `vencido` são as duas formas de «emitida e por receber» (008).
// O rascunho fica de fora: ainda não foi enviado a ninguém.
async function cobrancas(ctx: Ctx): Promise<AvisoItem[]> {
  const { data, error } = await janela(
    ctx.admin
      .from("invoices")
      .select("id, invoice_number, client_id, due_date, total")
      .eq("company_id", ctx.companyId)
      .in("status", ["pendente", "vencido"])
      .not("due_date", "is", null),
    "due_date",
    ctx,
  );
  if (error) throw new AvisosSourceError("cobranca", error.message);
  const linhas = data ?? [];
  const nomes = await nomesPorId(ctx, "cobranca", "clients", "name", linhas.map((r) => String(r.client_id ?? "")));

  return normalizar(linhas, ctx, (row) => {
    const cliente = nomes.get(String(row.client_id)) || "Cliente";
    return {
      source: "cobranca" as const,
      itemId: String(row.id),
      date: String(row.due_date),
      title: `${cliente}${row.invoice_number ? ` · ${row.invoice_number}` : ""}`,
      detail: `Cobrança a receber${euros(row.total)}`,
      href: "/dashboard/cobrancas",
    };
  });
}

// ── Cobranças avulsas por receber (2026-10-01, só quadro) ───────────────────
//
// Por receber = não anulada e ainda sem `pago_total`. Não têm vencimento: a
// data que existe é a do serviço (`charge_date`), e é por ela que entram.
async function cobrancasAvulsas(ctx: Ctx): Promise<AvisoItem[]> {
  const { data, error } = await janela(
    ctx.admin
      .from("manual_charges")
      .select("id, client_id, description, charge_date, amount, paid_amount, payment_status")
      .eq("company_id", ctx.companyId)
      .is("voided_at", null)
      .in("payment_status", ["nao_informado", "sinal_50"]),
    "charge_date",
    ctx,
  );
  if (error) throw new AvisosSourceError("cobranca_avulsa", error.message);
  const linhas = data ?? [];
  const nomes = await nomesPorId(ctx, "cobranca_avulsa", "clients", "name", linhas.map((r) => String(r.client_id ?? "")));

  return normalizar(linhas, ctx, (row) => {
    const cliente = nomes.get(String(row.client_id)) || "Cliente";
    const falta = typeof row.amount === "number"
      ? row.amount - (typeof row.paid_amount === "number" ? row.paid_amount : 0)
      : null;
    const estado = row.payment_status === "sinal_50" ? "Sinal recebido, falta o resto" : "Por receber";
    return {
      source: "cobranca_avulsa" as const,
      itemId: String(row.id),
      date: String(row.charge_date),
      title: `${cliente}${row.description ? ` · ${String(row.description).trim()}` : ""}`,
      detail: `${estado}${euros(falta)}`,
      href: "/dashboard/cobrancas",
    };
  });
}

// ── Movimentos de caixa por confirmar (2026-10-01, só quadro) ───────────────
//
// 🔴 Só os MANUAIS (`reference_type IS NULL`). Um movimento ligado a um
//    pagamento, a uma cobrança ou à folha já aparece pela sua origem — trazê-lo
//    também daqui seria o mesmo assunto duas vezes.
async function caixa(ctx: Ctx): Promise<AvisoItem[]> {
  const { data, error } = await janela(
    ctx.admin
      .from("cash_flow_entries")
      .select("id, type, amount, description, date")
      .eq("company_id", ctx.companyId)
      .eq("status", "pendente")
      .is("reference_type", null),
    "date",
    ctx,
  );
  if (error) throw new AvisosSourceError("caixa", error.message);

  return normalizar(data ?? [], ctx, (row) => ({
    source: "caixa" as const,
    itemId: String(row.id),
    date: String(row.date),
    title: String(row.description ?? "").trim() || "Movimento manual",
    detail: `${row.type === "entrada" ? "Entrada" : "Saída"} por confirmar${euros(row.amount)}`,
    href: "/dashboard/financeiro/fluxo-caixa",
  }));
}

// ── Férias por aprovar (2026-10-01, só quadro) ──────────────────────────────
//
// Um pedido pendente é uma decisão por tomar. Entra pela data de início:
// é aí que a resposta deixa de poder esperar.
async function ferias(ctx: Ctx): Promise<AvisoItem[]> {
  const { data, error } = await janela(
    ctx.admin
      .from("vacation_requests")
      .select("id, collaborator_id, starts_on, ends_on")
      .eq("company_id", ctx.companyId)
      .eq("status", "pendente"),
    "starts_on",
    ctx,
  );
  if (error) throw new AvisosSourceError("ferias", error.message);
  const linhas = data ?? [];
  const nomes = await nomesPorId(ctx, "ferias", "profiles", "full_name", linhas.map((r) => String(r.collaborator_id ?? "")));
  const dm = (d: unknown) => String(d ?? "").split("-").reverse().slice(0, 2).join("/");

  return normalizar(linhas, ctx, (row) => ({
    source: "ferias" as const,
    itemId: String(row.id),
    date: String(row.starts_on),
    title: nomes.get(String(row.collaborator_id)) || "Colaborador",
    detail: `Férias por aprovar · ${dm(row.starts_on)} a ${dm(row.ends_on)}`,
    href: "/dashboard/faltas",
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
    const urgencia = classificar(base.date, ctx.today, ctx.tomorrow, { desde: ctx.desde, ate: ctx.ate });
    if (!urgencia) continue;
    itens.push({ ...base, urgencia, key: avisoKey(base.source, base.itemId) });
  }
  return itens;
}

/** Como `normalizar`, mas sem atrasados — o caso das visitas. */
function normalizarSemAtrasados<T>(
  linhas: T[],
  ctx: Ctx,
  mapear: (row: T) => Omit<AvisoItem, "key" | "urgencia">,
): AvisoItem[] {
  return normalizar(linhas, ctx, mapear).filter((i) => i.urgencia !== "atrasado");
}

const CARREGADORES: Record<AvisoSource, (ctx: Ctx) => Promise<AvisoItem[]>> = {
  pagamento: pagamentos,
  tarefa: tarefas,
  lead: leads,
  visita: visitas,
  cobranca: cobrancas,
  cobranca_avulsa: cobrancasAvulsas,
  caixa,
  ferias,
};

function contexto(admin: AdminClient, companyId: string, today: string, j: JanelaAvisos): Ctx {
  return {
    admin,
    companyId,
    today,
    tomorrow: addDaysToDateString(today, 1),
    desde: j.diasAtras === null ? null : addDaysToDateString(today, -j.diasAtras),
    ate: addDaysToDateString(today, j.diasFrente),
  };
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
  j: JanelaAvisos = JANELA_SINO,
): Promise<AvisoItem[]> {
  const ctx = contexto(admin, companyId, today, j);
  const listas = await Promise.all(j.fontes.map((f) => CARREGADORES[f](ctx)));
  return ordenarAvisos(listas.flat());
}

/** O resultado do quadro: o que se leu, e o que não se conseguiu ler. */
export interface QuadroAvisos {
  itens: AvisoItem[];
  /** Fontes que falharam. Vazio = a lista é completa. */
  fontesEmFalha: AvisoSource[];
}

/**
 * Para o QUADRO: cada fonte falha sozinha.
 *
 * 🔴 Ao contrário do sino, aqui uma fonte em falha não apaga as outras — com
 *    oito fontes, uma tabela indisponível deixaria o quadro vazio e a dizer
 *    «nada pendente». O que falhou é devolvido pelo nome, para o quadro dizer
 *    «não consegui verificar X» em vez de fingir que X está em dia.
 */
export async function carregarQuadroAvisos(
  admin: AdminClient,
  companyId: string,
  today: string,
  j: JanelaAvisos,
): Promise<QuadroAvisos> {
  const ctx = contexto(admin, companyId, today, j);
  const resultados = await Promise.allSettled(j.fontes.map((f) => CARREGADORES[f](ctx)));
  const itens: AvisoItem[] = [];
  const fontesEmFalha: AvisoSource[] = [];
  resultados.forEach((r, i) => {
    if (r.status === "fulfilled") itens.push(...r.value);
    else {
      fontesEmFalha.push(j.fontes[i]);
      console.error("[avisos] fonte do quadro falhou", j.fontes[i], r.reason);
    }
  });
  return { itens: ordenarAvisos(itens), fontesEmFalha };
}

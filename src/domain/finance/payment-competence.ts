// ============================================================================
// COMPETÊNCIA DE UM PAGAMENTO — a que mês pertence
// ============================================================================
//
// Regra pura, sem Supabase, sem React. Existe porque a competência estava a ser
// decidida pelo **ecrã**, não pelo pagamento.
//
//     period_year:  input.year,     // ← o mês que estava aberto
//     period_month: input.month,    //   quando alguém carregou em "guardar"
//
// Criar um pagamento com vencimento a 03/11/2026 enquanto se via Julho gravava
// competência de Julho. E `updatePayment` alterava o `due_date` sem nunca tocar
// na competência: mudar 15/07 para 15/08 deixava o pagamento em Julho, com uma
// data de Agosto à vista.
//
// A consulta mensal nunca esteve errada — filtra por `period_year`/`period_month`
// com igualdade exata. O que estava errado era o valor que lá foi parar.
//
// Medido em produção a 2026-08-25: **29 de 84** pagamentos com vencimento tinham
// competência diferente do mês do vencimento. Em Julho, isso punha oito linhas
// com vencimento em Agosto e as três ocorrências do seguro trimestral
// (03/11/2026, 03/02/2027, 03/05/2027) todas dentro do mesmo mês.
//
// ---------------------------------------------------------------------------
// A regra
// ---------------------------------------------------------------------------
//
//   com vencimento  →  a competência é o mês do vencimento. Sempre.
//   sem vencimento  →  a competência é o mês em que foi registado, e fica.
//
// A segunda metade é deliberada, não um descuido. Há pagamentos reais sem data
// — IVA, Segurança Social, algumas rendas — e para esses o mês de registo é a
// única informação temporal que existe. O que não pode acontecer é uma linha
// sem competência **e** sem vencimento: aí não haveria mês nenhum a que
// pertencesse, e apareceria ao acaso.
//
// ---------------------------------------------------------------------------
// Porque é que isto não vive dentro da action
// ---------------------------------------------------------------------------
//
// Porque a mesma regra é precisa em três sítios que podem divergir: ao criar,
// ao editar a data, e a decidir o que a vista mensal mostra. Enquanto esteve
// escrita à mão em cada um, dois deles concordavam e o terceiro não.
// ============================================================================

/** Ano e mês a que um pagamento pertence. `month` é 1–12, como na base. */
export interface Competence {
  year: number;
  month: number;
}

/** `YYYY-MM`, a forma que a chave de período usa. */
export function competenceKey(c: Competence): string {
  return `${c.year}-${String(c.month).padStart(2, "0")}`;
}

/**
 * Lê a competência de uma data de vencimento.
 *
 * 🔴 Só aceita `YYYY-MM-DD`, e valida os campos. Uma data malformada devolve
 *    `null` em vez de um mês inventado — este projeto já teve um `starts_on`
 *    com o ano `72026` a rebentar páginas, e um `Number("7202")` silencioso
 *    seria a mesma armadilha noutro sítio.
 *
 *    Não usa `new Date(...)`: interpretar `"2026-08-03"` como instante e depois
 *    ler o mês traz o fuso horário para dentro de uma decisão que é puramente
 *    de calendário. Em Lisboa, no verão, isso desloca o dia 1 para o mês
 *    anterior.
 */
export function competenceFromDueDate(dueDate: string | null | undefined): Competence | null {
  if (typeof dueDate !== "string") return null;

  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(dueDate.trim());
  if (!m) return null;

  const year = Number(m[1]);
  const month = Number(m[2]);
  const day = Number(m[3]);

  if (!Number.isInteger(year) || year < 1900 || year > 2999) return null;
  if (!Number.isInteger(month) || month < 1 || month > 12) return null;
  if (!Number.isInteger(day) || day < 1 || day > 31) return null;

  return { year, month };
}

/**
 * Decide a competência de um pagamento.
 *
 * `fallback` é o mês em que o registo está a ser feito — usado apenas quando
 * não há vencimento de onde derivar. Nunca ganha ao vencimento: era exatamente
 * essa inversão que fazia o mês aberto no ecrã decidir a que mês o pagamento
 * pertencia.
 */
export function resolveCompetence(input: {
  dueDate: string | null | undefined;
  fallback: Competence;
}): Competence {
  return competenceFromDueDate(input.dueDate) ?? input.fallback;
}

/**
 * Um pagamento mudou de mês?
 *
 * Serve para dizer, em texto, o que uma edição de data vai provocar — mover
 * entre meses é uma consequência visível e quem edita deve poder prevê-la.
 */
export function competenceChanged(a: Competence, b: Competence): boolean {
  return a.year !== b.year || a.month !== b.month;
}

/**
 * A competência que uma linha existente deveria ter.
 *
 * Devolve `null` quando já está correta ou quando não há vencimento de onde
 * derivar — ou seja, quando não há nada a corrigir. É o que distingue «esta
 * linha diverge» de «esta linha não tem forma de saber», e nenhuma correção
 * automática deve tocar na segunda.
 */
export function competenceCorrectionFor(row: {
  due_date: string | null | undefined;
  period_year: number;
  period_month: number;
}): Competence | null {
  const derivada = competenceFromDueDate(row.due_date);
  if (!derivada) return null;

  const atual: Competence = { year: row.period_year, month: row.period_month };
  return competenceChanged(derivada, atual) ? derivada : null;
}

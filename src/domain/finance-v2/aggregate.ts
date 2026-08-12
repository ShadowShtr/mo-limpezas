// ============================================================================
// Financeiro V2 — a aritmética, separada da base de dados
// ============================================================================
//
// Funções puras: recebem factos, devolvem a fotografia. Não conhecem Supabase,
// não sabem o que é uma tabela, e não perguntam as horas.
//
// É essa separação que torna isto testável a sério — as fixtures dos testes
// são os mesmos factos que os adaptadores produzem, e uma regra de negócio
// errada aparece num teste em vez de aparecer no ecrã do dono.
// ============================================================================

import {
  medida,
  type BlocoAging,
  type BlocoAlertas,
  type BlocoTopClientes,
  type FaixaAgingDados,
  type FinanceAlert,
  type FinanceKpis,
  type FinanceReadContext,
  type Medida,
} from "./types";

// ─── Factos ──────────────────────────────────────────────────────────────────

export interface FactoFatura {
  id: string;
  status: string;
  total: number;
  dueDate: string | null;
  paidAt: string | null;
  periodStart: string | null;
  clientId: string | null;
  clientName: string | null;
}

export interface FactoCaixa {
  date: string;
  tipo: "entrada" | "saida";
  status: string;
  amount: number;
  categoria: string | null;
}

export interface FactoFolha {
  grossSalary: number;
  netSalary: number;
  workedHours: number;
  status: string;
}

/** Um bloco de factos, ou a razão por que não há factos. */
export type Fonte<T> =
  | { ok: true; factos: T[] }
  | { ok: false; erro: string };

// ─── Regras do domínio ───────────────────────────────────────────────────────

/**
 * Que estados de fatura contam como **faturado**.
 *
 * 🔴 `rascunho` não conta. Um rascunho é um documento que ainda não foi
 * emitido: transformá-lo em receita seria contar dinheiro que o cliente nunca
 * viu pedido. Hoje isso faz a diferença entre 0 € e ~3 300 € — e a resposta
 * certa é 0 €, porque ninguém foi faturado.
 */
export const ESTADOS_FATURADO = ["emitida", "enviada", "paga", "vencida", "parcial"] as const;

/** Que estados contam como **recebido**. */
export const ESTADOS_PAGA = ["paga"] as const;

/**
 * Categorias de saída de caixa que representam salários.
 *
 * 🔴 Existem para o `SALARY_DOUBLE_COUNT`: se a folha já se transformou num
 * movimento de caixa, somar as duas contaria o mesmo salário duas vezes. O
 * caixa é a fonte autoritativa — é dinheiro que saiu — e a folha só entra
 * pelo que ainda não passou por lá.
 */
export const CATEGORIAS_SALARIO = ["salario", "salário", "payroll"];

function soma(ns: number[]): number {
  return Math.round(ns.reduce((a, b) => a + b, 0) * 100) / 100;
}

function dentroDoPeriodo(data: string | null, ctx: FinanceReadContext): boolean {
  if (!data) return false;
  const d = data.slice(0, 10);
  return d >= ctx.periodStart && d <= ctx.periodEnd;
}

// ─── KPIs ────────────────────────────────────────────────────────────────────

export function calcularKpis(
  faturas: Fonte<FactoFatura>,
  caixa: Fonte<FactoCaixa>,
  folha: Fonte<FactoFolha>,
  ctx: FinanceReadContext,
): FinanceKpis {
  // ── Faturado ──────────────────────────────────────────────────────────────
  let faturado: Medida;
  if (!faturas.ok) {
    faturado = medida.erro(faturas.erro);
  } else {
    const emitidas = faturas.factos.filter(
      (f) => (ESTADOS_FATURADO as readonly string[]).includes(f.status) && dentroDoPeriodo(f.periodStart ?? f.dueDate, ctx),
    );
    // Zero real: carregou, e não há faturas emitidas. Isto é `0,00 €`, não
    // «Indisponível» — a diferença é entre "não faturámos" e "não sabemos".
    faturado = medida.disponivel(soma(emitidas.map((f) => f.total)));
  }

  // ── Recebido ──────────────────────────────────────────────────────────────
  //
  // Fonte autoritativa: o **caixa**. As faturas também têm `paid_at`, e somar
  // as duas contaria o mesmo recebimento duas vezes. Escolhe-se uma.
  let recebido: Medida;
  if (!caixa.ok) {
    recebido = medida.erro(caixa.erro);
  } else {
    const entradas = caixa.factos.filter(
      (c) => c.tipo === "entrada" && c.status === "confirmado" && dentroDoPeriodo(c.date, ctx),
    );
    recebido = medida.disponivel(soma(entradas.map((c) => c.amount)));
  }

  // ── Custos ────────────────────────────────────────────────────────────────
  let custos: Medida;
  if (!caixa.ok) {
    custos = medida.erro(caixa.erro);
  } else {
    const saidas = caixa.factos.filter(
      (c) => c.tipo === "saida" && c.status === "confirmado" && dentroDoPeriodo(c.date, ctx),
    );
    const saidasTotal = soma(saidas.map((c) => c.amount));

    // 🔴 SALARY_DOUBLE_COUNT
    //
    // Se já saiu do caixa uma verba de salário, a folha desse período já está
    // contada. Só se acrescenta a folha quando o caixa **não** tem nenhuma
    // saída de salário — caso contrário, o mesmo ordenado entrava duas vezes.
    const caixaTemSalario = saidas.some(
      (c) => c.categoria != null && CATEGORIAS_SALARIO.includes(c.categoria.toLowerCase()),
    );

    if (!folha.ok) {
      custos = medida.parcial(saidasTotal, "Folha indisponível — inclui apenas movimentos de caixa.");
    } else if (caixaTemSalario) {
      custos = medida.disponivel(saidasTotal, "Salários contados pelo caixa, para não duplicar com a folha.");
    } else {
      custos = medida.disponivel(soma([saidasTotal, ...folha.factos.map((f) => f.grossSalary)]));
    }
  }

  // ── Em aberto ─────────────────────────────────────────────────────────────
  //
  // Faturado por receber. Deriva de faturas, não de `faturado − recebido`: o
  // caixa inclui entradas que não vêm de faturas, e a subtracção daria um
  // número que não é dívida de ninguém.
  let emAberto: Medida;
  if (!faturas.ok) {
    emAberto = medida.erro(faturas.erro);
  } else {
    const porReceber = faturas.factos.filter(
      (f) =>
        (ESTADOS_FATURADO as readonly string[]).includes(f.status) &&
        !(ESTADOS_PAGA as readonly string[]).includes(f.status) &&
        f.paidAt == null,
    );
    emAberto = medida.disponivel(soma(porReceber.map((f) => f.total)));
  }

  // ── Margem ────────────────────────────────────────────────────────────────
  let margem: Medida;
  let margemPct: Medida;
  if (faturado.valor === null || custos.valor === null) {
    const razao = faturado.valor === null ? "Faturação indisponível." : "Custos indisponíveis.";
    margem = medida.indisponivel(razao);
    margemPct = medida.indisponivel(razao);
  } else {
    const m = Math.round((faturado.valor - custos.valor) * 100) / 100;
    margem = medida.disponivel(m);
    // Sem faturação não há rácio — e não há Infinity nem NaN a chegar ao ecrã.
    margemPct =
      faturado.valor > 0
        ? medida.disponivel(Math.round((m / faturado.valor) * 1000) / 10)
        : medida.indisponivel("Sem faturação no período.");
  }

  return { faturado, recebido, emAberto, custos, margem, margemPct };
}

// ─── Alertas ─────────────────────────────────────────────────────────────────

export function calcularAlertas(
  faturas: Fonte<FactoFatura>,
  porFaturar: Fonte<{ value: number }>,
  ctx: FinanceReadContext,
): BlocoAlertas {
  if (!faturas.ok) {
    return { estado: "ERROR", alertas: [], nota: faturas.erro };
  }

  const abertas = faturas.factos.filter(
    (f) =>
      (ESTADOS_FATURADO as readonly string[]).includes(f.status) &&
      !(ESTADOS_PAGA as readonly string[]).includes(f.status) &&
      f.paidAt == null &&
      f.dueDate != null,
  );

  const alertas: FinanceAlert[] = [];

  const vencidas = abertas.filter((f) => f.dueDate! < ctx.todayLisbon);
  if (vencidas.length > 0) {
    alertas.push({
      tipo: "VENCIDO",
      count: vencidas.length,
      amount: soma(vencidas.map((f) => f.total)),
      oldestDueDate: vencidas.map((f) => f.dueDate!).sort()[0],
    });
  }

  const limite = somarDias(ctx.todayLisbon, 7);
  const aVencer = abertas.filter((f) => f.dueDate! >= ctx.todayLisbon && f.dueDate! <= limite);
  if (aVencer.length > 0) {
    alertas.push({ tipo: "VENCE_7_DIAS", count: aVencer.length, amount: soma(aVencer.map((f) => f.total)) });
  }

  if (porFaturar.ok && porFaturar.factos.length > 0) {
    alertas.push({
      tipo: "POR_FATURAR",
      count: porFaturar.factos.length,
      amount: soma(porFaturar.factos.map((s) => s.value)),
    });
  }

  // Sem alertas **e** com as fontes carregadas é uma afirmação: está tudo em
  // ordem. Se uma fonte tivesse falhado, isto seria ERROR — nunca verde.
  const estado = porFaturar.ok ? "AVAILABLE" : "PARTIAL";
  return {
    estado,
    alertas,
    nota: porFaturar.ok ? undefined : "Serviços por faturar indisponíveis.",
  };
}

/** Soma dias a uma data `YYYY-MM-DD` por aritmética UTC, sem depender do fuso. */
export function somarDias(iso: string, dias: number): string {
  const [y, m, d] = iso.split("-").map(Number);
  const t = Date.UTC(y, m - 1, d) + dias * 86400000;
  return new Date(t).toISOString().slice(0, 10);
}

/** Dias inteiros entre duas datas `YYYY-MM-DD`. */
export function diasEntre(de: string, ate: string): number {
  const [y1, m1, d1] = de.split("-").map(Number);
  const [y2, m2, d2] = ate.split("-").map(Number);
  return Math.round((Date.UTC(y2, m2 - 1, d2) - Date.UTC(y1, m1 - 1, d1)) / 86400000);
}

// ─── Aging ───────────────────────────────────────────────────────────────────

/**
 * Reparte o vencido por idade.
 *
 * Serve para distinguir dívida de ontem de dívida de há três meses — «€ 3.420
 * vencido» não diz qual, e a acção é completamente diferente nos dois casos.
 *
 * Cada fatura entra em **exactamente um** balde; os testes provam que a soma
 * dos baldes é igual ao total vencido.
 */
export function calcularAging(faturas: Fonte<FactoFatura>, ctx: FinanceReadContext): BlocoAging {
  if (!faturas.ok) return { estado: "ERROR", faixas: [], nota: faturas.erro };

  const vencidas = faturas.factos.filter(
    (f) =>
      (ESTADOS_FATURADO as readonly string[]).includes(f.status) &&
      !(ESTADOS_PAGA as readonly string[]).includes(f.status) &&
      f.paidAt == null &&
      f.dueDate != null &&
      f.dueDate < ctx.todayLisbon,
  );

  const baldes: FaixaAgingDados[] = [
    { faixa: "1-7", count: 0, amount: 0 },
    { faixa: "8-15", count: 0, amount: 0 },
    { faixa: "16-30", count: 0, amount: 0 },
    { faixa: "30+", count: 0, amount: 0 },
  ];

  for (const f of vencidas) {
    const idade = diasEntre(f.dueDate!, ctx.todayLisbon);
    const i = idade <= 7 ? 0 : idade <= 15 ? 1 : idade <= 30 ? 2 : 3;
    baldes[i].count += 1;
    baldes[i].amount = Math.round((baldes[i].amount + f.total) * 100) / 100;
  }

  return { estado: "AVAILABLE", faixas: baldes };
}

// ─── Top clientes ────────────────────────────────────────────────────────────

/**
 * Ranking por faturado, calculado **aqui** e não na interface.
 *
 * O desempate é pelo nome, para o ranking ser determinístico: sem isso, dois
 * clientes com o mesmo valor trocariam de lugar entre carregamentos.
 */
export function calcularTopClientes(
  faturas: Fonte<FactoFatura>,
  ctx: FinanceReadContext,
  limite = 5,
): BlocoTopClientes {
  if (!faturas.ok) return { estado: "ERROR", metrica: "invoiced", clientes: [], nota: faturas.erro };

  const porCliente = new Map<string, { nome: string; total: number }>();
  for (const f of faturas.factos) {
    if (!(ESTADOS_FATURADO as readonly string[]).includes(f.status)) continue;
    if (!dentroDoPeriodo(f.periodStart ?? f.dueDate, ctx)) continue;
    if (!f.clientId) continue;
    const atual = porCliente.get(f.clientId) ?? { nome: f.clientName ?? "—", total: 0 };
    atual.total = Math.round((atual.total + f.total) * 100) / 100;
    porCliente.set(f.clientId, atual);
  }

  const total = soma([...porCliente.values()].map((c) => c.total));
  const ordenados = [...porCliente.entries()]
    .sort((a, z) => z[1].total - a[1].total || a[1].nome.localeCompare(z[1].nome, "pt"))
    .slice(0, limite);

  return {
    estado: "AVAILABLE",
    metrica: "invoiced",
    clientes: ordenados.map(([id, c], i) => ({
      rank: i + 1,
      clientId: id,
      clientName: c.nome,
      value: c.total,
      share: total > 0 ? Math.round((c.total / total) * 1000) / 1000 : 0,
    })),
  };
}

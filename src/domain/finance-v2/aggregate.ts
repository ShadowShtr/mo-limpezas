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
  type EstadoFonte,
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
  //
  // 🔴 **Do período**, como os outros KPIs. Somava a carteira inteira, de
  //    todos os meses, e não mudava ao trocar de mês — o cartão dizia o mesmo
  //    em Julho e em Agosto, ao lado de um seletor que sugeria o contrário.
  //
  //    A carteira global continua a ter quem a mostre: é o `aging`, e lá é
  //    uma decisão assumida.
  let emAberto: Medida;
  if (!faturas.ok) {
    emAberto = medida.erro(faturas.erro);
  } else {
    const porReceber = faturas.factos.filter(
      (f) =>
        (ESTADOS_FATURADO as readonly string[]).includes(f.status) &&
        !(ESTADOS_PAGA as readonly string[]).includes(f.status) &&
        f.paidAt == null &&
        dentroDoPeriodo(f.periodStart ?? f.dueDate, ctx),
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
 * 🔴 **Global por decisão, não por esquecimento.** Ao contrário dos KPIs, não
 *    filtra pelo período: responde a «que dívida antiga existe hoje», e não a
 *    «que dívida nasceu em Agosto». Filtrá-lo pelo mês esvaziaria os baldes de
 *    +30 dias precisamente quando são mais úteis — uma fatura vencida há 45
 *    dias não pertence ao mês que se está a ver, e é a que mais importa.
 *
 *    É a carteira vencida inteira, e há um teste que fixa esta escolha.
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

// ─── Despesas por categoria ──────────────────────────────────────────────────

export interface FatiaCategoria {
  categoria: string;
  /** `null` quando a despesa não tem categoria — nunca inventada. */
  chave: string | null;
  valor: number;
  share: number;
}

export interface BlocoCategorias {
  estado: "AVAILABLE" | "ERROR";
  fatias: FatiaCategoria[];
  total: number;
  semCategoria: number;
  nota?: string;
}

/**
 * Reparte as saídas de caixa do período pelas suas categorias.
 *
 * 🔴 **Não se adivinha categoria.** Uma despesa sem categoria vai para o grupo
 * «Sem categoria» e conta na mesma para o total. Inferir «Galp» → combustível
 * por texto seria fabricar informação contabilística a partir de uma descrição
 * escrita à pressa, e ninguém depois saberia distinguir o que foi classificado
 * do que foi adivinhado.
 *
 * O total das fatias é sempre igual ao total das despesas — os testes provam-no,
 * porque um donut cujas fatias não somam o todo mente sobre proporções.
 */
export function calcularDespesasPorCategoria(
  caixa: Fonte<FactoCaixa>,
  ctx: FinanceReadContext,
  topN = 5,
): BlocoCategorias {
  if (!caixa.ok) return { estado: "ERROR", fatias: [], total: 0, semCategoria: 0, nota: caixa.erro };

  const saidas = caixa.factos.filter(
    (c) => c.tipo === "saida" && c.status === "confirmado" && dentroDoPeriodo(c.date, ctx),
  );

  const porCat = new Map<string | null, number>();
  for (const s of saidas) {
    const k = s.categoria && s.categoria.trim() !== "" ? s.categoria.trim().toLowerCase() : null;
    porCat.set(k, Math.round(((porCat.get(k) ?? 0) + s.amount) * 100) / 100);
  }

  const total = soma([...porCat.values()]);
  const semCategoria = porCat.get(null) ?? 0;

  const ordenadas = [...porCat.entries()]
    .filter(([k]) => k !== null)
    .sort((a, z) => z[1] - a[1] || String(a[0]).localeCompare(String(z[0]), "pt"));

  const principais = ordenadas.slice(0, topN);
  const resto = soma(ordenadas.slice(topN).map(([, v]) => v));

  const fatias: FatiaCategoria[] = principais.map(([k, v]) => ({
    categoria: rotularCategoria(k as string),
    chave: k as string,
    valor: v,
    share: total > 0 ? Math.round((v / total) * 1000) / 1000 : 0,
  }));

  // «Outros» só existe se houver mesmo mais categorias por baixo do corte.
  if (resto > 0) {
    fatias.push({
      categoria: "Outros",
      chave: "__outros__",
      valor: resto,
      share: total > 0 ? Math.round((resto / total) * 1000) / 1000 : 0,
    });
  }
  if (semCategoria > 0) {
    fatias.push({
      categoria: "Sem categoria",
      chave: null,
      valor: semCategoria,
      share: total > 0 ? Math.round((semCategoria / total) * 1000) / 1000 : 0,
    });
  }

  return { estado: "AVAILABLE", fatias, total, semCategoria };
}

/** Rótulos legíveis para as categorias que a base já usa. */
const ROTULOS: Record<string, string> = {
  salario: "Salários",
  salarios: "Salários",
  combustivel: "Combustível",
  fornecedor: "Fornecedores",
  despesa: "Despesas gerais",
  material: "Materiais",
  materiais: "Materiais",
  manutencao: "Manutenção",
  avaria: "Manutenção",
  viatura: "Viaturas",
  equipamento: "Equipamentos",
  comunicacoes: "Comunicações",
  seguro: "Seguros",
  seguros: "Seguros",
  instalacoes: "Instalações",
  contabilidade: "Contabilidade",
  impostos: "Impostos e taxas",
  alimentacao: "Alimentação",
  subcontratacao: "Subcontratação",
  outro: "Outros",
  outros: "Outros",
};

export function rotularCategoria(chave: string): string {
  return ROTULOS[chave] ?? chave.charAt(0).toUpperCase() + chave.slice(1);
}

/**
 * Cor por categoria, estável.
 *
 * 🔴 Determinística de propósito. Uma cor aleatória por render faria a mesma
 * categoria mudar de cor entre carregamentos, e o donut deixaria de se poder
 * comparar de um mês para o outro.
 */
const CORES_CATEGORIA: Record<string, string> = {
  salario: "#6558F5", salarios: "#6558F5",
  combustivel: "#FF7A1A",
  material: "#16A35A", materiais: "#16A35A",
  manutencao: "#6378D9", avaria: "#6378D9",
  viatura: "#F04438",
  equipamento: "#8B5CF6",
  comunicacoes: "#06B6D4",
  seguro: "#F59E0B", seguros: "#F59E0B",
  fornecedor: "#6378D9",
  despesa: "#06B6D4",
  outro: "#94A3B8", outros: "#94A3B8",
  __outros__: "#94A3B8",
};

export function corDaCategoria(chave: string | null): string {
  if (chave === null) return "#CBD5E1";
  return CORES_CATEGORIA[chave] ?? "#8B5CF6";
}

// ─── Prédios ─────────────────────────────────────────────────────────────────

export interface FactoPredio {
  id: string;
  name: string;
  address: string | null;
  weekday: string | null;
  sortOrder: number;
  monthlyValue: number | null;
}

export interface LinhaPredio {
  id: string;
  nome: string;
  morada: string | null;
  /** `null` = valor desconhecido. **Nunca** convertido em zero. */
  valor: number | null;
  /** Este prédio aparece noutras linhas, noutros dias. */
  repetido: boolean;
}

export interface BlocoPredios {
  estado: EstadoFonte;
  linhas: LinhaPredio[];
  /** Soma **apenas dos valores conhecidos**. `null` quando nenhum é conhecido. */
  totalConhecido: number | null;
  contagem: number;
  comValor: number;
  semValor: number;
  /** Nomes que aparecem em mais do que uma linha — ver a nota abaixo. */
  repetidos: number;
  nota?: string;
}

/**
 * Os prédios e o seu valor mensal.
 *
 * ---------------------------------------------------------------------------
 * 🔴 Porque é que o total pode não existir
 * ---------------------------------------------------------------------------
 * `monthly_value` é nullable, e na base actual **os 146 prédios têm todos
 * valor nulo** — os valores de avença ficaram por preencher de propósito na
 * importação, porque a folha de origem não deu para casar com confiança.
 *
 * Somar nulos como zero daria «0,00 €», que se lê como «estes prédios não
 * rendem nada». O que se sabe é o contrário: não se sabe quanto rendem. Por
 * isso o total é `null` enquanto nenhum valor for conhecido, e passa a somar
 * só os conhecidos assim que existirem.
 *
 * ---------------------------------------------------------------------------
 * 🔴 Os duplicados entre dias
 * ---------------------------------------------------------------------------
 * Quatro prédios aparecem em duas linhas, em dias diferentes — o importador
 * preservou-os deliberadamente, porque são duas **visitas** ao mesmo sítio.
 *
 * Se ambas as linhas vierem a ter valor mensal, somá-las contaria a mesma
 * avença duas vezes. Mas **não se deduplica por nome nem por morada**: dois
 * prédios podem chamar-se «Pedrogão 14» e ser edifícios distintos, e agrupar
 * por texto livre é exactamente o tipo de inferência que este módulo recusa.
 *
 * Enquanto não existir uma identidade explícita de prédio, as linhas repetidas
 * são **assinaladas** e contadas, e o bloco fica `PARTIAL` — a interface avisa
 * em vez de apresentar um total que pode estar inflacionado.
 */
export function calcularPredios(predios: Fonte<FactoPredio>): BlocoPredios {
  if (!predios.ok) {
    return {
      estado: "ERROR", linhas: [], totalConhecido: null,
      contagem: 0, comValor: 0, semValor: 0, repetidos: 0, nota: predios.erro,
    };
  }

  const porNome = new Map<string, number>();
  for (const p of predios.factos) {
    const k = p.name.trim().toLowerCase();
    porNome.set(k, (porNome.get(k) ?? 0) + 1);
  }

  const linhas: LinhaPredio[] = [...predios.factos]
    // Ordem determinística: pela ordem definida, depois pelo nome. Sem isto, a
    // lista trocava de ordem entre carregamentos.
    .sort((a, z) => a.sortOrder - z.sortOrder || a.name.localeCompare(z.name, "pt"))
    .map((p) => ({
      id: p.id,
      nome: p.name,
      morada: p.address,
      valor: p.monthlyValue,
      repetido: (porNome.get(p.name.trim().toLowerCase()) ?? 0) > 1,
    }));

  const conhecidos = linhas.filter((l) => l.valor !== null);
  const comValor = conhecidos.length;
  const semValor = linhas.length - comValor;
  const repetidos = [...porNome.values()].filter((n) => n > 1).length;

  let estado: EstadoFonte = "AVAILABLE";
  let nota: string | undefined;

  if (linhas.length === 0) {
    // Zero prédios é um facto, e o total é zero de verdade.
    return {
      estado: "AVAILABLE", linhas: [], totalConhecido: 0,
      contagem: 0, comValor: 0, semValor: 0, repetidos: 0,
    };
  }

  if (comValor === 0) {
    estado = "PARTIAL";
    nota = "Nenhum prédio tem avença registada.";
  } else if (semValor > 0) {
    estado = "PARTIAL";
    nota = `${semValor} ${semValor === 1 ? "prédio sem" : "prédios sem"} valor registado.`;
  }

  // Duplicados **entre linhas com valor** são o caso perigoso: o total podia
  // estar a contar a mesma avença duas vezes.
  const nomesComValor = new Map<string, number>();
  for (const l of conhecidos) {
    const k = l.nome.trim().toLowerCase();
    nomesComValor.set(k, (nomesComValor.get(k) ?? 0) + 1);
  }
  const duplicadosComValor = [...nomesComValor.values()].filter((n) => n > 1).length;
  if (duplicadosComValor > 0) {
    estado = "PARTIAL";
    nota = `${duplicadosComValor} ${duplicadosComValor === 1 ? "prédio aparece" : "prédios aparecem"} em vários dias — o total pode contar a mesma avença mais do que uma vez.`;
  }

  return {
    estado,
    linhas,
    totalConhecido: comValor > 0 ? soma(conhecidos.map((l) => l.valor!)) : null,
    contagem: linhas.length,
    comValor,
    semValor,
    repetidos,
    nota,
  };
}

// ============================================================================
// Saídas de caixa por categoria — UMA regra para Pagamentos e para o Resumo
// ============================================================================
//
// Havia dois motores a responder à mesma pergunta — «quanto saiu, por
// categoria, neste mês?» — e davam números diferentes para a mesma seleção:
//
//   · Pagamentos › gráfico › Caixa   (`categorySlices`, ledger-presentation)
//   · Resumo › Saídas por categoria  (`calcularDespesasPorCategoria`, aggregate)
//
// Divergiam em duas coisas, medidas com o mesmo conjunto de movimentos:
//
//   1. ESTADO. O Resumo conta confirmadas E pendentes — decisão do dono,
//      registada em `calcularDespesasPorCategoria`, com o aviso «inclui X por
//      confirmar» no cartão. Pagamentos contava só as confirmadas. Uma despesa
//      acabada de lançar aparecia num ecrã e não no outro.
//
//   2. IDENTIDADE. O Resumo agrupava pelo NOME em minúsculas; Pagamentos pelo
//      `id` estruturado ou pelo texto legado, em espaços separados. Uma
//      categoria estruturada «Fornecedor» e o texto legado «fornecedor»
//      somavam-se numa fatia só no Resumo e ficavam em duas em Pagamentos.
//
// Nenhuma das duas regras é nova: este módulo escolhe, para cada eixo, a que
// já estava documentada como decisão — o estado vem do Resumo (decisão do
// dono), a identidade vem de Pagamentos (a «UMA identidade» da tabela, do
// filtro e do gráfico). Os dois ecrãs passam a agrupar por aqui.
//
// PERÍODO: a data civil do movimento de caixa, `YYYY-MM-DD`, comparada como
// texto. É o eixo «Caixa». O eixo «Competência» só existe em Pagamentos — o
// Resumo não o oferece, e por isso não há paridade a provar nesse modo.
// ============================================================================

/** A chave de «sem categoria» — igual à de `ledger-presentation`. */
export const SEM_CATEGORIA = "uncategorized";

/** Prefixo do espaço de nomes legado. Nunca colide com um uuid. */
const LEGADA = "legacy:";

/** Prefixo para uma estruturada de que só se conhece o nome (sem `id`). */
const NOMEADA = "named:";

const norm = (v: string | null | undefined): string | null => {
  const t = v?.trim().toLocaleLowerCase("pt-PT");
  return t ? t : null;
};

/**
 * A identidade de categoria de uma saída.
 *
 * Estruturada → o seu `id`. Estruturada sem `id` conhecido → o nome, num
 * espaço próprio. Legada → o texto normalizado, noutro espaço. Nenhuma →
 * `uncategorized`. Os três espaços nunca colidem entre si.
 */
export function chaveCategoriaDespesa(c: {
  categoriaId?: string | null;
  categoriaNome?: string | null;
  categoriaLegada?: string | null;
}): string {
  if (c.categoriaId) return c.categoriaId;
  const nome = norm(c.categoriaNome);
  if (nome) return NOMEADA + nome;
  const legada = norm(c.categoriaLegada);
  return legada ? LEGADA + legada : SEM_CATEGORIA;
}

/**
 * Os campos de identidade a partir da categoria EFECTIVA de um movimento
 * (`resolverCategoriaEfetiva`). É a ponte única entre «quem decidiu a
 * categoria» e a chave — usada pelo Resumo (agrupamento) e pelo Fluxo de
 * Caixa (drilldown), para que a fatia e a lista falem da mesma coisa.
 *
 *   · origem «legada»   → o nome é o texto legado: `legacy:<texto>`;
 *   · origem «nenhuma»  → `uncategorized` — em particular quando o PAGAMENTO
 *     ligado não tem categoria: o texto legado do movimento não volta a entrar;
 *   · pagamento/movimento → o `id` estruturado, ou `named:<nome>` sem ele.
 */
export function camposDaCategoriaEfetiva(efetiva: {
  origem: "pagamento" | "movimento" | "legada" | "nenhuma";
  nome: string | null;
  id?: string | null;
}): { categoriaId: string | null; categoriaNome: string | null; categoriaLegada: string | null } {
  if (efetiva.origem === "legada") return { categoriaId: null, categoriaNome: null, categoriaLegada: efetiva.nome };
  if (efetiva.origem === "nenhuma") return { categoriaId: null, categoriaNome: null, categoriaLegada: null };
  return { categoriaId: efetiva.id ?? null, categoriaNome: efetiva.nome, categoriaLegada: null };
}

/** A chave canónica de uma categoria efectiva. */
export function chaveDaCategoriaEfetiva(efetiva: Parameters<typeof camposDaCategoriaEfetiva>[0]): string {
  return chaveCategoriaDespesa(camposDaCategoriaEfetiva(efetiva));
}

/** Estados que contam neste gráfico. Ver o ponto 1 do cabeçalho. */
export const ESTADOS_DESPESA_CAIXA = ["confirmado", "pendente"] as const;

export function contaComoDespesaDeCaixa(m: { tipo: string; status: string | null | undefined }): boolean {
  return m.tipo === "saida" && (ESTADOS_DESPESA_CAIXA as readonly string[]).includes(m.status ?? "");
}

export function noMesCivil(data: string | null | undefined, periodo: { year: number; month: number }): boolean {
  if (!data) return false;
  return data.startsWith(`${periodo.year}-${String(periodo.month).padStart(2, "0")}-`);
}

export interface SaidaDeCaixa {
  data: string;
  tipo: string;
  status: string | null;
  valorCentimos: number;
  categoriaId?: string | null;
  /** Nome da categoria estruturada efectiva, quando existe. */
  categoriaNome?: string | null;
  categoriaLegada?: string | null;
}

export interface GrupoDespesa {
  chave: string;
  categoriaId: string | null;
  /** O primeiro nome visto para esta identidade — só para mostrar. */
  nome: string | null;
  legada: boolean;
  valorCentimos: number;
  pendentesCentimos: number;
  pendentesContagem: number;
}

/**
 * Agrupa as saídas de caixa do mês por categoria. Em cêntimos inteiros: somar
 * euros em vírgula flutuante deixa resíduos que depois desalinham dois ecrãs
 * por um cêntimo.
 */
export function agruparDespesasDeCaixa(
  saidas: readonly SaidaDeCaixa[],
  periodo: { year: number; month: number },
): Map<string, GrupoDespesa> {
  const grupos = new Map<string, GrupoDespesa>();
  for (const s of saidas) {
    if (!contaComoDespesaDeCaixa(s) || !noMesCivil(s.data, periodo)) continue;
    const chave = chaveCategoriaDespesa(s);
    const g = grupos.get(chave) ?? {
      chave,
      categoriaId: s.categoriaId ?? null,
      nome: s.categoriaNome?.trim() || s.categoriaLegada?.trim() || null,
      legada: !s.categoriaId && !s.categoriaNome?.trim() && !!s.categoriaLegada?.trim(),
      valorCentimos: 0,
      pendentesCentimos: 0,
      pendentesContagem: 0,
    };
    g.valorCentimos += s.valorCentimos;
    if (s.status === "pendente") {
      g.pendentesCentimos += s.valorCentimos;
      g.pendentesContagem += 1;
    }
    grupos.set(chave, g);
  }
  return grupos;
}

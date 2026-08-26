// ============================================================================
// CATEGORIA EFETIVA DE UMA SAÍDA DE CAIXA
// ============================================================================
//
// Uma saída de caixa pode nascer de duas maneiras, e a autoridade sobre a sua
// classificação depende disso:
//
//   lançamento manual        → a categoria é a do próprio movimento
//   originado num pagamento  → a categoria é a do pagamento que lhe deu origem
//
// A segunda regra é a que faltava. Ao marcar um pagamento como pago cria-se um
// movimento de caixa que **não** herda `expense_category_id`. Medido em
// produção a 2026-08-26: os 6 movimentos com origem em pagamento têm todos
// `expense_category_id = null`, e um deles vem de um pagamento que **tem**
// categoria. No gráfico aparecia pelo texto legado «despesa» em vez de
// «Subcontratação».
//
// ---------------------------------------------------------------------------
// Porque é que se resolve na leitura e não por cópia
// ---------------------------------------------------------------------------
//
// Copiar a categoria para o movimento no momento do pagamento resolveria o
// primeiro ecrã e criaria o problema seguinte: editar a categoria do pagamento
// deixaria o movimento com a antiga, e passaríamos a ter duas classificações do
// mesmo facto a divergir em silêncio — que é exatamente o defeito que se está a
// remover.
//
// Resolver na leitura mantém uma só verdade: a do pagamento. Um `snapshot`
// gravado no movimento continua a ser aceite como recurso, mas **nunca ganha**
// ao pagamento ligado.
//
// ---------------------------------------------------------------------------
// O que isto NÃO faz
// ---------------------------------------------------------------------------
//
// Não transforma movimentos manuais em obrigações, não os liga a pagamentos por
// semelhança de descrição ou valor, e não inventa categoria nenhuma. Um
// pagamento sem categoria dá «sem categoria» — não o texto legado do movimento,
// porque nesse caso a autoridade já disse que não há classificação.
// ============================================================================

/** Uma saída de caixa, tal como sai da leitura. */
export interface MovimentoParaClassificar {
  reference_type: string | null | undefined;
  reference_id: string | null | undefined;
  /** Categoria estruturada do próprio movimento (o «snapshot»). */
  categoriaEstruturada: string | null | undefined;
  categoriaEstruturadaCor?: string | null | undefined;
  /** Texto legado, anterior ao catálogo. */
  categoriaLegada: string | null | undefined;
}

/** O que se sabe do pagamento que originou o movimento, quando existe. */
export interface CategoriaDoPagamento {
  nome: string | null;
  cor: string | null;
}

export interface CategoriaEfetiva {
  nome: string | null;
  cor: string | null;
  /** De onde veio a decisão — serve para explicar, e para os testes. */
  origem: "pagamento" | "movimento" | "legada" | "nenhuma";
}

/** O valor exato que marca uma saída originada num pagamento. */
export const ORIGEM_PAGAMENTO = "fixed_variable_payment";

const limpo = (v: string | null | undefined): string | null => {
  if (typeof v !== "string") return null;
  const t = v.trim();
  return t === "" ? null : t;
};

/**
 * A categoria que deve ser mostrada para um movimento de saída.
 *
 * @param movimento a linha de caixa
 * @param categoriaDoPagamento categoria do pagamento ligado, ou `null` se o
 *        movimento não tem origem em pagamento **ou** se o pagamento não foi
 *        encontrado. Ver `PAGAMENTO_NAO_ENCONTRADO` para a diferença.
 */
export function resolverCategoriaEfetiva(
  movimento: MovimentoParaClassificar,
  categoriaDoPagamento: CategoriaDoPagamento | null,
): CategoriaEfetiva {
  const nasceuDeUmPagamento = limpo(movimento.reference_type) === ORIGEM_PAGAMENTO;

  if (nasceuDeUmPagamento && categoriaDoPagamento) {
    // 🔴 A autoridade é o pagamento, mesmo quando o movimento tem um snapshot
    //    diferente. Se o pagamento não tem categoria, o movimento fica sem
    //    categoria — não se cai para o texto legado, porque quem manda já
    //    respondeu «nenhuma».
    const nome = limpo(categoriaDoPagamento.nome);
    return nome
      ? { nome, cor: categoriaDoPagamento.cor ?? null, origem: "pagamento" }
      : { nome: null, cor: null, origem: "nenhuma" };
  }

  // Movimento manual — ou originado num pagamento que não se conseguiu
  // resolver, caso em que se usa o que o próprio movimento diz, em vez de
  // inventar. Ver `PAGAMENTO_NAO_ENCONTRADO`.
  const propria = limpo(movimento.categoriaEstruturada);
  if (propria) return { nome: propria, cor: movimento.categoriaEstruturadaCor ?? null, origem: "movimento" };

  const legada = limpo(movimento.categoriaLegada);
  if (legada) return { nome: legada, cor: null, origem: "legada" };

  return { nome: null, cor: null, origem: "nenhuma" };
}

/**
 * 🔴 Distingue «não tem origem em pagamento» de «tem, mas não o encontrei».
 *
 *    A segunda é um vínculo partido — `reference_id` não tem chave estrangeira
 *    em `cash_flow_entries`, por isso é possível. Devolver a categoria do
 *    próprio movimento nesse caso é degradar; devolver zero seria esconder.
 *    Quem chama recebe a lista para poder registá-la.
 */
export function vinculosPartidos(
  movimentos: MovimentoParaClassificar[],
  pagamentosEncontrados: ReadonlySet<string>,
): string[] {
  const partidos: string[] = [];
  for (const m of movimentos) {
    if (limpo(m.reference_type) !== ORIGEM_PAGAMENTO) continue;
    const id = limpo(m.reference_id);
    if (!id || !pagamentosEncontrados.has(id)) partidos.push(id ?? "(sem reference_id)");
  }
  return partidos;
}

/** Os ids de pagamento que uma lista de movimentos precisa de resolver. */
export function idsDePagamentoAResolver(movimentos: MovimentoParaClassificar[]): string[] {
  const ids = new Set<string>();
  for (const m of movimentos) {
    if (limpo(m.reference_type) !== ORIGEM_PAGAMENTO) continue;
    const id = limpo(m.reference_id);
    if (id) ids.add(id);
  }
  return [...ids];
}

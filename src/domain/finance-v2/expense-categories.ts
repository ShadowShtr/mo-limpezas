// ============================================================================
// Categorias de despesa — o catálogo sugerido
// ============================================================================
//
// 🔴 **Isto não é dado persistido.** É uma proposta, e vive no código
//    precisamente por isso.
//
// A migration 071 cria `expense_categories` **vazia**. A lista abaixo só chega
// à base se um admin ou gestor a confirmar, e depois de a poder editar.
//
// A razão é simples: estas catorze categorias foram sugestão nossa, não uma
// decisão da empresa. Semeá-las na migration transformaria uma proposta num
// dado contabilístico permanente — e uma categoria que ninguém pediu é uma
// categoria que ninguém apaga, mas que aparece em todos os relatórios durante
// anos.
//
// Nomeadamente: a Mó Limpezas pode não ter viaturas próprias, pode subcontratar
// tudo, ou pode querer distinguir "Produtos de limpeza" de "Consumíveis". Nada
// disso se adivinha daqui.
// ============================================================================

export interface CategoriaSugerida {
  name: string;
  colorToken: string;
}

/**
 * A lista que a UI propõe na primeira utilização.
 *
 * A ordem é a que aparece no ecrã, e é intencional: as categorias com mais
 * peso numa empresa de limpeza vêm primeiro, para quem só quiser as quatro ou
 * cinco do topo não ter de procurar.
 */
export const DEFAULT_EXPENSE_CATEGORY_SUGGESTIONS: readonly CategoriaSugerida[] = [
  { name: "Salários",             colorToken: "#6558F5" },
  { name: "Combustível",          colorToken: "#FF7A1A" },
  { name: "Materiais e produtos", colorToken: "#16A35A" },
  { name: "Manutenção",           colorToken: "#6378D9" },
  { name: "Viaturas",             colorToken: "#F04438" },
  { name: "Equipamentos",         colorToken: "#8B5CF6" },
  { name: "Comunicações",         colorToken: "#06B6D4" },
  { name: "Seguros",              colorToken: "#F59E0B" },
  { name: "Instalações",          colorToken: "#0EA5E9" },
  { name: "Contabilidade",        colorToken: "#64748B" },
  { name: "Impostos e taxas",     colorToken: "#DC2626" },
  { name: "Alimentação",          colorToken: "#84CC16" },
  { name: "Subcontratação",       colorToken: "#A855F7" },
  { name: "Outros",               colorToken: "#94A3B8" },
] as const;

/**
 * Normaliza um nome de categoria para comparação.
 *
 * Sem isto, «Combustível», «combustivel» e «COMBUSTÍVEL » entrariam as três
 * como categorias distintas, e o donut mostraria a mesma despesa repartida por
 * três fatias. A coluna `normalized_name` da 071 guarda este resultado, e o
 * `UNIQUE(company_id, normalized_name)` fecha a porta na base.
 */
export function normalizarNomeCategoria(nome: string): string {
  return nome
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")  // tira acentos
    .toLowerCase()
    .replace(/\s+/g, " ")
    .trim();
}

/**
 * Prepara a lista para gravação, removendo duplicados **depois** de normalizar.
 *
 * Devolve também o que foi descartado, para a interface poder dizer porquê em
 * vez de simplesmente gravar menos categorias do que as que estavam no ecrã.
 */
export function prepararCategorias(nomes: string[]): {
  aCriar: { name: string; normalizedName: string }[];
  descartados: { name: string; motivo: "vazio" | "duplicado" }[];
} {
  const aCriar: { name: string; normalizedName: string }[] = [];
  const descartados: { name: string; motivo: "vazio" | "duplicado" }[] = [];
  const vistos = new Set<string>();

  for (const bruto of nomes) {
    const name = bruto.trim();
    if (name === "") {
      descartados.push({ name: bruto, motivo: "vazio" });
      continue;
    }
    const normalizedName = normalizarNomeCategoria(name);
    if (vistos.has(normalizedName)) {
      descartados.push({ name, motivo: "duplicado" });
      continue;
    }
    vistos.add(normalizedName);
    aCriar.push({ name, normalizedName });
  }

  return { aCriar, descartados };
}

/**
 * O que falta criar, dado o que a empresa já tem.
 *
 * É isto que torna «Criar categorias sugeridas» idempotente: clicar duas vezes
 * não duplica nada, porque a segunda passagem não encontra nada por criar. A
 * base tem o `UNIQUE` como última linha de defesa, mas convém que a aplicação
 * não conte com ele para o caso normal — um erro de constraint devolvido ao
 * utilizador é uma má forma de dizer «já estava feito».
 */
export function diferencaDeCategorias(
  propostas: { name: string; normalizedName: string }[],
  existentesNormalizadas: string[],
): { name: string; normalizedName: string }[] {
  const jaExistem = new Set(existentesNormalizadas.map(normalizarNomeCategoria));
  return propostas.filter((p) => !jaExistem.has(p.normalizedName));
}

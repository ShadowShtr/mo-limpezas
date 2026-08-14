"use server";

// ============================================================================
// Categorias de despesa — leitura do catálogo e criação das sugeridas
// ============================================================================
//
// ---------------------------------------------------------------------------
// 🔴 A tabela pode não existir, e isso não é um erro do utilizador
// ---------------------------------------------------------------------------
// A migration **071 não está aplicada**. Estas funções correm hoje contra uma
// base onde `expense_categories` não existe, e têm de o dizer sem partir a
// página das Contas — que continua a servir para tudo o resto.
//
// Daí o `available: boolean`. Não é um `try/catch` a engolir tudo: é uma
// distinção entre três estados que a interface precisa de saber separar —
//
//   available: false   a funcionalidade ainda não existe nesta base
//   available: true, categories: []   existe, e a empresa ainda não criou nenhuma
//   available: true, categories: [...]  existe e está em uso
//
// Achatar os três num só faria a UI dizer «ainda não há categorias» a quem
// tem a base por migrar, e mandava essa pessoa criar categorias num botão que
// não podia funcionar.
//
// ⚠️ E o inverso é igualmente importante: um erro de rede ou de permissões
//    **não** pode ser lido como «a tabela não existe». Só os códigos concretos
//    de objecto em falta contam para isso — ver `pareceTabelaEmFalta`.
// ============================================================================

import { revalidatePath } from "next/cache";

import { requireProfile } from "@/lib/auth-guard";
import {
  DEFAULT_EXPENSE_CATEGORY_SUGGESTIONS,
  diferencaDeCategorias,
  prepararCategorias,
  type CategoriaSugerida,
} from "@/domain/finance-v2/expense-categories";

/**
 * 🔴 Porque é que há aqui um cast, e porque é que ele fica confinado
 *
 * `src/types/database.ts` é gerado a partir do esquema **real**, e a 071 não
 * está aplicada — logo `expense_categories` não existe lá. Acrescentá-la à mão
 * faria os tipos afirmar que a tabela existe, o que é falso, e o resto do
 * código deixaria de ter forma de saber a diferença.
 *
 * O cast fica num sítio só, e é a fronteira onde já se sabe que a tabela pode
 * não existir — as três funções que a tocam tratam esse caso explicitamente.
 * No dia em que a 071 for aplicada e os tipos forem regenerados, isto sai.
 */
type ClienteComCategorias = {
  from: (tabela: "expense_categories") => {
    select: (cols: string) => {
      eq: (col: string, val: unknown) => {
        eq: (col: string, val: unknown) => {
          order: (col: string) => {
            order: (col: string) => Promise<{ data: ExpenseCategory[] | null; error: ErroBase | null }>;
          };
        };
        then: Promise<{ data: { normalized_name: string }[] | null; error: ErroBase | null }>["then"];
      };
    };
    insert: (linhas: LinhaCategoria[]) => {
      select: (cols: string) => Promise<{ data: { id: string }[] | null; error: ErroBase | null }>;
    };
  };
};

type ErroBase = { code?: string; message?: string };

type LinhaCategoria = {
  company_id: string;
  name: string;
  normalized_name: string;
  color_token: string | null;
  sort_order: number;
  active: boolean;
};

export interface ExpenseCategory {
  id: string;
  name: string;
  normalized_name: string;
  color_token: string | null;
  active: boolean;
  sort_order: number;
}

export interface ExpenseCategoryCatalog {
  /** `false` = a 071 ainda não foi aplicada nesta base. */
  available: boolean;
  categories: ExpenseCategory[];
  suggestions: readonly CategoriaSugerida[];
  /** Das sugeridas, as que ainda não existem. Vazio = não há nada a criar. */
  missingSuggestions: CategoriaSugerida[];
  /** Preenchido quando `available` é falso por uma razão que não a migration. */
  error?: string;
}

/** Catálogo vazio e indisponível — o que a página usa quando a leitura falha. */
export async function emptyExpenseCategoryCatalog(): Promise<ExpenseCategoryCatalog> {
  return { available: false, categories: [], suggestions: [], missingSuggestions: [] };
}

/**
 * A tabela/coluna não existe — ou o erro é outro?
 *
 * 🔴 `42P01` (undefined_table) e `42703` (undefined_column) são os únicos
 *    códigos que significam «esta base ainda não tem a 071». O PostgREST
 *    responde `PGRST205` quando o schema cache não conhece a tabela.
 *
 * Tudo o resto — RLS, rede, timeout — é uma falha a comunicar como falha.
 * Tratá-la como «funcionalidade indisponível» esconderia um problema real
 * atrás de uma mensagem tranquilizadora sobre uma migration.
 */
function pareceTabelaEmFalta(erro: { code?: string; message?: string } | null): boolean {
  if (!erro) return false;
  if (["42P01", "42703", "PGRST205"].includes(erro.code ?? "")) return true;
  // Sem código, exige-se que a mensagem nomeie a relação em falta.
  return /relation .*expense_categor.* does not exist|could not find the table/i.test(erro.message ?? "");
}

export async function getExpenseCategoryCatalog(): Promise<
  { ok: true; catalog: ExpenseCategoryCatalog } | { ok: false; error: string }
> {
  const guard = await requireProfile({ roles: ["admin", "gestor"] });
  if (!guard.ok) return { ok: false, error: guard.error };
  const { admin, profile } = guard;

  const cliente = admin as unknown as ClienteComCategorias;

  const { data, error } = await cliente
    .from("expense_categories")
    .select("id, name, normalized_name, color_token, active, sort_order")
    .eq("company_id", profile.company_id)
    .eq("active", true)
    .order("sort_order")
    .order("name");

  if (error) {
    if (pareceTabelaEmFalta(error)) {
      return {
        ok: true,
        catalog: { available: false, categories: [], suggestions: [], missingSuggestions: [] },
      };
    }
    // 🔴 Falha real: não vira «indisponível», que se leria como «falta migrar».
    console.error("[expense-categories] leitura falhou", error.code, error.message);
    return {
      ok: true,
      catalog: {
        available: false, categories: [], suggestions: [], missingSuggestions: [],
        error: "Não foi possível carregar as categorias. A lista abaixo pode estar incompleta.",
      },
    };
  }

  const categories = (data ?? []) as ExpenseCategory[];
  const { aCriar } = prepararCategorias(
    DEFAULT_EXPENSE_CATEGORY_SUGGESTIONS.map((s) => s.name),
  );
  const emFalta = diferencaDeCategorias(aCriar, categories.map((c) => c.normalized_name));
  const porNome = new Map(DEFAULT_EXPENSE_CATEGORY_SUGGESTIONS.map((s) => [s.name, s]));

  return {
    ok: true,
    catalog: {
      available: true,
      categories,
      suggestions: DEFAULT_EXPENSE_CATEGORY_SUGGESTIONS,
      missingSuggestions: emFalta.map((c) => porNome.get(c.name)!).filter(Boolean),
    },
  };
}

/**
 * Cria as sugeridas que ainda faltam.
 *
 * Idempotente por duas vias independentes: a aplicação só insere a diferença,
 * e a base tem `UNIQUE(company_id, normalized_name)`. A primeira evita o erro
 * no caso normal; a segunda cobre duas pessoas a clicar ao mesmo tempo, que a
 * primeira sozinha não apanha.
 *
 * 🔴 Não é um seed. É uma acção deliberada de alguém com autorização, e por
 *    isso vive aqui e não dentro da migration: gravar catorze categorias que a
 *    gestão nunca aprovou seria transformar uma proposta nossa em dado
 *    contabilístico permanente de toda a empresa.
 */
export async function createSuggestedExpenseCategories(): Promise<
  { ok: true; criadas: number; jaExistiam: number } | { ok: false; error: string }
> {
  const guard = await requireProfile({ roles: ["admin", "gestor"] });
  if (!guard.ok) return { ok: false, error: guard.error };
  const { admin, profile } = guard;

  const cliente = admin as unknown as ClienteComCategorias;

  const { data: existentes, error: erroLeitura } = await cliente
    .from("expense_categories")
    .select("normalized_name")
    .eq("company_id", profile.company_id);

  if (erroLeitura) {
    if (pareceTabelaEmFalta(erroLeitura)) {
      return { ok: false, error: "Categorias disponíveis depois da migration 071." };
    }
    // 🔴 Ler antes de escrever: se a leitura falhar, não se insere nada.
    //    Assumir «não existe nenhuma» criaria as catorze por cima das que já lá
    //    estavam, e o UNIQUE rejeitaria o lote inteiro — ou, pior, metade.
    return { ok: false, error: erroLeitura.message ?? "Não foi possível ler as categorias existentes." };
  }

  const { aCriar } = prepararCategorias(
    DEFAULT_EXPENSE_CATEGORY_SUGGESTIONS.map((s) => s.name),
  );
  const jaNormalizadas = (existentes ?? []).map((c) => c.normalized_name);
  const emFalta = diferencaDeCategorias(aCriar, jaNormalizadas);

  if (emFalta.length === 0) {
    return { ok: true, criadas: 0, jaExistiam: jaNormalizadas.length };
  }

  const cor = new Map(DEFAULT_EXPENSE_CATEGORY_SUGGESTIONS.map((s) => [s.name, s.colorToken]));
  const ordem = new Map(DEFAULT_EXPENSE_CATEGORY_SUGGESTIONS.map((s, i) => [s.name, i]));

  const { data: inseridas, error: erroInsert } = await cliente
    .from("expense_categories")
    .insert(
      emFalta.map((c) => ({
        company_id: profile.company_id,
        name: c.name,
        normalized_name: c.normalizedName,
        color_token: cor.get(c.name) ?? null,
        sort_order: ordem.get(c.name) ?? 0,
        active: true,
      })),
    )
    .select("id");

  if (erroInsert) {
    if (pareceTabelaEmFalta(erroInsert)) {
      return { ok: false, error: "Categorias disponíveis depois da migration 071." };
    }
    // 23505 = alguém clicou ao mesmo tempo. Não é uma falha para o utilizador:
    // o resultado que ele queria — as categorias existirem — aconteceu.
    if (erroInsert.code === "23505") {
      return { ok: true, criadas: 0, jaExistiam: jaNormalizadas.length };
    }
    return { ok: false, error: erroInsert.message ?? "Não foi possível criar as categorias." };
  }

  revalidatePath("/dashboard/financeiro/contas");
  revalidatePath("/dashboard/financeiro");
  revalidatePath("/dashboard/financeiro/fluxo-caixa");

  return { ok: true, criadas: inseridas?.length ?? emFalta.length, jaExistiam: jaNormalizadas.length };
}

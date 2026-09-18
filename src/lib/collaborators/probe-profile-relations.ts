// ============================================================================
// Sondar o que um perfil ainda é responsável
// ============================================================================
//
// Percorre o inventário gerado do catálogo e conta, referência a referência,
// quantas linhas nomeiam esta pessoa. Não escreve nada — nem uma coluna, nem
// um NULL. É de propósito: o guard tem de poder responder «tem histórico» sem
// ter mexido em histórico nenhum.
//
// 🔴 As contagens são pedidas SEM filtro de empresa.
//
//    Um perfil pertence a uma empresa, e a tentação é filtrar por ela. Mas o
//    que se está a decidir é se apagar esta linha destrói alguma coisa — e uma
//    linha que aponte para cá a partir de outra empresa destrói na mesma. Além
//    disso há tabelas no inventário que nem têm `company_id`
//    (`platform_admins`). Filtrar por empresa daria zero onde há registos, que
//    é a única resposta errada que este módulo não pode dar.
// ============================================================================

import type { createAdminClient } from "@/lib/supabase/admin";
import { INVENTARIO_FK_PERFIS } from "@/domain/collaborators/lifecycle";
import type { SondagemRelacao } from "@/domain/collaborators/lifecycle-types";

type AdminClient = ReturnType<typeof createAdminClient>;

/**
 * A forma mínima do cliente para contar linhas de uma tabela nomeada em runtime.
 *
 * 🔴 Porque é que há aqui uma conversão de tipo, e porque é estreita.
 *
 *    `admin.from()` é tipado contra a lista de tabelas de
 *    `src/types/database.ts`, e este módulo escolhe a tabela a partir do
 *    inventário lido do catálogo — uma `string` que o compilador não pode
 *    conhecer. Pior: `database.ts` está desactualizado face à base real (não
 *    tem `crm_leads`, entre outras), e é precisamente às tabelas que faltam
 *    nesse ficheiro que o guard não pode deixar de perguntar.
 *
 *    A alternativa seria restringir o inventário ao que `database.ts` conhece
 *    — ou seja, escolher entre compilar e estar correcto. Esta conversão
 *    cobre só `from().select().eq()`, e o que garante a correspondência com a
 *    base não é o compilador: é `collaborator-lifecycle-postgres.test.ts`, que
 *    corre cada referência contra um Postgres real.
 */
type ContagemPorTabela = {
  from: (tabela: string) => {
    select: (
      colunas: string,
      opcoes: { count: "exact"; head: true },
    ) => {
      eq: (
        coluna: string,
        valor: string,
      ) => PromiseLike<{ count: number | null; error: { message: string } | null }>;
    };
  };
};

/**
 * Quantas sondagens correm ao mesmo tempo.
 *
 * Quarenta e oito pedidos de uma vez esgotariam o pool do PostgREST e as
 * falhas de saturação chegariam aqui como sondagens falhadas — o guard
 * recusaria por não conseguir ler, e a recusa pareceria um defeito. Em lotes,
 * o custo é uma fracção de segundo e a leitura é fiável.
 */
const LOTE = 8;

/**
 * Conta as linhas de uma referência.
 *
 * `head: true` com `count: "exact"` pede ao PostgREST a contagem sem trazer
 * uma única linha: o que interessa é se há, não o que há.
 */
async function sondarUma(
  admin: AdminClient,
  ref: (typeof INVENTARIO_FK_PERFIS)[number],
  profileId: string,
): Promise<SondagemRelacao> {
  try {
    const { count, error } = await (admin as unknown as ContagemPorTabela)
      .from(ref.tabela)
      .select("*", { count: "exact", head: true })
      .eq(ref.coluna, profileId);

    if (error) return { ref, estado: "falhada", detalhe: error.message };
    // Uma contagem ausente não é zero. O PostgREST devolve `null` quando não
    // conseguiu contar, e tratar isso como «não há nada» seria autorizar um
    // DELETE com base numa resposta que não respondeu.
    if (typeof count !== "number") {
      return { ref, estado: "falhada", detalhe: "contagem indisponível" };
    }
    return { ref, estado: "lida", contagem: count };
  } catch (e) {
    return { ref, estado: "falhada", detalhe: e instanceof Error ? e.message : String(e) };
  }
}

/**
 * Sonda TODAS as referências do inventário.
 *
 * Devolve sempre uma sondagem por referência — as que falharam vêm marcadas,
 * não omitidas. `avaliarRemocao` conta com isso para distinguir «não há nada»
 * de «não se conseguiu ver», e omitir uma falha apagaria essa distinção.
 */
export async function sondarRelacoesDoPerfil(
  admin: AdminClient,
  profileId: string,
): Promise<SondagemRelacao[]> {
  const resultado: SondagemRelacao[] = [];
  for (let i = 0; i < INVENTARIO_FK_PERFIS.length; i += LOTE) {
    const lote = INVENTARIO_FK_PERFIS.slice(i, i + LOTE);
    resultado.push(...(await Promise.all(lote.map((ref) => sondarUma(admin, ref, profileId)))));
  }
  return resultado;
}

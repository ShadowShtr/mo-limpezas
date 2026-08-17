// ============================================================================
// GUARDA CENTRAL DO PERÍODO FINANCEIRO
// ============================================================================
//
// Uma mutação financeira só passa se o período **do facto** estiver aberto.
// Não o mês selecionado na UI: o mês da data que dá identidade económica ao
// registo. Um pagamento com `paid_on = 2026-07-15` afecta Julho, mesmo que o
// ecrã esteja a mostrar Agosto — e é Julho que tem de estar aberto.
//
// ---------------------------------------------------------------------------
// Falha fechada — o ponto todo deste ficheiro
// ---------------------------------------------------------------------------
// Se a leitura de `financial_periods` falhar (timeout, permissão, ligação
// perdida), a resposta é **recusar a mutação**. Nunca "assumir aberto".
//
// A tentação de tratar erro-de-leitura como "aberto" é grande, porque a
// alternativa incomoda o utilizador quando a base está instável. Mas o efeito
// é que uma falha de infraestrutura passa a permitir escritas num mês fechado
// — precisamente aquilo que a guarda existe para impedir, e sem deixar rasto
// de que aconteceu. Um erro visível é recuperável; uma escrita indevida num
// período fechado é uma correcção contabilística.
//
// ---------------------------------------------------------------------------
// Porque é que não há cache entre pedidos
// ---------------------------------------------------------------------------
// O estado do período muda por acção humana (fechar, reabrir) e é lido em
// mutações que decidem se escrevem ou não. Uma cache com TTL abriria uma
// janela em que o mês está fechado na base e aberto na cache — escritas
// aceites contra um estado que já não existe.
//
// O que existe é um **contexto por pedido** (`criarContextoPeriodo`): dentro
// da mesma mutação, validar três datas não faz três leituras. A chave inclui
// sempre `companyId` — uma cache indexada só por ano/mês vazaria estado entre
// empresas, que num sistema multi-tenant é o pior tipo de bug.
// ============================================================================

import {
  ERRO_PERIODO_FECHADO,
  interpretarLinhaPeriodo,
  mensagemPeriodoFechado,
  periodoDeDataCivil,
  type EstadoPeriodoLido,
  type Periodo,
} from "@/domain/finance-v2/financial-period";

/**
 * Só o que a guarda precisa de um cliente Supabase.
 *
 * ⚠️ Os `eq` encadeados são deliberadamente auto-referenciais (`EqChain`) em
 *    vez de três níveis literais. Com níveis literais, o `AdminClient` real
 *    não encaixa aqui por estrutura e o TypeScript tenta reconciliar os dois
 *    tipos até rebentar com «Type instantiation is excessively deep»
 *    (TS2589) — foi exactamente o que aconteceu. Uma cadeia recursiva descreve
 *    a mesma forma sem obrigar o compilador a expandir a árvore inteira do
 *    tipo gerado do PostgREST.
 */
type EqChain = {
  eq: (coluna: string, valor: unknown) => EqChain;
  maybeSingle: () => PromiseLike<{
    data: Record<string, unknown> | null;
    error: { message: string; code?: string } | null;
  }>;
};

export type ClientePeriodo = {
  from: (tabela: string) => {
    select: (colunas: string) => EqChain;
  };
};

export type ResultadoGuarda =
  | { ok: true; periodo: Periodo; estado: EstadoPeriodoLido }
  | { ok: false; code: string; error: string; periodo?: Periodo };

/** Código para quando não se conseguiu determinar o estado do período. */
export const ERRO_ESTADO_INDETERMINADO = "FINANCIAL_PERIOD_STATE_UNKNOWN" as const;

/**
 * Lê o estado de um período. **Distingue "não há linha" de "não consegui ler".**
 *
 * `maybeSingle()` devolve `data: null, error: null` quando não há linha — que é
 * o caso normal de um mês nunca fechado. Um `error` não-nulo é outra coisa
 * completamente diferente, e é por isso que os dois ramos não podem colapsar
 * num só: `if (!data) return aberto` trataria uma falha de rede como mês
 * aberto.
 */
export async function lerEstadoPeriodo(
  cliente: ClientePeriodo,
  companyId: string,
  periodo: Periodo,
): Promise<{ ok: true; estado: EstadoPeriodoLido } | { ok: false; error: string }> {
  // ⚠️ O `as ClientePeriodo` é sobre o *cliente*, não sobre os dados.
  //
  //    Os tipos gerados do PostgREST são profundos, e passar o `AdminClient`
  //    real onde se espera esta forma mínima fazia o compilador rebentar com
  //    TS2589 («Type instantiation is excessively deep»). O cast trata o
  //    cliente como a interface estreita que este módulo declara — e mais
  //    nada.
  //
  //    O que sai da query continua verificado: `interpretarLinhaPeriodo` lê
  //    cada campo com `typeof` e nunca confia na forma da linha. Um cast em
  //    `data` seria outra coisa, e não é o que está aqui.
  const c = cliente as ClientePeriodo;
  const { data, error } = await c
    .from("financial_periods")
    .select("status, closed_at, closed_by, reopened_at, reopen_reason")
    .eq("company_id", companyId)
    .eq("year", periodo.year)
    .eq("month", periodo.month)
    .maybeSingle();

  if (error) {
    // 🔴 Aqui é onde a falha fecha. Não devolver "aberto".
    return { ok: false, error: error.message || "Não foi possível ler o estado do período." };
  }

  return { ok: true, estado: interpretarLinhaPeriodo(data) };
}

/**
 * Contexto por pedido: memoiza leituras dentro da mesma mutação.
 *
 * 🔴 A chave é `companyId:year:month`, e o `companyId` não é opcional. Uma
 *    chave só de ano/mês faria a primeira empresa a ler um mês decidir o
 *    estado desse mês para todas as outras no mesmo processo.
 *
 * O contexto vive o que durar a mutação. Não é cache entre pedidos, e não deve
 * passar a ser — ver o cabeçalho.
 */
export function criarContextoPeriodo(cliente: ClientePeriodo) {
  const lidos = new Map<string, { ok: true; estado: EstadoPeriodoLido } | { ok: false; error: string }>();

  return {
    async ler(companyId: string, periodo: Periodo) {
      const chave = `${companyId}:${periodo.year}:${periodo.month}`;
      const guardado = lidos.get(chave);
      if (guardado) return guardado;
      const r = await lerEstadoPeriodo(cliente, companyId, periodo);
      lidos.set(chave, r);
      return r;
    },
    /** Só para os testes: quantas leituras foram mesmo à base. */
    get tamanho() {
      return lidos.size;
    },
  };
}

export type ContextoPeriodo = ReturnType<typeof criarContextoPeriodo>;

/**
 * A guarda. Recusa se o período estiver fechado, ou se não se souber.
 *
 * `data` é a data civil `YYYY-MM-DD` do facto económico — nunca `new Date()`,
 * nunca o mês do selector. Cada action decide qual é a sua data autoritativa
 * (ver `docs/FINANCIAL-PERIOD-CLOSE-RUNTIME.md`).
 */
export async function assertFinancialPeriodOpen({
  cliente,
  contexto,
  companyId,
  data,
}: {
  cliente?: ClientePeriodo;
  contexto?: ContextoPeriodo;
  companyId: string;
  data: string;
}): Promise<ResultadoGuarda> {
  const p = periodoDeDataCivil(data);
  if (!p.ok) {
    return { ok: false, code: "INVALID_DATE", error: p.error };
  }

  if (!contexto && !cliente) {
    // Erro de programação, não de utilizador — mas falha fechada de qualquer
    // modo, em vez de deixar passar por omissão.
    return {
      ok: false,
      code: ERRO_ESTADO_INDETERMINADO,
      error: "Guarda de período sem cliente de base de dados.",
      periodo: p.periodo,
    };
  }

  const leitura = contexto
    ? await contexto.ler(companyId, p.periodo)
    : await lerEstadoPeriodo(cliente!, companyId, p.periodo);

  if (!leitura.ok) {
    return {
      ok: false,
      code: ERRO_ESTADO_INDETERMINADO,
      error:
        "Não foi possível confirmar se o período financeiro está aberto. " +
        "A alteração não foi feita — tente novamente.",
      periodo: p.periodo,
    };
  }

  if (leitura.estado.status === "closed") {
    return {
      ok: false,
      code: ERRO_PERIODO_FECHADO,
      error: mensagemPeriodoFechado(p.periodo),
      periodo: p.periodo,
    };
  }

  return { ok: true, periodo: p.periodo, estado: leitura.estado };
}

/**
 * Para updates que **mudam a data** de um registo: os dois períodos têm de
 * estar abertos.
 *
 * Mover um movimento de Julho para Agosto retira dinheiro de Julho e põe-no em
 * Agosto. Se Julho estiver fechado, a operação altera um mês fechado — mesmo
 * que Agosto esteja aberto, e mesmo que "só se esteja a editar a data". Validar
 * apenas o destino deixava um caminho para modificar meses fechados por
 * arrastamento.
 *
 * Quando as duas datas caem no mesmo período, faz uma verificação só.
 */
export async function assertPeriodosAbertosParaMudancaDeData({
  cliente,
  contexto,
  companyId,
  dataAntiga,
  dataNova,
}: {
  cliente?: ClientePeriodo;
  contexto?: ContextoPeriodo;
  companyId: string;
  dataAntiga: string;
  dataNova: string;
}): Promise<ResultadoGuarda> {
  const antiga = await assertFinancialPeriodOpen({ cliente, contexto, companyId, data: dataAntiga });
  if (!antiga.ok) return antiga;

  const pNova = periodoDeDataCivil(dataNova);
  if (!pNova.ok) return { ok: false, code: "INVALID_DATE", error: pNova.error };

  // Mesmo período: já está validado, não repetir a leitura.
  if (pNova.periodo.year === antiga.periodo.year && pNova.periodo.month === antiga.periodo.month) {
    return antiga;
  }

  return assertFinancialPeriodOpen({ cliente, contexto, companyId, data: dataNova });
}

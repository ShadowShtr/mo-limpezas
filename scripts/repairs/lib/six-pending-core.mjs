// ============================================================================
// NÚCLEO DA REPARAÇÃO DAS 6 OBRIGAÇÕES PENDENTES
// ============================================================================
//
// Seis facturas de fornecedor foram registadas directamente em
// `cash_flow_entries` como saídas **pendentes**, sem passarem por
// `fixed_variable_payments`. São obrigações a pagar, e o sítio delas é
// Pagamentos.
//
// O que a reparação faz, por cada uma:
//
//   1. cria um pagamento novo, `pendente`, com um id **gerado de antemão**;
//   2. liga o movimento que já existe a esse pagamento, pelo par
//      (`reference_type`, `reference_id`);
//   3. e mais nada.
//
// 🔴 O movimento **não** é duplicado, **não** é apagado, e continua
//    `pendente`. Criar um movimento novo somaria a mesma despesa duas vezes no
//    Fluxo de Caixa; apagar o antigo destruiria histórico real. A linha
//    sobrevive, com o seu `id`, o seu `created_at` e a sua data de registo — e
//    é assim que a data legada fica preservada sem ser transformada em
//    vencimento nenhum.
//
// Quando o pagamento for marcado como pago, a RPC da 079 converte **essa mesma
// linha** de `pendente` para `confirmado` e põe-lhe a data efectiva. Sem a 079
// esta reparação deixaria os seis movimentos presos em `pendente` para sempre —
// é por isso que a ordem das duas coisas não é negociável.
//
// ---------------------------------------------------------------------------
// Este ficheiro não fala com base nenhuma
// ---------------------------------------------------------------------------
// Decide o quê. O CLI decide o quando e o onde, e é ele que tem os guardas de
// alvo. Tudo o que é decisão vive aqui para poder ser testado sem uma base
// ligada — incluindo a verificação do hash do manifesto, que na #78 chegou a
// viver só no CLI e por isso não tinha um único teste capaz de a apanhar.
// ============================================================================

/**
 * As únicas colunas que a reparação escreve num movimento existente.
 *
 * 🔴 Construída campo a campo, nunca por espalhamento. Um `...patch` faria com
 *    que um campo a mais no manifesto passasse a ser escrito sem ninguém
 *    decidir isso.
 */
export const CAMPOS_ESCRITOS_NO_MOVIMENTO = ["reference_type", "reference_id"];

/** O valor que marca um movimento como tendo origem num pagamento. */
export const ORIGEM_PAGAMENTO = "fixed_variable_payment";

/** Facturas pontuais. Não são obrigações recorrentes mensais. */
export const KIND_ALVO = "variavel";

/** Quantas linhas esta reparação espera. Um número diferente aborta. */
export const ESPERADAS = 6;

// ─── Data e competência ──────────────────────────────────────────────────────

/**
 * O mês civil de uma data legada.
 *
 * 🔴 Só aceita texto `YYYY-MM-DD`. Nunca um `Date`.
 *
 *    Na #78 este mesmo cálculo recebeu objectos `Date` do node-postgres
 *    (colunas `date` chegam assim), devolveu `null`, e quem chamava tratou isso
 *    como «não tem data». O resultado foi um snapshot com **zero** candidatos
 *    que passou por sucesso. Por isso aqui há duas respostas diferentes para
 *    duas perguntas diferentes: `null` quer dizer «não consigo ler isto», e
 *    quem chama tem de abortar, não seguir em frente.
 *
 *    O CLI lê sempre `date::text` — o `::text` não é decoração.
 */
export function competenciaDaDataLegada(texto) {
  if (typeof texto !== "string") return null;
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(texto.trim());
  if (!m) return null;
  const ano = Number(m[1]);
  const mes = Number(m[2]);
  const dia = Number(m[3]);
  if (!Number.isInteger(ano) || ano < 2000 || ano > 2999) return null;
  if (!Number.isInteger(mes) || mes < 1 || mes > 12) return null;
  if (!Number.isInteger(dia) || dia < 1 || dia > 31) return null;
  return { ano, mes };
}

// ─── Categoria ───────────────────────────────────────────────────────────────

/**
 * A categoria estruturada do pagamento novo.
 *
 * Regra (§20): preservar o `expense_category_id` que já exista. Para o texto
 * legado, mapear **apenas** quando houver equivalência determinística com uma
 * categoria do catálogo — ou seja, exactamente um nome igual, ignorando
 * maiúsculas e espaços. Caso contrário `null`.
 *
 * 🔴 Não há aproximação, não há «parecido», não há categoria por omissão.
 *    `despesa` é o texto legado de quase tudo: mapeá-lo para alguma coisa seria
 *    inventar uma classificação que ninguém escolheu, em cima de dinheiro real.
 *    O texto legado não se perde — fica no movimento, que sobrevive.
 */
export function resolverCategoriaDoAlvo(legado, catalogo) {
  if (legado.expense_category_id) {
    return { id: legado.expense_category_id, origem: "preservada" };
  }

  const texto = typeof legado.category === "string" ? legado.category.trim().toLowerCase() : "";
  if (!texto) return { id: null, origem: "nenhuma" };

  const iguais = (catalogo ?? []).filter(
    (c) => typeof c.name === "string" && c.name.trim().toLowerCase() === texto,
  );
  if (iguais.length === 1) return { id: iguais[0].id, origem: "mapeada" };

  // Zero equivalências, ou mais do que uma: não é determinístico.
  return { id: null, origem: "sem-equivalencia-deterministica" };
}

// ─── O alvo ──────────────────────────────────────────────────────────────────

/**
 * O pagamento que uma linha legada deve tornar-se.
 *
 * `due_date` fica **nulo**, por decisão do proprietário: a data legada foi
 * medida como data de registo (é igual ao `created_at` nas seis), não como
 * vencimento. Transformar ausência de informação numa data inventada faria o
 * sistema afirmar um atraso que ninguém pode confirmar.
 *
 * Sem `due_date` não há nada a derivar, e a competência é o mês civil do
 * registo — que é o que a regra da #77 faz com o `fallback`.
 */
export function construirAlvo(legado, { paymentId, catalogo }) {
  const competencia = competenciaDaDataLegada(legado.date);
  if (!competencia) {
    return { ok: false, error: `Data ilegível na linha ${legado.id}: não consigo derivar a competência.` };
  }
  if (!paymentId) {
    return { ok: false, error: `Falta o id pré-gerado para a linha ${legado.id}.` };
  }

  const categoria = resolverCategoriaDoAlvo(legado, catalogo);

  return {
    ok: true,
    alvo: {
      id: paymentId,
      company_id: legado.company_id,
      kind: KIND_ALVO,
      description: legado.description,
      amount: legado.amount,
      due_date: null,
      status: "pendente",
      recurring: false,
      period_year: competencia.ano,
      period_month: competencia.mes,
      notes: legado.notes ?? null,
      expense_category_id: categoria.id,
    },
    categoriaOrigem: categoria.origem,
  };
}

// ─── Elegibilidade ───────────────────────────────────────────────────────────

/**
 * Uma linha só entra na reparação se for exactamente o que se espera.
 *
 * 🔴 Qualquer surpresa é motivo para parar o lote inteiro, não para saltar a
 *    linha. Saltar em silêncio dava um lote «bem sucedido» com menos linhas do
 *    que devia, e ninguém iria contar.
 */
export function razoesDeInelegibilidade(legado) {
  const razoes = [];
  if (legado.type !== "saida") razoes.push(`type=${legado.type} (esperado saida)`);
  if (legado.status !== "pendente") razoes.push(`status=${legado.status} (esperado pendente)`);
  if (legado.reference_type !== null && legado.reference_type !== undefined) {
    razoes.push(`reference_type=${legado.reference_type} (esperado nulo — já tem origem)`);
  }
  if (legado.reference_id !== null && legado.reference_id !== undefined) {
    razoes.push(`reference_id preenchido (esperado nulo)`);
  }
  if (!competenciaDaDataLegada(legado.date)) razoes.push(`date ilegível (${String(legado.date)})`);
  const valor = Number(legado.amount);
  if (!Number.isFinite(valor) || valor <= 0) razoes.push(`amount inválido (${String(legado.amount)})`);
  if (!legado.description || String(legado.description).trim() === "") {
    razoes.push("description vazia");
  }
  return razoes;
}

// ─── Manifesto ───────────────────────────────────────────────────────────────

/**
 * Ordena as chaves de um objecto, recursivamente.
 *
 * O hash tem de ser estável: a mesma informação não pode dar dois hashes só
 * porque as chaves saíram por outra ordem.
 */
function ordenar(v) {
  if (Array.isArray(v)) return v.map(ordenar);
  if (v && typeof v === "object") {
    return Object.fromEntries(Object.keys(v).sort().map((k) => [k, ordenar(v[k])]));
  }
  return v;
}

export function serializarParaHash(manifesto) {
  // O próprio hash não pode entrar no cálculo do hash.
  const { sha256, ...resto } = manifesto;
  void sha256;
  return JSON.stringify(ordenar(resto));
}

/**
 * O manifesto autorizado é aquele hash, e não «um manifesto qualquer».
 *
 * 🔴 Vive aqui, e não no CLI. Na #78 esta verificação existia só no CLI: apagá-la
 *    não punha um único teste vermelho, o que é o mesmo que não a ter.
 */
export function verificarHashManifesto(manifesto, shaEsperado, calcularSha) {
  if (typeof shaEsperado !== "string" || shaEsperado.length !== 64) {
    return { ok: false, error: "O --manifest-sha tem de ser um sha256 hexadecimal de 64 caracteres." };
  }
  const real = calcularSha(serializarParaHash(manifesto));
  if (real !== shaEsperado) {
    return {
      ok: false,
      error:
        "O manifesto no disco não é o que foi autorizado.\n" +
        `  autorizado: ${shaEsperado}\n` +
        `  no disco:   ${real}\n` +
        "Gerar um manifesto novo não o torna autorizado — é preciso autorizar o novo.",
    };
  }
  return { ok: true };
}

/**
 * As invariantes que o manifesto tem de cumprir antes de qualquer escrita.
 */
export function validarManifesto(manifesto) {
  const erros = [];
  const linhas = manifesto?.linhas ?? [];

  if (!Array.isArray(linhas) || linhas.length !== ESPERADAS) {
    erros.push(`Esperadas ${ESPERADAS} linhas, o manifesto tem ${Array.isArray(linhas) ? linhas.length : "?"}.`);
  }

  const idsLegado = new Set();
  const idsPagamento = new Set();
  const empresas = new Set();

  for (const l of linhas) {
    if (!l.legacy_cashflow_id) erros.push("linha sem legacy_cashflow_id");
    if (!l.target_payment_id) erros.push(`linha ${l.legacy_cashflow_id} sem target_payment_id`);
    if (l.legacy_cashflow_id === l.target_payment_id) {
      erros.push(`linha ${l.legacy_cashflow_id}: o id do pagamento é igual ao do movimento`);
    }
    if (idsLegado.has(l.legacy_cashflow_id)) erros.push(`legacy_cashflow_id repetido: ${l.legacy_cashflow_id}`);
    if (idsPagamento.has(l.target_payment_id)) erros.push(`target_payment_id repetido: ${l.target_payment_id}`);
    idsLegado.add(l.legacy_cashflow_id);
    idsPagamento.add(l.target_payment_id);
    empresas.add(l.company_id);

    if (l.target?.due_date !== null) {
      erros.push(`linha ${l.legacy_cashflow_id}: due_date tem de ser nulo (é ${JSON.stringify(l.target?.due_date)})`);
    }
    if (l.target?.kind !== KIND_ALVO) {
      erros.push(`linha ${l.legacy_cashflow_id}: kind tem de ser ${KIND_ALVO}`);
    }
    if (l.target?.status !== "pendente") {
      erros.push(`linha ${l.legacy_cashflow_id}: o pagamento nasce pendente`);
    }
    if (l.target?.recurring !== false) {
      erros.push(`linha ${l.legacy_cashflow_id}: uma factura pontual não cria recorrência`);
    }
    if (String(l.target?.amount) !== String(l.before?.amount)) {
      erros.push(`linha ${l.legacy_cashflow_id}: o valor do pagamento não é o do movimento`);
    }
    const c = competenciaDaDataLegada(l.before?.date);
    if (!c) {
      erros.push(`linha ${l.legacy_cashflow_id}: data legada ilegível no manifesto`);
    } else if (l.target?.period_year !== c.ano || l.target?.period_month !== c.mes) {
      erros.push(
        `linha ${l.legacy_cashflow_id}: competência ${l.target?.period_year}/${l.target?.period_month} ` +
        `não é o mês civil do registo (${c.ano}/${c.mes})`,
      );
    }
    if (l.after?.reference_type !== ORIGEM_PAGAMENTO || l.after?.reference_id !== l.target_payment_id) {
      erros.push(`linha ${l.legacy_cashflow_id}: a ligação prevista não aponta para o pagamento novo`);
    }
    if (l.after?.status !== "pendente") {
      erros.push(`linha ${l.legacy_cashflow_id}: o movimento continua pendente até o dinheiro sair`);
    }
    for (const campo of ["amount", "date", "type", "description", "created_at"]) {
      if (String(l.after?.[campo]) !== String(l.before?.[campo])) {
        erros.push(`linha ${l.legacy_cashflow_id}: a reparação não pode alterar \`${campo}\``);
      }
    }
  }

  if (empresas.size > 1) erros.push(`o manifesto mistura ${empresas.size} empresas`);

  return erros.length === 0 ? { ok: true } : { ok: false, erros };
}

// ─── Rollback ────────────────────────────────────────────────────────────────

/**
 * O que a reversão faz, e o que a impede.
 *
 * 🔴 Só é segura enquanto nada aconteceu depois. Se um dos pagamentos já foi
 *    pago, ou editado, ou se um dos movimentos mudou, a reversão **recusa**.
 *    Apagar um pagamento que entretanto alguém marcou como pago destruiria
 *    actividade real — e é actividade que ninguém saberia que desapareceu.
 */
export function planoRollback(manifesto, estadoActual) {
  const impedimentos = [];
  const linhas = manifesto?.linhas ?? [];

  for (const l of linhas) {
    const pag = estadoActual.pagamentos?.[l.target_payment_id];
    const mov = estadoActual.movimentos?.[l.legacy_cashflow_id];

    if (!pag) {
      impedimentos.push(`o pagamento ${l.target_payment_id} já não existe — a reversão não sabe o que desfazer`);
      continue;
    }
    if (pag.status !== "pendente") {
      impedimentos.push(`o pagamento ${l.target_payment_id} está \`${pag.status}\` — houve actividade depois do repair`);
    }
    if (String(pag.amount) !== String(l.target.amount)) {
      impedimentos.push(`o pagamento ${l.target_payment_id} mudou de valor depois do repair`);
    }
    if (pag.due_date !== null && pag.due_date !== undefined) {
      impedimentos.push(`o pagamento ${l.target_payment_id} ganhou um vencimento — alguém trabalhou nele`);
    }

    if (!mov) {
      impedimentos.push(`o movimento ${l.legacy_cashflow_id} já não existe`);
      continue;
    }
    if (mov.reference_id !== l.target_payment_id) {
      impedimentos.push(`o movimento ${l.legacy_cashflow_id} já não aponta para o pagamento do repair`);
    }
    if (mov.status !== "pendente") {
      impedimentos.push(`o movimento ${l.legacy_cashflow_id} está \`${mov.status}\` — o dinheiro já saiu`);
    }
  }

  if (impedimentos.length > 0) return { ok: false, impedimentos };

  return {
    ok: true,
    passos: linhas.map((l) => ({
      // A ordem importa: desligar primeiro, apagar depois. Apagar o pagamento
      // com o movimento ainda a apontar-lhe deixaria um vínculo partido no
      // intervalo — e se a transacção falhasse a meio, ficava assim.
      desligar: {
        cash_flow_id: l.legacy_cashflow_id,
        para: { reference_type: l.before.reference_type, reference_id: l.before.reference_id },
      },
      apagar_pagamento: l.target_payment_id,
    })),
  };
}

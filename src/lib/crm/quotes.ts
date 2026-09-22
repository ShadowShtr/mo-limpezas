// ============================================================================
// CRM — o vocabulário do orçamento
// ============================================================================
//
// 🔴 Sem `"use server"`: são constantes e funções puras. Ver a nota em
//    `stages.ts` — um `"use server"` que exporte um objeto compila e rebenta
//    em runtime.
//
// Tudo o que está aqui é ESPELHO do que a migration 103 já impõe:
//
//   · `QUOTE_STATUSES`      ↔ CHECK de `crm_quotes.status`
//   · `QUOTE_TRANSITIONS`   ↔ a matriz de `set_crm_quote_status`
//   · `QUOTE_UNITS`         ↔ CHECK de `crm_quote_items.unit`
//   · `QUOTE_PRICING_KINDS` ↔ CHECK de `crm_quotes.pricing_kind`
//   · `totaisDoOrcamento`   ↔ a aritmética das duas RPC de escrita
//
// `crm-quotes-vocabulary.test.ts` lê o SQL da 103 e compara cada uma destas
// listas com o CHECK correspondente. Divergir aqui é vermelho, não é opinião:
// uma lista a mais nesta ficha oferece ao utilizador um estado que a base
// recusa, e o erro só aparece depois de ele carregar no botão.
// ============================================================================

export const QUOTE_STATUSES = [
  "rascunho",
  "enviado",
  "aceite",
  "recusado",
  "expirado",
  "anulado",
] as const;

export type QuoteStatus = (typeof QUOTE_STATUSES)[number];

export function isQuoteStatus(value: unknown): value is QuoteStatus {
  return typeof value === "string" && (QUOTE_STATUSES as readonly string[]).includes(value);
}

export const QUOTE_STATUS_LABELS: Record<QuoteStatus, string> = {
  rascunho: "Rascunho",
  enviado: "Enviado",
  aceite: "Aceite",
  recusado: "Recusado",
  expirado: "Expirado",
  anulado: "Anulado",
};

/**
 * Para onde cada estado pode ir.
 *
 * 🔴 `rascunho → enviado` ESTÁ aqui, e a presença é o ponto.
 *
 *    O envio automático por email é a 103-B2 e não existe neste ciclo. Tirar
 *    `enviado` das transições com o raciocínio de que só o email o pode marcar
 *    deixaria o orçamento preso em rascunho para sempre. Na prática o
 *    orçamento sai por PDF, por mão, como já saía antes de haver aplicação
 *    nenhuma; quem o mandou é que sabe que o mandou, e tem de o poder dizer.
 *
 *    Quando a B2 chegar, acrescenta uma forma AUTOMÁTICA de chegar a
 *    `enviado`. Não retira a manual.
 *
 * `aceite` e `anulado` não aparecem como origem: a base trata-os como finais
 * (`QUOTE_ACCEPTED_IMMUTABLE`, `QUOTE_VOIDED_IMMUTABLE`).
 */
export const QUOTE_TRANSITIONS: Record<QuoteStatus, readonly QuoteStatus[]> = {
  rascunho: ["enviado", "anulado"],
  enviado: ["aceite", "recusado", "expirado", "anulado"],
  expirado: ["aceite", "recusado", "anulado"],
  recusado: ["anulado"],
  aceite: [],
  anulado: [],
};

/** Os destinos que a base aceita a partir deste estado. */
export function allowedQuoteTransitions(from: QuoteStatus): readonly QuoteStatus[] {
  return QUOTE_TRANSITIONS[from] ?? [];
}

export function canTransitionQuote(from: QuoteStatus, to: QuoteStatus): boolean {
  return allowedQuoteTransitions(from).includes(to);
}

/**
 * Um orçamento que já não muda de estado por vontade de ninguém.
 *
 * Um substituído também não muda — mas isso não se lê no estado, lê-se em
 * `superseded_by_id`, e por isso não está nesta função.
 */
export function isQuoteFinal(status: QuoteStatus): boolean {
  return allowedQuoteTransitions(status).length === 0;
}

/**
 * Os estados a partir dos quais uma revisão é possível.
 *
 * 🔴 `rascunho` NÃO está aqui, e não por esquecimento: `revise_crm_quote`
 *    recusa-o explicitamente com `QUOTE_DRAFT_EDIT_IN_PLACE`. Um rascunho
 *    não se revê — corrige-se. Mas corrigir in-place precisa de uma RPC
 *    atómica que a 103 não tem (ver o cabeçalho de `crm-orcamentos.ts`), por
 *    isso neste ciclo um rascunho errado anula-se e faz-se outro.
 */
export const QUOTE_REVISABLE_STATUSES = ["enviado", "recusado", "expirado"] as const;

export function canReviseQuote(quote: {
  status: string;
  superseded_by_id: string | null;
}): boolean {
  return (
    isQuoteStatus(quote.status)
    && (QUOTE_REVISABLE_STATUSES as readonly string[]).includes(quote.status)
    && quote.superseded_by_id === null
  );
}

export const QUOTE_UNITS = ["hora", "m2", "unidade", "mes", "servico"] as const;

export type QuoteUnit = (typeof QUOTE_UNITS)[number];

export const QUOTE_UNIT_LABELS: Record<QuoteUnit, string> = {
  hora: "hora",
  m2: "m²",
  unidade: "unidade",
  mes: "mês",
  servico: "serviço",
};

export const QUOTE_PRICING_KINDS = ["pontual", "mensal"] as const;

export type QuotePricingKind = (typeof QUOTE_PRICING_KINDS)[number];

export const QUOTE_PRICING_KIND_LABELS: Record<QuotePricingKind, string> = {
  pontual: "Serviço pontual",
  mensal: "Avença mensal",
};

/** Validade por omissão de um orçamento, em dias. */
export const QUOTE_DEFAULT_VALIDITY_DAYS = 30;

// ---------------------------------------------------------------------------
// 🔴 O DOMÍNIO DECIMAL: seis casas, e nem mais uma
// ---------------------------------------------------------------------------
//
// `micros()` trabalha em escala 1e-6 e trunca o que vem além da sexta casa.
// Enquanto os schemas aceitavam qualquer `number`, isso abria um buraco de
// paridade — o servidor aceitava valores que a pré-visualização não reproduz:
//
//     quantidade 100000 × preço 0,000000051
//        Postgres  round(0,0051, 2) = 0,01
//        runtime                     = 0,00      ← a sétima casa desapareceu
//
//     quantidade 100000 × preço 0,000001051
//        Postgres  round(0,1051, 2) = 0,11
//        runtime                     = 0,10
//
// Não se resolve alargando a escala: qualquer escala finita tem uma casa a
// seguir à última. Resolve-se FECHANDO O DOMÍNIO — o que entra é o que a
// aritmética reproduz exactamente, e o resto é recusado antes de chegar à RPC.
//
// A frase que se pode dizer depois disto é «`totaisDoOrcamento` é paritário
// com o PostgreSQL para o domínio aceite pelo runtime», e não «para qualquer
// number».

/** Casas decimais que o runtime reproduz exactamente. */
export const QUOTE_MAX_DECIMAL_PLACES = 6;

/**
 * Quantas casas decimais tem o valor, lendo a sua representação decimal.
 *
 * 🔴 NÃO se faz `Number.isInteger(value * 1e6)`. A multiplicação em binário
 *    introduz precisamente o erro que se quer medir: `0.000001051 * 1e6` dá
 *    1.0509999999999999, que não é inteiro — mas `1.000001 * 1e6` dá
 *    1000000.9999999999, que também não é, e esse é legítimo. O teste passaria
 *    a depender do lixo de arredondamento em vez do número escrito.
 *
 * 🔴 A notação exponencial TEM de ser tratada. `String(0.000000051)` é
 *    `"5.1e-8"`: contar o que vem depois de um ponto que não existe daria zero
 *    casas, e o valor mais perigoso de todos passaria como inteiro.
 *
 *    Com expoente, as casas efectivas são `casas(mantissa) − expoente`:
 *    `5.1e-8` → 1 − (−8) = 9. Um expoente positivo consome casas
 *    (`1.5e3` = 1500 → 1 − 3 = −2, limitado a 0).
 *
 * Um valor não finito devolve `Infinity` — não tem representação decimal, e
 * falha qualquer limite.
 */
export function decimalPlaces(value: number): number {
  if (!Number.isFinite(value)) return Number.POSITIVE_INFINITY;

  const s = String(Math.abs(value));
  const e = s.indexOf("e");

  if (e === -1) {
    const ponto = s.indexOf(".");
    return ponto === -1 ? 0 : s.length - ponto - 1;
  }

  const mantissa = s.slice(0, e);
  const expoente = Number(s.slice(e + 1));
  const ponto = mantissa.indexOf(".");
  const casasMantissa = ponto === -1 ? 0 : mantissa.length - ponto - 1;

  return Math.max(0, casasMantissa - expoente);
}

/** O valor cabe no domínio que a aritmética reproduz exactamente? */
export function hasMaxDecimalPlaces(value: number, max = QUOTE_MAX_DECIMAL_PLACES): boolean {
  return decimalPlaces(value) <= max;
}

/** A mesma frase em todo o lado onde o domínio é recusado. */
export const QUOTE_DECIMAL_MESSAGE = `Use no máximo ${QUOTE_MAX_DECIMAL_PLACES} casas decimais.`;

export interface QuoteItemAmounts {
  quantity: number;
  unit_price: number;
}

export interface QuoteTotals {
  subtotal: number;
  base: number;
  vatAmount: number;
  total: number;
}

// ---------------------------------------------------------------------------
// 🔴 A aritmética é feita em CÊNTIMOS INTEIROS, não em vírgula flutuante.
// ---------------------------------------------------------------------------
//
// `Math.round(x * 100) / 100` não reproduz o `round(x, 2)` do Postgres, e a
// diferença aparece em euros. `round()` opera sobre `numeric` — decimal
// exacto, meio arredondado para longe do zero — enquanto o produto em binário
// cai às vezes ligeiramente abaixo do meio: `8.615 * 100` dá 861.4999999999999
// e o arredondamento binário desce para 8.61 onde a base sobe para 8.62.
// `toFixed` tem o mesmo problema, porque parte do mesmo double.
//
// Com inteiros não há meio ambíguo: a decisão é `resto × 2 >= divisor`, e é
// exacta. `crm-quote-runtime-parity.pg.test.ts` compara valor a valor contra o
// Postgres a sério, casos de meio incluídos.

// ---------------------------------------------------------------------------
// 🔴 As escalas, e porque é que o cálculo NÃO quantiza a entrada a 2 decimais
// ---------------------------------------------------------------------------
//
// É tentador arredondar quantidade e preço a dois decimais antes de
// multiplicar, «porque as colunas são `numeric(10,2)`». Está errado, e o
// ensaio de paridade contra Postgres real provou-o:
//
//     unit_price escrito 0,335 · quantidade 3
//       coluna unit_price  → 0,34   (a coluna quantiza no INSERT)
//       line_total gravado → 1,01   (= round(3 × 0,335, 2))
//
// A RPC calcula `round((i->>'quantity')::numeric * (i->>'unit_price')::numeric, 2)`
// sobre o JSONB — os valores COMO FORAM ESCRITOS, sem quantização. A coluna
// só arredonda o preço que guarda. Quantizar primeiro daria 3 × 0,34 = 1,02:
// um cêntimo a mais do que o documento.
//
// (E é por isso que o PDF mostra `line_total`, e nunca `quantity × unit_price`
// lidos da base: esses dois não se multiplicam de volta ao total gravado.)
//
// Escalas usadas: os valores escritos vivem em micro-unidades (1e-6, seis
// decimais), os montantes em cêntimos (1e-2).

// 🔴 Constantes `BigInt(...)` em vez dos literais de bigint com sufixo: esses
//    exigem `target` >= ES2020 e o `tsconfig.json` deste projecto tem ES2017.
//    Mudar o alvo global do compilador — que afecta o bundle inteiro — por uma
//    questão de notação não se justifica.
const ZERO = BigInt(0);
const UM = BigInt(1);
const DOIS = BigInt(2);

/** Divisão inteira com o meio arredondado para cima. `n` e `d` positivos. */
function roundDiv(n: bigint, d: bigint): bigint {
  const q = n / d;
  const resto = n - q * d;
  return resto * DOIS >= d ? q + UM : q;
}

/**
 * O valor em micro-unidades (1e-6) — o literal decimal, tal como foi escrito.
 *
 * 🔴 `BigInt`, e não `number`: o produto de duas micro-unidades chega a 1e23,
 *    muito acima de `Number.MAX_SAFE_INTEGER`. Em `number` o produto perderia
 *    precisão exactamente onde a conta tem de ser exacta.
 *
 * Parte-se da representação decimal CURTA (`String`), que é o que a pessoa
 * escreveu — é esse o literal que o Postgres receberia — e não de `toFixed`,
 * que arrasta o erro binário do double.
 */
function micros(valor: number): bigint {
  if (!Number.isFinite(valor) || valor === 0) return ZERO;

  let s = String(Math.abs(valor));
  // Notação exponencial (valores minúsculos ou enormes): seis decimais bastam
  // para o que depois é arredondado a dois.
  if (s.includes("e") || s.includes("E")) s = Math.abs(valor).toFixed(6);

  const [inteiro, frac = ""] = s.split(".");
  const m = BigInt(inteiro) * BigInt(1_000_000) + BigInt(`${frac}000000`.slice(0, 6));
  return valor < 0 ? -m : m;
}

/** 1e-6 × 1e-6 = 1e-12; daí a cêntimos (1e-2) divide-se por 1e10. */
const PRODUTO_PARA_CENTIMOS = BigInt(10_000_000_000);
/** Um factor percentual em escala 1e-8: `1` é 100_000_000. */
const UM_EM_1E8 = BigInt(100_000_000);

/**
 * Os totais de um orçamento — a mesma aritmética das RPC, pela mesma ordem.
 *
 * 🔴 A ORDEM das operações faz parte do contrato, não é detalhe de estilo. As
 *    RPC fazem:
 *
 *      subtotal = Σ round(quantidade × preço, 2)      ← arredonda por LINHA
 *      base     = round(subtotal × (1 − desconto/100), 2)
 *      iva      = round(base × taxa/100, 2)           ← sobre a BASE, não o subtotal
 *      total    = base + iva                          ← soma exacta, sem round
 *
 *    Arredondar no fim em vez de por linha dá diferenças de cêntimos que o
 *    cliente vê no PDF e a base não confirma. E calcular o IVA sobre o
 *    subtotal em vez da base cobra imposto sobre um desconto que foi dado.
 *
 * Isto é PRÉ-VISUALIZAÇÃO. Os valores que valem são os que a base gravou — o
 * PDF e o detalhe leem `crm_quotes`, nunca esta função.
 */
export function totaisDoOrcamento(
  itens: readonly QuoteItemAmounts[],
  opts: { discountPct?: number | null; applyVat?: boolean | null; vatRate?: number | null },
): QuoteTotals {
  // Σ round(qtd × preço, 2) — o arredondamento é por LINHA.
  const subtotalC = itens.reduce(
    (acc, i) =>
      acc
      + roundDiv(micros(Number(i.quantity)) * micros(Number(i.unit_price)), PRODUTO_PARA_CENTIMOS),
    ZERO,
  );

  // round(subtotal × (1 − desconto/100), 2).
  // `desconto/100` em escala 1e-8 é exactamente o desconto em micros.
  const descontoM = micros(Number(opts.discountPct ?? 0));
  const descontoLimitado =
    descontoM < ZERO ? ZERO : descontoM > UM_EM_1E8 ? UM_EM_1E8 : descontoM;
  const factor = UM_EM_1E8 - descontoLimitado;
  const baseC = roundDiv(subtotalC * factor, UM_EM_1E8);

  // round(base × taxa/100, 2), pela mesma escala.
  const taxaM = micros(Number(opts.vatRate ?? 0));
  const aplicaIva = (opts.applyVat ?? true) && taxaM > ZERO;
  const ivaC = aplicaIva ? roundDiv(baseC * taxaM, UM_EM_1E8) : ZERO;

  // 🔴 `base + iva` sem arredondar: é o que a RPC faz
  //    (`v_total := v_base + v_iva`). Os dois já são `numeric(10,2)` e a soma
  //    é exacta — em cêntimos inteiros também é.
  return {
    subtotal: Number(subtotalC) / 100,
    base: Number(baseC) / 100,
    vatAmount: Number(ivaC) / 100,
    total: Number(baseC + ivaC) / 100,
  };
}

/** `ORC2026/001-R1` → `ORC2026/001`. A raiz da cadeia, para agrupar. */
export function quoteNumberRoot(numero: string): string {
  return numero.split("-R")[0];
}

// ============================================================================
// T11 — IVA canónico
// ============================================================================
//
// 🚨 INTEGRIDADE DE DADOS FINANCEIROS
// Módulo puro. Não lê nem escreve dados. Não altera nenhum valor persistido.
//
// ----------------------------------------------------------------------------
//
// O problema que resolve.
//
// Havia (e continua a haver, até os consumidores serem ligados) quatro formas
// distintas de aplicar IVA no repositório:
//
//   1. `withVat()` em `src/lib/service-value.ts`
//         base * (1 + taxa/100), arredondado no fim → devolve só o GROSS
//   2. `financial-dashboard.ts`
//         base * (1 + vatFactor), acumulado sem arredondar, arredondado no fim
//   3. `reports.ts`
//         iva += base * vatFactor, acumulado, arredondado no fim (separa IVA)
//   4. `invoices.ts`
//         vatAmount = round(taxedBase * vatFactor), sobre a base já somada
//
// As quatro dão o mesmo número num serviço isolado e divergem em somas, porque
// arredondam em momentos diferentes. Pior: (1) e (2) devolvem um total sem
// nunca materializar o valor do IVA, o que torna impossível reconciliar com a
// fatura, que precisa das três parcelas em separado.
//
// A decisão da T11: uma função, três parcelas explícitas, invariante fechada.
//
//   net + vat = gross    (sempre, exactamente, em cêntimos inteiros)
//
// A taxa NUNCA está fixa em código. Vem sempre de `company_settings.vat_rate`
// através de quem chama. As fixtures usam 23% como exemplo por ser a taxa
// portuguesa corrente, mas o domínio recebe-a como parâmetro.

import {
  type MoneyCents,
  ZERO_CENTS,
  assertMoneyCents,
  multiplyCents,
} from "./money";

/**
 * As três parcelas de um montante. Nunca devolver só uma delas: foi
 * precisamente isso que permitiu chamar "total" a coisas diferentes.
 */
export interface VatBreakdown {
  /** Base tributável, sem IVA. */
  netCents: MoneyCents;
  /** Imposto. Zero quando não se aplica. */
  vatCents: MoneyCents;
  /** Net + VAT. Nunca calculado à parte — sempre derivado. */
  grossCents: MoneyCents;
  /** Taxa efectivamente aplicada, em pontos percentuais. Zero se isento. */
  appliedRatePct: number;
}

/** O que determina se há imposto. Explícito para não haver default escondido. */
export interface VatPolicy {
  /** `contracts.apply_vat` / `services.apply_vat`. */
  applyVat: boolean;
  /** `company_settings.vat_rate`, em pontos percentuais (ex.: 23). */
  ratePct: number;
  /**
   * `clients.vat_exempt`. Um cliente isento anula o `applyVat` da linha — é
   * assim que `generateInvoices` já se comporta hoje, e a regra fiscal é do
   * cliente, não do serviço.
   */
  clientExempt?: boolean;
}

function isUsableRate(ratePct: number): boolean {
  return Number.isFinite(ratePct) && ratePct > 0;
}

/** `true` se esta política produz imposto. */
export function vatApplies(policy: VatPolicy): boolean {
  if (policy.clientExempt === true) return false;
  if (!policy.applyVat) return false;
  return isUsableRate(policy.ratePct);
}

/**
 * Decompõe uma base tributável nas três parcelas.
 *
 * Arredonda **uma única vez**, sobre o imposto, e deriva o gross por soma
 * inteira. É o que garante `net + vat = gross` sem excepções — incluindo
 * quando a taxa produz meios cêntimos (ex.: 0,01 € a 23% = 0,0023 €).
 */
export function applyVat(netCents: MoneyCents, policy: VatPolicy): VatBreakdown {
  assertMoneyCents(netCents, "applyVat.netCents");

  if (!vatApplies(policy)) {
    return {
      netCents,
      vatCents: ZERO_CENTS,
      grossCents: netCents,
      appliedRatePct: 0,
    };
  }

  const vatCents = multiplyCents(netCents, policy.ratePct / 100);
  return {
    netCents,
    vatCents,
    grossCents: assertMoneyCents(netCents + vatCents, "applyVat.grossCents"),
    appliedRatePct: policy.ratePct,
  };
}

/**
 * Soma decomposições preservando a invariante.
 *
 * Repara-se que o total do IVA é a **soma dos IVAs já arredondados por linha**,
 * e não o IVA da base somada. As duas contas diferem em cêntimos, e esta é a
 * que a fatura tem de usar: o cliente vê as linhas, e as linhas têm de somar
 * exactamente o rodapé.
 *
 * `appliedRatePct` só se mantém se todas as parcelas com imposto usarem a mesma
 * taxa; caso contrário fica 0, porque um número único deixaria de ter
 * significado (é também o que `invoices.ts` já grava quando não há imposto).
 */
export function sumVatBreakdowns(parts: readonly VatBreakdown[]): VatBreakdown {
  let net = 0;
  let vat = 0;
  const rates = new Set<number>();

  for (const p of parts) {
    net += p.netCents;
    vat += p.vatCents;
    if (p.vatCents !== 0) rates.add(p.appliedRatePct);
  }

  return {
    netCents: assertMoneyCents(net, "sumVatBreakdowns.net"),
    vatCents: assertMoneyCents(vat, "sumVatBreakdowns.vat"),
    grossCents: assertMoneyCents(net + vat, "sumVatBreakdowns.gross"),
    appliedRatePct: rates.size === 1 ? [...rates][0] : 0,
  };
}

/**
 * Caminho inverso: a partir de um total COM imposto, recupera a base.
 *
 * Necessário porque parte da UI actual guarda e mostra valores já com IVA
 * (o tooltip do calendário, por exemplo, parte de `withVat`). Sem isto, ligar
 * a nova UI obrigaria a inventar a base.
 *
 * O gross é reconstruído por soma para a invariante se manter fechada mesmo
 * quando o arredondamento da divisão não é reversível.
 */
export function extractVatFromGross(grossCents: MoneyCents, policy: VatPolicy): VatBreakdown {
  assertMoneyCents(grossCents, "extractVatFromGross.grossCents");

  if (!vatApplies(policy)) {
    return {
      netCents: grossCents,
      vatCents: ZERO_CENTS,
      grossCents,
      appliedRatePct: 0,
    };
  }

  const net = multiplyCents(grossCents, 1 / (1 + policy.ratePct / 100));
  const vat = assertMoneyCents(grossCents - net, "extractVatFromGross.vat");
  return {
    netCents: net,
    vatCents: vat,
    grossCents,
    appliedRatePct: policy.ratePct,
  };
}

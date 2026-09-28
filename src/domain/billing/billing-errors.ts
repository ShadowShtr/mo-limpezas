// ============================================================================
// Recusas das RPCs de cobrança — da base para quem está ao balcão
// ============================================================================
//
// As RPCs 086/091/097 recusam com códigos estáveis no início da mensagem
// (`MANUAL_CHARGE_HAS_PAYMENT`, `FINANCIAL_PERIOD_CLOSED: 2026-08`, …). O
// código decide; a frase é para ler. Nenhum nome de tabela, função ou coluna
// chega ao ecrã.
//
// 🔴 Uma recusa conhecida é traduzida; uma desconhecida NÃO é mostrada crua.
//    Devolve-se `null` e quem chama regista o detalhe no servidor e mostra a
//    mensagem genérica. Mostrar a mensagem do Postgres a quem gere a empresa
//    não ajuda ninguém e pode expor o esquema.
// ============================================================================

export type BillingRefusal =
  | "PERIOD_CLOSED"
  | "PERIOD_UNKNOWN"
  | "HAS_PAYMENT"
  | "AMOUNT_LOCKED"
  | "CLIENT_LOCKED"
  | "CLIENT_FOREIGN"
  | "VOIDED"
  | "NOT_FOUND"
  | "INVALID_INPUT"
  | "DELETE_BLOCKED_BY_PAYMENT";

const REGRAS: ReadonlyArray<{ padrao: RegExp; codigo: BillingRefusal; mensagem: string }> = [
  {
    padrao: /FINANCIAL_PERIOD_CLOSED/,
    codigo: "PERIOD_CLOSED",
    mensagem: "Este mês está fechado. Reabra o período no Financeiro antes de alterar esta cobrança.",
  },
  {
    padrao: /FINANCIAL_PERIOD_(STATE_UNKNOWN|LOCK_)/,
    codigo: "PERIOD_UNKNOWN",
    mensagem: "Não foi possível confirmar se o mês está aberto. Nada foi alterado — tente de novo.",
  },
  {
    padrao: /MANUAL_CHARGE_HAS_PAYMENT/,
    codigo: "HAS_PAYMENT",
    mensagem: "Esta cobrança tem um recebimento registado. Remova o recebimento antes de a excluir.",
  },
  {
    padrao: /MANUAL_CHARGE_PAID_AMOUNT_LOCKED/,
    codigo: "AMOUNT_LOCKED",
    mensagem: "Esta cobrança já tem recebimento. Remova-o antes de alterar o valor ou o IVA.",
  },
  {
    padrao: /MANUAL_CHARGE_CLIENT_LOCKED/,
    codigo: "CLIENT_LOCKED",
    mensagem: "Esta cobrança já tem recebimento. Remova-o antes de mudar o cliente.",
  },
  {
    padrao: /MANUAL_CHARGE_CLIENT_FOREIGN/,
    codigo: "CLIENT_FOREIGN",
    mensagem: "O cliente escolhido não é válido. Atualize a página e escolha de novo.",
  },
  {
    padrao: /MANUAL_CHARGE_VOIDED/,
    codigo: "VOIDED",
    mensagem: "Esta cobrança já foi excluída. Atualize a página.",
  },
  {
    padrao: /MANUAL_CHARGE_NOT_FOUND|SERVICE_NOT_FOUND|Serviço não encontrado/,
    codigo: "NOT_FOUND",
    mensagem: "Este registo já não existe. Atualize a página.",
  },
  {
    padrao: /SERVICE_DELETE_BLOCKED_BY_PAYMENT/,
    codigo: "DELETE_BLOCKED_BY_PAYMENT",
    mensagem: "Este serviço tem um recebimento registado. Remova o recebimento antes de o excluir.",
  },
  {
    padrao: /(MANUAL_CHARGE|SERVICE_PAYMENT)_(STATUS_INVALID|AMOUNT_INVALID|STATUS_AMOUNT_INCOHERENT|DESCRIPTION_REQUIRED|INVALID_ARGS|FIELD_NOT_EDITABLE)/,
    codigo: "INVALID_INPUT",
    mensagem: "Os dados indicados não são válidos para esta operação. Verifique o valor e o estado.",
  },
];

export function interpretBillingRefusal(
  message: string | null | undefined,
): { code: BillingRefusal; message: string } | null {
  const texto = message ?? "";
  for (const regra of REGRAS) {
    if (regra.padrao.test(texto)) return { code: regra.codigo, message: regra.mensagem };
  }
  return null;
}

export const BILLING_GENERIC_FAILURE =
  "Não foi possível concluir a operação. Nada foi alterado — atualize a página e tente de novo.";

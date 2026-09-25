import { revalidatePath } from "next/cache";

// Helper central de revalidação (Causa 9 da auditoria de reversões).
//
// Depois de uma server action gravar dados, é preciso chamar revalidatePath
// para cada rota afetada — senão outras páginas continuam a mostrar a versão
// em cache até recarregar manualmente ("gravei numa aba e a outra não
// mostra"). A cobertura tinha buracos: alterações financeiras de contrato
// não revalidavam /dashboard/cobrancas. Esta é a matriz única — qualquer
// action nova usa isto em vez de chamar revalidatePath à mão e arriscar
// esquecer uma rota.
export type BusinessScope =
  | "clientes"
  | "calendario"
  | "contratos"
  | "cobrancas"
  | "financeiro"
  | "locais"
  | "configuracoes"
  | "relatorios"
  | "crm";

export function revalidateBusinessPaths(opts: {
  clientId?: string | null;
  scopes: BusinessScope[];
}) {
  const { clientId, scopes } = opts;
  if (scopes.includes("clientes")) {
    revalidatePath("/dashboard/clientes");
    if (clientId) revalidatePath(`/dashboard/clientes/${clientId}`);
  }
  if (scopes.includes("calendario")) revalidatePath("/dashboard/calendario");
  if (scopes.includes("contratos")) revalidatePath("/dashboard/contratos");
  if (scopes.includes("cobrancas")) revalidatePath("/dashboard/cobrancas");
  if (scopes.includes("financeiro")) revalidatePath("/dashboard/financeiro");
  if (scopes.includes("locais")) revalidatePath("/dashboard/locais");
  if (scopes.includes("configuracoes")) revalidatePath("/dashboard/configuracoes");
  // As configurações (IVA, taxa horária, subsídio) entram nos cálculos dos
  // relatórios — guardá-las sem revalidar esta rota deixava números antigos
  // no ecrã de quem já a tivesse aberta.
  if (scopes.includes("relatorios")) revalidatePath("/dashboard/relatorios");
  // O funil e a ficha da lead. A ficha entra aqui pelo mesmo motivo que a do
  // cliente: mudar o estado no quadro e voltar à ficha não pode mostrar o
  // estado antigo.
  if (scopes.includes("crm")) {
    revalidatePath("/dashboard/crm");
    revalidatePath("/dashboard/crm/[leadId]", "page");
  }
}

// ─── matriz por domínio (Task T10) ──────────────────────────────────────────
//
// `revalidateBusinessPaths` pede ROTAS. Quem escreve uma action sabe o que
// mudou ("um contrato"), não necessariamente que ecrãs dependem disso — e é aí
// que nascem os buracos: a alteração financeira de um contrato não revalidava
// /dashboard/cobrancas, e ninguém dava por isso até alguém reparar num número
// antigo no ecrã.
//
// A matriz abaixo inverte a pergunta: declara-se o DOMÍNIO que mudou e ela
// resolve os ecrãs afetados. Continua a usar o mesmo helper — não é um
// mecanismo concorrente.

export type BusinessDomain =
  | "contracts"
  | "services"
  | "clients"
  | "locations"
  | "teams"
  | "collaborators"
  | "invoices"
  | "payments"
  | "settings"
  | "leads";

/**
 * Que ecrãs dependem de cada domínio.
 *
 * As dependências indiretas estão aqui de propósito, com a razão à frente —
 * são precisamente as que se esquecem.
 */
export const DOMAIN_SCOPES: Record<BusinessDomain, BusinessScope[]> = {
  // Um contrato define ocorrências futuras (calendário) e o que há a faturar.
  contracts: ["contratos", "calendario", "clientes", "cobrancas", "relatorios"],
  // Um serviço é a unidade de trabalho: conta para horas, receita e cobrança.
  services: ["calendario", "clientes", "cobrancas", "relatorios"],
  // O nome do cliente aparece nos cartões do calendário e nas faturas.
  clients: ["clientes", "calendario", "contratos", "cobrancas"],
  // O valor/hora do local entra no cálculo de cada serviço gerado.
  locations: ["locais", "clientes", "calendario", "contratos", "relatorios"],
  // O tamanho da equipa multiplica o valor do serviço.
  teams: ["calendario", "relatorios"],
  // Horas e ausências entram nos relatórios e na folha.
  collaborators: ["relatorios", "financeiro"],
  invoices: ["cobrancas", "financeiro", "clientes", "relatorios"],
  payments: ["financeiro", "cobrancas", "relatorios"],
  // IVA, taxa horária e subsídio entram em todos os cálculos.
  settings: ["configuracoes", "relatorios", "financeiro", "cobrancas", "calendario"],
  // Uma lead só toca no funil — não entra em faturação, calendário nem mapa.
  // Quando é convertida, quem revalida `clientes`/`locais` é a action de
  // conversão, declarando também esses domínios: é a conversão que os muda,
  // não a lead.
  leads: ["crm"],
};

/** Ecrãs afetados por um conjunto de domínios, sem repetições. */
export function scopesForDomains(domains: readonly BusinessDomain[]): BusinessScope[] {
  const scopes = new Set<BusinessScope>();
  for (const domain of domains) {
    for (const scope of DOMAIN_SCOPES[domain] ?? []) scopes.add(scope);
  }
  return [...scopes].sort();
}

/**
 * Revalida por domínio.
 *
 * Preferir isto a listar rotas à mão: acrescentar um consumidor novo passa a
 * ser uma alteração na matriz, e não uma caça a 126 chamadas espalhadas.
 */
export function invalidateBusinessState(opts: {
  domains: readonly BusinessDomain[];
  clientId?: string | null;
}): void {
  revalidateBusinessPaths({
    clientId: opts.clientId,
    scopes: scopesForDomains(opts.domains),
  });
}

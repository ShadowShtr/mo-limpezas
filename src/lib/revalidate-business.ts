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
  | "clientes" | "calendario" | "contratos" | "cobrancas" | "financeiro" | "locais";

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
}

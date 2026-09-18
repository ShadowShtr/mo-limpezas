import { cache } from "react";
import { createClient } from "@/lib/supabase/server";
import { createAdminClient } from "@/lib/supabase/admin";
import type { User } from "@supabase/supabase-js";
import {
  RESOLUCAO_CODES, resolverPerfilAutenticado, type ResolucaoCode,
} from "@/lib/collaborators/current-profile-resolver";

export interface CurrentProfile {
  id: string;
  company_id: string;
  full_name: string;
  role: string;
  avatar_url: string | null;
  /**
   * 🔴 Aqui porque os layouts têm de o poder ver.
   *
   *    Sem o estado, a app móvel e o dashboard deixavam entrar quem já tinha
   *    levado saída enquanto o token não expirasse. Quem lê este perfil para
   *    decidir acesso passa por `perfilPodeEntrar`.
   */
  status: string | null;
}

/**
 * Devolve o utilizador autenticado. Deduplicado com React.cache: várias chamadas
 * dentro do mesmo render RSC (layout + page) resultam num único pedido ao Auth.
 */
export const getCurrentUser = cache(async (): Promise<User | null> => {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  return user;
});

/**
 * Devolve o perfil do utilizador autenticado (com company_id, role, etc.).
 * Deduplicado com React.cache — layout e páginas partilham o mesmo fetch.
 */
export const getCurrentProfile = cache(async (): Promise<CurrentProfile | null> => {
  const resolucao = await resolverPerfilDaSessao();
  return resolucao.ok ? resolucao.perfil : null;
});

/**
 * O mesmo, mas com a RAZÃO quando não há perfil.
 *
 * 🔴 `getCurrentProfile` devolve `null` para «não há sessão», «não há perfil»
 *    e «a base não respondeu», e os layouts terminam a sessão em qualquer dos
 *    três. Para uma falha de infraestrutura isso é a pior resposta possível:
 *    desliga toda a gente que estiver a trabalhar, e a causa some-se.
 *
 *    O `null` fica para quem só precisa de saber se há perfil. Quem decide
 *    terminar sessão passa a poder distinguir.
 */
export const resolverPerfilDaSessao = cache(async (): Promise<
  | { ok: true; perfil: CurrentProfile }
  | { ok: false; codigo: ResolucaoCode; erro: string }
> => {
  const user = await getCurrentUser();
  if (!user) {
    return { ok: false, codigo: RESOLUCAO_CODES.AUTH_MISSING, erro: "Não autenticado." };
  }

  const admin = createAdminClient();
  const resolucao = await resolverPerfilAutenticado(admin, user.id);
  if (!resolucao.ok) return { ok: false, codigo: resolucao.codigo, erro: resolucao.erro };

  // `avatar_url` e `full_name` não pertencem à decisão de autorização, por isso
  // não estão no resolver canónico — vêm numa leitura à parte, e a sua
  // ausência não é motivo para negar nada.
  const { data } = await admin
    .from("profiles").select("full_name, avatar_url").eq("id", resolucao.perfil.id).maybeSingle();
  const extra = (data ?? {}) as { full_name?: string; avatar_url?: string | null };

  return {
    ok: true,
    perfil: {
      id: resolucao.perfil.id,
      company_id: resolucao.perfil.company_id,
      role: resolucao.perfil.role,
      status: resolucao.perfil.status,
      full_name: extra.full_name ?? "",
      avatar_url: extra.avatar_url ?? null,
    },
  };
});

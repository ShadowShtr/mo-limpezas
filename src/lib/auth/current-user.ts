import { cache } from "react";
import { createClient } from "@/lib/supabase/server";
import { createAdminClient } from "@/lib/supabase/admin";
import type { User } from "@supabase/supabase-js";
import { estadoAutoriza } from "@/domain/collaborators/status";

export interface CurrentProfile {
  id: string;
  company_id: string;
  full_name: string;
  role: string;
  avatar_url: string | null;
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
  const user = await getCurrentUser();
  if (!user) return null;

  const admin = createAdminClient();
  const { data } = await admin
    .from("profiles")
    .select("id, company_id, full_name, role, avatar_url, status")
    .eq("id", user.id)
    .single();

  if (!data) return null;

  // 🔴 Quem não está activo não tem perfil corrente.
  //
  //    Isto corre com service_role, que faz BYPASSRLS — a migration 106 fechou
  //    as políticas e não fecha NADA deste caminho. Devolver o perfil aqui
  //    daria às páginas e aos layouts uma identidade que a base já recusa.
  //
  //    Devolve-se `null`, e não uma variante nova: todos os consumidores já
  //    tratam `null` como «não entra». Um terceiro estado de retorno obrigaria
  //    a mexer em cada um deles, e cada um esquecido seria um buraco.
  if (!estadoAutoriza((data as { status?: unknown }).status)) return null;

  return data as CurrentProfile;
});

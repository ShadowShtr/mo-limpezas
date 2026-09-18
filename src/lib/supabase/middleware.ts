import { createServerClient } from "@supabase/ssr";
import { NextResponse, type NextRequest } from "next/server";
import type { User } from "@supabase/supabase-js";
import type { Database } from "@/types/database";
import { perfilPodeEntrar } from "@/domain/collaborators/access-state";

export async function updateSession(request: NextRequest) {
  let supabaseResponse = NextResponse.next({ request });

  const supabase = createServerClient<Database>(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
    {
      cookies: {
        getAll() {
          return request.cookies.getAll();
        },
        setAll(cookiesToSet) {
          cookiesToSet.forEach(({ name, value }) =>
            request.cookies.set(name, value)
          );
          supabaseResponse = NextResponse.next({ request });
          cookiesToSet.forEach(({ name, value, options }) =>
            supabaseResponse.cookies.set(name, value, options)
          );
        },
      },
    }
  );

  // Resiliente: se o Supabase falhar, tratamos como "sem sessão" em vez de rebentar.
  let user: User | null = null;
  let profileRole: string | null = null;
  // 🔴 `null` significa «não se sabe», e não «pode entrar».
  //
  //    O proxy é fail-open por desenho (uma falha do Supabase não pode
  //    derrubar o site), por isso quem decide o que fazer com a ignorância é
  //    o proxy — mas só a consegue distinguir se ela chegar como `null` em
  //    vez de `true`. Ver a nota em `src/proxy.ts`.
  let profileAtivo: boolean | null = null;
  try {
    const { data } = await supabase.auth.getUser();
    user = data.user;
    if (user) {
      const { data: profile } = await supabase
        .from("profiles").select("role, status").eq("id", user.id).maybeSingle();
      profileRole = profile?.role ?? null;
      if (profile) profileAtivo = perfilPodeEntrar((profile as { status?: string | null }).status);
    }
  } catch (e) {
    console.error("[updateSession] falha a obter sessão:", e);
  }

  return { supabaseResponse, user, profileRole, profileAtivo };
}

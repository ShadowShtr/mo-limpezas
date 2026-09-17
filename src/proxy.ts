import { NextResponse, type NextRequest } from "next/server";
import { updateSession } from "@/lib/supabase/middleware";

const PUBLIC_ROUTES = ["/login"];
const MANAGER_ROUTES = ["/dashboard"];
const COLLABORATOR_ROUTES = ["/app"];

function redirectWithCookies(url: URL, supabaseResponse: NextResponse) {
  const res = NextResponse.redirect(url);
  supabaseResponse.cookies.getAll().forEach((cookie) => {
    res.cookies.set(cookie.name, cookie.value);
  });
  return res;
}

export async function proxy(request: NextRequest) {
  // Contenção: o middleware corre em TODAS as rotas. Se a verificação de sessão
  // falhar (Supabase indisponível, etc.) nunca pode rebentar o site — deixa
  // passar e as próprias páginas fazem o seu guard de autenticação.
  let session: Awaited<ReturnType<typeof updateSession>>;
  try {
    session = await updateSession(request);
  } catch (e) {
    console.error("[proxy] falha na verificação de sessão — fail-open:", e);
    return NextResponse.next({ request });
  }
  const { supabaseResponse, user, profileRole, profileAtivo } = session;
  const pathname = request.nextUrl.pathname;

  const isPublic = PUBLIC_ROUTES.some((r) => pathname.startsWith(r));
  const isManagerRoute = MANAGER_ROUTES.some((r) => pathname.startsWith(r));
  const isCollaboratorRoute = COLLABORATOR_ROUTES.some((r) => pathname.startsWith(r));

  if (!user && (isManagerRoute || isCollaboratorRoute)) {
    const url = request.nextUrl.clone();
    url.pathname = "/login";
    return redirectWithCookies(url, supabaseResponse);
  }

  // 🔴 Quem levou saída não entra, mesmo com a sessão ainda válida.
  //
  //    `profileAtivo === false` é uma resposta, não uma ausência: o perfil foi
  //    lido e diz que esta pessoa saiu. `null` é ignorância — Supabase em
  //    baixo, perfil não encontrado — e aí o proxy continua a deixar passar,
  //    como sempre fez, porque os layouts fazem o seu próprio guard e trancar
  //    o site inteiro por uma falha de leitura seria pior do que o problema.
  //
  //    O `signOut` fica para os layouts: o proxy corre em todas as rotas e
  //    terminar sessões a partir daqui é caro e fácil de disparar por engano.
  if (user && profileAtivo === false && (isManagerRoute || isCollaboratorRoute)) {
    const url = request.nextUrl.clone();
    url.pathname = "/login";
    url.searchParams.set("error", "inactive");
    return redirectWithCookies(url, supabaseResponse);
  }

  // Só redireciona para dentro da app quando o profile foi mesmo confirmado
  // (profileRole veio de public.profiles, não de user_metadata — esse é
  // controlável pelo próprio utilizador e não prova que o profile existe).
  // Sem isso: um utilizador autenticado cujo profile não foi encontrado
  // (ex.: chave administrativa inválida a montante) ficava preso entre
  // /login (aqui) e /dashboard (guard que também não encontra o profile),
  // em loop — ver DashboardLayout.
  // `profileAtivo !== false`: quem saiu fica no /login em vez de ser mandado
  // de volta para dentro do sistema pelo redirect de conveniência.
  if (user && isPublic && profileRole && profileAtivo !== false) {
    const url = request.nextUrl.clone();
    url.pathname = profileRole === "colaborador" ? "/app" : "/dashboard";
    return redirectWithCookies(url, supabaseResponse);
  }

  if (user && isManagerRoute) {
    const role = profileRole ?? (user.user_metadata?.role as string | undefined);
    if (role === "colaborador") {
      const url = request.nextUrl.clone();
      url.pathname = "/app";
      return redirectWithCookies(url, supabaseResponse);
    }
  }

  return supabaseResponse;
}

export const config = {
  matcher: [
    "/((?!_next/static|_next/image|favicon.ico|.*\\.(?:svg|png|jpg|jpeg|gif|webp)$).*)",
  ],
};

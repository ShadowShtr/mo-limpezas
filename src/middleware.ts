import { NextResponse, type NextRequest } from "next/server";
import { updateSession } from "@/lib/supabase/middleware";

const PUBLIC_ROUTES = ["/login"];
const MANAGER_ROUTES = ["/dashboard"];
const COLLABORATOR_ROUTES = ["/app"];

function redirectWithCookies(url: URL, supabaseResponse: NextResponse) {
  const res = NextResponse.redirect(url);
  // Crítico: copiar cookies do Supabase para o redirect para não perder a sessão
  supabaseResponse.cookies.getAll().forEach((cookie) => {
    res.cookies.set(cookie.name, cookie.value);
  });
  return res;
}

export async function middleware(request: NextRequest) {
  const { supabaseResponse, user } = await updateSession(request);
  const pathname = request.nextUrl.pathname;

  const isPublic = PUBLIC_ROUTES.some((r) => pathname.startsWith(r));
  const isManagerRoute = MANAGER_ROUTES.some((r) => pathname.startsWith(r));
  const isCollaboratorRoute = COLLABORATOR_ROUTES.some((r) => pathname.startsWith(r));

  // Não autenticado → redireciona para /login
  if (!user && (isManagerRoute || isCollaboratorRoute)) {
    const url = request.nextUrl.clone();
    url.pathname = "/login";
    return redirectWithCookies(url, supabaseResponse);
  }

  // Autenticado na página pública → redireciona para a área correta
  if (user && isPublic) {
    const role = user.user_metadata?.role as string | undefined;
    const url = request.nextUrl.clone();
    url.pathname = role === "colaborador" ? "/app" : "/dashboard";
    return redirectWithCookies(url, supabaseResponse);
  }

  // Colaborador a tentar aceder ao /dashboard → redireciona para /app
  if (user && isManagerRoute) {
    const role = user.user_metadata?.role as string | undefined;
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

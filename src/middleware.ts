import { NextResponse, type NextRequest } from "next/server";
import { updateSession } from "@/lib/supabase/middleware";

const PUBLIC_ROUTES = ["/login"];
const MANAGER_ROUTES = ["/dashboard"];
const COLLABORATOR_ROUTES = ["/app"];

export async function middleware(request: NextRequest) {
  const { supabaseResponse, user } = await updateSession(request);
  const pathname = request.nextUrl.pathname;

  const isPublic = PUBLIC_ROUTES.some((r) => pathname.startsWith(r));
  const isManagerRoute = MANAGER_ROUTES.some((r) => pathname.startsWith(r));
  const isCollaboratorRoute = COLLABORATOR_ROUTES.some((r) => pathname.startsWith(r));

  // Redireciona para /login se não autenticado e rota protegida
  if (!user && (isManagerRoute || isCollaboratorRoute)) {
    const url = request.nextUrl.clone();
    url.pathname = "/login";
    return NextResponse.redirect(url);
  }

  // Redireciona para /dashboard se já autenticado e tenta aceder /login
  if (user && isPublic) {
    const role = user.user_metadata?.role as string | undefined;
    const url = request.nextUrl.clone();
    url.pathname = role === "colaborador" ? "/app" : "/dashboard";
    return NextResponse.redirect(url);
  }

  // Redireciona colaborador para /app se tentar aceder /dashboard
  if (user && isManagerRoute) {
    const role = user.user_metadata?.role as string | undefined;
    if (role === "colaborador") {
      const url = request.nextUrl.clone();
      url.pathname = "/app";
      return NextResponse.redirect(url);
    }
  }

  return supabaseResponse;
}

export const config = {
  matcher: [
    "/((?!_next/static|_next/image|favicon.ico|.*\\.(?:svg|png|jpg|jpeg|gif|webp)$).*)",
  ],
};

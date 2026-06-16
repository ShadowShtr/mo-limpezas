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
  const { supabaseResponse, user, profileRole } = await updateSession(request);
  const pathname = request.nextUrl.pathname;

  const isPublic = PUBLIC_ROUTES.some((r) => pathname.startsWith(r));
  const isManagerRoute = MANAGER_ROUTES.some((r) => pathname.startsWith(r));
  const isCollaboratorRoute = COLLABORATOR_ROUTES.some((r) => pathname.startsWith(r));

  if (!user && (isManagerRoute || isCollaboratorRoute)) {
    const url = request.nextUrl.clone();
    url.pathname = "/login";
    return redirectWithCookies(url, supabaseResponse);
  }

  if (user && isPublic) {
    const role = profileRole ?? (user.user_metadata?.role as string | undefined);
    const url = request.nextUrl.clone();
    url.pathname = role === "colaborador" ? "/app" : "/dashboard";
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

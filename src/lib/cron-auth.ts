import type { NextRequest } from "next/server";

/**
 * Autorização central para rotas de cron / tarefas internas.
 *
 * Aceita (por ordem):
 *  1. `Authorization: Bearer <CRON_SECRET>` — forma padrão dos Vercel Cron Jobs.
 *  2. `x-cron-secret: <CRON_SECRET>` — chamadas internas (ex.: auto-continuação).
 *  3. `?secret=<CRON_SECRET>` — APENAS fora de produção (testes locais).
 *
 * Em produção o segredo NUNCA é aceite pela query string, para não ficar
 * exposto em logs, histórico do browser ou capturas de ecrã.
 *
 * Devolve `null` se autorizado, ou um objeto com o motivo se não autorizado
 * (para o handler devolver 401/500 conforme o caso).
 */
export function checkCronAuth(req: NextRequest): { ok: true } | { ok: false; status: number; error: string } {
  const secret = process.env.CRON_SECRET;
  if (!secret) return { ok: false, status: 500, error: "Cron secret not configured" };

  const auth = req.headers.get("authorization");
  if (auth && auth === `Bearer ${secret}`) return { ok: true };

  if (req.headers.get("x-cron-secret") === secret) return { ok: true };

  if (process.env.NODE_ENV !== "production") {
    if (req.nextUrl.searchParams.get("secret") === secret) return { ok: true };
  }

  return { ok: false, status: 401, error: "Unauthorized" };
}

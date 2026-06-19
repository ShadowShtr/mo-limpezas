// TASK 08 — Logs leves de performance por rota.
// Emite uma linha estruturada (JSON) para os logs da Vercel. Não escreve no
// banco em cada request (evita virar gargalo). Amostra rotas muito chamadas;
// erros são sempre registados. NUNCA inclui dados sensíveis (token, signed URL,
// GPS, nomes) — apenas metadados operacionais.

export interface RouteMetricInput {
  route: string;                 // ex: "/api/app/uploads/sign"
  method: string;                // GET | POST | PATCH ...
  status: number;                // código HTTP
  durationMs: number;            // duração total
  role?: string | null;          // papel do utilizador (sem id)
  companyId?: string | null;     // tenant (para correlacionar, não é sensível)
  errorSummary?: string | null;  // mensagem curta, sem stack nem dados
  approxBytes?: number | null;   // tamanho aproximado do corpo, se conhecido
}

// Fração de pedidos OK que são registados nas rotas "quentes" (alto volume).
const SAMPLE_RATE = 0.1;

// Rotas de alto volume — amostradas quando OK; sempre registadas em erro.
const HOT_ROUTES = new Set<string>([
  "/api/health",
  "/api/app/timesheet",
  "/api/app/uploads/sign",
  "/api/app/uploads/confirm",
]);

function shouldLog(route: string, status: number): boolean {
  if (status >= 400) return true;               // erros: sempre
  if (!HOT_ROUTES.has(route)) return true;      // rotas normais: sempre
  return Math.random() < SAMPLE_RATE;           // rotas quentes OK: amostra
}

/** Trunca a mensagem de erro e remove quebras de linha (sem stack/dados). */
function safeError(msg: string | null | undefined): string | null {
  if (!msg) return null;
  return msg.replace(/\s+/g, " ").slice(0, 120);
}

/**
 * Regista uma métrica de rota (fire-and-forget). Custo desprezável: uma
 * chamada a console quando passa o filtro de amostragem.
 */
export function recordRouteMetric(input: RouteMetricInput): void {
  try {
    if (!shouldLog(input.route, input.status)) return;
    const line = {
      t: "route_metric",
      ts: new Date().toISOString(),
      route: input.route,
      method: input.method,
      status: input.status,
      ms: Math.round(input.durationMs),
      role: input.role ?? null,
      company: input.companyId ?? null,
      bytes: input.approxBytes ?? null,
      err: safeError(input.errorSummary),
    };
    if (input.status >= 500) console.error(JSON.stringify(line));
    else if (input.status >= 400) console.warn(JSON.stringify(line));
    else console.log(JSON.stringify(line));
  } catch {
    /* observabilidade nunca pode partir a request */
  }
}

/**
 * Envolve um handler de rota, medindo duração e status automaticamente.
 * Útil quando não precisamos de role/company (ex.: /api/health).
 */
export function withRouteMetrics<A extends unknown[]>(
  route: string,
  handler: (...args: A) => Promise<Response> | Response,
) {
  return async (...args: A): Promise<Response> => {
    const start = Date.now();
    try {
      const res = await handler(...args);
      recordRouteMetric({
        route,
        method: (args[0] as Request | undefined)?.method ?? "GET",
        status: res.status,
        durationMs: Date.now() - start,
      });
      return res;
    } catch (err) {
      recordRouteMetric({
        route,
        method: (args[0] as Request | undefined)?.method ?? "GET",
        status: 500,
        durationMs: Date.now() - start,
        errorSummary: err instanceof Error ? err.message : "unhandled",
      });
      throw err;
    }
  };
}

/**
 * Cronómetro ergonómico para handlers de rota:
 *   const m = startRouteTimer("/api/...", req.method);
 *   ... m.setContext({ role, companyId }) ...
 *   return m.finish(response);          // ou m.fail(500, err)
 */
export function startRouteTimer(route: string, method: string) {
  const start = Date.now();
  let role: string | null = null;
  let companyId: string | null = null;
  let approxBytes: number | null = null;

  return {
    setContext(ctx: { role?: string | null; companyId?: string | null; approxBytes?: number | null }) {
      if (ctx.role !== undefined) role = ctx.role;
      if (ctx.companyId !== undefined) companyId = ctx.companyId;
      if (ctx.approxBytes !== undefined) approxBytes = ctx.approxBytes ?? null;
    },
    finish<T extends { status: number }>(res: T, errorSummary?: string | null): T {
      recordRouteMetric({
        route, method, status: res.status, durationMs: Date.now() - start,
        role, companyId, approxBytes, errorSummary: errorSummary ?? null,
      });
      return res;
    },
    record(status: number, errorSummary?: string | null) {
      recordRouteMetric({
        route, method, status, durationMs: Date.now() - start,
        role, companyId, approxBytes, errorSummary: errorSummary ?? null,
      });
    },
  };
}

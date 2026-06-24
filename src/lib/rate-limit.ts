import { NextResponse } from "next/server";

// ─── Tipos ────────────────────────────────────────────────────────────────────

interface RateLimitRecord {
  count: number;
  resetAt: number;
}

// ─── In-memory fallback (dev / sem Upstash configurado) ───────────────────────

const store = new Map<string, RateLimitRecord>();

function inMemoryAllow(key: string, max: number, windowMs: number): boolean {
  const now = Date.now();
  const record = store.get(key);
  if (!record || now >= record.resetAt) {
    store.set(key, { count: 1, resetAt: now + windowMs });
    return true;
  }
  if (record.count >= max) return false;
  record.count += 1;
  return true;
}

// ─── Upstash Redis (produção distribuída) ─────────────────────────────────────

type Duration = `${number} ${"ms" | "s" | "m" | "h" | "d"}`;

function msToUpstashDuration(ms: number): Duration {
  const s = ms / 1000;
  if (s < 60) return `${Math.round(s)} s`;
  const m = Math.round(s / 60);
  if (m < 60) return `${m} m`;
  return `${Math.round(m / 60)} h`;
}

// Lazy singleton — evita imports desnecessários quando Upstash não está configurado
type UpstashMod = { Ratelimit: typeof import("@upstash/ratelimit").Ratelimit; Redis: typeof import("@upstash/redis").Redis };
let upstashMod: UpstashMod | null = null;
let upstashLoaded = false;

// Aceita tanto os nomes nativos do Upstash (UPSTASH_REDIS_REST_*) como os criados
// pela integração Vercel/Upstash (KV_REST_API_*) — apontam para o mesmo endpoint REST.
function getUpstashCreds(): { url: string; token: string } | null {
  const url = process.env.UPSTASH_REDIS_REST_URL ?? process.env.KV_REST_API_URL;
  const token = process.env.UPSTASH_REDIS_REST_TOKEN ?? process.env.KV_REST_API_TOKEN;
  return url && token ? { url, token } : null;
}

async function getUpstashLimiter(max: number, windowMs: number) {
  const creds = getUpstashCreds();
  // Em produção o fallback in-memory não é fiável entre instâncias Vercel.
  if (!creds) {
    if (process.env.NODE_ENV === "production") {
      console.warn("Rate limit a usar fallback local: UPSTASH_REDIS_REST_URL/TOKEN nao configurados.");
    }
    return null;
  }
  try {
    if (!upstashLoaded) {
      upstashLoaded = true;
      const [rl, r] = await Promise.all([
        import("@upstash/ratelimit"),
        import("@upstash/redis"),
      ]);
      upstashMod = { Ratelimit: rl.Ratelimit, Redis: r.Redis };
    }
    if (!upstashMod) return null;

    const { Ratelimit, Redis } = upstashMod;
    const redis = new Redis({ url: creds.url, token: creds.token });
    return new Ratelimit({
      redis,
      limiter: Ratelimit.slidingWindow(max, msToUpstashDuration(windowMs)),
      prefix: "rl",
    });
  } catch {
    return null;
  }
}

// ─── API Pública ──────────────────────────────────────────────────────────────

/** Chave de rate limit estável a partir de um prefixo e identificador. */
export function rateLimitKey(prefix: string, identifier: string): string {
  return `${prefix}:${identifier}`;
}

/**
 * Para API routes — devolve NextResponse 429 se exceder o limite, null se OK.
 * Usa Upstash se configurado, cai para in-memory caso contrário.
 */
export async function rateLimit(
  key: string,
  maxRequests: number,
  windowMs: number,
): Promise<NextResponse | null> {
  let limiter: Awaited<ReturnType<typeof getUpstashLimiter>> = null;
  try {
    limiter = await getUpstashLimiter(maxRequests, windowMs);
  } catch {
    limiter = null; // Upstash indisponível — nunca bloquear por causa disso.
  }

  if (limiter) {
    let success = true, reset = Date.now() + windowMs, remaining = maxRequests;
    try {
      ({ success, reset, remaining } = await limiter.limit(key));
    } catch {
      // Falha a contactar o Upstash: fail-open (deixa passar), não parte o pedido.
      return null;
    }
    if (!success) {
      const retryAfter = Math.ceil((reset - Date.now()) / 1000);
      return NextResponse.json(
        { error: "Demasiadas tentativas. Tenta novamente mais tarde." },
        {
          status: 429,
          headers: {
            "Retry-After": String(Math.max(1, retryAfter)),
            "X-RateLimit-Limit": String(maxRequests),
            "X-RateLimit-Remaining": String(remaining),
          },
        },
      );
    }
    return null;
  }

  // Fallback in-memory
  const allowed = inMemoryAllow(key, maxRequests, windowMs);
  if (!allowed) {
    const record = store.get(key);
    const retryAfter = record ? Math.ceil((record.resetAt - Date.now()) / 1000) : 60;
    return NextResponse.json(
      { error: "Demasiadas tentativas. Tenta novamente mais tarde." },
      {
        status: 429,
        headers: {
          "Retry-After": String(Math.max(1, retryAfter)),
          "X-RateLimit-Limit": String(maxRequests),
          "X-RateLimit-Remaining": "0",
        },
      },
    );
  }
  return null;
}

/**
 * Para server actions (não podem retornar NextResponse) — devolve true se OK, false se bloqueado.
 * Usa Upstash se configurado, cai para in-memory caso contrário.
 */
export async function checkRateLimit(
  key: string,
  maxRequests: number,
  windowMs: number,
): Promise<boolean> {
  let limiter: Awaited<ReturnType<typeof getUpstashLimiter>> = null;
  try {
    limiter = await getUpstashLimiter(maxRequests, windowMs);
  } catch {
    limiter = null; // Upstash indisponível — não bloquear o login por causa disso.
  }
  if (limiter) {
    try {
      const { success } = await limiter.limit(key);
      return success;
    } catch {
      return inMemoryAllow(key, maxRequests, windowMs); // fail-open via fallback local
    }
  }
  return inMemoryAllow(key, maxRequests, windowMs);
}

import { NextResponse } from "next/server";

interface RateLimitRecord {
  count: number;
  resetAt: number;
}

const store = new Map<string, RateLimitRecord>();

/**
 * In-memory rate limiter. Returns a 429 NextResponse if the limit is exceeded,
 * or null if the request should be allowed through.
 *
 * NOTE: This resets on server restart and is per-instance (not shared across
 * Vercel edge replicas). For shared rate limiting use Upstash Redis.
 */
export function rateLimit(
  key: string,
  maxRequests: number,
  windowMs: number
): NextResponse | null {
  const now = Date.now();
  const record = store.get(key);

  if (!record || now >= record.resetAt) {
    store.set(key, { count: 1, resetAt: now + windowMs });
    return null;
  }

  if (record.count >= maxRequests) {
    const retryAfter = Math.ceil((record.resetAt - now) / 1000);
    return NextResponse.json(
      { error: "Demasiadas tentativas. Tenta novamente mais tarde." },
      {
        status: 429,
        headers: {
          "Retry-After": String(retryAfter),
          "X-RateLimit-Limit": String(maxRequests),
          "X-RateLimit-Remaining": "0",
        },
      }
    );
  }

  record.count += 1;
  return null;
}

/** Extract a stable key for rate limiting from a request. */
export function rateLimitKey(prefix: string, identifier: string): string {
  return `${prefix}:${identifier}`;
}

/**
 * Boolean version for use in server actions (cannot return NextResponse).
 * Returns true if the request is allowed, false if rate limited.
 */
export function checkRateLimit(
  key: string,
  maxRequests: number,
  windowMs: number
): boolean {
  const now = Date.now();
  const record = store.get(key);

  if (!record || now >= record.resetAt) {
    store.set(key, { count: 1, resetAt: now + windowMs });
    return true;
  }

  if (record.count >= maxRequests) return false;

  record.count += 1;
  return true;
}

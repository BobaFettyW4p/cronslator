/** Minimal slice of the Rate Limiting binding (easy to fake in tests). */
export interface Limiter {
  limit(options: { key: string }): Promise<{ success: boolean }>;
}

export type RateLimitResult = { ok: true } | { ok: false; scope: "ip" | "global" };

export function clientIp(request: Request): string {
  return request.headers.get("cf-connecting-ip") ?? "unknown";
}

/**
 * Check the per-IP limiter, then the global one. If a limiter errors, let the
 * request through (fail open) rather than take the site down; the global
 * limiter and Workers AI's own limits still bound cost.
 */
export async function checkRateLimits(
  ipLimiter: Limiter,
  globalLimiter: Limiter,
  ip: string,
): Promise<RateLimitResult> {
  const ask = async (limiter: Limiter, key: string) => {
    try {
      return (await limiter.limit({ key })).success;
    } catch (e) {
      console.error("rate limiter error", e);
      return true;
    }
  };
  if (!(await ask(ipLimiter, `ip:${ip}`))) return { ok: false, scope: "ip" };
  if (!(await ask(globalLimiter, "global"))) return { ok: false, scope: "global" };
  return { ok: true };
}

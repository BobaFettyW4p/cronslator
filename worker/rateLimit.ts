import type { RateLimiter } from "../limiter/index";

export const IP_LIMIT = { limit: 10, windowMs: 60_000 };
export const GLOBAL_LIMIT = { limit: 200, windowMs: 60_000 };

export interface LimitOutcome {
  success: boolean;
  retryAfterSeconds?: number;
}

/** Anything that can answer "may this key proceed?" (DO-backed in prod, fake in tests). */
export interface Limiter {
  limit(options: { key: string }): Promise<LimitOutcome>;
}

export type RateLimitResult = { ok: true } | { ok: false; scope: "ip" | "global"; retryAfterSeconds: number };

/** A Limiter backed by one RateLimiter Durable Object instance per key. */
export function durableLimiter(
  ns: DurableObjectNamespace<RateLimiter>,
  { limit, windowMs }: { limit: number; windowMs: number },
): Limiter {
  return {
    async limit({ key }) {
      const stub = ns.get(ns.idFromName(key));
      return stub.hit(limit, windowMs);
    },
  };
}

export function clientIp(request: Request): string {
  return request.headers.get("cf-connecting-ip") ?? "unknown";
}

/** Expand an IPv6 address to 8 hextets, or return null if it isn't one. */
function expandIpv6(ip: string): string[] | null {
  if (!ip.includes(":")) return null;
  const [head, tail = ""] = ip.split("::");
  const headParts = head ? head.split(":") : [];
  const tailParts = ip.includes("::") ? (tail ? tail.split(":") : []) : [];
  const missing = 8 - headParts.length - tailParts.length;
  if (missing < 0 || (!ip.includes("::") && headParts.length !== 8)) return null;
  const parts = [...headParts, ...Array(ip.includes("::") ? missing : 0).fill("0"), ...tailParts];
  if (parts.length !== 8 || parts.some((p) => !/^[0-9a-f]{1,4}$/i.test(p))) return null;
  return parts.map((p) => p.toLowerCase().replace(/^0+(?=.)/, ""));
}

/**
 * Rate-limit key for a client. IPv6 clients usually control a whole /64,
 * so key on that prefix; otherwise one user could rotate addresses freely.
 */
export function rateLimitKey(ip: string): string {
  const v6 = expandIpv6(ip);
  if (v6) return `ip:${v6.slice(0, 4).join(":")}::/64`;
  return `ip:${ip}`;
}

/**
 * Check the per-IP limiter, then the global one. If a limiter errors, let the
 * request through (fail open) rather than take the site down; Workers AI's own
 * account limits still bound cost.
 */
export async function checkRateLimits(
  ipLimiter: Limiter,
  globalLimiter: Limiter,
  ip: string,
): Promise<RateLimitResult> {
  const ask = async (limiter: Limiter, key: string): Promise<LimitOutcome> => {
    try {
      return await limiter.limit({ key });
    } catch (e) {
      console.error("rate limiter error", e);
      return { success: true };
    }
  };
  const byIp = await ask(ipLimiter, rateLimitKey(ip));
  if (!byIp.success) return { ok: false, scope: "ip", retryAfterSeconds: byIp.retryAfterSeconds ?? 60 };
  const total = await ask(globalLimiter, "global");
  if (!total.success) return { ok: false, scope: "global", retryAfterSeconds: total.retryAfterSeconds ?? 60 };
  return { ok: true };
}

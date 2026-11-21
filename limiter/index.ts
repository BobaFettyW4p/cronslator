import { DurableObject } from "cloudflare:workers";
import { FixedWindow } from "./window";

/**
 * Exact fixed-window rate limiter. One Durable Object instance per key
 * (e.g. "ip:2601:243:1780:abcd::/64" or "global"), so every request for a
 * key is counted in one place worldwide, unlike the per-location,
 * eventually consistent Rate Limiting binding.
 *
 * Counts live in memory only: if the instance is evicted the window resets,
 * which is acceptable for rate limiting and avoids storage writes.
 */
export class RateLimiter extends DurableObject {
  private window = new FixedWindow();

  async hit(limit: number, windowMs: number): Promise<{ success: boolean; retryAfterSeconds: number }> {
    return this.window.hit(Date.now(), limit, windowMs);
  }
}

// Not publicly routable (workers_dev/preview_urls are off); exists to host the DO.
export default {
  fetch: () => new Response("Not found", { status: 404 }),
} satisfies ExportedHandler;

/** Fixed-window counter: at most `limit` hits per aligned `windowMs` window. */
export class FixedWindow {
  private windowStart = 0;
  private count = 0;

  hit(now: number, limit: number, windowMs: number): { success: boolean; retryAfterSeconds: number } {
    const start = now - (now % windowMs);
    if (start !== this.windowStart) {
      this.windowStart = start;
      this.count = 0;
    }
    if (this.count >= limit) {
      return { success: false, retryAfterSeconds: Math.max(1, Math.ceil((start + windowMs - now) / 1000)) };
    }
    this.count++;
    return { success: true, retryAfterSeconds: 0 };
  }
}

import { describe, expect, it } from "vitest";
import { FixedWindow } from "../limiter/window";
import { checkRateLimits, clientIp, rateLimitKey } from "../worker/rateLimit";
import { fakeLimiter } from "./fakeAi";

describe("FixedWindow", () => {
  const MIN = 60_000;
  const t0 = 1_800_000_000_000; // aligned to a minute boundary

  it("allows `limit` hits per window, then denies with seconds until reset", () => {
    const w = new FixedWindow();
    for (let i = 0; i < 3; i++) expect(w.hit(t0 + i, 3, MIN).success).toBe(true);
    expect(w.hit(t0 + 15_000, 3, MIN)).toEqual({ success: false, retryAfterSeconds: 45 });
  });

  it("resets at the next window", () => {
    const w = new FixedWindow();
    w.hit(t0, 1, MIN);
    expect(w.hit(t0 + 59_999, 1, MIN).success).toBe(false);
    expect(w.hit(t0 + MIN, 1, MIN).success).toBe(true);
  });

  it("denied hits don't extend the count", () => {
    const w = new FixedWindow();
    w.hit(t0, 1, MIN);
    w.hit(t0 + 1, 1, MIN);
    w.hit(t0 + 2, 1, MIN);
    expect(w.hit(t0 + MIN + 1, 1, MIN).success).toBe(true);
  });

  it("never reports retry-after of 0 when denied", () => {
    const w = new FixedWindow();
    w.hit(t0, 1, MIN);
    expect(w.hit(t0 + MIN - 1, 1, MIN).retryAfterSeconds).toBe(1);
  });
});

describe("rateLimitKey", () => {
  it("keys IPv4 by full address", () => expect(rateLimitKey("1.2.3.4")).toBe("ip:1.2.3.4"));
  it("keys IPv6 by /64 prefix", () => {
    expect(rateLimitKey("2601:243:1780:abcd:1111:2222:3333:4444")).toBe("ip:2601:243:1780:abcd::/64");
    expect(rateLimitKey("2601:243:1780:abcd:9999::1")).toBe("ip:2601:243:1780:abcd::/64");
  });
  it("normalizes case, leading zeros and :: compression", () => {
    expect(rateLimitKey("2601:0243:1780:ABCD::")).toBe("ip:2601:243:1780:abcd::/64");
    expect(rateLimitKey("2001:db8::1")).toBe("ip:2001:db8:0:0::/64");
    expect(rateLimitKey("::1")).toBe("ip:0:0:0:0::/64");
  });
  it("passes through unparseable values", () => {
    expect(rateLimitKey("unknown")).toBe("ip:unknown");
    expect(rateLimitKey("1:2:3")).toBe("ip:1:2:3");
  });
});

describe("clientIp", () => {
  it("reads cf-connecting-ip", () => {
    expect(clientIp(new Request("https://x", { headers: { "cf-connecting-ip": "1.2.3.4" } }))).toBe("1.2.3.4");
  });
  it("falls back to 'unknown'", () => expect(clientIp(new Request("https://x"))).toBe("unknown"));
});

describe("checkRateLimits", () => {
  it("allows when both limiters allow, keying by IP then global", async () => {
    const ip = fakeLimiter();
    const global = fakeLimiter();
    expect(await checkRateLimits(ip, global, "1.2.3.4")).toEqual({ ok: true });
    expect(ip.keys).toEqual(["ip:1.2.3.4"]);
    expect(global.keys).toEqual(["global"]);
  });

  it("denies with scope 'ip', passes retry-after, and skips the global limiter", async () => {
    const ip = fakeLimiter(0);
    const global = fakeLimiter();
    expect(await checkRateLimits(ip, global, "1.2.3.4")).toEqual({ ok: false, scope: "ip", retryAfterSeconds: 42 });
    expect(global.keys).toEqual([]);
  });

  it("denies with scope 'global'", async () => {
    expect(await checkRateLimits(fakeLimiter(), fakeLimiter(0), "1.2.3.4")).toMatchObject({ ok: false, scope: "global" });
  });

  it("treats addresses in the same IPv6 /64 as one client", async () => {
    const ip = fakeLimiter(1);
    const global = fakeLimiter();
    expect((await checkRateLimits(ip, global, "2601:243:1780:abcd::1")).ok).toBe(true);
    expect((await checkRateLimits(ip, global, "2601:243:1780:abcd::2")).ok).toBe(false);
    expect((await checkRateLimits(ip, global, "2601:243:1780:beef::1")).ok).toBe(true);
  });

  it("fails open if a limiter throws", async () => {
    expect(await checkRateLimits(fakeLimiter(Infinity, { throws: true }), fakeLimiter(), "a")).toEqual({ ok: true });
  });
});

import { describe, expect, it } from "vitest";
import { checkRateLimits, clientIp } from "../worker/rateLimit";
import { fakeLimiter } from "./fakeAi";

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

  it("denies with scope 'ip' and skips the global limiter", async () => {
    const ip = fakeLimiter(0);
    const global = fakeLimiter();
    expect(await checkRateLimits(ip, global, "1.2.3.4")).toEqual({ ok: false, scope: "ip" });
    expect(global.keys).toEqual([]);
  });

  it("denies with scope 'global'", async () => {
    expect(await checkRateLimits(fakeLimiter(), fakeLimiter(0), "1.2.3.4")).toEqual({ ok: false, scope: "global" });
  });

  it("limits each IP independently", async () => {
    const ip = fakeLimiter(1);
    const global = fakeLimiter();
    expect((await checkRateLimits(ip, global, "a")).ok).toBe(true);
    expect((await checkRateLimits(ip, global, "a")).ok).toBe(false);
    expect((await checkRateLimits(ip, global, "b")).ok).toBe(true);
  });

  it("fails open if a limiter throws", async () => {
    expect(await checkRateLimits(fakeLimiter(Infinity, { throws: true }), fakeLimiter(), "a")).toEqual({ ok: true });
  });
});

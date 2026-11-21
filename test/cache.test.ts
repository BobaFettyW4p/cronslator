import { describe, expect, it } from "vitest";
import { cacheKey, getCached, normalizeQuery, putCached } from "../worker/cache";
import { fakeKv } from "./fakeAi";

describe("normalizeQuery", () => {
  it.each([
    ["Every Weekday at 9am", "every weekday at 9am"],
    ["  every   hour  ", "every hour"],
    ["every hour.", "every hour"],
    ["every hour?!", "every hour"],
    ["at 9 a.m.", "at 9 a.m"],
  ])("%j → %j", (input, out) => expect(normalizeQuery(input)).toBe(out));
});

describe("cacheKey", () => {
  it("is the same for equivalent questions", async () => {
    expect(await cacheKey("m", "Every hour.")).toBe(await cacheKey("m", "every   hour"));
  });
  it("differs by question and by model", async () => {
    const base = await cacheKey("m", "every hour");
    expect(await cacheKey("m", "every day")).not.toBe(base);
    expect(await cacheKey("other-model", "every hour")).not.toBe(base);
  });
  it("includes model and a prompt fingerprint, not the raw question", async () => {
    const key = await cacheKey("@cf/x/y", "my secret schedule");
    expect(key).toMatch(/^parse:v1:@cf\/x\/y:[0-9a-f]{12}:[0-9a-f]{64}$/);
    expect(key).not.toContain("secret");
  });
});

describe("getCached / putCached", () => {
  it("round-trips answers with a 30-day TTL", async () => {
    const kv = fakeKv();
    await putCached(kv, "k", { kind: "ok", cron: "0 * * * *", assumptions: "" });
    expect(kv.puts[0].ttl).toBe(2_592_000);
    expect(await getCached(kv, "k")).toEqual({ kind: "ok", cron: "0 * * * *", assumptions: "" });
  });
  it("returns null for misses and malformed entries", async () => {
    const kv = fakeKv();
    expect(await getCached(kv, "missing")).toBeNull();
    kv.store.set("bad", JSON.stringify({ kind: "ok", cron: 5 }));
    expect(await getCached(kv, "bad")).toBeNull();
  });
  it("swallows KV errors", async () => {
    const kv = fakeKv({ failReads: true, failWrites: true });
    expect(await getCached(kv, "k")).toBeNull();
    await expect(putCached(kv, "k", { kind: "not_expressible", reason: "x" })).resolves.toBeUndefined();
  });
});

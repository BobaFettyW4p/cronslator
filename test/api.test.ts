import { describe, expect, it } from "vitest";
import worker from "../worker/index";
import { answer, fakeAi, fakeCtx, fakeKv, fakeLimiterNamespace, impossible } from "./fakeAi";

function env(...responses: unknown[]) {
  return envWith({}, ...responses);
}

function envWith(opts: { denyGlobal?: boolean; kv?: ReturnType<typeof fakeKv> }, ...responses: unknown[]) {
  const { ai, calls } = fakeAi(...responses);
  const limiter = fakeLimiterNamespace({ deny: (k) => !!opts.denyGlobal && k === "global" });
  const kv = opts.kv ?? fakeKv();
  const e = { AI: ai, MODEL: "@cf/test/model", RATE_LIMITER: limiter.ns, CRON_CACHE: kv };
  return { env: e as unknown as Env, calls, limiterKeys: limiter.keys, kv };
}

const post = (body: unknown) =>
  new Request("https://x/api/parse", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: typeof body === "string" ? body : JSON.stringify(body),
  });

/** Calls the Worker and waits for any waitUntil work (e.g. cache writes) to settle. */
async function call(req: Request, e: Env) {
  const { ctx, pending } = fakeCtx();
  const res = await worker.fetch(req as Parameters<typeof worker.fetch>[0], e, ctx as unknown as ExecutionContext);
  await Promise.all(pending);
  return res;
}

describe("POST /api/parse", () => {
  it("returns the cron plus code-computed details", async () => {
    const { env: e } = env(answer("30 9 * * 1-5"));
    const res = await call(post({ text: "  every weekday   at 9:30am ", timezone: "America/Chicago" }), e);
    expect(res.status).toBe(200);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body).toMatchObject({
      ok: true,
      input: "every weekday at 9:30am",
      cron: "30 9 * * 1-5",
      description: "At 09:30 AM, Monday through Friday",
      timezone: "America/Chicago",
      model: "@cf/test/model",
      warnings: [],
    });
    expect(body.nextRuns).toHaveLength(5);
  });

  it("defaults the timezone to UTC", async () => {
    const { env: e } = env(answer("0 0 * * *"));
    const body = (await (await call(post({ text: "daily" }), e)).json()) as { timezone: string };
    expect(body.timezone).toBe("UTC");
  });

  it("returns 422 with the reason for impossible schedules", async () => {
    const { env: e } = env(impossible("Every 90 seconds isn't possible."));
    const res = await call(post({ text: "every 90 seconds" }), e);
    expect(res.status).toBe(422);
    expect(await res.json()).toEqual({ ok: false, error: "not_expressible", message: "Every 90 seconds isn't possible." });
  });

  it("returns 502 when the model keeps failing", async () => {
    const { env: e } = env(answer("nonsense"), answer("still nonsense"));
    const res = await call(post({ text: "hmm" }), e);
    expect(res.status).toBe(502);
    expect(await res.json()).toMatchObject({ ok: false, error: "model_error" });
  });

  it("allows 10 requests per minute per IP, then returns 429 with Retry-After", async () => {
    const { env: e, calls } = envWith({}, answer("0 * * * *"));
    const fromIp = (ip: string) => {
      const r = post({ text: "hourly" });
      r.headers.set("cf-connecting-ip", ip);
      return r;
    };
    for (let i = 0; i < 10; i++) expect((await call(fromIp("9.9.9.9"), e)).status).toBe(200);
    const res = await call(fromIp("9.9.9.9"), e);
    expect(res.status).toBe(429);
    expect(Number(res.headers.get("retry-after"))).toBeGreaterThan(0);
    expect(await res.json()).toMatchObject({ ok: false, error: "rate_limited", message: expect.stringMatching(/fast/) });
    // Identical questions: 1 model call, then cache hits, which still count toward the limit.
    expect(calls).toHaveLength(1);
  });

  it("returns 429 when the global limit is hit", async () => {
    const { env: e, calls } = envWith({ denyGlobal: true });
    const res = await call(post({ text: "hourly" }), e);
    expect(res.status).toBe(429);
    expect(res.headers.get("retry-after")).toBe("30");
    expect(await res.json()).toMatchObject({ error: "rate_limited", message: expect.stringMatching(/busy/) });
    expect(calls).toHaveLength(0);
  });

  it("does not count invalid requests against the limit", async () => {
    const { env: e, limiterKeys } = envWith({});
    await call(post({ text: "" }), e);
    await call(post({ text: "daily", timezone: "Nope/Nope" }), e);
    expect(limiterKeys).toEqual([]);
  });

  it("returns 503 over_capacity with Retry-After when the AI quota is exhausted", async () => {
    const { env: e, kv } = envWith({}, new Error("4006: you have used up your daily free allocation of 10,000 neurons"));
    const res = await call(post({ text: "hourly" }), e);
    expect(res.status).toBe(503);
    expect(Number(res.headers.get("retry-after"))).toBeGreaterThan(0);
    expect(await res.json()).toMatchObject({ ok: false, error: "over_capacity", message: expect.stringMatching(/00:00 UTC/) });
    expect(kv.puts).toHaveLength(0);
  });

  it.each([
    ["not json", "{"],
    ["missing text", {}],
    ["blank text", { text: "   " }],
    ["non-string text", { text: 5 }],
    ["too long", { text: "a".repeat(201) }],
    ["bad timezone", { text: "daily", timezone: "Mars/Olympus" }],
  ])("returns 400 for %s without calling the model", async (_name, body) => {
    const { env: e, calls } = env();
    const res = await call(post(body), e);
    expect(res.status).toBe(400);
    expect(await res.json()).toMatchObject({ ok: false, error: "bad_request" });
    expect(calls).toHaveLength(0);
  });

  it("rejects GET with 405", async () => {
    const { env: e } = env();
    expect((await call(new Request("https://x/api/parse"), e)).status).toBe(405);
  });
});

describe("POST /api/parse caching", () => {
  it("caches answers: a repeat (differently cased/spaced) question skips the model", async () => {
    const { env: e, calls, kv } = envWith({}, answer("30 9 * * 1-5", "none"));
    const first = await call(post({ text: "Every weekday at 9:30am" }), e);
    expect(first.headers.get("x-cache")).toBe("MISS");
    expect(kv.puts).toHaveLength(1);
    expect(kv.puts[0].ttl).toBe(30 * 24 * 60 * 60);

    const second = await call(post({ text: "  every   WEEKDAY at 9:30am. ", timezone: "Asia/Tokyo" }), e);
    expect(second.headers.get("x-cache")).toBe("HIT");
    expect(await second.json()).toMatchObject({
      ok: true,
      cron: "30 9 * * 1-5",
      assumptions: "none",
      timezone: "Asia/Tokyo", // run times are recomputed per request
      input: "every WEEKDAY at 9:30am.",
    });
    expect(calls).toHaveLength(1);
  });

  it("caches not-expressible answers too", async () => {
    const { env: e, calls } = envWith({}, impossible("No."));
    expect((await call(post({ text: "every 90 seconds" }), e)).status).toBe(422);
    const again = await call(post({ text: "every 90 seconds" }), e);
    expect(again.status).toBe(422);
    expect(again.headers.get("x-cache")).toBe("HIT");
    expect(await again.json()).toMatchObject({ error: "not_expressible", message: "No." });
    expect(calls).toHaveLength(1);
  });

  it("does not cache model failures", async () => {
    const { env: e, kv } = envWith({}, answer("bad"), answer("worse"));
    expect((await call(post({ text: "hmm" }), e)).status).toBe(502);
    expect(kv.puts).toHaveLength(0);
  });

  it("ignores a cached cron that no longer validates", async () => {
    const kv = fakeKv();
    const seed = envWith({ kv }, answer("0 0 * * *"));
    await call(post({ text: "daily" }), seed.env);
    for (const k of kv.store.keys()) kv.store.set(k, JSON.stringify({ kind: "ok", cron: "0 0 L * *", assumptions: "" }));
    const { env: e, calls } = envWith({ kv }, answer("0 0 * * *"));
    const res = await call(post({ text: "daily" }), e);
    expect(res.headers.get("x-cache")).toBe("MISS");
    expect(calls).toHaveLength(1);
  });

  it("still answers when KV reads and writes fail", async () => {
    const { env: e } = envWith({ kv: fakeKv({ failReads: true, failWrites: true }) }, answer("0 * * * *"));
    const res = await call(post({ text: "hourly" }), e);
    expect(res.status).toBe(200);
    expect(res.headers.get("x-cache")).toBe("MISS");
  });
});

describe("GET /api/describe", () => {
  const get = (qs: string) => call(new Request(`https://x/api/describe?${qs}`), env().env);

  it("explains a valid cron without calling the model", async () => {
    const { env: e, calls } = env();
    const res = await call(new Request("https://x/api/describe?cron=30+9+*+*+1-5&tz=America/Chicago"), e);
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({
      ok: true,
      cron: "30 9 * * 1-5",
      description: "At 09:30 AM, Monday through Friday",
      timezone: "America/Chicago",
    });
    expect(calls).toHaveLength(0);
  });

  it("defaults tz to UTC", async () => {
    expect(await (await get("cron=0+0+*+*+*")).json()).toMatchObject({ timezone: "UTC" });
  });

  it.each([
    ["missing cron", ""],
    ["invalid cron", "cron=0+0+L+*+*"],
    ["bad tz", "cron=0+0+*+*+*&tz=Mars/Olympus"],
  ])("400s on %s", async (_n, qs) => {
    const res = await get(qs);
    expect(res.status).toBe(400);
    expect(await res.json()).toMatchObject({ ok: false, error: "bad_request" });
  });

  it("rejects POST with 405", async () => {
    expect((await call(new Request("https://x/api/describe", { method: "POST" }), env().env)).status).toBe(405);
  });
});

describe("other routes", () => {
  it("serves /api/health", async () => {
    const { env: e } = env();
    expect(await (await call(new Request("https://x/api/health"), e)).json()).toEqual({ ok: true, service: "cronslator" });
  });
  it("404s unknown API routes", async () => {
    const { env: e } = env();
    expect((await call(new Request("https://x/api/nope"), e)).status).toBe(404);
  });
});

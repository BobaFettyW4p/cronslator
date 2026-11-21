import { describe, expect, it } from "vitest";
import worker from "../worker/index";
import { answer, fakeAi, fakeLimiterNamespace, impossible } from "./fakeAi";

function env(...responses: unknown[]) {
  return envWith({}, ...responses);
}

function envWith(opts: { denyGlobal?: boolean }, ...responses: unknown[]) {
  const { ai, calls } = fakeAi(...responses);
  const limiter = fakeLimiterNamespace({ deny: (k) => !!opts.denyGlobal && k === "global" });
  const e = { AI: ai, MODEL: "@cf/test/model", RATE_LIMITER: limiter.ns };
  return { env: e as unknown as Env, calls, limiterKeys: limiter.keys };
}

const post = (body: unknown) =>
  new Request("https://x/api/parse", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: typeof body === "string" ? body : JSON.stringify(body),
  });

const call = (req: Request, e: Env) =>
  worker.fetch(req as Parameters<typeof worker.fetch>[0], e);

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
    const responses = Array.from({ length: 10 }, () => answer("0 * * * *"));
    const { env: e, calls } = envWith({}, ...responses);
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
    expect(calls).toHaveLength(10);
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

import { describe, expect, it } from "vitest";
import worker from "../worker/index";
import { answer, fakeAi, fakeLimiter, impossible } from "./fakeAi";

function env(...responses: unknown[]) {
  return envWith({}, ...responses);
}

function envWith(limits: { ip?: number; global?: number }, ...responses: unknown[]) {
  const { ai, calls } = fakeAi(...responses);
  const ipLimiter = fakeLimiter(limits.ip);
  const globalLimiter = fakeLimiter(limits.global);
  const e = { AI: ai, MODEL: "@cf/test/model", IP_RATE_LIMITER: ipLimiter, GLOBAL_RATE_LIMITER: globalLimiter };
  return { env: e as unknown as Env, calls, ipLimiter, globalLimiter };
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

  it("returns 429 with Retry-After when the IP limit is hit, without calling the model", async () => {
    const { env: e, calls, ipLimiter } = envWith({ ip: 1 }, answer("0 * * * *"));
    const withIp = () => {
      const r = post({ text: "hourly" });
      r.headers.set("cf-connecting-ip", "9.9.9.9");
      return r;
    };
    expect((await call(withIp(), e)).status).toBe(200);
    const res = await call(withIp(), e);
    expect(res.status).toBe(429);
    expect(res.headers.get("retry-after")).toBe("60");
    expect(await res.json()).toMatchObject({ ok: false, error: "rate_limited", message: expect.stringMatching(/fast/) });
    expect(calls).toHaveLength(1);
    expect(ipLimiter.keys).toEqual(["ip:9.9.9.9", "ip:9.9.9.9"]);
  });

  it("returns 429 when the global limit is hit", async () => {
    const { env: e, calls } = envWith({ global: 0 });
    const res = await call(post({ text: "hourly" }), e);
    expect(res.status).toBe(429);
    expect(await res.json()).toMatchObject({ error: "rate_limited", message: expect.stringMatching(/busy/) });
    expect(calls).toHaveLength(0);
  });

  it("does not count invalid requests against the limit", async () => {
    const { env: e, ipLimiter } = envWith({ ip: 1 });
    await call(post({ text: "" }), e);
    await call(post({ text: "daily", timezone: "Nope/Nope" }), e);
    expect(ipLimiter.keys).toEqual([]);
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

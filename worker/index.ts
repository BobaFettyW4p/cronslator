import { MAX_INPUT_LENGTH, type DescribeResponse, type ErrorCode, type ParseResponse } from "../shared/api";
import { cacheKey, getCached, putCached, type CachedAnswer } from "./cache";
import { enrich, isValidTimeZone, validateCron } from "./cron";
import { translate, type AiRunner } from "./llm";
import type { RateLimiter } from "../limiter/index";
import { checkRateLimits, clientIp, durableLimiter, GLOBAL_LIMIT, IP_LIMIT } from "./rateLimit";

export { MAX_INPUT_LENGTH };

function json(body: ParseResponse | DescribeResponse | Record<string, unknown>, status = 200): Response {
  return Response.json(body, { status, headers: { "cache-control": "no-store" } });
}

function fail(error: ErrorCode, message: string, status: number, headers: HeadersInit = {}): Response {
  const res = json({ ok: false, error, message }, status);
  for (const [k, v] of new Headers(headers)) res.headers.set(k, v);
  return res;
}

export async function handleParse(request: Request, env: Env, ctx?: ExecutionContext): Promise<Response> {
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return fail("bad_request", "Request body must be JSON.", 400);
  }
  const { text, timezone } = (body ?? {}) as { text?: unknown; timezone?: unknown };

  if (typeof text !== "string" || text.trim() === "") {
    return fail("bad_request", "Describe a schedule, e.g. \"every weekday at 9am\".", 400);
  }
  const input = text.trim().replace(/\s+/g, " ");
  if (input.length > MAX_INPUT_LENGTH) {
    return fail("bad_request", `Keep it under ${MAX_INPUT_LENGTH} characters.`, 400);
  }
  const tz = timezone === undefined || timezone === "" ? "UTC" : timezone;
  if (typeof tz !== "string" || !isValidTimeZone(tz)) {
    return fail("bad_request", "Unknown timezone.", 400);
  }

  // Rate limit valid requests (cache hits included, so the cache can't be hammered either);
  // invalid input never counts.
  const ns = env.RATE_LIMITER as DurableObjectNamespace<RateLimiter>;
  const limited = await checkRateLimits(durableLimiter(ns, IP_LIMIT), durableLimiter(ns, GLOBAL_LIMIT), clientIp(request));
  if (!limited.ok) {
    const message =
      limited.scope === "ip"
        ? "You're going a bit fast. Try again in a minute."
        : "Cronslator is busy right now. Try again in a minute.";
    return fail("rate_limited", message, 429, { "retry-after": String(limited.retryAfterSeconds) });
  }

  const key = await cacheKey(env.MODEL, input);
  let answer = await getCached(env.CRON_CACHE, key);
  // Re-check cached crons in case validation rules got stricter since they were stored.
  if (answer?.kind === "ok" && !validateCron(answer.cron).ok) answer = null;
  const cacheStatus = answer ? "HIT" : "MISS";

  if (!answer) {
    const result = await translate(env.AI as unknown as AiRunner, env.MODEL, input);
    if (result.kind === "failed") {
      console.error("translate failed", { input, error: result.error, attempts: result.attempts });
      return fail("model_error", "Sorry, couldn't turn that into a cron expression. Try rephrasing it.", 502);
    }
    const fresh: CachedAnswer =
      result.kind === "ok"
        ? { kind: "ok", cron: result.cron, assumptions: result.assumptions }
        : { kind: "not_expressible", reason: result.reason };
    answer = fresh;
    const write = putCached(env.CRON_CACHE, key, fresh);
    if (ctx) ctx.waitUntil(write);
    else await write;
  }

  const headers = { "x-cache": cacheStatus };
  if (answer.kind === "not_expressible") {
    return fail("not_expressible", answer.reason, 422, headers);
  }

  const ok: ParseResponse = {
    ok: true,
    input,
    assumptions: answer.assumptions,
    model: env.MODEL,
    ...enrich(answer.cron, tz),
  };
  const res = json(ok);
  res.headers.set("x-cache", cacheStatus);
  return res;
}

/** GET /api/describe?cron=...&tz=... : explain a cron without calling the model. */
export function handleDescribe(url: URL): Response {
  const v = validateCron(url.searchParams.get("cron") ?? "");
  if (!v.ok) return fail("bad_request", v.error, 400);
  const tz = url.searchParams.get("tz") || "UTC";
  if (!isValidTimeZone(tz)) return fail("bad_request", "Unknown timezone.", 400);
  const body: DescribeResponse = { ok: true, ...enrich(v.cron, tz) };
  return json(body);
}

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);

    if (url.pathname === "/api/health") {
      return json({ ok: true, service: "cronslator" });
    }

    if (url.pathname === "/api/parse") {
      if (request.method !== "POST") return fail("method_not_allowed", "Use POST.", 405);
      return handleParse(request, env, ctx);
    }

    if (url.pathname === "/api/describe") {
      if (request.method !== "GET") return fail("method_not_allowed", "Use GET.", 405);
      return handleDescribe(url);
    }

    if (url.pathname.startsWith("/api/")) {
      return fail("not_found", "Not found.", 404);
    }

    return new Response(null, { status: 404 });
  },
} satisfies ExportedHandler<Env>;

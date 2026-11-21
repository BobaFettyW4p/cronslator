import { enrich, isValidTimeZone } from "./cron";
import { translate, type AiRunner } from "./llm";
import { checkRateLimits, clientIp } from "./rateLimit";

export const MAX_INPUT_LENGTH = 200;

export type ParseResponse =
  | ({ ok: true; input: string; assumptions: string; model: string } & ReturnType<typeof enrich>)
  | { ok: false; error: ErrorCode; message: string };

export type ErrorCode =
  | "bad_request"
  | "rate_limited"
  | "not_expressible"
  | "model_error"
  | "not_found"
  | "method_not_allowed";

function json(body: ParseResponse | Record<string, unknown>, status = 200): Response {
  return Response.json(body, { status, headers: { "cache-control": "no-store" } });
}

function fail(error: ErrorCode, message: string, status: number, headers: HeadersInit = {}): Response {
  const res = json({ ok: false, error, message }, status);
  for (const [k, v] of new Headers(headers)) res.headers.set(k, v);
  return res;
}

export async function handleParse(request: Request, env: Env): Promise<Response> {
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

  // Rate limit only requests that would reach the model, so typos don't burn quota.
  const limited = await checkRateLimits(env.IP_RATE_LIMITER, env.GLOBAL_RATE_LIMITER, clientIp(request));
  if (!limited.ok) {
    const message =
      limited.scope === "ip"
        ? "You're going a bit fast. Try again in a minute."
        : "Cronslator is busy right now. Try again in a minute.";
    return fail("rate_limited", message, 429, { "retry-after": "60" });
  }

  const result = await translate(env.AI as unknown as AiRunner, env.MODEL, input);

  if (result.kind === "not_expressible") {
    return fail("not_expressible", result.reason, 422);
  }
  if (result.kind === "failed") {
    console.error("translate failed", { input, error: result.error, attempts: result.attempts });
    return fail("model_error", "Sorry, couldn't turn that into a cron expression. Try rephrasing it.", 502);
  }

  return json({
    ok: true,
    input,
    assumptions: result.assumptions,
    model: env.MODEL,
    ...enrich(result.cron, tz),
  });
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    if (url.pathname === "/api/health") {
      return json({ ok: true, service: "cronslator" });
    }

    if (url.pathname === "/api/parse") {
      if (request.method !== "POST") return fail("method_not_allowed", "Use POST.", 405);
      return handleParse(request, env);
    }

    if (url.pathname.startsWith("/api/")) {
      return fail("not_found", "Not found.", 404);
    }

    return new Response(null, { status: 404 });
  },
} satisfies ExportedHandler<Env>;

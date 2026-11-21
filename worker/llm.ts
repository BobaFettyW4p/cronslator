import { validateCron } from "./cron";
import { buildMessages, RESPONSE_SCHEMA, type ModelAnswer } from "./prompt";

/** Minimal slice of the Workers AI binding we depend on (easy to fake in tests). */
export interface AiRunner {
  run(model: string, inputs: Record<string, unknown>): Promise<unknown>;
}

export type TranslateResult =
  | { kind: "ok"; cron: string; assumptions: string; attempts: number }
  | { kind: "not_expressible"; reason: string; attempts: number }
  | { kind: "failed"; error: string; attempts: number };

const MAX_ATTEMPTS = 2;

/** Pull the model's text/JSON out of the various shapes Workers AI can return. */
export function extractAnswer(raw: unknown): ModelAnswer {
  let payload: unknown = raw;
  if (payload && typeof payload === "object") {
    const o = payload as Record<string, unknown>;
    if ("response" in o) {
      payload = o.response; // legacy Workers AI shape
    } else if (Array.isArray(o.choices)) {
      payload = (o.choices[0] as { message?: { content?: unknown } } | undefined)?.message?.content; // OpenAI shape
    }
  }
  if (typeof payload === "string") {
    const trimmed = payload.trim().replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/, "");
    try {
      payload = JSON.parse(trimmed);
    } catch {
      throw new Error("Model did not return valid JSON");
    }
  }
  if (!payload || typeof payload !== "object") throw new Error("Model returned an empty response");
  const a = payload as Record<string, unknown>;
  if (typeof a.possible !== "boolean") throw new Error('Model response is missing "possible"');
  return {
    possible: a.possible,
    cron: typeof a.cron === "string" ? a.cron : "",
    reason: typeof a.reason === "string" ? a.reason : "",
    assumptions: typeof a.assumptions === "string" ? a.assumptions : "",
  };
}

/**
 * Ask the model for a cron expression, validate it strictly, and retry once
 * with the validation error fed back if the first answer is invalid.
 */
export async function translate(ai: AiRunner, model: string, text: string): Promise<TranslateResult> {
  const messages = buildMessages(text);
  let lastError = "Unknown error";

  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    let answer: ModelAnswer;
    try {
      const raw = await ai.run(model, {
        messages,
        response_format: { type: "json_schema", json_schema: RESPONSE_SCHEMA },
        max_tokens: 2048,
        temperature: 0,
      });
      answer = extractAnswer(raw);
    } catch (e) {
      lastError = e instanceof Error ? e.message : String(e);
      continue;
    }

    if (!answer.possible) {
      return { kind: "not_expressible", reason: answer.reason || "That schedule can't be expressed in standard cron.", attempts: attempt };
    }

    const v = validateCron(answer.cron);
    if (v.ok) return { kind: "ok", cron: v.cron, assumptions: answer.assumptions, attempts: attempt };

    lastError = `Model produced an invalid expression "${answer.cron}": ${v.error}`;
    messages.push({ role: "assistant", content: JSON.stringify(answer) });
    messages.push({
      role: "user",
      content: `That cron expression is invalid: ${v.error}. Return corrected JSON for the original request, using only standard 5-field syntax.`,
    });
  }

  return { kind: "failed", error: lastError, attempts: MAX_ATTEMPTS };
}

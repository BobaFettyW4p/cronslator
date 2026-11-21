import { FEW_SHOT, RESPONSE_SCHEMA, SYSTEM_PROMPT } from "./prompt";

/** Only the model's answer is cached; descriptions and run times are recomputed per request. */
export type CachedAnswer =
  | { kind: "ok"; cron: string; assumptions: string }
  | { kind: "not_expressible"; reason: string };

/** Minimal slice of KVNamespace (easy to fake in tests). */
export interface Kv {
  get(key: string, type: "json"): Promise<unknown>;
  put(key: string, value: string, options?: { expirationTtl?: number }): Promise<void>;
}

export const CACHE_TTL_SECONDS = 30 * 24 * 60 * 60;
const KEY_VERSION = "v1";

async function sha256Hex(input: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(input));
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

/** Lowercase, collapse whitespace, drop trailing sentence punctuation. */
export function normalizeQuery(text: string): string {
  return text.trim().toLowerCase().replace(/\s+/g, " ").replace(/[.!?]+$/, "").trim();
}

let promptFingerprint: Promise<string> | undefined;

/** Changes whenever the prompt, few-shot examples or schema change. */
export function getPromptFingerprint(): Promise<string> {
  promptFingerprint ??= sha256Hex(JSON.stringify([SYSTEM_PROMPT, FEW_SHOT, RESPONSE_SCHEMA])).then((h) =>
    h.slice(0, 12),
  );
  return promptFingerprint;
}

export async function cacheKey(model: string, text: string): Promise<string> {
  const [fp, q] = await Promise.all([getPromptFingerprint(), sha256Hex(normalizeQuery(text))]);
  return `parse:${KEY_VERSION}:${model}:${fp}:${q}`;
}

function isCachedAnswer(v: unknown): v is CachedAnswer {
  if (!v || typeof v !== "object") return false;
  const o = v as Record<string, unknown>;
  if (o.kind === "ok") return typeof o.cron === "string" && typeof o.assumptions === "string";
  if (o.kind === "not_expressible") return typeof o.reason === "string";
  return false;
}

/** Returns null on a miss, a malformed entry, or a KV error (the cache must never break a request). */
export async function getCached(kv: Kv, key: string): Promise<CachedAnswer | null> {
  try {
    const v = await kv.get(key, "json");
    return isCachedAnswer(v) ? v : null;
  } catch (e) {
    console.error("cache read failed", e);
    return null;
  }
}

export async function putCached(kv: Kv, key: string, value: CachedAnswer): Promise<void> {
  try {
    await kv.put(key, JSON.stringify(value), { expirationTtl: CACHE_TTL_SECONDS });
  } catch (e) {
    console.error("cache write failed", e);
  }
}

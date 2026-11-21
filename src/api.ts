import type { ApiError, DescribeResponse, ParseRequest, ParseResponse } from "../shared/api";

const NETWORK_ERROR: ApiError = {
  ok: false,
  error: "model_error",
  message: "Couldn't reach Cronslator. Check your connection and try again.",
};

async function readJson<T extends { ok: boolean }>(res: Response): Promise<T | ApiError> {
  try {
    return (await res.json()) as T;
  } catch {
    if (res.status === 429) {
      return { ok: false, error: "rate_limited", message: "You're going a bit fast. Try again in a minute." };
    }
    return { ok: false, error: "model_error", message: "Something went wrong. Please try again." };
  }
}

export async function parseSchedule(req: ParseRequest, signal?: AbortSignal): Promise<ParseResponse> {
  try {
    const res = await fetch("/api/parse", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(req),
      signal,
    });
    return readJson<ParseResponse>(res);
  } catch (e) {
    if (e instanceof DOMException && e.name === "AbortError") throw e;
    return NETWORK_ERROR;
  }
}

export async function describeCron(cron: string, tz: string, signal?: AbortSignal): Promise<DescribeResponse> {
  try {
    const qs = new URLSearchParams({ cron, tz });
    return readJson<DescribeResponse>(await fetch(`/api/describe?${qs}`, { signal }));
  } catch (e) {
    if (e instanceof DOMException && e.name === "AbortError") throw e;
    return NETWORK_ERROR;
  }
}

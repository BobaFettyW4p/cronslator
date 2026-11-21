import type { AiRunner } from "../worker/llm";

/** A fake Workers AI binding that returns queued responses and records calls. */
export function fakeAi(...responses: (unknown | Error)[]) {
  const calls: { model: string; inputs: Record<string, unknown> }[] = [];
  const ai: AiRunner = {
    async run(model, inputs) {
      calls.push({ model, inputs: structuredClone(inputs) });
      const next = responses.shift();
      if (next === undefined) throw new Error("fakeAi: no more responses queued");
      if (next instanceof Error) throw next;
      return next;
    },
  };
  return { ai, calls };
}

export const answer = (cron: string, assumptions = "") => ({
  response: { possible: true, cron, reason: "", assumptions },
});
export const impossible = (reason: string) => ({
  response: { possible: false, cron: "", reason, assumptions: "" },
});

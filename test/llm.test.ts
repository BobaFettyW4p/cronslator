import { describe, expect, it } from "vitest";
import { extractAnswer, translate } from "../worker/llm";
import { answer, fakeAi, impossible } from "./fakeAi";

const M = "@cf/test/model";

describe("extractAnswer", () => {
  const a = { possible: true, cron: "0 9 * * *", reason: "", assumptions: "" };
  it("handles { response: object }", () => expect(extractAnswer({ response: a })).toEqual(a));
  it("handles { response: string }", () => expect(extractAnswer({ response: JSON.stringify(a) })).toEqual(a));
  it("handles OpenAI choices shape", () =>
    expect(extractAnswer({ choices: [{ message: { content: JSON.stringify(a) } }] })).toEqual(a));
  it("strips markdown fences", () => expect(extractAnswer("```json\n" + JSON.stringify(a) + "\n```")).toEqual(a));
  it("rejects non-JSON", () => expect(() => extractAnswer({ response: "sure! 0 9 * * *" })).toThrow(/valid JSON/));
  it("rejects missing fields", () => expect(() => extractAnswer({ response: { cron: "x" } })).toThrow(/possible/));
});

describe("translate", () => {
  it("returns a validated, normalized cron on the first try", async () => {
    const { ai, calls } = fakeAi(answer("30  9 * * 1-5", "none"));
    expect(await translate(ai, M, "weekdays at 9:30")).toEqual({
      kind: "ok",
      cron: "30 9 * * 1-5",
      assumptions: "none",
      attempts: 1,
    });
    expect(calls).toHaveLength(1);
    expect(calls[0].model).toBe(M);
    const msgs = calls[0].inputs.messages as { role: string; content: string }[];
    expect(msgs[0].role).toBe("system");
    expect(msgs.at(-1)).toEqual({ role: "user", content: "weekdays at 9:30" });
    expect(calls[0].inputs.response_format).toMatchObject({ type: "json_schema" });
  });

  it("retries once with the validation error, then succeeds", async () => {
    const { ai, calls } = fakeAi(answer("0 0 L * *"), answer("0 0 28-31 * *"));
    const r = await translate(ai, M, "end of month");
    expect(r).toMatchObject({ kind: "ok", cron: "0 0 28-31 * *", attempts: 2 });
    const retryMsgs = calls[1].inputs.messages as { role: string; content: string }[];
    expect(retryMsgs.at(-1)?.content).toMatch(/invalid.*Non-standard/);
  });

  it("gives up after two invalid answers", async () => {
    const { ai } = fakeAi(answer("0 0 * * * *"), answer("@daily"));
    expect(await translate(ai, M, "daily")).toMatchObject({ kind: "failed", attempts: 2 });
  });

  it("retries after a model/network error", async () => {
    const { ai } = fakeAi(new Error("upstream 500"), answer("0 * * * *"));
    expect(await translate(ai, M, "hourly")).toMatchObject({ kind: "ok", cron: "0 * * * *", attempts: 2 });
  });

  it("passes through not-expressible answers without retrying", async () => {
    const { ai, calls } = fakeAi(impossible("No L in standard cron."));
    expect(await translate(ai, M, "last day of month")).toEqual({
      kind: "not_expressible",
      reason: "No L in standard cron.",
      attempts: 1,
    });
    expect(calls).toHaveLength(1);
  });
});

describe("translate: quota exhaustion", () => {
  it("returns over_capacity immediately without retrying", async () => {
    const { ai, calls } = fakeAi(
      new Error("4006: you have used up your daily free allocation of 10,000 neurons, please upgrade"),
      answer("0 * * * *"),
    );
    expect(await translate(ai, "m", "hourly")).toMatchObject({ kind: "over_capacity", attempts: 1 });
    expect(calls).toHaveLength(1);
  });
});

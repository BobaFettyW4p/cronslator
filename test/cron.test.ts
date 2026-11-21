import { describe, expect, it } from "vitest";
import { describeCron, enrich, isValidTimeZone, nextRuns, validateCron, warnings } from "../worker/cron";

describe("validateCron: accepts standard 5-field cron", () => {
  it.each([
    "* * * * *",
    "*/15 * * * *",
    "30 9 * * 1-5",
    "*/15 9-17 * * 1-5",
    "0 12 1 * *",
    "0 0 1 1 *",
    "0 0,12 * * *",
    "5-55/10 * * * *",
    "0 9 * * MON-FRI",
    "0 0 * JAN,JUL *",
    "0 0 * * 7",
    "0 0 * * 0",
  ])("%s", (expr) => {
    expect(validateCron(expr)).toEqual({ ok: true, cron: expr.toUpperCase() });
  });

  it("normalizes whitespace and case", () => {
    expect(validateCron("  0   9  * *  mon-fri ")).toEqual({ ok: true, cron: "0 9 * * MON-FRI" });
  });
});

describe("validateCron: rejects non-standard or invalid input", () => {
  it.each([
    ["", /empty/i],
    ["   ", /empty/i],
    ["* * * *", /5 fields/],
    ["0 * * * * *", /5 fields/],
    ["0 0 12 * * ? 2026", /5 fields/],
    ["@daily", /macro/i],
    ["0 0 ? * MON", /non-standard/i],
    ["0 0 L * *", /non-standard/i],
    ["0 0 15W * *", /non-standard/i],
    ["0 0 * * 1#2", /non-standard/i],
    ["H * * * *", /non-standard/i],
    ["60 * * * *", /out of range/],
    ["* 24 * * *", /out of range/],
    ["* * 0 * *", /out of range/],
    ["* * 32 * *", /out of range/],
    ["* * * 13 *", /out of range/],
    ["* * * * 8", /out of range/],
    ["*/0 * * * *", /step of 0/i],
    ["*/90 * * * *", /larger/],
    ["0 17-9 * * *", /backwards/],
    ["0 9 * * FOO", /not a valid day of week name/],
    ["0 MON * * *", /not allowed in the hour/],
    ["0 9,,10 * * *", /empty list item/i],
    ["0 9 * * 1-", /not valid/],
  ])("%j", (expr, msg) => {
    const r = validateCron(expr);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toMatch(msg);
  });
});

describe("isValidTimeZone", () => {
  it("accepts IANA names", () => {
    expect(isValidTimeZone("UTC")).toBe(true);
    expect(isValidTimeZone("America/Chicago")).toBe(true);
  });
  it("rejects garbage", () => {
    expect(isValidTimeZone("Mars/Olympus")).toBe(false);
    expect(isValidTimeZone("")).toBe(false);
  });
});

describe("describeCron", () => {
  it("describes common schedules", () => {
    expect(describeCron("30 9 * * 1-5")).toBe("At 09:30 AM, Monday through Friday");
    expect(describeCron("*/15 * * * *")).toBe("Every 15 minutes");
  });
});

describe("nextRuns", () => {
  const from = new Date("2026-03-02T12:00:00Z"); // a Monday

  it("computes runs in UTC", () => {
    expect(nextRuns("30 9 * * 1-5", "UTC", 3, from)).toEqual([
      "2026-03-03T09:30:00.000Z",
      "2026-03-04T09:30:00.000Z",
      "2026-03-05T09:30:00.000Z",
    ]);
  });

  it("respects the timezone (9:30 Chicago = 15:30 UTC in early March, CST)", () => {
    expect(nextRuns("30 9 * * 1-5", "America/Chicago", 1, from)).toEqual(["2026-03-02T15:30:00.000Z"]);
  });

  it("handles the DST shift (CDT starts 2026-03-08, so 9:30 Chicago = 14:30 UTC)", () => {
    const runs = nextRuns("30 9 * * 1-5", "America/Chicago", 6, from);
    expect(runs[4]).toBe("2026-03-06T15:30:00.000Z");
    expect(runs[5]).toBe("2026-03-09T14:30:00.000Z");
  });

  it("uses OR semantics when both day-of-month and day-of-week are set", () => {
    // 1st of the month OR any Monday
    expect(nextRuns("0 0 1 * 1", "UTC", 3, from)).toEqual([
      "2026-03-09T00:00:00.000Z",
      "2026-03-16T00:00:00.000Z",
      "2026-03-23T00:00:00.000Z",
    ]);
    expect(nextRuns("0 0 1 * 1", "UTC", 6, from)).toContain("2026-04-01T00:00:00.000Z");
  });
});

describe("warnings", () => {
  it("flags DOM + DOW OR semantics", () => {
    expect(warnings("0 0 1 * 1")[0]).toMatch(/EITHER/);
  });
  it("flags every-minute schedules", () => {
    expect(warnings("* 9 * * *")[0]).toMatch(/every minute/);
    expect(warnings("* * * * *")).toEqual(["This runs every minute."]);
  });
  it("is empty for ordinary schedules", () => {
    expect(warnings("30 9 * * 1-5")).toEqual([]);
  });
});

describe("enrich", () => {
  it("bundles everything for the API response", () => {
    const d = enrich("0 12 1 * *", "UTC", new Date("2026-03-02T12:00:00Z"));
    expect(d.description).toMatch(/12:00 PM, on day 1 of the month/);
    expect(d.fields.map((f) => f.value)).toEqual(["0", "12", "1", "*", "*"]);
    expect(d.nextRuns[0]).toBe("2026-04-01T12:00:00.000Z");
    expect(d.timezone).toBe("UTC");
    expect(d.warnings).toEqual([]);
  });
});

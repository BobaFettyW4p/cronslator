import { describe, expect, it } from "vitest";
import { cronEquivalent, expandField } from "./eval/equivalence";

describe("expandField", () => {
  it("handles *, ranges, lists, steps and names", () => {
    expect([...expandField("*/15", 0, 59)]).toEqual([0, 15, 30, 45]);
    expect([...expandField("1-10/3", 0, 59)]).toEqual([1, 4, 7, 10]);
    expect([...expandField("5/20", 0, 59)]).toEqual([5, 25, 45]);
    expect([...expandField("1,3,5", 0, 7)]).toEqual([1, 3, 5]);
    expect([...expandField("MON-FRI", 0, 7, ["SUN", "MON", "TUE", "WED", "THU", "FRI", "SAT"])]).toEqual([1, 2, 3, 4, 5]);
  });
});

describe("cronEquivalent", () => {
  it.each([
    ["*/30 * * * *", "0,30 * * * *"],
    ["0 */6 * * *", "0 0,6,12,18 * * *"],
    ["0 1-23/4 * * *", "0 1,5,9,13,17,21 * * *"],
    ["0 9 * * 1-5", "0 9 * * MON-FRI"],
    ["0 0 * * 0", "0 0 * * 7"],
    ["0 0 * * 0,6", "0 0 * * 6,0"],
    ["0 0 1-31 * *", "0 0 * * *"],
    ["30 2 1 */2 *", "30 2 1 1,3,5,7,9,11 *"],
    ["0 9 * 6-8 6", "0 9 * JUN-AUG SAT"],
  ])("%s ≡ %s", (a, b) => expect(cronEquivalent(a, b)).toBe(true));

  it.each([
    ["*/15 9-16 * * 1-5", "*/15 9-17 * * 1-5"],
    ["0 9 * * 1", "0 9 * * 2"],
    ["0 0 1 * 1", "0 0 1 * *"], // OR semantics: also every Monday
    ["0 0 1-31 * 1", "0 0 * * 1"], // restricted DOM → OR → every day
    ["0 0 */2 * *", "0 0 1-31/2 * 1"],
    ["0 9 * * *", "0 9 * * * extra"],
    ["0 0 L * *", "0 0 L * *"], // invalid crons are never equivalent
  ])("%s ≢ %s", (a, b) => expect(cronEquivalent(a, b)).toBe(false));
});

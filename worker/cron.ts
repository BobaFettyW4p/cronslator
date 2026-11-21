import { CronExpressionParser } from "cron-parser";
import cronstrue from "cronstrue";

/**
 * Standard 5-field Unix cron: minute hour day-of-month month day-of-week.
 * We deliberately reject non-standard extensions (seconds, ?, L, W, #, H, @macros)
 * because the output is meant to be pasted into crontab, Kubernetes, GitHub
 * Actions, Cloudflare Cron Triggers, etc.
 */

export const FIELD_NAMES = ["minute", "hour", "day of month", "month", "day of week"] as const;
export type FieldName = (typeof FIELD_NAMES)[number];

const MONTH_NAMES = ["JAN", "FEB", "MAR", "APR", "MAY", "JUN", "JUL", "AUG", "SEP", "OCT", "NOV", "DEC"];
const DOW_NAMES = ["SUN", "MON", "TUE", "WED", "THU", "FRI", "SAT"];

const FIELD_RANGES: Record<FieldName, [number, number]> = {
  minute: [0, 59],
  hour: [0, 23],
  "day of month": [1, 31],
  month: [1, 12],
  "day of week": [0, 7], // 0 and 7 are both Sunday
};

// One list item: "*", "5", "MON", "1-5", "MON-FRI", optionally followed by "/step".
const ITEM_RE = /^(\*|[0-9]+|[A-Z]{3})(?:-([0-9]+|[A-Z]{3}))?(?:\/([0-9]+))?$/;

export type ValidationResult = { ok: true; cron: string } | { ok: false; error: string };

/** Trim, collapse whitespace and uppercase month/day names. */
export function normalizeCron(input: string): string {
  return input.trim().replace(/\s+/g, " ").toUpperCase();
}

function namesFor(field: FieldName): string[] | null {
  if (field === "month") return MONTH_NAMES;
  if (field === "day of week") return DOW_NAMES;
  return null;
}

function toNumber(token: string, field: FieldName): number | string {
  if (/^[0-9]+$/.test(token)) return Number(token);
  const names = namesFor(field);
  if (!names) return `"${token}" is not allowed in the ${field} field`;
  const idx = names.indexOf(token);
  if (idx === -1) return `"${token}" is not a valid ${field} name`;
  return field === "month" ? idx + 1 : idx;
}

function validateField(value: string, field: FieldName): string | null {
  const [min, max] = FIELD_RANGES[field];
  for (const item of value.split(",")) {
    if (item === "") return `Empty list item in the ${field} field`;
    const m = ITEM_RE.exec(item);
    if (!m) return `"${item}" is not valid standard cron syntax in the ${field} field`;
    const [, start, end, step] = m;

    const bounds: number[] = [];
    for (const tok of [start, end]) {
      if (tok === undefined || tok === "*") continue;
      const n = toNumber(tok, field);
      if (typeof n === "string") return n;
      if (n < min || n > max) return `${n} is out of range for the ${field} field (${min}-${max})`;
      bounds.push(n);
    }
    if (start === "*" && end !== undefined) return `"${item}" is not valid: "*" cannot start a range`;
    if (bounds.length === 2 && bounds[0] > bounds[1]) {
      return `Range "${item}" in the ${field} field runs backwards`;
    }
    if (step !== undefined) {
      const s = Number(step);
      if (s === 0) return `Step of 0 in the ${field} field is not allowed`;
      if (s > max) return `Step of ${s} is larger than the ${field} field allows (max ${max})`;
    }
  }
  return null;
}

/** Strictly validate a standard 5-field cron expression. */
export function validateCron(input: string): ValidationResult {
  if (typeof input !== "string" || input.trim() === "") {
    return { ok: false, error: "Cron expression is empty" };
  }
  const cron = normalizeCron(input);

  if (cron.startsWith("@")) {
    return { ok: false, error: `Macros like "${cron}" are not standard; use 5 fields instead` };
  }
  const parts = cron.split(" ");
  if (parts.length !== 5) {
    return {
      ok: false,
      error: `Expected 5 fields (minute hour day-of-month month day-of-week) but got ${parts.length}`,
    };
  }
  if (/[?LW#H]/.test(cron.replace(/[A-Z]{3}/g, ""))) {
    return { ok: false, error: "Non-standard characters (?, L, W, #, H) are not supported in 5-field cron" };
  }
  for (let i = 0; i < 5; i++) {
    const err = validateField(parts[i], FIELD_NAMES[i]);
    if (err) return { ok: false, error: err };
  }

  // Final sanity check with the library (catches anything we missed).
  try {
    CronExpressionParser.parse(cron);
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) };
  }
  return { ok: true, cron };
}

export function isValidTimeZone(tz: string): boolean {
  if (typeof tz !== "string" || tz === "") return false;
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: tz });
    return true;
  } catch {
    return false;
  }
}

/** Human-readable description, generated deterministically (not by the LLM). */
export function describeCron(cron: string): string {
  return cronstrue.toString(cron, { verbose: false, use24HourTimeFormat: false, throwExceptionOnParseError: true });
}

/** Next `count` run times as ISO-8601 UTC strings, evaluated in `tz`. */
export function nextRuns(cron: string, tz: string, count = 5, from: Date = new Date()): string[] {
  const interval = CronExpressionParser.parse(cron, { tz, currentDate: from });
  return interval.take(count).map((d) => {
    const iso = d.toISOString();
    if (!iso) throw new Error("Could not compute next run time");
    return iso;
  });
}

export function breakdown(cron: string): { field: FieldName; value: string }[] {
  return cron.split(" ").map((value, i) => ({ field: FIELD_NAMES[i], value }));
}

/** Gotchas worth surfacing to the user. */
export function warnings(cron: string): string[] {
  const [minute, hour, dom, , dow] = cron.split(" ");
  const out: string[] = [];
  if (dom !== "*" && dow !== "*") {
    out.push(
      "Both day-of-month and day-of-week are set. Cron runs when EITHER matches, not only when both do.",
    );
  }
  if (minute === "*" && hour !== "*") {
    out.push("Minute is \"*\", so this runs every minute during the matching hours.");
  }
  if (minute === "*" && hour === "*") {
    out.push("This runs every minute.");
  }
  return out;
}

export interface CronDetails {
  cron: string;
  description: string;
  fields: { field: FieldName; value: string }[];
  nextRuns: string[];
  timezone: string;
  warnings: string[];
}

/** Assumes `cron` has already passed validateCron and `tz` passed isValidTimeZone. */
export function enrich(cron: string, tz: string, from: Date = new Date()): CronDetails {
  return {
    cron,
    description: describeCron(cron),
    fields: breakdown(cron),
    nextRuns: nextRuns(cron, tz, 5, from),
    timezone: tz,
    warnings: warnings(cron),
  };
}

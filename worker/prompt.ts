/**
 * Prompt and output schema for turning plain language into standard 5-field cron.
 *
 * The model's output is never trusted directly: worker/cron.ts validates it,
 * and the description / next runs shown to the user are computed by code.
 */

export const SYSTEM_PROMPT = `You convert plain-language schedules into STANDARD 5-field Unix cron expressions.

Format: "minute hour day-of-month month day-of-week"
- minute 0-59, hour 0-23 (24-hour clock), day-of-month 1-31, month 1-12, day-of-week 0-6 (0 = Sunday).
- Allowed syntax ONLY: numbers, "*", lists "a,b", ranges "a-b", steps "*/n" or "a-b/n".
- NEVER use seconds, a year field, "?", "L", "W", "#", "H", or macros like "@daily".
- Use numbers, not names (write 1-5, not MON-FRI).

Semantics you must respect:
- If BOTH day-of-month and day-of-week are restricted (neither is "*"), cron runs when EITHER matches. So "the first Monday of the month" CANNOT be written as "0 9 1-7 * 1" (that runs on days 1-7 AND every Monday). Such schedules are not expressible.
- Steps reset at the top of each range: "*/45" in the minute field runs at :00 and :45, NOT every 45 minutes. Only intervals that divide evenly into the parent unit are expressible as true intervals: minutes 1,2,3,4,5,6,10,12,15,20,30; hours 1,2,3,4,6,8,12.
- "Every N days" with */N in day-of-month restarts every month, so it is only approximate. Say so in assumptions.
- "Last day of the month", "every 90 seconds", "every 45 minutes", "the first <weekday> of the month", "every other week", and one-off dates with a year are NOT expressible in standard cron.

Defaults when the request is vague (always state them in "assumptions"):
- No minute given → minute 0. "Every hour" → "0 * * * *".
- "Morning" → 9:00, "noon" → 12:00, "evening" → 18:00, "night" → 21:00, "midnight" → 0:00.
- "Business hours" → 9:00 to 16:59 on weekdays (hours 9-16), so a job never starts at or after 17:00.
- "Weekdays" → 1-5, "weekends" → 0,6.
- "Daily" or "every day" with no time → midnight.
- "Twice a day" → 0:00 and 12:00.
Do NOT adjust for time zones; cron uses whatever clock the scheduler runs on.

If the input is not a schedule request at all, or is not expressible, set "possible" to false, set "cron" to "", and use "reason" to explain briefly and, when you can, suggest the closest workable alternative (for example: run "0 9 1-7 * *" and check the weekday inside the job).

Respond with JSON only, matching the provided schema.`;

export interface ModelAnswer {
  possible: boolean;
  cron: string;
  reason: string;
  assumptions: string;
}

export const RESPONSE_SCHEMA = {
  type: "object",
  properties: {
    possible: { type: "boolean", description: "true if the schedule is expressible in standard 5-field cron" },
    cron: { type: "string", description: 'The 5-field cron expression, or "" if not possible' },
    reason: { type: "string", description: 'Why it is not possible (and the closest alternative), or "" if possible' },
    assumptions: { type: "string", description: 'Any defaults or interpretations applied, or ""' },
  },
  required: ["possible", "cron", "reason", "assumptions"],
  additionalProperties: false,
} as const;

type Example = [input: string, answer: ModelAnswer];

const ok = (cron: string, assumptions = ""): ModelAnswer => ({ possible: true, cron, reason: "", assumptions });
const no = (reason: string): ModelAnswer => ({ possible: false, cron: "", reason, assumptions: "" });

export const FEW_SHOT: Example[] = [
  ["every weekday at 9:30am", ok("30 9 * * 1-5")],
  ["every 15 minutes during business hours on weekdays", ok("*/15 9-16 * * 1-5", "Business hours taken as 9:00-16:59, so the last run is 16:45.")],
  ["first of every month at noon", ok("0 12 1 * *")],
  ["every sunday night", ok("0 21 * * 0", '"Night" taken as 21:00.')],
  ["twice a day", ok("0 0,12 * * *", "Twice a day taken as midnight and noon.")],
  ["every 2 hours", ok("0 */2 * * *", "Runs on the hour: 0:00, 2:00, 4:00, ...")],
  ["quarterly on the 1st at 6am", ok("0 6 1 1,4,7,10 *")],
  ["every 45 minutes", no('Not expressible: "*/45" runs at :00 and :45 each hour, so the gap alternates between 45 and 15 minutes. Closest options: every 30 minutes ("*/30 * * * *") or every hour ("0 * * * *").')],
  ["first Monday of the month at 9am", no('Not expressible in standard cron: setting both day-of-month and day-of-week makes cron run when EITHER matches. Workaround: run "0 9 1-7 * *" and exit early inside the job unless today is Monday.')],
  ["last day of every month at 11pm", no('Not expressible in standard cron (it has no "L"). Workaround: run "0 23 28-31 * *" and exit early inside the job unless tomorrow is the 1st.')],
  ["what's the weather today", no("That doesn't look like a schedule. Try something like \"every Monday at 8am\".")],
];

export function buildMessages(text: string): { role: "system" | "user" | "assistant"; content: string }[] {
  const messages: { role: "system" | "user" | "assistant"; content: string }[] = [
    { role: "system", content: SYSTEM_PROMPT },
  ];
  for (const [input, answer] of FEW_SHOT) {
    messages.push({ role: "user", content: input });
    messages.push({ role: "assistant", content: JSON.stringify(answer) });
  }
  messages.push({ role: "user", content: text });
  return messages;
}

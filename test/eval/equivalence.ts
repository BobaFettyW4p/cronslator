import { validateCron } from "../../worker/cron";

const MONTHS = ["JAN", "FEB", "MAR", "APR", "MAY", "JUN", "JUL", "AUG", "SEP", "OCT", "NOV", "DEC"];
const DAYS = ["SUN", "MON", "TUE", "WED", "THU", "FRI", "SAT"];

function toNum(tok: string, names?: string[], offset = 0): number {
  if (/^\d+$/.test(tok)) return Number(tok);
  const i = names?.indexOf(tok) ?? -1;
  if (i < 0) throw new Error(`bad token ${tok}`);
  return i + offset;
}

/** Expand one (already validated) cron field into the set of values it matches. */
export function expandField(field: string, min: number, max: number, names?: string[], offset = 0): Set<number> {
  const out = new Set<number>();
  for (const item of field.split(",")) {
    const [range, stepStr] = item.split("/");
    const step = stepStr ? Number(stepStr) : 1;
    let lo: number;
    let hi: number;
    if (range === "*") {
      lo = min;
      hi = max;
    } else if (range.includes("-")) {
      const [a, b] = range.split("-");
      lo = toNum(a, names, offset);
      hi = toNum(b, names, offset);
    } else {
      lo = toNum(range, names, offset);
      hi = stepStr ? max : lo; // "5/15" means 5-max/15
    }
    for (let v = lo; v <= hi; v += step) out.add(v);
  }
  return out;
}

/**
 * A canonical fingerprint of when a cron fires. Two crons are equivalent iff
 * their fingerprints match. Day matching follows Vixie cron: if either day
 * field starts with "*", both must match (AND); otherwise either may (OR).
 */
export function cronSignature(cron: string): string {
  const v = validateCron(cron);
  if (!v.ok) throw new Error(`invalid cron "${cron}": ${v.error}`);
  const [mi, h, dom, mon, dow] = v.cron.split(" ");
  const minutes = expandField(mi, 0, 59);
  const hours = expandField(h, 0, 23);
  const doms = expandField(dom, 1, 31);
  const months = expandField(mon, 1, 12, MONTHS, 1);
  const dows = new Set([...expandField(dow, 0, 7, DAYS)].map((d) => d % 7));
  const domStar = dom.startsWith("*");
  const dowStar = dow.startsWith("*");
  let grid = "";
  for (let d = 1; d <= 31; d++) {
    for (let w = 0; w < 7; w++) {
      const hit = domStar || dowStar ? doms.has(d) && dows.has(w) : doms.has(d) || dows.has(w);
      grid += hit ? "1" : "0";
    }
  }
  const s = (set: Set<number>) => [...set].sort((a, b) => a - b).join(",");
  return [s(minutes), s(hours), s(months), grid].join("|");
}

export function cronEquivalent(a: string, b: string): boolean {
  try {
    return cronSignature(a) === cronSignature(b);
  } catch {
    return false;
  }
}

/**
 * Accuracy eval: runs the golden set through the same translate() code the
 * Worker uses, against the real Workers AI model (no cache, no rate limit).
 *
 *   npm run eval                      # all cases, default model from wrangler.jsonc
 *   npm run eval -- --model @cf/...   # try another model
 *   npm run eval -- --tag intervals   # one category
 *   npm run eval -- --repeat 3        # run each case 3x to measure consistency
 *   npm run eval -- --min 0.95        # exit 1 if accuracy is below 95%
 *
 * Needs Cloudflare credentials: `wrangler login` locally, or
 * CLOUDFLARE_API_TOKEN + CLOUDFLARE_ACCOUNT_ID in CI.
 */
import { parseArgs } from "node:util";
import { getPlatformProxy } from "wrangler";
import { translate, type AiRunner, type TranslateResult } from "../../worker/llm";
import { CASES, type EvalCase } from "./cases";
import { cronEquivalent } from "./equivalence";

const { values: args } = parseArgs({
  options: {
    model: { type: "string" },
    tag: { type: "string" },
    repeat: { type: "string", default: "1" },
    concurrency: { type: "string", default: "4" },
    min: { type: "string" },
    json: { type: "boolean", default: false },
  },
});

interface Outcome {
  c: EvalCase;
  run: number;
  result: TranslateResult;
  pass: boolean;
  ms: number;
}

function judge(c: EvalCase, r: TranslateResult): boolean {
  if ("notExpressible" in c) {
    if (r.kind === "not_expressible") return true;
    return r.kind === "ok" && (c.orCron ?? []).some((ok) => cronEquivalent(r.cron, ok));
  }
  return r.kind === "ok" && c.cron.some((ok) => cronEquivalent(r.cron, ok));
}

function expected(c: EvalCase): string {
  if ("notExpressible" in c) return c.orCron ? `not expressible (or ${c.orCron.join(" | ")})` : "not expressible";
  return c.cron.join(" | ");
}

function got(r: TranslateResult): string {
  if (r.kind === "ok") return r.cron + (r.attempts > 1 ? `  (after ${r.attempts} attempts)` : "");
  if (r.kind === "not_expressible") return `not expressible: ${r.reason.slice(0, 90)}`;
  return `FAILED: ${r.error.slice(0, 90)}`;
}

async function pool<T, R>(items: T[], n: number, fn: (t: T) => Promise<R>): Promise<R[]> {
  const out: R[] = new Array(items.length);
  let next = 0;
  await Promise.all(
    Array.from({ length: Math.min(n, items.length) }, async () => {
      while (next < items.length) {
        const i = next++;
        out[i] = await fn(items[i]);
      }
    }),
  );
  return out;
}

const proxy = await getPlatformProxy<Env>({ persist: false });
try {
  const model = args.model ?? proxy.env.MODEL;
  const ai = proxy.env.AI as unknown as AiRunner;
  const cases = CASES.filter((c) => !args.tag || c.tag === args.tag);
  const repeat = Math.max(1, Number(args.repeat));
  const jobs = cases.flatMap((c) => Array.from({ length: repeat }, (_, run) => ({ c, run })));

  console.error(`Evaluating ${model} on ${cases.length} cases × ${repeat}…`);
  const started = Date.now();
  let quotaHit = "";
  const outcomes: Outcome[] = await pool(jobs, Number(args.concurrency), async ({ c, run }) => {
    if (quotaHit) return null as unknown as Outcome;
    const t = Date.now();
    let result: TranslateResult;
    try {
      result = await translate(ai, model, c.q);
    } catch (e) {
      result = { kind: "failed", error: String(e), attempts: 0 };
    }
    if (result.kind === "over_capacity") {
      quotaHit = result.error;
      return null as unknown as Outcome;
    }
    const pass = judge(c, result);
    process.stderr.write(pass ? "." : "F");
    return { c, run, result, pass, ms: Date.now() - t };
  });
  process.stderr.write("\n");
  if (quotaHit) {
    console.error(
      `\nStopped: Workers AI quota exhausted (${quotaHit.slice(0, 120)}).\n` +
        "The eval shares the account's daily allocation with the live site. Results are incomplete; not scoring.",
    );
    process.exit(2);
  }

  const passed = outcomes.filter((o) => o.pass).length;
  const accuracy = passed / outcomes.length;

  if (args.json) {
    console.log(
      JSON.stringify(
        {
          model,
          accuracy,
          passed,
          total: outcomes.length,
          outcomes: outcomes.map((o) => ({ q: o.c.q, tag: o.c.tag, run: o.run, pass: o.pass, ms: o.ms, result: o.result })),
        },
        null,
        2,
      ),
    );
  } else {
    const failures = outcomes.filter((o) => !o.pass);
    if (failures.length) {
      console.log("\nFailures:");
      for (const f of failures) {
        console.log(`  ✗ [${f.c.tag}] "${f.c.q}"`);
        console.log(`      expected: ${expected(f.c)}`);
        console.log(`      got:      ${got(f.result)}`);
      }
    }
    console.log("\nBy category:");
    const tags = [...new Set(outcomes.map((o) => o.c.tag))];
    for (const tag of tags) {
      const t = outcomes.filter((o) => o.c.tag === tag);
      console.log(`  ${tag.padEnd(16)} ${t.filter((o) => o.pass).length}/${t.length}`);
    }
    const ms = outcomes.map((o) => o.ms).sort((a, b) => a - b);
    const p = (q: number) => (ms[Math.min(ms.length - 1, Math.floor(q * ms.length))] / 1000).toFixed(1);
    const retries = outcomes.filter((o) => o.result.attempts > 1).length;
    console.log(`\nModel:    ${model}`);
    console.log(`Accuracy: ${(accuracy * 100).toFixed(1)}%  (${passed}/${outcomes.length})`);
    console.log(`Latency:  p50 ${p(0.5)}s  p90 ${p(0.9)}s  max ${p(1)}s   retries: ${retries}`);
    console.log(`Wall:     ${((Date.now() - started) / 1000).toFixed(0)}s`);
  }

  if (args.min !== undefined && accuracy < Number(args.min)) {
    console.error(`\nAccuracy ${(accuracy * 100).toFixed(1)}% is below the required ${Number(args.min) * 100}%.`);
    process.exitCode = 1;
  }
} finally {
  await proxy.dispose();
}

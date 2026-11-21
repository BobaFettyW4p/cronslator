import { useEffect, useMemo, useRef, useState, type FormEvent } from "react";
import { MAX_INPUT_LENGTH, type ApiError, type CronDetails } from "../shared/api";
import { describeCron, parseSchedule } from "./api";
import { CronResult } from "./components/CronResult";
import { browserTimeZone, suggestedCrons, timeZones } from "./format";

const EXAMPLES = [
  "every weekday at 9:30am",
  "every 15 minutes",
  "first of the month at noon",
  "twice a day on weekends",
  "every sunday night",
  "first Monday of the month",
];

type View =
  | { kind: "idle" }
  | { kind: "result"; details: CronDetails; assumptions: string; heading: string }
  | { kind: "error"; error: ApiError; heading: string };

const ERROR_TITLE: Record<string, string> = {
  not_expressible: "Cron can’t express that exactly",
  rate_limited: "Slow down a little",
  bad_request: "Hmm, check that input",
  model_error: "That didn’t work",
  over_capacity: "Daily limit reached",
};

export default function App() {
  const [text, setText] = useState("");
  const [tz, setTz] = useState(browserTimeZone);
  const [view, setView] = useState<View>({ kind: "idle" });
  const [loading, setLoading] = useState(false);
  const [updating, setUpdating] = useState(false);
  const inflight = useRef<AbortController | null>(null);
  const zones = useMemo(timeZones, []);
  const inputRef = useRef<HTMLInputElement>(null);

  function startRequest(): AbortSignal {
    inflight.current?.abort();
    inflight.current = new AbortController();
    return inflight.current.signal;
  }

  async function translate(input: string) {
    const trimmed = input.trim();
    if (!trimmed) {
      inputRef.current?.focus();
      return;
    }
    const signal = startRequest();
    setLoading(true);
    try {
      const res = await parseSchedule({ text: trimmed, timezone: tz }, signal);
      if (res.ok) {
        const { ok: _ok, input: echoed, assumptions, model: _model, ...details } = res;
        setView({ kind: "result", details, assumptions, heading: echoed });
      } else {
        setView({ kind: "error", error: res, heading: trimmed });
      }
    } catch {
      return; // aborted by a newer request
    } finally {
      if (!signal.aborted) setLoading(false);
    }
  }

  /** Re-explain an existing cron (timezone change or a suggested alternative); no model call. */
  async function explain(cron: string, timezone: string, next: (d: CronDetails) => View) {
    const signal = startRequest();
    setUpdating(true);
    try {
      const res = await describeCron(cron, timezone, signal);
      if (res.ok) {
        const { ok: _ok, ...details } = res;
        setView(next(details));
      }
    } catch {
      return;
    } finally {
      if (!signal.aborted) setUpdating(false);
    }
  }

  useEffect(() => {
    if (view.kind === "result" && view.details.timezone !== tz) {
      void explain(view.details.cron, tz, (details) => ({ ...view, details }));
    }
    // Only react to timezone changes; `view` is read at that moment.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tz]);

  function onSubmit(e: FormEvent) {
    e.preventDefault();
    void translate(text);
  }

  function pickExample(example: string) {
    setText(example);
    void translate(example);
  }

  const remaining = MAX_INPUT_LENGTH - text.length;

  return (
    <div className="page">
      <header className="masthead">
        <h1 className="wordmark">
          <span className="logo" aria-hidden="true">✱</span> Cronslator
        </h1>
        <p className="tagline">Describe a schedule in plain English. Get a cron expression you can trust.</p>
      </header>

      <main>
        <form className="card ask" onSubmit={onSubmit}>
          <label htmlFor="schedule" className="sr-only">
            Describe your schedule
          </label>
          <div className="ask-row">
            <input
              id="schedule"
              ref={inputRef}
              type="text"
              value={text}
              onChange={(e) => setText(e.target.value)}
              maxLength={MAX_INPUT_LENGTH}
              placeholder="e.g. every weekday at 9:30am"
              autoComplete="off"
              autoFocus
              aria-describedby="char-count"
            />
            <button type="submit" className="btn btn-primary" disabled={loading}>
              {loading ? <span className="spinner" aria-label="Translating" /> : "Translate"}
            </button>
          </div>

          <div className="ask-meta">
            <label className="tz">
              <span className="muted">Scheduler timezone</span>
              <select value={tz} onChange={(e) => setTz(e.target.value)}>
                {zones.map((z) => (
                  <option key={z} value={z}>
                    {z.replaceAll("_", " ")}
                  </option>
                ))}
              </select>
            </label>
            <span id="char-count" className={`muted count${remaining < 20 ? " count-low" : ""}`}>
              {remaining < 50 ? `${remaining} characters left` : ""}
            </span>
          </div>

          <div className="examples" aria-label="Examples">
            {EXAMPLES.map((ex) => (
              <button type="button" key={ex} className="chip" onClick={() => pickExample(ex)} disabled={loading}>
                {ex}
              </button>
            ))}
          </div>
        </form>

        <div aria-live="polite">
          {view.kind === "result" && (
            <CronResult
              details={view.details}
              assumptions={view.assumptions}
              heading={view.heading}
              updating={updating}
            />
          )}

          {view.kind === "error" && (
            <ErrorCard
              error={view.error}
              onSuggestion={(cron) =>
                explain(cron, tz, (details) => ({
                  kind: "result",
                  details,
                  assumptions: "",
                  heading: `${view.heading} (suggested workaround)`,
                }))
              }
            />
          )}
        </div>
      </main>

      <footer className="footer">
        <p>
          An AI model drafts the expression. The description, warnings and run times are computed by code, so you
          can check its work.
        </p>
        <p>
          Standard 5-field cron · Runs on Cloudflare Workers AI ·{" "}
          <a href="https://github.com/BobaFettyW4p/cronslator">Source on GitHub</a>
        </p>
      </footer>
    </div>
  );
}

function ErrorCard({ error, onSuggestion }: { error: ApiError; onSuggestion: (cron: string) => void }) {
  const suggestions = error.error === "not_expressible" ? suggestedCrons(error.message) : [];
  const tone = ["not_expressible", "rate_limited", "over_capacity"].includes(error.error) ? "warn" : "error";
  return (
    <section className={`card notice notice-${tone}`} role="status">
      <h2>{ERROR_TITLE[error.error] ?? "Something went wrong"}</h2>
      <p>{error.message}</p>
      {suggestions.length > 0 && (
        <div className="suggestions">
          {suggestions.map((s) => (
            <button type="button" key={s} className="btn btn-ghost" onClick={() => onSuggestion(s)}>
              Explain <code>{s}</code>
            </button>
          ))}
        </div>
      )}
    </section>
  );
}

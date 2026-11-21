import type { CSSProperties } from "react";
import type { CronDetails } from "../../shared/api";
import { formatRun, relative } from "../format";
import { CopyButton } from "./CopyButton";

const SHORT_LABEL: Record<string, string> = {
  minute: "minute",
  hour: "hour",
  "day of month": "day (month)",
  month: "month",
  "day of week": "day (week)",
};

interface Props {
  details: CronDetails;
  assumptions?: string;
  /** e.g. "every weekday at 9:30am", or a suggestion the user picked */
  heading?: string;
  updating?: boolean;
}

export function CronResult({ details, assumptions, heading, updating }: Props) {
  const { cron, description, fields, nextRuns, timezone, warnings } = details;
  return (
    <section className="card result" aria-labelledby="result-heading" aria-busy={updating}>
      {heading && (
        <p className="result-input" id="result-heading">
          <span className="muted">You asked for</span> “{heading}”
        </p>
      )}

      <div className="cron-row">
        <code
          className="cron"
          aria-label={`Cron expression: ${cron}`}
          style={{ "--len": Math.max(cron.length, 9) } as CSSProperties}
        >
          {cron}
        </code>
        <CopyButton text={cron} />
      </div>

      <ol className="fields" aria-label="Field breakdown">
        {fields.map((f) => (
          <li key={f.field}>
            <code>{f.value}</code>
            <span>{SHORT_LABEL[f.field] ?? f.field}</span>
          </li>
        ))}
      </ol>

      <p className="description">{description}</p>

      {assumptions && (
        <p className="note note-info">
          <strong>Assumed:</strong> {assumptions}
        </p>
      )}
      {warnings.map((w) => (
        <p className="note note-warn" key={w}>
          <strong>Heads up:</strong> {w}
        </p>
      ))}

      <div className={`runs${updating ? " is-updating" : ""}`}>
        <h2>Next runs</h2>
        <ul>
          {nextRuns.map((iso) => (
            <li key={iso}>
              <time dateTime={iso}>{formatRun(iso, timezone)}</time>
              <span className="muted">{relative(iso)}</span>
            </li>
          ))}
        </ul>
        <p className="fineprint">
          Times assume the scheduler’s clock is set to <strong>{timezone}</strong>. Cron uses the clock of whatever
          runs it; servers, GitHub Actions and Cloudflare Cron Triggers usually run in UTC.
        </p>
      </div>
    </section>
  );
}

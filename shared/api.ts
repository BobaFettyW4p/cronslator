/** API contract shared by the Worker and the React app. */

export const MAX_INPUT_LENGTH = 200;

export type FieldName = "minute" | "hour" | "day of month" | "month" | "day of week";

export interface CronDetails {
  cron: string;
  description: string;
  fields: { field: FieldName; value: string }[];
  /** ISO-8601 UTC timestamps */
  nextRuns: string[];
  timezone: string;
  warnings: string[];
}

export type ErrorCode =
  | "bad_request"
  | "rate_limited"
  | "not_expressible"
  | "model_error"
  | "not_found"
  | "method_not_allowed";

export interface ApiError {
  ok: false;
  error: ErrorCode;
  message: string;
}

/** POST /api/parse { text, timezone } */
export interface ParseRequest {
  text: string;
  timezone?: string;
}
export type ParseResponse = ({ ok: true; input: string; assumptions: string; model: string } & CronDetails) | ApiError;

/** GET /api/describe?cron=...&tz=...  (no model call; validates and explains a cron) */
export type DescribeResponse = ({ ok: true } & CronDetails) | ApiError;

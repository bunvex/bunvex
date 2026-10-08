// JSON text as Convex writes it (serde_json), for a job's or a cron's arguments (STUDY-133 §12
// M8). Only numbers differ from `JSON.stringify`: a float64 is written as serde_json writes it (`formatExportFloat`:
// `2.0`, not `2`). Strings are escaped alike (both escape `"`, `\` and control characters only).
import { formatExportFloat } from "./export-json.ts";
import type { JSONValue } from "./value.ts";

const PLAIN_KEY = /^[A-Za-z0-9_$]*$/;

/** `value` as serde_json writes it: `JSON.stringify` but for the numbers. */
export function jsonText(value: JSONValue): string {
  if (value === null) return "null";
  switch (typeof value) {
    case "string":
      return JSON.stringify(value);
    case "number":
      return formatExportFloat(value);
    case "boolean":
      return value ? "true" : "false";
  }
  if (Array.isArray(value)) {
    let s = "[";
    for (let i = 0; i < value.length; i++) s += (i ? "," : "") + jsonText(value[i]!);
    return `${s}]`;
  }
  let s = "{";
  let first = true;
  for (const k in value) {
    const v = value[k];
    if (v === undefined) continue;
    s += `${first ? "" : ","}${PLAIN_KEY.test(k) ? `"${k}"` : JSON.stringify(k)}:${jsonText(v)}`;
    first = false;
  }
  return `${s}}`;
}

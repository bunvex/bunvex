// Exporting log lines (UI-01 §22.4): the lines the list shows, one JSON object per line (JSON Lines), saved
// by the browser as a file — no library, the way snapshot exports are saved.
import type { LogEntry } from "../data-source.ts";

/** `lines` as JSON Lines, oldest first (the order a log file reads in). */
export function toJsonLines(lines: LogEntry[]): string {
  return lines
    .toReversed()
    .map((e) => `${JSON.stringify(e)}\n`)
    .join("");
}

/** "logs-2026-10-01T12-04-05.jsonl" */
export const exportName = (prefix: string, now: number) =>
  `${prefix}-${new Date(now).toISOString().slice(0, 19).replaceAll(":", "-")}.jsonl`;

/** Hands `text` to the browser as a download named `name`. */
export function saveText(name: string, text: string, type = "application/x-ndjson") {
  const url = URL.createObjectURL(new Blob([text], { type }));
  const a = document.createElement("a");
  a.href = url;
  a.download = name;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

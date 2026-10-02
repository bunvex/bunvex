// One rule for times on every screen (UX2-20): grids and details show the absolute time in the viewer's zone,
// `YYYY-MM-DD HH:mm:ss` (formatTime); log lines add milliseconds and drop the date for today; summaries show
// a relative time ("3 minutes ago") with the absolute one in its tooltip (RelativeTime).
import { formatTime } from "../database/values.ts";
import { timeAgo } from "../screens/stats.ts";

export { formatTime };

const pad = (n: number, w = 2) => String(n).padStart(w, "0");
const sameDay = (a: Date, b: Date) =>
  a.getFullYear() === b.getFullYear() && a.getMonth() === b.getMonth() && a.getDate() === b.getDate();

/** A log line's time: "12:04:05.123" today, "2026-09-29 12:04:05.123" before. */
export function formatLogTime(ms: number, now = Date.now()): string {
  const d = new Date(ms);
  const clock = `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}.${pad(d.getMilliseconds(), 3)}`;
  return sameDay(d, new Date(now)) ? clock : `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${clock}`;
}

/** "3 minutes ago", with the absolute time in its tooltip and `dateTime`. */
export function RelativeTime(props: { ms: number; now?: number; className?: string }) {
  return (
    <time dateTime={new Date(props.ms).toISOString()} title={formatTime(props.ms)} className={props.className}>
      {timeAgo(props.ms, props.now ?? Date.now())}
    </time>
  );
}

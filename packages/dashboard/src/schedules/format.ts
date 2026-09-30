// Times the Schedules, Files and History screens show: absolute in the viewer's zone, and relative to now.

/** "in 5 min", "2 h ago", "in 3 days"; "now" within a few seconds. */
export function formatRelative(ms: number, now: number): string {
  const d = ms - now;
  const abs = Math.abs(d);
  const units: [number, string][] = [
    [86_400_000, "day"],
    [3_600_000, "h"],
    [60_000, "min"],
    [1_000, "s"],
  ];
  if (abs < 5_000) return "now";
  for (const [size, name] of units)
    if (abs >= size) {
      const n = Math.floor(abs / size);
      const unit = name === "day" && n !== 1 ? "days" : name;
      return d > 0 ? `in ${n} ${unit}` : `${n} ${unit} ago`;
    }
  return "now";
}

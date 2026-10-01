// A day as a time bound for a time range (Files, History); the input itself is @bunvex/ui's DayInput (UX-15).
export { DayInput } from "@bunvex/ui/components/day-input";

/** A `YYYY-MM-DD` day in the viewer's zone, as a time bound: its first or its last millisecond. */
export function dayBound(day: string | undefined, end: boolean): number | undefined {
  if (!day) return undefined;
  const [y, m, d] = day.split("-").map(Number) as [number, number, number];
  return end ? new Date(y, m - 1, d + 1).getTime() - 1 : new Date(y, m - 1, d).getTime();
}

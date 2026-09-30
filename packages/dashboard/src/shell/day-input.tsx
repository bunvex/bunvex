// A day picker for a time range (Files, History), and the day as a time bound.
import { Input } from "@bunvex/ui/components/input";
import { useId } from "react";

/** A `YYYY-MM-DD` day in the viewer's zone, as a time bound: its first or its last millisecond. */
export function dayBound(day: string | undefined, end: boolean): number | undefined {
  if (!day) return undefined;
  const [y, m, d] = day.split("-").map(Number) as [number, number, number];
  return end ? new Date(y, m - 1, d + 1).getTime() - 1 : new Date(y, m - 1, d).getTime();
}

export function DayInput(props: {
  label: string;
  value: string | undefined;
  onChange: (v: string | undefined) => void;
}) {
  const id = useId();
  return (
    <div className="flex flex-col gap-1">
      <label htmlFor={id} className="text-sm text-muted-foreground">
        {props.label}
      </label>
      <Input
        id={id}
        type="date"
        className="h-8 w-40"
        value={props.value ?? ""}
        onChange={(e) => props.onChange(e.target.value || undefined)}
      />
    </div>
  );
}

// A day, typed as `YYYY-MM-DD` or picked from a month's calendar (UX-15): the design system's input instead of
// the browser's date field, whose placeholder and icon follow the OS, not the dashboard. The value is the ISO
// day or undefined; a typed day applies once it is complete and valid (Enter or leaving the field).
import { Button } from "@bunvex/ui/components/button";
import { Input } from "@bunvex/ui/components/input";
import { Popover, PopoverContent, PopoverTrigger } from "@bunvex/ui/components/popover";
import { cn } from "@bunvex/ui/lib/utils";
import { CalendarDays, ChevronLeft, ChevronRight } from "lucide-react";
import { useEffect, useId, useState } from "react";

const pad = (n: number) => String(n).padStart(2, "0");
const iso = (y: number, m: number, d: number) => `${y}-${pad(m + 1)}-${pad(d)}`;

/** A real `YYYY-MM-DD` day (not 2026-02-31), or null. */
export function parseDay(text: string): string | null {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(text.trim());
  if (!m) return null;
  const [y, mo, d] = [Number(m[1]), Number(m[2]) - 1, Number(m[3])];
  const date = new Date(y, mo, d);
  return date.getFullYear() === y && date.getMonth() === mo && date.getDate() === d ? iso(y, mo, d) : null;
}

const MONTHS = new Intl.DateTimeFormat(undefined, { month: "long", year: "numeric" });
const WEEKDAYS = ["Mo", "Tu", "We", "Th", "Fr", "Sa", "Su"];

function Calendar(props: { value?: string; onPick: (day: string) => void }) {
  const start = props.value ? new Date(`${props.value}T00:00`) : new Date();
  const [month, setMonth] = useState({ y: start.getFullYear(), m: start.getMonth() });
  const first = new Date(month.y, month.m, 1);
  const lead = (first.getDay() + 6) % 7; // weeks start on Monday
  const days = new Date(month.y, month.m + 1, 0).getDate();
  const shift = (by: number) => {
    const d = new Date(month.y, month.m + by, 1);
    setMonth({ y: d.getFullYear(), m: d.getMonth() });
  };
  const title = MONTHS.format(first);
  return (
    <div className="flex flex-col gap-2">
      <div className="flex items-center justify-between">
        <Button variant="ghost" size="icon-sm" aria-label="Previous month" onClick={() => shift(-1)}>
          <ChevronLeft aria-hidden="true" />
        </Button>
        <span className="text-sm font-medium" aria-live="polite">
          {title}
        </span>
        <Button variant="ghost" size="icon-sm" aria-label="Next month" onClick={() => shift(1)}>
          <ChevronRight aria-hidden="true" />
        </Button>
      </div>
      <div aria-hidden="true" className="grid grid-cols-7 gap-0.5 text-center text-xs text-muted-foreground">
        {WEEKDAYS.map((w) => (
          <span key={w} className="py-1">
            {w}
          </span>
        ))}
      </div>
      {/* the month's days as buttons, each named by its day; the picked one is pressed */}
      <fieldset aria-label={title} className="grid grid-cols-7 gap-0.5 text-center text-xs">
        {Array.from({ length: lead }, (_, i) => (
          // biome-ignore lint/suspicious/noArrayIndexKey: empty leading cells, by position
          <span key={`lead-${i}`} />
        ))}
        {Array.from({ length: days }, (_, i) => {
          const day = iso(month.y, month.m, i + 1);
          const picked = day === props.value;
          return (
            <button
              key={day}
              type="button"
              aria-label={day}
              aria-pressed={picked}
              className={cn(
                "h-7 w-full outline-none hover:bg-muted focus-visible:ring-2 focus-visible:ring-ring",
                picked && "bg-primary text-primary-foreground hover:bg-primary/90",
              )}
              onClick={() => props.onPick(day)}
            >
              {i + 1}
            </button>
          );
        })}
      </fieldset>
    </div>
  );
}

function DayInput(props: { label: string; value: string | undefined; onChange: (day: string | undefined) => void }) {
  const id = useId();
  const errorId = useId();
  const [text, setText] = useState(props.value ?? "");
  const [open, setOpen] = useState(false);
  useEffect(() => setText(props.value ?? ""), [props.value]);
  const invalid = text.trim() !== "" && parseDay(text) === null;
  const commit = () => {
    if (text.trim() === "") return props.onChange(undefined);
    const day = parseDay(text);
    if (day && day !== props.value) props.onChange(day);
  };
  return (
    <div className="flex flex-col gap-1">
      <label htmlFor={id} className="text-sm text-muted-foreground">
        {props.label}
      </label>
      <div className="flex items-center gap-1">
        <Input
          id={id}
          className="h-8 w-32 font-mono text-xs tabular-nums"
          placeholder="YYYY-MM-DD"
          inputMode="numeric"
          autoComplete="off"
          value={text}
          aria-invalid={invalid || undefined}
          aria-describedby={invalid ? errorId : undefined}
          onChange={(e) => setText(e.target.value)}
          onBlur={commit}
          onKeyDown={(e) => {
            if (e.key === "Enter") commit();
          }}
        />
        <Popover open={open} onOpenChange={setOpen}>
          <PopoverTrigger
            render={<Button variant="outline" size="icon-sm" className="size-8" aria-label={`Pick ${props.label}`} />}
          >
            <CalendarDays aria-hidden="true" />
          </PopoverTrigger>
          <PopoverContent align="end" className="w-64">
            <Calendar
              value={props.value}
              onPick={(day) => {
                setOpen(false);
                setText(day);
                props.onChange(day);
              }}
            />
          </PopoverContent>
        </Popover>
      </div>
      {invalid && (
        <span id={errorId} className="text-xs text-destructive">
          A day as YYYY-MM-DD
        </span>
      )}
    </div>
  );
}

export { DayInput };

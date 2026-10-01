// Cron strings as Convex reads them: the `saffron` crate (get-convex fork, rev 1d84237), which Convex
// parses with in crates/model/src/cron_jobs (STUDY-30). bunvex's own code, written to the same grammar and
// semantics, quirks included, so a schedule runs at the same times on both:
// - 5 fields `minute hour day-of-month month day-of-week`, separated by spaces/tabs; UTC; minute resolution.
// - Each field: `*`, or a comma list of `v`, `a-b`, `a-b/n`, `a/n` (`a` through the end), `*/n`; inside a
//   list a leading `*` is the field's lowest value. Names JAN–DEC and SUN–SAT, case-insensitive; Sunday is 0.
// - Day of month also takes `L`, `L-n`, `LW`, `L-nW`, `nW`; day of week `L` (Saturday), `dL` (last d of
//   the month) and `d#k` (the k-th d). Those cannot be listed.
// - When both day fields are restricted (anything but a bare `*`), a day matches either (Vixie cron).
// - Quirks kept: a wrapped range `a-b` (a > b) also includes a−1; a wrapped step over day of month, month
//   or day of week skips the field's lowest value and may set a value past the end that never matches;
//   `any()` (the "will never match" check) is saffron's heuristic.
// - One divergence: saffron's `L-nW` comparison underflows (a crash in Convex) on some Mondays; here it is
//   simply false.
type FieldKind = "minute" | "hour" | "dom" | "month" | "dow";

/** Values a field accepts, saffron's declared MIN/MAX (which the wrapped-step chain uses), and its names. */
const FIELDS: Record<
  FieldKind,
  { lo: number; hi: number; declMin: number; declMax: number; base: number; names?: string[] }
> = {
  minute: { lo: 0, hi: 59, declMin: 0, declMax: 59, base: 0 },
  hour: { lo: 0, hi: 23, declMin: 0, declMax: 23, base: 0 },
  dom: { lo: 1, hi: 31, declMin: 1, declMax: 31, base: 1 },
  month: {
    lo: 1,
    hi: 12,
    declMin: 1,
    declMax: 12,
    base: 1,
    names: ["JAN", "FEB", "MAR", "APR", "MAY", "JUN", "JUL", "AUG", "SEP", "OCT", "NOV", "DEC"],
  },
  dow: { lo: 0, hi: 6, declMin: 1, declMax: 7, base: 0, names: ["SUN", "MON", "TUE", "WED", "THU", "FRI", "SAT"] },
};

class CronParseError extends Error {
  constructor() {
    super("Failed to parse cron expression");
  }
}

/** A field as a set of bit positions (value − base), as saffron's masks. */
type Bits = Set<number>;
type Dom =
  | { kind: "star" }
  | { kind: "pattern"; bits: Bits }
  | { kind: "last"; offset: number } // L, L-n
  | { kind: "lastWeekday"; offset: number } // LW, L-nW
  | { kind: "weekday"; day: number }; // nW
type Dow =
  | { kind: "star" }
  | { kind: "pattern"; bits: Bits }
  | { kind: "nth"; weekday: number; nth: number }
  | { kind: "last"; weekday: number };

const fail = (): never => {
  throw new CronParseError();
};

/** A number (as saffron's u8, so above 255 fails) or a name, in range for the field: its value. */
function value(f: FieldKind, s: string): number {
  const d = FIELDS[f];
  let n: number;
  if (/^[0-9]+$/.test(s)) {
    n = Number(s);
    if (n > 255) fail();
  } else {
    const i = d.names?.indexOf(s.toUpperCase()) ?? -1;
    if (i === -1 || s.length !== 3) fail();
    n = i + d.lo;
  }
  if (n < d.lo || n > d.hi) fail();
  return n;
}

function step(f: FieldKind, s: string): number {
  if (!/^[0-9]+$/.test(s)) fail();
  const n = Number(s);
  const d = FIELDS[f];
  if (n > 255 || n < 1 || n > d.declMax - d.declMin) fail();
  return n;
}

/** One list item into `bits`. `first`: a leading `*` stands for the field's lowest value. */
function item(f: FieldKind, s: string, bits: Bits) {
  const d = FIELDS[f];
  const m = /^([^-/]+)(?:-([^-/]+))?(?:\/([^-/]+))?$/.exec(s);
  if (!m) fail();
  const [, a, b, n] = m as unknown as [string, string, string | undefined, string | undefined];
  const start = (a === "*" ? d.lo : value(f, a)) - d.base;
  if (b === "*") fail();
  const end = b === undefined ? (n === undefined ? start : d.hi - d.base) : value(f, b) - d.base;
  let by = n === undefined ? 1 : step(f, n);
  if (b !== undefined && start === end) by = 1; // `a-a`, `a-a/n` are `a`
  if (by === 1) {
    if (start <= end) for (let i = start; i <= end; i++) bits.add(i);
    else {
      // A wrapped range: from start − 1 (saffron's off-by-one) to the top, and from the bottom to end.
      for (let i = start - 1; i <= d.hi - d.base; i++) bits.add(i);
      for (let i = 0; i <= end; i++) bits.add(i);
    }
    return;
  }
  if (start <= end) {
    for (let i = start; i <= end; i += by) bits.add(i);
    return;
  }
  // A wrapped step chains start..=declared MAX, then declared MIN..=end, and steps through that.
  const seq: number[] = [];
  for (let i = start; i <= d.declMax; i++) seq.push(i);
  for (let i = d.declMin; i <= end; i++) seq.push(i);
  for (let i = 0; i < seq.length; i += by) bits.add(seq[i]);
}

function list(f: FieldKind, s: string): Bits {
  const bits: Bits = new Set();
  for (const part of s.split(",")) {
    if (part === "") fail();
    item(f, part, bits);
  }
  return bits;
}

// A field that is `*` (all), or a list; a leading `*` not followed by a slash must stand alone.
function field(f: FieldKind, s: string): Bits | "star" {
  if (s === "*") return "star";
  if (s.startsWith("*") && s[1] !== "/") fail();
  return list(f, s);
}

function parseDom(s: string): Dom {
  if (s === "L") return { kind: "last", offset: 0 };
  if (s === "LW") return { kind: "lastWeekday", offset: 0 };
  let m = /^L-([0-9]+)(W?)$/.exec(s);
  if (m) {
    const n = Number(m[1]);
    if (n > 255 || n < 1 || n > 30) fail();
    return m[2] ? { kind: "lastWeekday", offset: n } : { kind: "last", offset: n };
  }
  m = /^([0-9]+)W$/.exec(s);
  if (m) return { kind: "weekday", day: value("dom", m[1]) };
  const r = field("dom", s);
  return r === "star" ? { kind: "star" } : { kind: "pattern", bits: r };
}

function parseDow(s: string): Dow {
  if (s === "L") return { kind: "pattern", bits: new Set([6]) };
  let m = /^([^#L]+)L$/.exec(s);
  if (m) return { kind: "last", weekday: value("dow", m[1]) };
  m = /^([^#]+)#([0-9]+)$/.exec(s);
  if (m) {
    const k = Number(m[2]);
    if (k < 1 || k > 5) fail();
    return { kind: "nth", weekday: value("dow", m[1]), nth: k };
  }
  const r = field("dow", s);
  return r === "star" ? { kind: "star" } : { kind: "pattern", bits: r };
}

const daysInMonth = (y: number, m0: number) => new Date(Date.UTC(y, m0 + 1, 0)).getUTCDate();

export class CronExpression {
  constructor(
    private readonly minutes: Bits | "star",
    private readonly hours: Bits | "star",
    private readonly dom: Dom,
    private readonly months: Bits | "star",
    private readonly dow: Dow,
  ) {}

  /** saffron's `any()`: false for a few day/month combinations that can never happen (e.g. Feb 30). */
  any(): boolean {
    if (this.dow.kind !== "star") return true;
    if (this.dom.kind === "star") return true;
    let firstSet: number;
    if (this.dom.kind === "last" || this.dom.kind === "lastWeekday") {
      if (this.dom.offset === 0) return true;
      firstSet = this.dom.offset + 1;
    } else if (this.dom.kind === "weekday") {
      // saffron reads the stored day as if it were a mask (its lowest set bit), a quirk kept as is.
      firstSet = Math.log2(this.dom.day & -this.dom.day) + 1;
    } else {
      firstSet = Math.min(...this.dom.bits) + 1;
    }
    const m = (i: number) => this.months === "star" || this.months.has(i);
    const has = (ms: number[]) => ms.some(m);
    const max = has([0, 2, 4, 6, 7, 9, 11]) ? 31 : has([3, 5, 8, 10]) ? 30 : 29;
    return firstSet <= max;
  }

  private domMatches(y: number, m0: number, day: number, weekday: number): boolean {
    const dim = daysInMonth(y, m0);
    const isWeekday = weekday !== 0 && weekday !== 6;
    const d = this.dom;
    switch (d.kind) {
      case "star":
        return true;
      case "pattern":
        return d.bits.has(day - 1);
      case "last":
        return day + d.offset === dim;
      case "lastWeekday": {
        if (d.offset === 0) return (isWeekday && day === dim) || (weekday === 5 && dim - day < 3);
        const shifted = day + d.offset;
        return (
          (isWeekday && shifted === dim) ||
          // saffron computes `shifted - dim` unsigned: below zero it crashes; here that case is false.
          (weekday === 1 && shifted >= dim && shifted - dim < 3) ||
          (weekday === 5 && shifted + 1 === dim)
        );
      }
      case "weekday":
        return (
          (isWeekday && day === d.day) ||
          (weekday === 1 && day - 1 === d.day) ||
          (weekday === 1 && day === 3 && d.day === 1) ||
          (weekday === 5 && day + 1 === d.day) ||
          (weekday === 5 && day + 2 === d.day && d.day === dim)
        );
    }
  }

  private dowMatches(y: number, m0: number, day: number, weekday: number): boolean {
    const d = this.dow;
    switch (d.kind) {
      case "star":
        return true;
      case "pattern":
        return d.bits.has(weekday);
      case "nth":
        return weekday === d.weekday && Math.floor((day - 1) / 7) + 1 === d.nth;
      case "last":
        return weekday === d.weekday && day + 7 > daysInMonth(y, m0);
    }
  }

  private dateMatches(t: Date): boolean {
    const y = t.getUTCFullYear();
    const m0 = t.getUTCMonth();
    if (this.months !== "star" && !this.months.has(m0)) return false;
    const day = t.getUTCDate();
    const wd = t.getUTCDay();
    const domStar = this.dom.kind === "star";
    const dowStar = this.dow.kind === "star";
    if (domStar && dowStar) return true;
    if (domStar) return this.dowMatches(y, m0, day, wd);
    if (dowStar) return this.domMatches(y, m0, day, wd);
    return this.dowMatches(y, m0, day, wd) || this.domMatches(y, m0, day, wd);
  }

  /** The first matching minute on that day at or after `fromMinute` (minutes since midnight), if any. */
  private timeOn(fromMinute: number): number | null {
    for (let h = Math.floor(fromMinute / 60); h < 24; h++) {
      if (this.hours !== "star" && !this.hours.has(h)) continue;
      const m0 = h === Math.floor(fromMinute / 60) ? fromMinute % 60 : 0;
      for (let m = m0; m < 60; m++) if (this.minutes === "star" || this.minutes.has(m)) return h * 60 + m;
    }
    return null;
  }

  /**
   * saffron's candidate day of month at or after `day` in this month (one per month, never re-checked
   * against `contains_date`; a candidate outside the month, or already past, means none this month).
   */
  private nextDomDay(y: number, m0: number, day: number): number | null {
    const dim = daysInMonth(y, m0);
    const inMonth = (d: number) => (d >= 1 && d <= dim ? d : null);
    const weekdayOf = (d: number) => new Date(Date.UTC(y, m0, d)).getUTCDay();
    const d = this.dom;
    let c: number | null;
    switch (d.kind) {
      case "star":
        c = day;
        break;
      case "last":
        c = inMonth(dim - d.offset);
        break;
      case "lastWeekday": {
        if (d.offset === 0) {
          const wd = weekdayOf(dim);
          c = wd === 6 ? dim - 1 : wd === 0 ? dim - 2 : dim;
          break;
        }
        const expected = dim - d.offset;
        if (inMonth(expected) === null) {
          c = null;
          break;
        }
        const wd = weekdayOf(expected);
        c = inMonth(wd === 6 && expected === 1 ? 3 : wd === 6 ? expected - 1 : wd === 0 ? expected + 1 : expected);
        break;
      }
      case "weekday": {
        const expected = d.day;
        if (inMonth(expected) === null) {
          c = null;
          break;
        }
        const wd = weekdayOf(expected);
        c = inMonth(
          wd === 6 && expected === 1
            ? 3
            : wd === 6
              ? expected - 1
              : wd === 0 && expected === dim
                ? dim - 2
                : wd === 0
                  ? expected + 1
                  : expected,
        );
        break;
      }
      case "pattern": {
        c = null;
        for (let i = day - 1; i < dim; i++)
          if (d.bits.has(i)) {
            c = i + 1;
            break;
          }
        break;
      }
    }
    return c !== null && c >= day ? c : null;
  }

  /** saffron's candidate day of week at or after `day` in this month. */
  private nextDowDay(y: number, m0: number, day: number): number | null {
    const dim = daysInMonth(y, m0);
    const current = new Date(Date.UTC(y, m0, day)).getUTCDay();
    const day0 = day - 1;
    const offsetTo = (w: number) => (w < current ? 7 - (current - w) : w - current);
    const d = this.dow;
    let c0: number | null;
    switch (d.kind) {
      case "star":
        c0 = day0;
        break;
      case "last": {
        const first = (day0 + offsetTo(d.weekday)) % 7;
        const five = (dim === 29 && first === 0) || (dim === 30 && first <= 1) || (dim === 31 && first <= 2);
        c0 = first + 7 * (five ? 4 : 3);
        break;
      }
      case "nth":
        c0 = ((day0 + offsetTo(d.weekday)) % 7) + 7 * (d.nth - 1);
        break;
      case "pattern": {
        let next: number | null = null;
        for (let w = current; w <= 6; w++)
          if (d.bits.has(w)) {
            next = w;
            break;
          }
        if (next !== null) c0 = day0 + (next - current);
        else {
          // The lowest weekday of the pattern (saffron masks off the value past Saturday; none gives 32).
          const lowest = Math.min(...[...d.bits].filter((b) => b <= 6), 32);
          c0 = day0 + (6 - current) + 1 + lowest;
        }
        break;
      }
    }
    if (c0 === null || c0 < 0 || c0 >= dim) return null;
    return c0 + 1 >= day ? c0 + 1 : null;
  }

  /** saffron's `find_next_day`: the next candidate day in this month, if any. */
  private nextDay(y: number, m0: number, day: number): number | null {
    const domStar = this.dom.kind === "star";
    const dowStar = this.dow.kind === "star";
    if (domStar && dowStar) return day;
    if (domStar) return this.nextDowDay(y, m0, day);
    if (dowStar) return this.nextDomDay(y, m0, day);
    const a = this.nextDomDay(y, m0, day);
    const b = this.nextDowDay(y, m0, day);
    return a === null ? b : b === null ? a : Math.min(a, b);
  }

  private monthOk(m0: number) {
    return this.months === "star" || this.months.has(m0);
  }

  /** saffron's `find_next_date`, year by year: the next candidate date on or after (y, m0, day). */
  private nextDate(y: number, m0: number, day: number): [number, number, number] | null {
    // The calendar repeats every 400 years: a cycle without a candidate means there is none.
    for (let year = y; year <= y + 401; year++) {
      let m = year === y ? m0 : 0;
      let d = year === y ? day : 1;
      if (this.monthOk(m)) {
        const c = this.nextDay(year, m, d);
        if (c !== null) return [year, m, c];
      }
      for (m = m + 1; m < 12; m++) {
        if (!this.monthOk(m)) continue;
        d = 1;
        const c = this.nextDay(year, m, d);
        if (c !== null) return [year, m, c];
      }
    }
    return null;
  }

  /**
   * saffron's `next_after`: the first match strictly after the minute containing `ms`, or null if none.
   * The start day is checked with the matching rules; later days come from saffron's candidate search.
   */
  nextAfter(ms: number): number | null {
    if (!this.any()) return null;
    const start = Math.floor(ms / 60_000) * 60_000 + 60_000;
    const day0 = Math.floor(start / 86_400_000) * 86_400_000;
    if (this.dateMatches(new Date(day0))) {
      const t = this.timeOn((start - day0) / 60_000);
      if (t !== null) return day0 + t * 60_000;
    }
    const next = new Date(day0 + 86_400_000);
    const found = this.nextDate(next.getUTCFullYear(), next.getUTCMonth(), next.getUTCDate());
    if (!found) return null;
    const t = this.timeOn(0);
    return t === null ? null : Date.UTC(found[0], found[1], found[2]) + t * 60_000;
  }
}

export function parseCronExpression(s: string): CronExpression {
  const parts = s.split(/[ \t]+/);
  if (parts.length !== 5 || parts.some((p) => p === "")) fail();
  const [mi, h, dom, mo, dow] = parts as [string, string, string, string, string];
  return new CronExpression(field("minute", mi), field("hour", h), parseDom(dom), field("month", mo), parseDow(dow));
}

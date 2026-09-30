// Every foreground/background pair of both themes reaches WCAG AA (UI-01 §4.2), read from the real
// stylesheet: 4.5:1 for text, 3:1 for the focus ring and control boundaries (--input).
import { describe, expect, test } from "bun:test";
import { contrast, over, parseOklch, type Rgba, withAlpha } from "@bunvex/ui/lib/contrast";

const css = await Bun.file(new URL("../src/styles/globals.css", import.meta.url)).text();

function tokens(selector: string): Map<string, string> {
  const start = css.indexOf(`${selector} {`);
  if (start < 0) throw new Error(`no ${selector} block`);
  const body = css.slice(start, css.indexOf("}", start));
  return new Map([...body.matchAll(/--([\w-]+):\s*([^;]+);/g)].map((m) => [m[1]!, m[2]!.trim()]));
}
const light = tokens(":root");
const dark = new Map([...light, ...tokens(".dark")]);

const TEXT = 4.5;
const UI = 3;
// [foreground, background, minimum, only in this theme?]; a background "x/NN" is token x at NN % over
// --background, "x/NN@y" over --y.
const PAIRS: [string, string, number, ("light" | "dark")?][] = [
  ["foreground", "background", TEXT],
  ["card-foreground", "card", TEXT],
  ["popover-foreground", "popover", TEXT],
  ["primary-foreground", "primary", TEXT],
  ["secondary-foreground", "secondary", TEXT],
  ["muted-foreground", "background", TEXT],
  ["muted-foreground", "muted", TEXT],
  ["muted-foreground", "card", TEXT],
  ["accent-foreground", "accent", TEXT],
  ["destructive-foreground", "destructive", TEXT],
  ["success-foreground", "success", TEXT],
  ["warning-foreground", "warning", TEXT],
  ["info-foreground", "info", TEXT],
  // status colours used as text, plain and on their own tinted badge (shadcn's bg-x/10 variants)
  ["destructive", "background", TEXT],
  ["success", "background", TEXT],
  ["warning", "background", TEXT],
  ["info", "background", TEXT],
  ["destructive", "destructive/10", TEXT],
  ["destructive", "destructive/20", TEXT],
  ["success", "success/10", TEXT],
  ["warning", "warning/10", TEXT],
  ["info", "info/10", TEXT],
  ["sidebar-foreground", "sidebar", TEXT],
  ["sidebar-primary-foreground", "sidebar-primary", TEXT],
  ["sidebar-accent-foreground", "sidebar-accent", TEXT],
  ["muted-foreground", "sidebar", TEXT],
  // a cell's text while it flashes after a live change
  ["foreground", "highlight", TEXT],
  ["muted-foreground", "highlight", TEXT],
  // a placeholder in a hovered select on a card (the filter bar): dark:hover:bg-input/50
  ["muted-foreground", "input/50@card", TEXT, "dark"],
  ["ring", "background", UI],
  ["ring", "card", UI],
  ["sidebar-ring", "sidebar", UI],
  ["input", "background", UI],
  ["input", "card", UI],
];

function colour(theme: Map<string, string>, spec: string): Rgba {
  const [token, under = "background"] = spec.split("@") as [string, string | undefined];
  const [name, pct] = token.split("/") as [string, string | undefined];
  const value = theme.get(name);
  if (!value) throw new Error(`no token --${name}`);
  const background = parseOklch(theme.get(under)!);
  const c = parseOklch(value);
  return over(pct === undefined ? c : withAlpha(c, Number(pct) / 100), background);
}

for (const [theme, values] of [
  ["light", light],
  ["dark", dark],
] as const)
  describe(`${theme} theme`, () => {
    for (const [fg, bg, min] of PAIRS.filter((p) => p[3] === undefined || p[3] === theme))
      test(`--${fg} on --${bg} ≥ ${min}:1`, () => {
        const ratio = contrast(colour(values, fg), colour(values, bg));
        expect(Math.round(ratio * 100) / 100).toBeGreaterThanOrEqual(min);
      });
  });

describe("reduced motion", () => {
  test("the stylesheet stops every animation and transition when the reader asks for less motion", () => {
    const at = css.indexOf("@media (prefers-reduced-motion: reduce)");
    expect(at).toBeGreaterThan(0);
    const block = css.slice(at, css.indexOf("}", css.indexOf("{", css.indexOf("{", at) + 1)));
    for (const rule of ["animation-duration: 0.01ms !important", "transition-duration: 0.01ms !important"])
      expect(block).toContain(rule);
  });
});

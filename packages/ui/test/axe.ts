// axe-core on a rendered tree. Colour contrast is off: happy-dom has no layout or computed colours, and
// the token test checks every pair instead (UI-01 §7). Selectors are off too: axe builds them from
// attribute values (a `title` holding JSON) that happy-dom's selector engine rejects; nodes are reported
// by their HTML instead.
import { expect } from "bun:test";
import axe from "axe-core";

export async function expectAccessible(root: Element = document.body) {
  const { violations } = await axe.run(root, {
    rules: { "color-contrast": { enabled: false } },
    selectors: false,
    elementRef: false,
  });
  expect(violations.map((v) => `${v.id}: ${v.help} (${v.nodes.map((n) => n.html.slice(0, 120)).join(" | ")})`)).toEqual(
    [],
  );
}

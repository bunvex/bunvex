// axe-core on a rendered tree. Colour contrast is off: happy-dom has no layout or computed colours, and
// test/tokens.test.ts checks every token pair instead (UI-01 §7).
import { expect } from "bun:test";
import axe from "axe-core";

export async function expectAccessible(root: Element = document.body) {
  const { violations } = await axe.run(root, { rules: { "color-contrast": { enabled: false } } });
  expect(violations.map((v) => `${v.id}: ${v.help} (${v.nodes.map((n) => n.target.join(" ")).join(", ")})`)).toEqual(
    [],
  );
}

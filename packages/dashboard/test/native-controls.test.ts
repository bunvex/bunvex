import { describe, expect, test } from "bun:test";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";

// UX2-3: the browser's own <select>, file chooser, radios and checkboxes ignore the theme (grey OS chrome in
// dark mode). Screens use @bunvex/ui's ChoiceSelect, ChoiceRadios, Checkbox and FilePicker instead.
const SRC = join(import.meta.dir, "../src");
// files that keep a native control on purpose, and why
const ALLOWED: Record<string, string> = {
  "files/screen.tsx": "a hidden file input behind the column's Upload button",
  "shell/section-column.tsx": "facet radios styled with accent-primary, one per row with its count",
  "schema/diagram.tsx": "the canvas toolbar's 'Group related tables' toggle",
  // TODO(UX2-3, Authentication PR): move to ChoiceSelect, then drop these two lines
  "auth/config.tsx": "Multi-factor 'Required for' — Authentication follow-up",
  "auth/user-panel.tsx": "'Ban for' — Authentication follow-up",
};

function* sources(dir: string): Generator<string> {
  for (const name of readdirSync(dir)) {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) yield* sources(path);
    else if (/\.tsx$/.test(name)) yield path;
  }
}

describe("native form controls", () => {
  test("no screen uses the browser's select, file, radio or checkbox chrome", () => {
    const found: string[] = [];
    for (const path of sources(SRC)) {
      const file = relative(SRC, path);
      if (file in ALLOWED) continue;
      const text = readFileSync(path, "utf8");
      if (/<select\b|type="(file|radio|checkbox)"/.test(text)) found.push(file);
    }
    expect(found).toEqual([]);
  });
});

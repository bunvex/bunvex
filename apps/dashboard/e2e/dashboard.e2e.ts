// Smoke tests in a real browser (UI-01 §12.5.10): what happy-dom cannot show — Monaco (its worker, its
// keys), layout (the object editor's popover), colour contrast, reduced motion. Against the built app
// (`vite preview`), in Chromium: the system Chrome locally, Playwright's Chromium in CI
// (`E2E_BROWSER=chromium`). Run with `bun run e2e`.
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { type Browser, chromium, type Page } from "playwright-core";

const PORT = 4179;
const ORIGIN = `http://localhost:${PORT}`;
// no live writes and no delay from the mock: a stable page (the host takes these out of the address)
const KNOBS = "writes=0&latency=0";
const url = (path: string) => `${ORIGIN}${path}${path.includes("?") ? "&" : "?"}${KNOBS}`;
const AXE = readFileSync(createRequire(import.meta.url).resolve("axe-core/axe.min.js"), "utf8");

let server: ReturnType<typeof Bun.spawn>;
let browser: Browser;

beforeAll(async () => {
  server = Bun.spawn(["bun", "--bun", "vite", "preview", "--port", String(PORT), "--strictPort"], {
    cwd: `${import.meta.dir}/..`,
    stdout: "ignore",
    stderr: "inherit",
  });
  for (let i = 0; ; i++) {
    if (
      await fetch(ORIGIN).then(
        (r) => r.ok,
        () => false,
      )
    )
      break;
    if (i > 100) throw new Error("vite preview did not start");
    await Bun.sleep(100);
  }
  browser = await chromium.launch(process.env.E2E_BROWSER === "chromium" ? {} : { channel: "chrome" });
});

afterAll(async () => {
  await browser?.close();
  server?.kill("SIGINT");
});

/** A page that records every request leaving the app's origin, and every uncaught error. */
async function open(
  path: string,
  opts: { colorScheme?: "light" | "dark"; reducedMotion?: "reduce"; viewport?: { width: number; height: number } } = {},
) {
  const context = await browser.newContext({ viewport: { width: 1400, height: 900 }, ...opts });
  const page = await context.newPage();
  const external: string[] = [];
  const errors: string[] = [];
  page.on("request", (r) => {
    if (!r.url().startsWith(ORIGIN) && !r.url().startsWith("data:") && !r.url().startsWith("blob:"))
      external.push(r.url());
  });
  page.on("pageerror", (e) => errors.push(String(e)));
  await page.goto(url(path));
  return { page, external, errors, close: () => context.close() };
}

const heading = (page: Page, name: string) => page.getByRole("heading", { level: 1, name }).waitFor();
const cellOf = (page: Page, text: RegExp) => page.getByRole("gridcell").filter({ hasText: text }).first();
const inMonaco = (page: Page) => page.evaluate(() => !!document.activeElement?.closest(".monaco-editor"));
/**
 * Empties the focused editor. (Typing a quote over a selection would wrap it in quotes — Monaco's
 * autoSurround, the default Convex's editor keeps too.)
 */
const clear = async (page: Page) => {
  await page.keyboard.press("ControlOrMeta+A");
  await page.keyboard.press("Backspace");
};

describe("the dashboard in a browser", () => {
  test("the design system's page: every specimen in both themes, no axe violation (contrast included)", async () => {
    const { page, errors, close } = await open("/design-system.html");
    await page.getByRole("heading", { level: 1, name: "bunvex design system" }).waitFor();
    for (const title of ["Colors", "Buttons", "Form controls", "Data"])
      for (const theme of ["light", "dark"])
        await page.getByRole("region", { name: `${title}, ${theme}`, exact: true }).waitFor();
    await page.addScriptTag({ content: AXE });
    const violations = await page.evaluate(async () => {
      // biome-ignore lint/suspicious/noExplicitAny: axe is injected as a global
      const axe = (window as any).axe;
      const r = await axe.run(document, { resultTypes: ["violations"] });
      return r.violations.map((v: { id: string; nodes: unknown[] }) => `${v.id} (${v.nodes.length})`);
    });
    expect(violations).toEqual([]);
    expect(errors).toEqual([]);
    await close();
  });

  test("a phone's width: no screen scrolls sideways; the screens are behind Menu", async () => {
    const phone = { viewport: { width: 390, height: 800 } };
    const { page, errors, close } = await open("/", phone);
    await heading(page, "Health");
    for (const path of ["/database/users", "/functions?function=tasks:list", "/logs", "/settings/general", "/files"]) {
      await page.goto(`${ORIGIN}${path}`);
      await page.locator("main h1").first().waitFor();
      const overflow = await page.evaluate(() => document.scrollingElement!.scrollWidth - innerWidth);
      expect([path, overflow]).toEqual([path, 0]);
    }
    const menu = page.getByRole("button", { name: "Menu" });
    expect(await page.getByRole("link", { name: "History" }).isVisible()).toBe(false);
    await menu.click();
    await page.getByRole("link", { name: "History" }).click();
    await heading(page, "History");
    expect(await menu.getAttribute("aria-expanded")).toBe("false");
    expect(errors).toEqual([]);
    await close();
  });

  test("the first load is the shell: each screen is its own chunk (UI-01 §14.1)", async () => {
    const assets = readdirSync(`${import.meta.dir}/../dist/assets`);
    const entry = assets.filter((f) => /^index-.*\.js$/.test(f));
    expect(entry.length).toBe(1);
    // no screen's own text in the entry: a screen imported eagerly again fails this
    const code = readFileSync(`${import.meta.dir}/../dist/assets/${entry[0]}`, "utf8");
    expect(
      ["Documents in ", "Log lines", "Search functions", "Run a function"].filter((t) => code.includes(t)),
    ).toEqual([]);
    // what Health's first load fetches, as the browser counts it: 722 kB before route splitting, ~494 kB after
    const { page, close } = await open("/");
    await heading(page, "Health");
    const kb = await page.evaluate(
      () =>
        performance
          .getEntriesByType("resource")
          .filter((e) => e.name.endsWith(".js"))
          .reduce((n, e) => n + (e as PerformanceResourceTiming).decodedBodySize, 0) / 1024,
    );
    expect(kb).toBeLessThan(600);
    await close();
  });

  test("plain paths: a deep link opens, the knobs leave the address, reload and back keep the route", async () => {
    const { page, errors, close } = await open("/database/users?panel=schema");
    await heading(page, "users");
    expect(new URL(page.url()).pathname + new URL(page.url()).search).toBe("/database/users?panel=schema");
    expect(new URL(page.url()).hash).toBe("");
    await page.getByRole("complementary").waitFor();
    await page.reload();
    await heading(page, "users");
    await page.getByRole("link", { name: "Logs" }).first().click();
    await page.waitForURL(`${ORIGIN}/logs`);
    await page.goBack();
    await heading(page, "users");
    expect(page.url()).toBe(`${ORIGIN}/database/users?panel=schema`);
    expect(errors).toEqual([]);
    await close();
  });

  test("Monaco loads from the app itself, with nothing fetched elsewhere; its worker is bundled", async () => {
    const { page, external, errors, close } = await open("/database/tasks");
    await heading(page, "tasks");
    await page.getByRole("button", { name: "Add filter" }).click();
    await page.locator(".monaco-editor").first().waitFor();
    await page.locator(".monaco-editor").first().click();
    await page.keyboard.type("[1, 2]");
    // the worker only starts for language services (bunvex-literal has none), so check it ships with the app
    expect(readdirSync(`${import.meta.dir}/../dist/assets`).some((f) => /^editor\.worker-.*\.js$/.test(f))).toBe(true);
    expect(external).toEqual([]);
    expect(errors).toEqual([]);
    await close();
  });

  test("a cell: Enter edits in Monaco, Enter saves, Tab saves and moves right, Escape leaves it", async () => {
    const { page, errors, close } = await open("/database/users");
    await heading(page, "users");
    await cellOf(page, /@example/).click();
    await page.keyboard.press("Enter");
    await page.waitForFunction(() => !!document.activeElement?.closest(".monaco-editor"));
    await clear(page);
    await page.keyboard.type('"e2e@example.com"');
    await page.keyboard.press("Enter");
    await cellOf(page, /^e2e@example\.com$/).waitFor();
    expect(await inMonaco(page)).toBe(false);
    // Tab: saves and the next cell (admin) is current
    await page.keyboard.press("Enter");
    await page.waitForFunction(() => !!document.activeElement?.closest(".monaco-editor"));
    await clear(page);
    await page.keyboard.type('"tab@example.com"');
    await page.keyboard.press("Tab");
    await cellOf(page, /^tab@example\.com$/).waitFor();
    await page.waitForFunction(() => document.activeElement?.getAttribute("aria-colindex") !== null);
    // Escape: nothing changes
    await page.keyboard.press("ArrowLeft");
    await page.keyboard.press("Enter");
    await page.waitForFunction(() => !!document.activeElement?.closest(".monaco-editor"));
    await page.keyboard.type("ignored");
    await page.keyboard.press("Escape");
    await cellOf(page, /^tab@example\.com$/).waitFor();
    expect(await inMonaco(page)).toBe(false);
    expect(errors).toEqual([]);
    await close();
  });

  test("an object or list opens a multi-line editor that stays inside the grid", async () => {
    const { page, close } = await open("/database/tasks");
    await heading(page, "tasks");
    const cell = cellOf(page, /^\[/);
    await cell.scrollIntoViewIfNeeded();
    await cell.click();
    await page.keyboard.press("Enter");
    const editor = page.locator(".monaco-editor").first();
    await editor.waitFor();
    const grid = (await page.locator('[data-slot="data-table"]').boundingBox())!;
    const box = (await editor.boundingBox())!;
    expect(box.height).toBeGreaterThan(100);
    expect(box.x + box.width).toBeLessThanOrEqual(grid.x + grid.width + 1);
    await page.keyboard.press("Escape");
    await close();
  });

  test("a document: Edit, type fast, Ctrl+Enter saves exactly what was typed", async () => {
    const { page, errors, close } = await open("/database/users");
    await heading(page, "users");
    const tags = Array.from({ length: 12 }, (_, i) => `'tag-${i}'`).join(", ");
    for (let round = 0; round < 3; round++) {
      await page.locator('[role="grid"] a').nth(round).click();
      await page.getByRole("button", { name: "Edit" }).click();
      await page.waitForFunction(() => !!document.activeElement?.closest(".monaco-editor"));
      await clear(page);
      // as fast as keys can go: a controlled editor used to drop keystrokes here and save the rest
      await page.keyboard.type(`{ name: 'E2E ${round}', credits: ${round}n, tags: [${tags}] }`);
      await page.keyboard.press("Control+Enter");
      await page.getByText("Saved.").waitFor();
      const shown = (await page.getByRole("complementary").textContent()) ?? "";
      expect(shown).toContain(`"E2E ${round}"`);
      expect(shown).toContain('"tag-11"');
    }
    expect(errors).toEqual([]);
    await close();
  });

  test("the theme toggle switches the page and Monaco together", async () => {
    const { page, close } = await open("/database/tasks", { colorScheme: "light" });
    await heading(page, "tasks");
    await page.getByRole("button", { name: "Add filter" }).click();
    const editor = page.locator(".monaco-editor .monaco-editor-background").first();
    await editor.waitFor();
    const before = await editor.evaluate((e) => getComputedStyle(e).backgroundColor);
    // system → light → dark
    for (let i = 0; i < 3 && !(await page.evaluate(() => document.documentElement.classList.contains("dark"))); i++)
      await page.getByRole("button", { name: /theme/ }).click();
    expect(await page.evaluate(() => document.documentElement.classList.contains("dark"))).toBe(true);
    await page.waitForFunction(
      (b) =>
        getComputedStyle(document.querySelector(".monaco-editor .monaco-editor-background")!).backgroundColor !== b,
      before,
    );
    await close();
  });

  test("reduced motion: animations and transitions are cut to nothing", async () => {
    const { page, close } = await open("/database/users", { reducedMotion: "reduce" });
    await heading(page, "users");
    const durations = await page
      .getByRole("button", { name: "Schema" })
      .evaluate((e) => [getComputedStyle(e).transitionDuration, getComputedStyle(e).animationDuration]);
    expect(durations.every((d) => d.split(",").every((x) => Number.parseFloat(x) <= 0.00001))).toBe(true);
    await close();
  });

  test("Schema: the tables drawn with their references; a table opens with Enter; xyflow stays in its chunk", async () => {
    for (const colorScheme of ["light", "dark"] as const) {
      const { page, errors, external, close } = await open("/schema", { colorScheme });
      await heading(page, "Schema");
      await page.locator(".react-flow__node-table").nth(3).waitFor();
      expect(await page.locator(".react-flow__edge").count()).toBe(2);
      await page.addScriptTag({ content: AXE });
      const violations = await page.evaluate(async () => {
        // biome-ignore lint/suspicious/noExplicitAny: axe is injected as a global
        const axe = (window as any).axe;
        const r = await axe.run(document, { resultTypes: ["violations"] });
        return r.violations.map(
          (v: { id: string; nodes: { html: string }[] }) =>
            `${v.id}: ${v.nodes.map((n) => n.html.slice(0, 90)).join(" | ")}`,
        );
      });
      expect([colorScheme, violations]).toEqual([colorScheme, []]);
      await page.locator('.react-flow__node-table[data-id="tasks"]').focus();
      await page.keyboard.press("Enter");
      await page.getByRole("complementary", { name: "tasks" }).waitFor();
      await page.keyboard.press("Escape");
      await page.waitForURL(`${ORIGIN}/schema`);
      expect([errors, external]).toEqual([[], []]);
      await close();
    }
    // the diagram's libraries load with the Schema screen only, never with the shell
    const entry = readdirSync(`${import.meta.dir}/../dist/assets`).find((f) => /^index-.*\.js$/.test(f))!;
    const code = readFileSync(`${import.meta.dir}/../dist/assets/${entry}`, "utf8");
    expect(["react-flow__", "elk.algorithm"].filter((t) => code.includes(t))).toEqual([]);
  });

  test("Schedules: the scheduled runs and a cron job's recent runs", async () => {
    const { page, errors, close } = await open("/schedules");
    await heading(page, "Schedules");
    await page.waitForURL(`${ORIGIN}/schedules/functions`);
    await page.getByRole("grid", { name: "Scheduled functions" }).getByRole("row").nth(3).waitFor();
    await page.getByRole("link", { name: "Cron jobs" }).click();
    await page.getByRole("gridcell", { name: "summarize tasks" }).click();
    const panel = page.getByRole("complementary", { name: "summarize tasks" });
    await panel.getByRole("listitem").first().waitFor();
    expect(await panel.getByRole("listitem").count()).toBe(5);
    expect(errors).toEqual([]);
    await close();
  });

  test("Files: upload one, see it first, preview an image", async () => {
    const { page, errors, close } = await open("/files");
    await heading(page, "Files");
    await page
      .getByLabel("Files to upload")
      .setInputFiles({ name: "note.txt", mimeType: "text/plain", buffer: Buffer.from("hi\n") });
    await page.getByText("Uploaded 1 file.").waitFor();
    const grid = page.getByRole("grid", { name: "Files" });
    expect(await grid.getByRole("row").nth(1).textContent()).toContain("text/plain");
    await grid.getByRole("gridcell", { name: "image/svg+xml" }).first().click();
    const img = page.getByRole("complementary", { name: "File" }).getByRole("img");
    await img.waitFor();
    // the preview really loaded (a broken image has no natural width)
    await page.waitForFunction(
      () => (document.querySelector("aside img") as HTMLImageElement | null)?.naturalWidth === 96,
    );
    expect(errors).toEqual([]);
    await close();
  });

  test("Settings: show a hidden value, add a variable and save", async () => {
    const { page, errors, close } = await open("/settings/environment-variables");
    await heading(page, "Settings");
    await page.getByRole("button", { name: "Show the value of LOG_LEVEL" }).click();
    await page.getByText("info", { exact: true }).waitFor();
    await page.getByRole("button", { name: "Add a variable" }).click();
    await page.getByRole("textbox", { name: "Name" }).fill("E2E_FLAG");
    await page.getByRole("textbox", { name: "Value" }).fill("yes");
    await page.getByRole("button", { name: "Save" }).click();
    await page.getByText("Saved 1 change.").waitFor();
    await page.getByRole("listitem").filter({ hasText: "E2E_FLAG" }).waitFor();
    expect(errors).toEqual([]);
    await close();
  });

  test("History: a change made in Settings is recorded", async () => {
    const { page, errors, close } = await open("/settings/environment-variables");
    await page.getByRole("button", { name: "Delete LOG_LEVEL" }).click();
    await page.getByRole("button", { name: "Save" }).click();
    await page.getByText("Saved 1 change.").waitFor();
    await page.getByRole("link", { name: "History" }).click();
    await heading(page, "History");
    const first = page.getByRole("grid", { name: "Audit log" }).getByRole("row").nth(1);
    await first.getByText("Deleted environment variable LOG_LEVEL").waitFor();
    expect(errors).toEqual([]);
    await close();
  });

  for (const colorScheme of ["light", "dark"] as const)
    test(`axe, colour contrast included, on the main screens (${colorScheme})`, async () => {
      const found: string[] = [];
      for (const [path, name] of [
        ["/", "Health"],
        ["/database/users", "users"],
        ["/database/users?panel=schema", "users"],
        ["/database/users?panel=add", "users"],
        ["/schedules/functions", "Schedules"],
        ["/schedules/crons?cron=summarize+tasks", "Schedules"],
        ["/files", "Files"],
        ["/settings/environment-variables", "Settings"],
        ["/history", "History"],
      ] as const) {
        const { page, close } = await open(path, { colorScheme });
        await heading(page, name);
        await page.waitForTimeout(300);
        await page.addScriptTag({ content: AXE });
        const violations = await page.evaluate(async () => {
          // biome-ignore lint/suspicious/noExplicitAny: axe is injected as a global
          const axe = (window as any).axe;
          const r = await axe.run(document, { resultTypes: ["violations"] });
          return r.violations.map((v: { id: string; nodes: unknown[] }) => `${v.id} (${v.nodes.length})`);
        });
        found.push(...violations.map((v: string) => `${path}: ${v}`));
        await close();
      }
      expect(found).toEqual([]);
    });
});

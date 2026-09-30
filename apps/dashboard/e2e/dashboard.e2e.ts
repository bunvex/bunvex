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
async function open(path: string, opts: { colorScheme?: "light" | "dark"; reducedMotion?: "reduce" } = {}) {
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
  test("the first load is the shell: each screen is its own chunk (UI-01 §14.1)", () => {
    const assets = readdirSync(`${import.meta.dir}/../dist/assets`);
    const entry = assets.filter((f) => /^index-.*\.js$/.test(f));
    expect(entry.length).toBe(1);
    const file = Bun.file(`${import.meta.dir}/../dist/assets/${entry[0]}`);
    // 740 kB before route splitting, ~336 kB after
    expect(file.size).toBeLessThan(380_000);
    // no screen's own text in the entry: a screen imported eagerly again fails this
    const code = readFileSync(file.name!, "utf8");
    for (const text of ["Documents in ", "Log lines", "Search functions", "Run a function"])
      expect(code).not.toContain(text);
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

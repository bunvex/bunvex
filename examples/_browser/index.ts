// The examples in a real browser (STUDY-90). Each `<example>.browser.ts` deploys its example with the harness
// (this repository's backend, a temporary state: the developer's `.bunvex/` is never touched), serves its front
// end with its own dev server (Vite or Next.js) pointed at that deployment, and drives the page in Chromium. A
// page that loads but whose client throws — what `Buffer is not defined` was — fails the test: every page error
// and console error is collected and must be empty at the end.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { type Deployment, deploy } from "bunvex-examples-harness";
import { type Browser, chromium, type Page } from "playwright-core";

export { type Deployment, until } from "bunvex-examples-harness";
export type { Page } from "playwright-core";

const bindable = (port: number) => {
  try {
    Bun.listen({ hostname: "0.0.0.0", port, socket: { data() {} } }).stop(true);
    return true;
  } catch {
    return false;
  }
};
/** A free port below the OS's ephemeral range (see the harness's `freePorts`). */
function freePort(): number {
  for (;;) {
    const p = 20_000 + Math.floor(Math.random() * 12_000);
    if (bindable(p)) return p;
  }
}

/** Wait until `f` resolves to something truthy (polled every 50 ms, for up to 15 s); its last value otherwise. */
export async function eventually<T>(f: () => Promise<T>, what: string): Promise<T> {
  let last: T | undefined;
  for (let i = 0; i < 300; i++) {
    last = await f();
    if (last) return last;
    await Bun.sleep(50);
  }
  throw new Error(`timed out waiting for ${what} (last: ${JSON.stringify(last)})`);
}

/** The texts of a page's list items. */
export const items = (page: Page) => page.locator("li").allInnerTexts();

/** A 1×1 PNG, for uploads. */
export const PNG = {
  name: "dot.png",
  mimeType: "image/png",
  buffer: Buffer.from(
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==",
    "base64",
  ),
};

/** Whether the image `img` (a locator's element) loaded: its natural width, once it settles. */
export const imageWidth = (page: Page, selector: string) =>
  page
    .locator(selector)
    .first()
    .evaluate(
      (el: HTMLImageElement) =>
        new Promise<number>((r) => {
          if (el.complete) r(el.naturalWidth);
          else {
            el.onload = () => r(el.naturalWidth);
            el.onerror = () => r(0);
          }
        }),
    );

export type App = {
  d: Deployment;
  url: string;
  browser: Browser;
  /** A new tab on the app, its errors collected. */
  open: (path?: string) => Promise<Page>;
  /** Page errors, console errors and failed requests, from every tab. */
  errors: string[];
  /** Run `bunx bunvex env set name value` against the deployment, as a user following the README does. */
  envSet: (name: string, value: string) => Promise<void>;
  stop: () => Promise<void>;
};

/**
 * Deploy the example at `dir`, serve its front end against the deployment, and launch Chromium (the one
 * `bun x playwright-core install chromium` installs; a local Chrome with E2E_BROWSER=chrome).
 */
export async function startApp(dir: string, options: { env?: Record<string, string> } = {}): Promise<App> {
  const d = await deploy(dir, options);
  const port = freePort();
  const next = "next" in (JSON.parse(readFileSync(join(dir, "package.json"), "utf8")).dependencies ?? {});
  const cmd = next
    ? [process.execPath, "x", "next", "dev", "--port", String(port)]
    : [process.execPath, "x", "vite", "--port", String(port), "--strictPort"];
  const out: string[] = [];
  const server = Bun.spawn(cmd, {
    cwd: dir,
    // Process variables win over the example's own .env.local, in Vite and in Next.js.
    env: {
      ...process.env,
      VITE_BUNVEX_URL: d.url,
      VITE_BUNVEX_SITE_URL: d.siteUrl,
      NEXT_PUBLIC_BUNVEX_URL: d.url,
      NEXT_TELEMETRY_DISABLED: "1",
      BROWSER: "none",
    },
    stdout: "pipe",
    stderr: "pipe",
  });
  const pump = async (s: ReadableStream<Uint8Array>) => {
    for await (const c of s) out.push(new TextDecoder().decode(c));
  };
  void pump(server.stdout);
  void pump(server.stderr);
  const url = `http://localhost:${port}`;
  const stopServer = async () => {
    server.kill("SIGTERM");
    await Promise.race([server.exited, Bun.sleep(5000)]);
    if (server.exitCode === null) server.kill("SIGKILL");
  };
  for (let i = 0; ; i++) {
    const up = await fetch(url).then(
      (r) => r.status < 500,
      () => false,
    );
    if (up) break;
    if (server.exitCode !== null || i > 600) {
      await stopServer();
      await d.stop();
      throw new Error(`${dir}: the front end did not start:\n${out.join("")}`);
    }
    await Bun.sleep(100);
  }
  const browser = await chromium.launch(process.env.E2E_BROWSER === "chrome" ? { channel: "chrome" } : {});
  const errors: string[] = [];
  const open = async (path = "/") => {
    const page = await browser.newPage();
    // An uncaught error in the page: shown at once, and the page closed, so the test's next wait fails now
    // instead of timing out on a page whose client has died.
    page.on("pageerror", (e) => {
      errors.push(`page error: ${e.message}`);
      console.error(`${dir}: page error: ${e.message}`);
      void page.close();
    });
    page.setDefaultTimeout(20_000);
    page.on("console", (m) => {
      if (m.type() === "error") errors.push(`console error: ${m.text()}`);
    });
    await page.goto(url + path);
    return page;
  };
  return {
    d,
    url,
    browser,
    open,
    errors,
    envSet: async (name, value) => {
      await d.cli("env", "set", name, value, "--force");
    },
    stop: async () => {
      await browser.close();
      await stopServer();
      await d.stop();
    },
  };
}

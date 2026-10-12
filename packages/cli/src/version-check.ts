// The version check (AD-29, STUDY-146 §7): a bunvex addition, the npm-registry analogue of the message Convex's
// `dev` and `deploy` print from Convex's version service (`checkVersionAndAiFilesStaleness`, lib/updates.ts;
// `getVersion`, lib/versionApi.ts). While `dev` or `deploy` runs, the registry is asked for the latest
// `@bunvex/cli` (every `@bunvex/*` package is released at one version, STUDY-40 L7); when it is newer than this
// CLI, one line says so. It never blocks the command: it runs beside it, gives up
// after a short timeout, fails silently, and asks at most once a day (the answer is cached). It is off in CI
// (`CI` set, as Convex's CLI detects CI), with `BUNVEX_DISABLE_VERSION_CHECK` or npm's `NO_UPDATE_NOTIFIER`.
// `BUNVEX_VERSION_API_ORIGIN` points it at another registry, as Convex's `CONVEX_VERSION_API_ORIGIN` does its service.
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import type { Io } from "./io.ts";
import { cacheDir } from "./local-deployment.ts";
import { VERSION } from "./version.ts";

export const DEFAULT_REGISTRY = "https://registry.npmjs.org";
/** The package asked for: this CLI's own (npm will not allow the name `bunvex`, STUDY-40 L7). */
export const VERSION_CHECK_PACKAGE = "@bunvex/cli";
/**
 * The registry path of a package's `latest` version. A scoped name's `/` is escaped (`@bunvex%2fcli`), as npm's
 * own client asks for it (npm-package-arg's `escapedName`), which every registry and mirror accepts.
 */
export const latestPath = (name: string) => `/${encodeURIComponent(name).replace(/^%40/, "@")}/latest`;
/** How long the registry may take before the check gives up. */
export const VERSION_CHECK_TIMEOUT_MS = 1500;
/** How long an answer is kept before the registry is asked again. */
export const VERSION_CHECK_TTL_MS = 24 * 60 * 60 * 1000;
/** How long a command that has finished waits for a check still running before it exits without it. */
export const VERSION_CHECK_GRACE_MS = 200;

type Cache = { checkedAt: number; latest: string };

/** Whether the check is off: in CI, or turned off by a variable. */
export function versionCheckDisabled(env: Io["env"]): boolean {
  return !!env.CI || !!env.BUNVEX_DISABLE_VERSION_CHECK || !!env.NO_UPDATE_NOTIFIER;
}

/** The notice for `latest`, when it is newer than `installed`; else null. */
export function versionNotice(installed: string, latest: string): string | null {
  try {
    if (Bun.semver.order(installed, latest) >= 0) return null;
  } catch {
    return null;
  }
  return `A newer version of bunvex is available: ${latest} (this is ${installed}). Run \`bunvex update\` to see how to upgrade.`;
}

/**
 * Ask (or remember) the latest `@bunvex/cli` and return the notice, if any. Never throws: any failure (offline, a
 * timeout, an answer that is not a version, a cache that cannot be read or written) is no notice.
 */
export async function checkForNewerVersion(
  env: Io["env"],
  o: { installed?: string; now?: () => number; timeoutMs?: number } = {},
): Promise<string | null> {
  try {
    if (versionCheckDisabled(env)) return null;
    const installed = o.installed ?? VERSION;
    const now = (o.now ?? Date.now)();
    const file = join(cacheDir(env), "version-check.json");
    try {
      const cached = JSON.parse(readFileSync(file, "utf8")) as Cache;
      if (
        typeof cached.latest === "string" &&
        now - cached.checkedAt >= 0 &&
        now - cached.checkedAt < VERSION_CHECK_TTL_MS
      )
        return versionNotice(installed, cached.latest);
    } catch {
      // no answer yet
    }
    const origin = (env.BUNVEX_VERSION_API_ORIGIN || DEFAULT_REGISTRY).replace(/\/+$/, "");
    const r = await fetch(`${origin}${latestPath(VERSION_CHECK_PACKAGE)}`, {
      headers: { accept: "application/json" },
      signal: AbortSignal.timeout(o.timeoutMs ?? VERSION_CHECK_TIMEOUT_MS),
    });
    if (!r.ok) return null;
    const { version } = (await r.json()) as { version?: unknown };
    if (typeof version !== "string" || !/^\d+\.\d+\.\d+(-[\w.]+)?(\+[\w.]+)?$/.test(version)) return null;
    try {
      mkdirSync(dirname(file), { recursive: true });
      writeFileSync(file, JSON.stringify({ checkedAt: now, latest: version } satisfies Cache));
    } catch {
      // asked again next time
    }
    return versionNotice(installed, version);
  } catch {
    return null;
  }
}

/** Start the check for a command (`Io.versionCheck`; none when the Io has none, as in tests). */
export function startVersionCheck(io: Io): Promise<string | null> {
  return (io.versionCheck?.() ?? Promise.resolve(null)).catch(() => null);
}

/** Print the check's notice if it has one by now, or within `VERSION_CHECK_GRACE_MS`. */
export async function printVersionNotice(check: Promise<string | null>, io: Io, graceMs = VERSION_CHECK_GRACE_MS) {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const notice = await Promise.race([
    check,
    new Promise<null>((resolve) => {
      timer = setTimeout(() => resolve(null), graceMs);
    }),
  ]);
  clearTimeout(timer);
  if (notice) io.err(notice);
}

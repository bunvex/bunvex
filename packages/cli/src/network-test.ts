// `bunvex network-test` (STUDY-146): Convex's `npx convex network-test` (npm-packages/convex/src/cli/network_test.ts,
// lib/networkTest.ts) against the deployment: a DNS lookup, a TCP connect, `GET /instance_name`, a WebSocket
// subscription with the admin key, then `POST /echo` of 128 bytes and 4 MiB (and 64 MiB with `--speed-test`), all
// within `--timeout` seconds (30 by default). Convex's lines on stderr, its retries for the HTTP requests.
import { randomBytes } from "node:crypto";
import { lookup } from "node:dns";
import { connect } from "node:net";
import { BunvexClient, makeFunctionReference } from "@bunvex/client";
import { argumentError, missingArgument, optionsIn, tooManyArguments, unknownOption } from "./args.ts";
import type { Io } from "./io.ts";
import { acquireTarget } from "./local-deployment.ts";
import { NO_DEPLOYMENT, TARGET_OPTIONS, takeTargetFlags } from "./target.ts";

export const NETWORK_TEST_USAGE = `Usage: bunvex network-test [options]

Run a network test to the deployment.

Options:
  --timeout <timeout>  Timeout in seconds for the network test (default: 30).
  --ip-family <ipFamily>
                       IP family to use (ipv4, ipv6, or auto)
  --speed-test         Perform a large echo test to measure network speed.
${TARGET_OPTIONS}`;

const IP_FAMILY_NUMBERS: Record<string, 0 | 4 | 6> = { ipv4: 4, ipv6: 6, auto: 0 };
const IP_FAMILY_NAMES: Record<number, string> = { 4: "ipv4", 6: "ipv6", 0: "auto" };
const BYTE_UNITS = ["bytes", "KiB", "MiB", "GiB", "TiB", "PiB"];

/** Convex's `formatSize`: binary units, one decimal place, a trailing `.0` dropped. */
export function formatSize(n: number): string {
  let value = n;
  let unit = 0;
  while (value >= 1024 && unit < BYTE_UNITS.length - 1) {
    value /= 1024;
    unit++;
  }
  // Rounding can reach the next unit (1023.96 KiB is 1.0 MiB, not 1024.0 KiB).
  if (Number(value.toFixed(1)) >= 1024 && unit < BYTE_UNITS.length - 1) {
    value /= 1024;
    unit++;
  }
  return `${value.toFixed(1).replace(/\.0$/, "")} ${BYTE_UNITS[unit]}`;
}

/** Convex's `formatDuration`: ns, µs, ms, s or m, with at most two decimals, in en-US digits. */
export function formatDuration(ms: number): string {
  const two = (n: number, unit: string) => `${n.toLocaleString("en-US", { maximumFractionDigits: 2 })}${unit}`;
  if (ms < 1e-3) return two(ms * 1e9, "ns");
  if (ms < 1) return two(ms * 1e3, "µs");
  if (ms < 1e3) return two(ms, "ms");
  const s = ms / 1e3;
  if (s < 60) return two(s, "s");
  return two(s / 60, "m");
}

/** A check's failure: Convex's `ctx.crash` with its printed message. */
class Fail extends Error {}

/** An HTTP answer that is not a success, as Convex's `ThrowingFetchError` names it. */
class StatusError extends Error {
  constructor(
    readonly status: number,
    text: string,
  ) {
    super(text);
  }
  override toString() {
    return `Error: ${this.message}`;
  }
}

const MAX_RETRIES = 6;
const RETRY_LOG_THRESHOLD = 3;

type Run = { io: Io; stopped: () => boolean; line: (s: string) => void };

/**
 * Convex's `bareDeploymentFetch` as the network test uses it: a fetch that throws on an answer that is not a
 * success (`ThrowingFetchError`), retried up to 6 times with Convex's backoff (1 ms, then 1 s doubling, plus up to
 * 20%) on a network error or a 404. (Convex also retries other failures of idempotent methods, but only when the
 * request names its method, which the test's GETs do not.) `onError` hears each failure that is retried, the last
 * one too, as Convex's `retryOn` calls it.
 */
async function retryingFetch(
  run: Run,
  url: string,
  init: RequestInit,
  onError?: (error: string) => void,
): Promise<Response> {
  for (let attempt = 0; ; attempt++) {
    let error: string | null = null;
    let response: Response | null = null;
    let thrown: unknown;
    try {
      response = await fetch(url, init);
    } catch (e) {
      thrown = e;
      error = String(e);
    }
    if (response?.status === 404) error = `Received response with status ${response.status}`;
    if (error !== null) {
      onError?.(error);
      if (attempt >= RETRY_LOG_THRESHOLD) run.line(`Retrying request (attempt ${attempt}/${MAX_RETRIES})...`);
    }
    if (error === null || attempt >= MAX_RETRIES || run.stopped()) {
      if (thrown !== undefined) throw thrown;
      if (!response!.ok) throw await statusError(response!);
      return response!;
    }
    const delay = attempt === 0 ? 1 : 2 ** (attempt - 1) * 1000;
    await Bun.sleep(delay + delay * 0.2 * Math.random());
  }
}

async function statusError(r: Response): Promise<StatusError> {
  let text = `${r.status} ${r.statusText}`;
  try {
    const { code, message } = (await r.json()) as { code?: unknown; message?: unknown };
    if (code !== undefined && message !== undefined) text += `: ${code}: ${message}`;
  } catch {
    // the status is the error
  }
  return new StatusError(r.status, text);
}

async function checkDns(run: Run, url: string) {
  const hostname = new URL("/", url).hostname.replace(/^\[(.*)\]$/, "$1");
  const start = performance.now();
  try {
    const { address, family } = await new Promise<{ address: string; family: number }>((resolve, reject) =>
      lookup(hostname, (err, address, family) => (err ? reject(err) : resolve({ address, family }))),
    );
    run.line(
      `✔ OK: DNS lookup => ${address}:${IP_FAMILY_NAMES[family]} (${formatDuration(performance.now() - start)})`,
    );
  } catch (e) {
    throw new Fail(`FAIL: DNS lookup (${e})`);
  }
}

async function checkTcpHostPort(run: Run, host: string, port: number, ipFamily: string) {
  const family = IP_FAMILY_NUMBERS[ipFamily];
  const name = `TCP${ipFamily === "auto" ? "" : `/${ipFamily} ${host}:${port}`}`;
  const start = performance.now();
  try {
    await new Promise<void>((resolve, reject) => {
      const socket = connect({ host: host.replace(/^\[(.*)\]$/, "$1"), port, noDelay: true, family }, () => {
        socket.destroy();
        resolve();
      });
      socket.on("error", reject);
    });
  } catch (e) {
    const message =
      e instanceof AggregateError
        ? `AggregateError with ${e.errors.length} errors:\n${e.errors.map((x, i) => `  ${i + 1}. ${x}`).join("\n")}`
        : `${e}`;
    throw new Fail(`FAIL: ${name} connect (${message})`);
  }
  run.line(`✔ OK: ${name} connect (${formatDuration(performance.now() - start)})`);
}

async function checkTcp(run: Run, urlString: string, ipFamily: string) {
  const url = new URL(urlString);
  if (url.protocol === "http:")
    return checkTcpHostPort(run, url.hostname, Number.parseInt(url.port || "80", 10), ipFamily);
  if (url.protocol !== "https:") throw new Error(`Unknown protocol: ${url.protocol}`);
  await checkTcpHostPort(run, url.hostname, Number.parseInt(url.port || "443", 10), ipFamily);
  // Without a port, port 80 too.
  if (!url.port) await checkTcpHostPort(run, url.hostname, 80, ipFamily);
}

async function checkHttpOnce(run: Run, name: string, url: string, allowRedirects: boolean) {
  const start = performance.now();
  try {
    const r = await retryingFetch(run, new URL("/instance_name", url).toString(), {
      redirect: allowRedirects ? "follow" : "manual",
    });
    if (r.status !== 200) throw new Error(`Unexpected status code: ${r.status}`);
  } catch (e) {
    // Without following redirects, a 301 (an HTTPS deployment's port 80) is the answer expected.
    if (allowRedirects || !(e instanceof StatusError && e.status === 301)) throw new Fail(`FAIL: ${name} check (${e})`);
  }
  run.line(`✔ OK: ${name} check (${formatDuration(performance.now() - start)})`);
}

async function checkHttp(run: Run, urlString: string) {
  const url = new URL(urlString);
  const https = url.protocol === "https:";
  if (https) {
    url.protocol = "http:";
    url.port = "80";
    await checkHttpOnce(run, "HTTP", url.toString(), false);
  }
  await checkHttpOnce(run, https ? "HTTPS" : "HTTP", urlString, true);
}

/** Convex's WebSocket check: the CLI's system query, as an admin, answered within 10 s. */
async function checkWs(run: Run, url: string, adminKey: string | null) {
  if (adminKey === null) {
    run.line("Skipping WebSocket check because no admin key was provided.");
    return;
  }
  const client = new BunvexClient(url, { logger: false });
  client.client.setAdminAuth(adminKey);
  let timer: ReturnType<typeof setTimeout> | undefined;
  let unsubscribe = () => {};
  try {
    const answered = await new Promise<boolean>((resolve) => {
      timer = setTimeout(() => resolve(false), 10_000);
      ({ unsubscribe } = client.onUpdate(
        makeFunctionReference<"query">("_system/cli/deploymentUrl:cloudUrl"),
        {},
        (value) => {
          if (typeof value === "string") resolve(true);
        },
        () => {},
      ));
    });
    if (!answered) throw new Fail("FAIL: Failed to connect to deployment over WebSocket.");
    run.line("✔ OK: WebSocket connection established.");
  } finally {
    clearTimeout(timer);
    unsubscribe();
    void client.close();
  }
}

async function checkEcho(run: Run, url: string, size: number) {
  const start = performance.now();
  try {
    const data = randomBytes(size);
    const r = await retryingFetch(run, new URL("/echo", url).toString(), { method: "POST", body: data }, (err) =>
      run.line(`✖ FAIL: echo ${formatSize(size)} (${err}), retrying...`),
    );
    if (r.status !== 200) throw new Error(`Unexpected status code: ${r.status}`);
    const back = Buffer.from(await r.arrayBuffer());
    if (!data.equals(back)) throw new Error("Response data mismatch");
  } catch (e) {
    throw new Fail(`FAIL: echo ${formatSize(size)} (${e})`);
  }
  const duration = performance.now() - start;
  run.line(`✔ OK: echo ${formatSize(size)} (${formatDuration(duration)}, ${formatSize(size / (duration / 1000))}/s)`);
}

/** Convex's `runNetworkTestOnUrl`. */
async function runNetworkTestOnUrl(
  run: Run,
  url: string,
  adminKey: string | null,
  o: { ipFamily: string; speedTest: boolean },
) {
  await checkDns(run, url);
  await checkTcp(run, url, o.ipFamily);
  await checkHttp(run, url);
  await checkWs(run, url, adminKey);
  // Much smaller than most networks' MTU, then much larger.
  await checkEcho(run, url, 128);
  await checkEcho(run, url, 4 * 1024 * 1024);
  if (o.speedTest) await checkEcho(run, url, 64 * 1024 * 1024);
  run.line("✔ Network test passed.");
}

export async function networkTestCommand(args: string[], io: Io): Promise<number> {
  if (args.includes("--help") || args.includes("-h")) {
    io.out(NETWORK_TEST_USAGE);
    return 0;
  }
  const taken = takeTargetFlags(args);
  if (typeof taken === "string") return argumentError(io, taken);
  let timeout: string | undefined;
  let ipFamily = "auto";
  let speedTest = false;
  let positional = 0;
  const rest = taken.rest;
  for (let i = 0; i < rest.length; i++) {
    const a = rest[i]!;
    const [name, inline] = a.includes("=") ? [a.slice(0, a.indexOf("=")), a.slice(a.indexOf("=") + 1)] : [a, undefined];
    if (name === "--timeout" || name === "--ip-family") {
      const v = inline ?? rest[++i];
      if (v === undefined)
        return argumentError(io, missingArgument(`${name} <${name === "--timeout" ? "timeout" : "ipFamily"}>`));
      if (name === "--timeout") timeout = v;
      else ipFamily = v;
    } else if (a === "--speed-test") speedTest = true;
    else if (a.startsWith("-")) return argumentError(io, unknownOption(a, optionsIn(NETWORK_TEST_USAGE)));
    else positional++;
  }
  if (positional) return argumentError(io, tooManyArguments("network-test", 0, positional));
  const timeoutMs = (timeout === undefined ? 30 : Number.parseFloat(timeout)) * 1000;

  let stopped = false;
  const run: Run = { io, stopped: () => stopped, line: (s) => !stopped && io.err(s) };
  let release = async () => {};
  const test = (async () => {
    // As Convex's: `--url` alone tests that URL without the WebSocket check; otherwise the configured deployment.
    let url: string;
    let adminKey: string | null;
    if (taken.flags.url !== undefined) {
      url = taken.flags.url;
      adminKey = taken.flags.adminKey ?? null;
    } else {
      const acquired = await acquireTarget(taken.flags, io);
      if (!acquired) throw new Error(NO_DEPLOYMENT);
      release = acquired.release;
      ({ url, adminKey } = acquired.target);
    }
    run.line(`✔ Deployment URL: ${url}`);
    await runNetworkTestOnUrl(run, url, adminKey, { ipFamily, speedTest });
  })();
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const outcome = await Promise.race([
      test.then(() => "ok" as const),
      new Promise<"timeout">((resolve) => {
        timer = setTimeout(() => resolve("timeout"), timeoutMs);
      }),
    ]);
    if (outcome === "timeout") {
      io.err(`✖ FAIL: Network test timed out after ${formatDuration(timeoutMs)}.`);
      return 1;
    }
    return 0;
  } catch (e) {
    io.err(e instanceof Fail ? `✖ ${e.message}` : `bunvex network-test: ${(e as Error).message}`);
    return 1;
  } finally {
    stopped = true;
    clearTimeout(timer);
    test.catch(() => {});
    await release();
  }
}

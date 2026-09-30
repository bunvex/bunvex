// The contract suite for the deployment's other features (UI-01 §14): each block runs when the source has
// the feature's methods. Reads are safe on any deployment; what changes data (cancelling scheduled runs)
// runs only when the caller opts in.
import { expect } from "bun:test";
import {
  type DashboardDataSource,
  DataSourceError,
  type FileQuery,
  type Page,
  type ScheduledFunction,
  type StoredFile,
} from "./data-source.ts";

export type DeploymentContractOptions = {
  /** Lets the suite cancel scheduled runs — every pending run of one function. Never on data you keep. */
  schedules?: { cancel: boolean };
  /** Lets the suite upload a small text file and delete it again. */
  files?: { write: boolean };
  /** Lets the suite add, change and delete a variable named BUNVEX_CONTRACT_SUITE. */
  environmentVariables?: { write: boolean };
};

type Ctx = {
  make: () => DashboardDataSource | Promise<DashboardDataSource>;
  test: (name: string, fn: () => Promise<void>) => void;
  watchTimeoutMs: number;
  opts: DeploymentContractOptions;
};

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function expectCode(p: Promise<unknown>, code: DataSourceError["code"]) {
  const e = await p.then(
    () => null,
    (err: unknown) => err,
  );
  expect(e).toBeInstanceOf(DataSourceError);
  expect((e as DataSourceError).code).toBe(code);
}

async function allScheduled(src: DashboardDataSource, fn?: string): Promise<ScheduledFunction[]> {
  const out: ScheduledFunction[] = [];
  let cursor: string | null = null;
  for (let i = 0; i < 1000; i++) {
    const p: Page<ScheduledFunction> = await src.listScheduledFunctions!({ numItems: 7, cursor, function: fn });
    out.push(...p.page);
    if (p.isDone) return out;
    cursor = p.continueCursor;
  }
  throw new Error("pagination did not finish");
}

async function allFiles(
  src: DashboardDataSource,
  q: Omit<FileQuery, "numItems" | "cursor"> = {},
): Promise<StoredFile[]> {
  const out: StoredFile[] = [];
  let cursor: string | null = null;
  for (let i = 0; i < 1000; i++) {
    const p: Page<StoredFile> = await src.listFiles!({ ...q, numItems: 3, cursor });
    out.push(...p.page);
    if (p.isDone) return out;
    cursor = p.continueCursor;
  }
  throw new Error("pagination did not finish");
}

async function sha256(blob: Blob): Promise<string> {
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", await blob.arrayBuffer()));
  return btoa(String.fromCharCode(...digest));
}

export function describeDeploymentContract({ make, test, watchTimeoutMs, opts }: Ctx) {
  // ---------------------------------------------------------------- scheduled functions and crons
  test("scheduled functions (when offered): nearest first, paged, one function's on request", async () => {
    const src = await make();
    if (!src.listScheduledFunctions) return;
    const all = await allScheduled(src);
    expect(new Set(all.map((j) => j.id)).size).toBe(all.length);
    for (let i = 1; i < all.length; i++)
      expect(all[i]!.scheduledTime).toBeGreaterThanOrEqual(all[i - 1]!.scheduledTime);
    for (const j of all) expect(["pending", "inProgress"]).toContain(j.state);
    const fn = all[0]?.function;
    if (fn === undefined) return;
    const mine = await allScheduled(src, fn);
    expect(mine.length).toBe(all.filter((j) => j.function === fn).length);
    expect(mine.every((j) => j.function === fn)).toBe(true);
  });

  test("cron jobs (when offered): each with its schedule, next run and runs newest first", async () => {
    const src = await make();
    if (!src.listCronJobs || !src.listCronRuns) return;
    const jobs = await src.listCronJobs();
    for (const job of jobs) {
      expect(typeof job.schedule.type).toBe("string");
      const runs = await src.listCronRuns(job.name);
      for (let i = 1; i < runs.length; i++) expect(runs[i]!.time).toBeLessThanOrEqual(runs[i - 1]!.time);
      if (job.lastRun) expect(runs[0]?.time).toBe(job.lastRun.time);
      if (job.lastRun) expect(job.nextRun).toBeGreaterThan(job.lastRun.time);
    }
    await expectCode(src.listCronRuns("no such cron job"), "not_found");
  });

  if (opts.schedules?.cancel)
    test("cancelling (opt-in): one run, then all of a function's; watchers hear it", async () => {
      const src = await make();
      if (!src.listScheduledFunctions || !src.cancelScheduledFunction || !src.cancelAllScheduledFunctions)
        throw new Error("schedules.cancel was enabled but the source cannot cancel scheduled runs");
      let heard = 0;
      const off = src.watchScheduledFunctions?.(
        () => heard++,
        () => {},
      );
      const pending = (await allScheduled(src)).filter((j) => j.state === "pending");
      const one = pending[0];
      if (!one) throw new Error("the cancel tests need a pending scheduled run");
      await src.cancelScheduledFunction(one.id);
      expect((await allScheduled(src)).some((j) => j.id === one.id)).toBe(false);
      await expectCode(src.cancelScheduledFunction(one.id), "not_found");
      const fn = pending.find((j) => j.id !== one.id)?.function;
      if (fn !== undefined) {
        const { canceled } = await src.cancelAllScheduledFunctions(fn);
        expect(canceled).toBeGreaterThan(0);
        expect((await allScheduled(src, fn)).filter((j) => j.state === "pending")).toEqual([]);
      }
      if (off) {
        const deadline = performance.now() + watchTimeoutMs;
        while (heard === 0 && performance.now() < deadline) await sleep(5);
        off();
        expect(heard).toBeGreaterThan(0);
      }
    });

  // ---------------------------------------------------------------- file storage
  test("files (when offered): newest first by default, oldest on request, bounded by time, counted", async () => {
    const src = await make();
    if (!src.listFiles) return;
    const newest = await allFiles(src);
    for (let i = 1; i < newest.length; i++)
      expect(newest[i]!.creationTime).toBeLessThanOrEqual(newest[i - 1]!.creationTime);
    const oldest = await allFiles(src, { order: "asc" });
    expect(oldest.map((f) => f.id)).toEqual([...newest].reverse().map((f) => f.id));
    if (src.countFiles) expect(await src.countFiles()).toBe(newest.length);
    if (newest.length >= 3) {
      const from = newest.at(-2)!.creationTime;
      const to = newest[1]!.creationTime;
      const inside = await allFiles(src, { from, to });
      expect(inside.map((f) => f.id)).toEqual(
        newest.filter((f) => f.creationTime >= from && f.creationTime <= to).map((f) => f.id),
      );
    }
    const first = newest[0];
    if (first && src.getFile) {
      const got = await src.getFile(first.id);
      expect({ ...got, url: undefined }).toEqual({ ...first, url: undefined });
      expect(await src.getFile("no-such-file")).toBeNull();
    }
    for (const f of newest) {
      expect(f.size).toBeGreaterThanOrEqual(0);
      expect(typeof f.url).toBe("string");
    }
  });

  if (opts.files?.write)
    test("uploading and deleting (opt-in): metadata as stored, first in the list, watchers hear it", async () => {
      const src = await make();
      if (!src.uploadFile || !src.deleteFiles || !src.getFile || !src.listFiles)
        throw new Error("files.write was enabled but the source cannot upload, read and delete files");
      let heard = 0;
      const off = src.watchFiles?.(
        () => heard++,
        () => {},
      );
      const blob = new Blob(["contract suite\n"], { type: "text/plain" });
      const id = await src.uploadFile(blob);
      const f = await src.getFile(id);
      expect(f).not.toBeNull();
      expect(f!.size).toBe(blob.size);
      expect(f!.contentType).toBe("text/plain");
      expect(f!.sha256).toBe(await sha256(blob));
      expect((await src.listFiles({ numItems: 1, cursor: null })).page[0]?.id).toBe(id);
      await src.deleteFiles([id, "no-such-file"]);
      expect(await src.getFile(id)).toBeNull();
      if (off) {
        const deadline = performance.now() + watchTimeoutMs;
        while (heard === 0 && performance.now() < deadline) await sleep(5);
        off();
        expect(heard).toBeGreaterThan(0);
      }
    });

  // ---------------------------------------------------------------- environment variables
  test("environment variables (when offered and allowed): by name, with valid names", async () => {
    const src = await make();
    if (!src.listEnvironmentVariables) return;
    if (!(await src.getCapabilities()).operations.includes("viewEnvironmentVariables")) return;
    const vars = await src.listEnvironmentVariables();
    const names = vars.map((v) => v.name);
    expect(names).toEqual([...names].sort());
    for (const n of names) expect(n).toMatch(/^[a-zA-Z_]+[a-zA-Z0-9_]*$/);
  });

  if (opts.environmentVariables?.write)
    test("changing environment variables (opt-in): a batch applies whole or not at all", async () => {
      const src = await make();
      if (!src.listEnvironmentVariables || !src.updateEnvironmentVariables)
        throw new Error("environmentVariables.write was enabled but the source cannot change them");
      const name = "BUNVEX_CONTRACT_SUITE";
      const get = async () => (await src.listEnvironmentVariables!()).find((v) => v.name === name)?.value;
      await src.updateEnvironmentVariables([{ name, value: "one" }]);
      expect(await get()).toBe("one");
      const names = (await src.listEnvironmentVariables()).map((v) => v.name);
      expect(names).toEqual([...names].sort()); // still by name with a new one
      await expectCode(
        src.updateEnvironmentVariables([
          { name, value: "two" },
          { name: "1_BAD NAME", value: "x" },
        ]),
        "invalid_request",
      );
      expect(await get()).toBe("one"); // nothing of the failed batch applied
      await expectCode(src.updateEnvironmentVariables([{ name, value: "x".repeat(8 * 1024 + 1) }]), "invalid_request");
      await src.updateEnvironmentVariables([
        { name, value: null },
        { name: "BUNVEX_NEVER_SET", value: null },
      ]);
      expect(await get()).toBeUndefined();
    });
}

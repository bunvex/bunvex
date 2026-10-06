// `bunvex export` (STUDY-42 PR 1), as Convex's `npx convex export` (npm-packages/convex/src/cli/convexExport.ts,
// lib/convexExport.ts): request a snapshot export, follow it until it completes, then download its ZIP into a
// directory (the server's file name) or to a new path.
import { existsSync, statSync } from "node:fs";
import { join, resolve } from "node:path";
import { argumentError, missingArgument, optionsIn, requiredOption, tooManyArguments, unknownOption } from "./args.ts";
import type { Io } from "./io.ts";
import { acquireTarget } from "./local-deployment.ts";
import { adminRequest, NO_DEPLOYMENT, TARGET_OPTIONS, type Target, takeTargetFlags } from "./target.ts";

export const EXPORT_USAGE = `Usage: bunvex export --path <zipFilePath> [options]

Export the deployment's data (and optionally its files) into a ZIP file.

Options:
  --path <zipFilePath>      a directory, or an unoccupied .zip path
  --include-file-storage    include the files in file storage
${TARGET_OPTIONS}`;

type Latest = { state: string; start_ts?: bigint | number; progress_message?: string } | null;

async function latest(target: Target): Promise<Latest> {
  const r = (await adminRequest(target, "/api/query", { path: "_system/cli/exports:getLatest", args: {} })) as {
    status: string;
    value?: Record<string, unknown> | null;
    errorMessage?: string;
  };
  if (r.status !== "success") throw new Error(r.errorMessage ?? "could not read the export's state");
  const v = r.value;
  if (!v) return null;
  // The wire carries int64 as `{"$integer": base64}`.
  const ts = v.start_ts as { $integer?: string } | number | undefined;
  const start =
    ts && typeof ts === "object" && ts.$integer
      ? Buffer.from(ts.$integer, "base64").readBigInt64LE()
      : (ts as number | undefined);
  return { state: String(v.state), start_ts: start, progress_message: v.progress_message as string | undefined };
}

export async function exportCommand(args: string[], io: Io, opts: { pollMs?: number } = {}): Promise<number> {
  if (args.includes("--help") || args.includes("-h")) {
    io.out(EXPORT_USAGE);
    return 0;
  }
  const taken = takeTargetFlags(args);
  // Convex's `export` shows its help after an argument error.
  if (typeof taken === "string") return argumentError(io, taken, EXPORT_USAGE);
  let path: string | undefined;
  let includeStorage = false;
  const positional: string[] = [];
  const r = taken.rest;
  for (let i = 0; i < r.length; i++) {
    const a = r[i]!;
    if (a === "--include-file-storage") includeStorage = true;
    else if (a === "--path" || a.startsWith("--path=")) {
      path = a.includes("=") ? a.slice(7) : r[++i];
      if (path === undefined) return argumentError(io, missingArgument("--path <zipFilePath>"), EXPORT_USAGE);
    } else if (!a.startsWith("-")) positional.push(a);
    else return argumentError(io, unknownOption(a, optionsIn(EXPORT_USAGE)), EXPORT_USAGE);
  }
  if (!path) return argumentError(io, requiredOption("--path <zipFilePath>"), EXPORT_USAGE);
  if (positional.length) return argumentError(io, tooManyArguments("export", 0, positional.length), EXPORT_USAGE);
  const out = resolve(io.cwd, path);
  if (existsSync(out) && !statSync(out).isDirectory()) {
    io.err(`Error: Path ${path} already exists.`);
    return 1;
  }
  let acquired: Awaited<ReturnType<typeof acquireTarget>>;
  try {
    acquired = await acquireTarget(taken.flags, io);
  } catch (e) {
    io.err(`bunvex export: ${(e as Error).message}`);
    return 1;
  }
  if (!acquired) {
    io.err(`bunvex export: ${NO_DEPLOYMENT}`);
    return 1;
  }
  const target = acquired.target;
  try {
    io.err("Creating snapshot export");
    try {
      await adminRequest(target, `/api/export/request/zip?includeStorage=${includeStorage}`, {});
    } catch (e) {
      if (/already an export requested or in progress/.test((e as Error).message)) {
        io.err(
          "A snapshot export is already requested or in progress. Only one can run at a time, so wait for it to finish and try again.",
        );
        return 1;
      }
      throw e;
    }
    let state: Latest = null;
    let shown = "";
    for (;;) {
      state = await latest(target);
      if (state?.state === "completed" || state?.state === "failed" || state?.state === "canceled") break;
      if (state?.progress_message && state.progress_message !== shown) {
        shown = state.progress_message;
        io.err(shown);
      }
      await Bun.sleep(opts.pollMs ?? 500);
    }
    if (state.state === "failed") {
      io.err("Export failed. Please try again later.");
      return 1;
    }
    if (state.state !== "completed") {
      io.err(`unknown error: unexpected state ${state.state}`);
      return 1;
    }
    io.err(`Created snapshot export at timestamp ${state.start_ts}`);
    const res = await fetch(`${target.url}/api/export/zip/${state.start_ts}`, {
      headers: { authorization: `Bunvex ${target.adminKey}` },
    });
    if (!res.ok || !res.body) {
      io.err(`Exporting data failed: ${res.status} ${await res.text()}`);
      return 1;
    }
    let file = out;
    if (existsSync(out)) {
      const name = /attachment; filename=(.+)$/.exec(res.headers.get("content-disposition") ?? "")?.[1];
      file = join(out, name ?? `snapshot_${state.start_ts}.zip`);
    }
    try {
      await Bun.write(file, res);
    } catch (e) {
      io.err(`Exporting data failed: ${(e as Error).message}`);
      return 1;
    }
    io.err(`Downloaded snapshot export to ${file}`);
    return 0;
  } catch (e) {
    io.err(`bunvex export: ${(e as Error).message}`);
    return 1;
  } finally {
    await acquired.release();
  }
}

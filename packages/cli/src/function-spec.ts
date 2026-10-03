// `bunvex function-spec` (STUDY-37 §CLI), as Convex's `npx convex function-spec`
// (npm-packages/convex/src/cli/functionSpec.ts, lib/functionSpec.ts): the deployment's URL and every function's
// kind, visibility, argument and return validators, and its HTTP routes, as JSON — printed, or with `--file`
// written to `function_spec_<ms>.json`.
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import type { Io } from "./io.ts";
import { acquireTarget } from "./local-deployment.ts";
import { adminRequest, NO_DEPLOYMENT, TARGET_OPTIONS, type Target, takeTargetFlags } from "./target.ts";

export const FUNCTION_SPEC_USAGE = `Usage: bunvex function-spec [options]

List the arguments and return values of the deployment's functions.

Options:
  --file               write the JSON to a file instead of printing it
${TARGET_OPTIONS}`;

async function systemQuery(target: Target, path: string): Promise<unknown> {
  const r = (await adminRequest(target, "/api/query", { path, args: {} })) as {
    status: string;
    value?: unknown;
    errorMessage?: string;
  };
  if (r.status !== "success") throw new Error(r.errorMessage ?? `${path} failed`);
  return r.value;
}

export async function functionSpecCommand(args: string[], io: Io, opts: { now?: () => number } = {}): Promise<number> {
  if (args.includes("--help") || args.includes("-h")) {
    io.out(FUNCTION_SPEC_USAGE);
    return 0;
  }
  const taken = takeTargetFlags(args);
  if (typeof taken === "string") {
    io.err(`bunvex function-spec: ${taken}`);
    return 2;
  }
  let file = false;
  for (const a of taken.rest) {
    if (a === "--file") file = true;
    else {
      io.err(`bunvex function-spec: unknown option ${a}\n\n${FUNCTION_SPEC_USAGE}`);
      return 2;
    }
  }
  let acquired: Awaited<ReturnType<typeof acquireTarget>>;
  try {
    acquired = await acquireTarget(taken.flags, io);
  } catch (e) {
    io.err(`bunvex function-spec: ${(e as Error).message}`);
    return 1;
  }
  if (!acquired) {
    io.err(`bunvex function-spec: ${NO_DEPLOYMENT}`);
    return 1;
  }
  try {
    // The values arrive in their JSON form, which is what Convex's CLI prints (`convexToJson`).
    const functions = await systemQuery(acquired.target, "_system/cli/modules:apiSpec");
    const url = await systemQuery(acquired.target, "_system/cli/deploymentUrl:cloudUrl");
    const output = JSON.stringify({ url, functions }, null, 2);
    if (file) {
      const name = `function_spec_${(opts.now ?? Date.now)()}.json`;
      writeFileSync(join(io.cwd, name), output);
      io.out(`Wrote function spec to ${name}`);
    } else io.out(output);
    return 0;
  } catch (e) {
    io.err(`bunvex function-spec: ${(e as Error).message}`);
    return 1;
  } finally {
    await acquired.release();
  }
}

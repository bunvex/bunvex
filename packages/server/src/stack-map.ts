// An error's stack as the app sees it (STUDY-95), as Convex's `JsError::from_frames` (common/src/errors.rs)
// builds it: only the frames of the pushed code, each mapped through its module's source map to the original
// file, line and column. The server's own frames (the engine, the function runtime, `node:async_hooks`) are not
// the app's: Convex's harness frames are dropped too, having no module source map.
//
// A pushed module runs as a `vm.SourceTextModule` whose `sourceURL` is `moduleUrl(version, path)`: unique per
// loaded code version, so two versions (a hot swap, two deployments in one process) never map each other's
// frames.
import { resolve } from "node:path";
import type { SourceMapTokens } from "./source-position.ts";

const SCHEME = "bunvex:/";
let loads = 0;
/** Each loaded code version's maps, weakly: a version no longer referenced maps nothing. */
const versions = new Map<string, WeakRef<SourceMapTokens>>();

/** A new code version's id, its maps registered for its frames. */
export function registerModules(maps: SourceMapTokens): string {
  const id = `v${++loads}`;
  versions.set(id, new WeakRef(maps));
  // Drop the versions collected since: the map holds only live ones (and the latest few ids).
  if (versions.size > 64) for (const [k, ref] of versions) if (!ref.deref()) versions.delete(k);
  return id;
}

/** The URL a pushed module's frames carry (its `sourceURL`). */
export const moduleUrl = (version: string, path: string) => `${SCHEME}${version}/${path}`;

// `at <function> (<location>)` or `at <location>`; a location is `<file>:<line>:<column>`.
const FRAME = /^(\s*at )(?:(.*?) \((.*)\)|(.*))$/;
const LOCATION = /^(.*):(\d+):(\d+)$/;

// The server's own code: bunvex's packages' sources (`<packages>/<package>/src/`, siblings of this one, in the
// repository or under `node_modules/@bunvex/`) and the packages it depends on (under its `node_modules/`).
const PACKAGES = resolve(import.meta.dir, "../..");
const MODULES = import.meta.dir.includes("/node_modules/")
  ? import.meta.dir.slice(0, import.meta.dir.lastIndexOf("/node_modules/") + "/node_modules/".length)
  : `${resolve(PACKAGES, "../node_modules")}/`;
const isServerFile = (file: string) =>
  file.startsWith(MODULES) ||
  file.startsWith("node:") ||
  // The server's code run in a pushed module's context (`installNestedCalls`).
  file.startsWith("bunvex-runtime:") ||
  file === "native" ||
  (file.startsWith(`${PACKAGES}/`) && file.slice(PACKAGES.length + 1).split("/")[1] === "src");

/**
 * The frames of `stack` (an error's `stack`, or any text whose `at` lines are frames) as the app sees them:
 * a pushed module's frame mapped to its original source (`../bunvex/messages.ts:12:4`, the path its source map
 * names), or its module path when the map has no answer; a frame with no location kept as it is; every other
 * frame (the server's own) dropped. Lines that are not frames are kept. A stack with no pushed module's frame
 * keeps its frames but the server's own code's (`serverFramesDropped`): functions registered in-process
 * (`Functions.register`, `@bunvex/testing`) are not pushed code, and their frames are the developer's.
 *
 * `nodeFrames`, for a `"use node"` context (DV-482 as amended, STUDY-188 Q2): Node's own frames (`node:https`,
 * `node:_http_client`, `node:internal/…`) are kept too, as they are, as Convex's Node executor keeps them
 * (`node-executor/src/errors.ts` `registerPrepareStackTrace`: "proxy-agents depends on Node-formatted frames";
 * agent-base looks for `node:https:` in a fresh stack to tell an https request). They hold no path of the
 * server's. Those past the app's outermost frame are the server calling the handler (`AsyncLocalStorage.run`),
 * not the app's code, and are dropped with the server's other frames.
 */
export function mapStack(stack: string, nodeFrames = false): string {
  if (!stack.includes(SCHEME)) return serverFramesDropped(stack, nodeFrames);
  const out: Line[] = [];
  for (const line of stack.split("\n")) {
    const frame = FRAME.exec(line);
    if (!frame) {
      out.push({ line, kind: "text" });
      continue;
    }
    const [, at, fn, inParens, bare] = frame;
    const where = (inParens ?? bare)!;
    if (nodeFrames && isNodeFile(LOCATION.exec(where)?.[1])) {
      // Named by its function alone, as Convex's executor prints a frame (`formatTraceLine`): no `new`.
      const name = fn?.startsWith("new ") ? fn.slice(4) : fn;
      out.push({ line: name !== undefined ? `${at}${name} (${where})` : line, kind: "node" });
      continue;
    }
    const mapped = mapLocation(where);
    // No location (native code, the module loader's `unknown`): kept between the app's frames only, as
    // Convex trims the harness's frames before and after them.
    if (mapped === undefined) out.push({ line, kind: "unlocated" });
    else if (mapped !== null)
      out.push({ line: fn !== undefined ? `${at}${fn} (${mapped})` : `${at}${mapped}`, kind: "app" });
  }
  return trimmed(out);
}

/** A line of a stack: not a frame, a frame with no location, the app's, or Node's (`mapStack`'s `nodeFrames`). */
type Line = { line: string; kind: "text" | "unlocated" | "app" | "node" };

/** Whether a frame's file is one of Node's own modules (`node:https`, `node:internal/…`). */
const isNodeFile = (file: string | undefined) => file?.startsWith("node:") === true;

/**
 * A stack's lines, its frames trimmed to the app's: a frame with no location kept between the others only;
 * Node's kept from the top down to the app's outermost frame, or all of them when the app has none (an error
 * Node made in its own callback).
 */
function trimmed(out: Line[]): string {
  const located = (l: Line) => l.kind === "app" || l.kind === "node";
  const first = out.findIndex(located);
  let last = out.findLastIndex((l) => l.kind === "app");
  if (last === -1) last = out.findLastIndex(located);
  return out
    .filter((l, i) => l.kind === "text" || (i >= first && i <= last))
    .map((l) => l.line)
    .join("\n");
}

/** A location mapped: the original's, null to drop the frame, undefined when it is no location at all. */
function mapLocation(where: string): string | null | undefined {
  const loc = LOCATION.exec(where);
  if (!loc) return undefined;
  const [, file, line, col] = loc;
  if (!file!.startsWith(SCHEME)) return null;
  const rest = file!.slice(SCHEME.length);
  const slash = rest.indexOf("/");
  const path = rest.slice(slash + 1);
  const maps = versions.get(rest.slice(0, slash))?.deref();
  const original = maps?.original(path, Number(line), Number(col));
  if (!original) return `${path}:${line}:${col}`;
  return `${original.source ?? path}:${original.line}:${original.col}`;
}

/**
 * A stack with no pushed module's frame, without the server's own frames (its sources, its packages, `node:`
 * internals): an error the server raised for pushed code (a value it could not serialize) shows no frame of the
 * server's installation, as Convex's shows none of its runtime's. Frames with no location are kept between the
 * remaining ones only. With `nodeFrames`, Node's own frames are kept as `mapStack` keeps them.
 */
function serverFramesDropped(stack: string, nodeFrames: boolean): string {
  const out: Line[] = [];
  for (const line of stack.split("\n")) {
    const frame = FRAME.exec(line);
    if (!frame) {
      out.push({ line, kind: "text" });
      continue;
    }
    const where = (frame[3] ?? frame[4])!;
    const loc = LOCATION.exec(where);
    if (!loc) out.push({ line, kind: "unlocated" });
    else if (nodeFrames && isNodeFile(loc[1])) out.push({ line, kind: "node" });
    else if (!isServerFile(loc[1]!)) out.push({ line, kind: "app" });
  }
  return trimmed(out);
}

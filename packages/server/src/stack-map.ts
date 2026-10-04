// An error's stack as the app sees it (STUDY-95), as Convex's `JsError::from_frames` (common/src/errors.rs)
// builds it: only the frames of the pushed code, each mapped through its module's source map to the original
// file, line and column. The server's own frames (the engine, the function runtime, `node:async_hooks`) are not
// the app's: Convex's harness frames are dropped too, having no module source map.
//
// A pushed module runs as a `vm.SourceTextModule` whose `sourceURL` is `moduleUrl(version, path)`: unique per
// loaded code version, so two versions (a hot swap, two deployments in one process) never map each other's
// frames.
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

/**
 * The frames of `stack` (an error's `stack`, or any text whose `at` lines are frames) as the app sees them:
 * a pushed module's frame mapped to its original source (`../bunvex/messages.ts:12:4`, the path its source map
 * names), or its module path when the map has no answer; a frame with no location kept as it is; every other
 * frame (the server's own) dropped. Lines that are not frames are kept. A stack with no pushed module's frame
 * is returned as it is: functions registered in-process (`Functions.register`, `@bunvex/testing`) are not
 * pushed code, and their frames are the developer's.
 */
export function mapStack(stack: string): string {
  if (!stack.includes(SCHEME)) return stack;
  const out: { line: string; located: boolean; frame: boolean }[] = [];
  for (const line of stack.split("\n")) {
    const frame = FRAME.exec(line);
    if (!frame) {
      out.push({ line, located: false, frame: false });
      continue;
    }
    const [, at, fn, inParens, bare] = frame;
    const mapped = mapLocation((inParens ?? bare)!);
    // No location (native code, the module loader's `unknown`): kept between the app's frames only, as
    // Convex trims the harness's frames before and after them.
    if (mapped === undefined) out.push({ line, located: false, frame: true });
    else if (mapped !== null)
      out.push({ line: fn !== undefined ? `${at}${fn} (${mapped})` : `${at}${mapped}`, located: true, frame: true });
  }
  const first = out.findIndex((l) => l.located);
  const last = out.findLastIndex((l) => l.located);
  return out
    .filter((l, i) => !l.frame || (i >= first && i <= last))
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

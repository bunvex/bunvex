// A code version across the wire: the child describes what `CodeVersion.load` made of a push (`describeVersion`),
// and the host turns the description back into the analysis it would have had in-process (`loadedVersion`).
import type { AnalyzedModule, AnyRoomDef, CodeVersion } from "@bunvex/server/executor";
import { NODE_FUNCTIONS } from "@bunvex/server/executor";
import { fromJsonValue, type JSONValue, toJsonValue, type Value } from "@bunvex/values";
import type { WireFunction, WireRoom, WireVersion } from "./protocol.ts";

/** A function of a version loaded in a child: what the host's stand-in for it needs (STUDY-168 PR 3). */
export type RemoteFunction = WireFunction;

/** A code version loaded in a child, as the host sees it. */
export type LoadedVersion = {
  /** `CodeVersion.analysis`: what the push reports and stores, by module path. */
  analysis: Record<string, AnalyzedModule>;
  /** `CodeVersion.moduleHashes`. */
  moduleHashes: Map<string, string>;
  /** `CodeVersion.moduleLoads`. */
  moduleLoads: Map<string, string[]>;
  /** `CodeVersion.functions`, by registry key (`dir/file:name`). */
  functions: Map<string, RemoteFunction>;
  /** `CodeVersion.rooms`: each definition's validators and gates, by registry key. */
  rooms: Map<string, WireRoom>;
};

/** The child's side: a loaded version, described. */
export function describeVersion(version: CodeVersion): WireVersion {
  return {
    analysis: Object.entries(version.analysis).map(([path, a]) => [
      path,
      {
        ...a,
        cronSpecs:
          a.cronSpecs === null
            ? null
            : Object.entries(a.cronSpecs).map(([id, s]) => [
                id,
                { udfPath: s.udfPath, udfArgs: s.udfArgs.map(toJsonValue), cronSchedule: s.cronSchedule },
              ]),
      },
    ]),
    moduleHashes: [...version.moduleHashes],
    moduleLoads: [...version.moduleLoads],
    functions: [...version.functions].map(([key, f]) => [
      key,
      {
        kind: f.kind,
        visibility: f.visibility,
        node: NODE_FUNCTIONS.has(f),
        args: f.args ? JSON.stringify(f.args.json) : null,
        returns: f.returns ? JSON.stringify(f.returns.json) : null,
      },
    ]),
    rooms: [...version.rooms].map(([key, r]) => [key, describeRoom(r)]),
  };
}

/** A room or presence definition, for the host's stand-in. */
export function describeRoom(r: AnyRoomDef): WireRoom {
  const json = (v: { json: unknown } | undefined) => (v ? JSON.stringify(v.json) : null);
  return r.kind === "room"
    ? {
        kind: "room",
        args: json(r.args),
        value: json(r.presence)!,
        events: Object.entries(r.events).map(([name, v]) => [name, json(v)!]),
        canJoin: r.canJoin !== undefined,
        canPublish: r.canPublish !== undefined,
      }
    : {
        kind: "presence",
        args: json(r.args),
        value: json(r.state)!,
        events: [],
        canJoin: r.canJoin !== undefined,
        canPublish: false,
      };
}

/** The host's side: a checked description (`parseChildMessage`), as the in-process analysis. */
export function loadedVersion(wire: WireVersion): LoadedVersion {
  // `fromEntries`: a path such as `__proto__` is a key like any other.
  const analysis: Record<string, AnalyzedModule> = Object.fromEntries(
    wire.analysis.map(([path, a]) => [
      path,
      {
        ...a,
        cronSpecs:
          a.cronSpecs === null
            ? null
            : Object.fromEntries(
                a.cronSpecs.map(([id, s]) => [
                  id,
                  {
                    udfPath: s.udfPath,
                    udfArgs: s.udfArgs.map((x) => fromJsonValue(x as JSONValue) as Value),
                    cronSchedule: s.cronSchedule as NonNullable<AnalyzedModule["cronSpecs"]>[string]["cronSchedule"],
                  },
                ]),
              ),
      },
    ]),
  );
  return {
    analysis,
    moduleHashes: new Map(wire.moduleHashes),
    moduleLoads: new Map(wire.moduleLoads),
    functions: new Map(wire.functions),
    rooms: new Map(wire.rooms),
  };
}

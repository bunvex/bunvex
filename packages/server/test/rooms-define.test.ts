// room() and presence() (AD-42, STUDY-164 §3.3): definitions, found at push beside the functions.
import { describe, expect, test } from "bun:test";
import type { FunctionReference } from "@bunvex/protocol";
import { v } from "@bunvex/values";
import type { ApiFromModules, FilterApi, RoomReference } from "../src/api-types.ts";
import { CodeVersion } from "../src/code-version.ts";
import { isFunctionDef } from "../src/functions.ts";
import { isRoomDef, presence, query, room } from "../src/index.ts";

const load = (sources: Record<string, string>) =>
  CodeVersion.load(
    Object.entries(sources).map(([path, source]) => ({ path, source, environment: "isolate" as const })),
    { seed: Uint32Array.of(1, 2, 3, 4), timestamp: 1_700_000_000_000 },
  );

describe("room() and presence()", () => {
  test("room() keeps its gates and validators, and is not a function", () => {
    const canJoin = () => true;
    const r = room({
      args: { docId: v.string() },
      canJoin,
      presence: v.object({ x: v.number() }),
      events: { wave: v.object({}) },
    });
    expect(isRoomDef(r)).toBe(true);
    expect(isFunctionDef(r)).toBe(false);
    expect(r.kind).toBe("room");
    expect(r.canJoin).toBe(canJoin);
    expect(Object.keys(r.events)).toEqual(["wave"]);
  });
  test("an object of fields is an object validator, as a function's args", () => {
    const r = presence({ args: { channel: v.string() }, state: { name: v.string() } });
    expect(r.state.json).toEqual(v.object({ name: v.string() }).json);
  });
  test("a definition without its validator is refused when it is defined", () => {
    expect(() => room({} as never)).toThrow("room(): `presence` is required");
    expect(() => presence({} as never)).toThrow("presence(): `state` is required");
  });
  test("a query is not a room", () => {
    expect(isRoomDef(query(async () => null))).toBe(false);
  });
  test("push finds a module's rooms, beside its functions", async () => {
    const version = await load({
      "rooms.js": `import { room, presence, query } from "@bunvex/server"; import { v } from "@bunvex/values";
      export const doc = room({ args: { id: v.string() }, presence: v.any() });
      export const online = presence({ state: v.any() });
      export const list = query(async () => null);`,
    });
    expect([...version.rooms.keys()].sort()).toEqual(["rooms:doc", "rooms:online"]);
    expect(version.functions.has("rooms:list")).toBe(true);
    expect(version.analysis["rooms.js"]?.rooms).toEqual([
      { name: "doc", kind: "room" },
      { name: "online", kind: "presence" },
    ]);
  });
});

// The api's type keeps a module's rooms, beside its functions (checked by `bun run typecheck`).
const doc = room({ args: { id: v.string() }, presence: { x: v.number() }, events: { wave: { from: v.string() } } });
const online = presence({ state: { name: v.string() } });
type Api = ApiFromModules<{ rooms: { doc: typeof doc; online: typeof online } }>;
type Equal<A, B> = (<T>() => T extends A ? 1 : 2) extends <T>() => T extends B ? 1 : 2 ? true : false;
const typed: [
  Equal<Api["rooms"]["doc"], RoomReference<"room", { id: string }, { x: number }, { wave: { from: string } }>>,
  Equal<Api["rooms"]["online"], RoomReference<"presence", Record<string, never>, { name: string }>>,
] = [true, true];
void typed;
// biome-ignore lint/suspicious/noExplicitAny: any reference
type Anything = any;
type Public = FilterApi<Api, FunctionReference<Anything, "public">>;
type Internal = FilterApi<Api, FunctionReference<Anything, "internal">>;
const filtered: [Equal<keyof Public["rooms"], "doc" | "online">, Equal<keyof Internal, never>] = [true, true];
void filtered;

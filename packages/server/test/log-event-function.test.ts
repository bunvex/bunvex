// The `function` object of log stream events, as Convex's `FunctionEventSource`: `path` is the stripped path
// (`identifier_str`: `m:f`, a default export `m`), an HTTP action's route; `cached` is a query's cache hit, false on
// an action's streamed line (`log_action_progress`), else null. Against Convex's binary in
// packages/differential/test/log-event-function.test.ts.
import { afterEach, expect, test } from "bun:test";
import { defineSchema, Engine } from "@bunvex/core";
import { MemoryPersistence } from "@bunvex/core/persistence/memory";
import { action, Functions, mutation, query } from "../src/functions.ts";
import { eventJsonV2, type LogEvent } from "../src/log-events.ts";
import { createServer } from "../src/server.ts";

const stops: (() => unknown)[] = [];
afterEach(async () => {
  for (const s of stops.splice(0).reverse()) await s();
});

test("stripped paths; cached false on an action's streamed line, a query's hit, null otherwise", async () => {
  const engine = await new Engine(defineSchema({}), await MemoryPersistence.open(null, { durable: false })).init();
  const functions = new Functions(engine)
    .register("m", {
      q: query(() => console.log("q")),
      w: mutation(() => console.log("w")),
      a: action(async () => console.log("a")),
    })
    .register("d", { default: query(() => console.log("d")) });
  const s = createServer({ engine, functions, port: 0 });
  stops.push(() => s.stop());
  const events: Record<string, any>[] = [];
  functions.logManager = { active: true, send: (e: LogEvent[]) => events.push(...e.map(eventJsonV2)) } as never;
  const call = (kind: string, path: string) =>
    fetch(`http://127.0.0.1:${s.server.port}/api/${kind}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ path, args: {} }),
    }).then((r) => r.json());
  await call("query", "m:q");
  await call("mutation", "m:w");
  await call("action", "m:a");
  await call("query", "d");
  const seen = events
    .filter((e) => e.topic === "console" || e.topic === "function_execution")
    .map((e) => [e.topic, e.function.path, e.function.cached]);
  expect(seen).toEqual([
    ["console", "m:q", false],
    ["function_execution", "m:q", false],
    ["console", "m:w", null],
    ["function_execution", "m:w", null],
    ["console", "m:a", false],
    ["function_execution", "m:a", null],
    ["console", "d", false],
    ["function_execution", "d", false],
  ]);
});

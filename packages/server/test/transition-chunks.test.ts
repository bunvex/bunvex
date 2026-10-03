// Transitions over 5 MB as `TransitionChunk`s (DV-10), as Convex's `maybe_split_transition`: only for npm
// clients from 1.28.0 (the client header, else the version in the sync URL), cut on UTF-8 boundaries,
// numbered from 0, the JSON's byte length as their id; smaller transitions and older clients get them whole.
import { afterEach, expect, test } from "bun:test";
import { defineSchema, Engine } from "@bunvex/core";
import { MemoryPersistence } from "@bunvex/core/persistence/memory";
import type { v1 } from "@bunvex/protocol";
import { Functions, query } from "../src/functions.ts";
import { createServer } from "../src/server.ts";
import { MAX_TRANSITION_MESSAGE_BYTES, supportsTransitionChunks, transitionFrames } from "../src/sync.ts";
import { add, v1Client } from "./v1-client.ts";

const stops: (() => unknown)[] = [];
afterEach(async () => {
  for (const s of stops.splice(0).reverse()) await s();
});

test("which clients take chunks: npm from 1.28.0, by the header, else the URL", () => {
  expect(supportsTransitionChunks(null, "/api/1.28.0/sync")).toBe(true);
  expect(supportsTransitionChunks(null, "/api/1.46.0/sync")).toBe(true);
  expect(supportsTransitionChunks(null, "/api/1.27.9/sync")).toBe(false);
  expect(supportsTransitionChunks(null, "/api/1.28.0-alpha.1/sync")).toBe(false);
  expect(supportsTransitionChunks(null, "/api/0.0.0/sync")).toBe(false);
  expect(supportsTransitionChunks(null, "/api/latest/sync")).toBe(false);
  expect(supportsTransitionChunks("npm-1.30.0", "/api/0.0.0/sync")).toBe(true);
  expect(supportsTransitionChunks("python-1.30.0", "/api/1.46.0/sync")).toBe(false);
});

test("the chunks: at most 5 MB each, on character boundaries, numbered, joined back to the transition", () => {
  // Three-byte characters, so a byte cut would land inside one.
  const json = JSON.stringify({ type: "Transition", value: "€".repeat(4_000_000) });
  const bytes = Buffer.byteLength(json);
  const frames = transitionFrames(json, true).map((f) => JSON.parse(f) as Record<string, unknown>);
  expect(frames.length).toBe(Math.ceil(bytes / MAX_TRANSITION_MESSAGE_BYTES));
  for (const [i, f] of frames.entries()) {
    expect(f).toMatchObject({
      type: "TransitionChunk",
      partNumber: i,
      totalParts: frames.length,
      transitionId: String(bytes),
    });
    expect(Buffer.byteLength(f.chunk as string)).toBeLessThanOrEqual(MAX_TRANSITION_MESSAGE_BYTES);
    expect((f.chunk as string).includes("�")).toBe(false);
  }
  expect(frames.map((f) => f.chunk).join("")).toBe(json);
  // Small, or a client without chunks: whole.
  expect(transitionFrames('{"type":"Transition"}', true)).toEqual(['{"type":"Transition"}']);
  expect(transitionFrames(json, false)).toEqual([json]);
});

async function serve() {
  const engine = await new Engine(defineSchema({}), await MemoryPersistence.open(null, { durable: false })).init();
  const functions = new Functions(engine).register("m", {
    big: query(async () => "x".repeat(6_000_000)),
  });
  const { server, stop } = createServer({ engine, functions, port: 0 });
  stops.push(stop);
  return server.port;
}

test("end to end: a big result reaches a 1.28 client in chunks, an older one whole", async () => {
  const port = await serve();
  const modern = await v1Client(`ws://127.0.0.1:${port}/api/1.46.0/sync`);
  stops.push(() => modern.ws.close());
  modern.modify([add(0, "m:big")]);
  const chunks = await modern.until(() => {
    const c = modern.got.filter((m) => m.type === "TransitionChunk") as v1.TransitionChunk[];
    return c.length > 0 && c.length === c[0]!.totalParts ? c : undefined;
  });
  expect(chunks.length).toBe(2);
  const joined = JSON.parse(chunks.map((c) => c.chunk).join("")) as {
    type: string;
    modifications: { value: string }[];
  };
  expect(joined.type).toBe("Transition");
  expect(joined.modifications[0]!.value.length).toBe(6_000_000);
  const old = await v1Client(`ws://127.0.0.1:${port}/api/1.27.0/sync`);
  stops.push(() => old.ws.close());
  old.modify([add(0, "m:big")]);
  await old.transition(0);
  expect(old.got.some((m) => m.type === "TransitionChunk")).toBe(false);
});

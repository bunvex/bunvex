// The rooms-cursors example end to end: two clients in a room see each other's cursor and a wave.
import { afterAll, beforeAll, expect, test } from "bun:test";
import { resolve } from "node:path";
import { build, type Deployment, deploy, until } from "bunvex-examples-harness";
import { api } from "../bunvex/_generated/api.js";

const DIR = resolve(import.meta.dir, "..");
let d: Deployment;
beforeAll(async () => {
  d = await deploy(DIR);
});
afterAll(() => d?.stop());

test("a cursor and a wave reach the other member, not the sender", async () => {
  const a = d.client().client.joinRoom(api.rooms.board, { board: "t" });
  const b = d.client().client.joinRoom(api.rooms.board, { board: "t" });
  const waves: string[] = [];
  const own: string[] = [];
  b.on("wave", (_from, data) => waves.push(data.name));
  a.on("wave", (_from, data) => own.push(data.name));
  await until(() => a.status === "joined" && b.status === "joined" && a.others().length === 1, "both in the room");
  a.setPresence({ x: 10, y: 20, name: "a" });
  const seen = await until(() => b.others()[0]?.presence, "a's cursor");
  expect(seen).toEqual({ x: 10, y: 20, name: "a" });
  a.broadcast("wave", { name: "a" });
  await until(() => waves.length === 1, "the wave");
  expect(waves).toEqual(["a"]);
  expect(own).toEqual([]);
});

test("a presence scope is for signed-in users: an anonymous connection is refused", async () => {
  const p = d.client().client.joinPresence(api.rooms.online, { board: "t" });
  await until(() => p.status === "error", "the refusal");
  expect(p.error?.message).toContain("signed-in");
});

test("a room's arguments are checked", async () => {
  const bad = d.client().client.joinRoom(api.rooms.board, { board: 1 } as never);
  await until(() => bad.status === "error", "the refusal");
});

test("the front end typechecks and builds", async () => {
  await build(DIR);
});

// The system tables example end to end (STUDY-90): an upload's metadata read from `_storage`, and scheduled
// sends followed through `_scheduled_functions` (pending, canceled, success), with `db.system`.
import { afterAll, beforeAll, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { resolve } from "node:path";
import { build, type Deployment, deploy, until } from "bunvex-examples-harness";
import { api } from "../bunvex/_generated/api.js";

const DIR = resolve(import.meta.dir, "..");
let d: Deployment;
beforeAll(async () => {
  d = await deploy(DIR);
});
afterAll(() => d?.stop());

test("an upload: its metadata from _storage, joined with who uploaded it, and its URL", async () => {
  const bytes = new Uint8Array([137, 80, 78, 71, 1, 2, 3]);
  const url = await d.http.mutation(api.messages.generateUploadUrl, {});
  const response = await fetch(url, { method: "POST", headers: { "Content-Type": "image/png" }, body: bytes });
  const { storageId } = (await response.json()) as { storageId: string };
  await d.http.mutation(api.messages.sendImage, { file: storageId as never, author: "Ada" });
  const [file] = await d.http.query(api.admin.files, {});
  expect(file).toEqual({
    _id: storageId,
    _creationTime: expect.any(Number),
    contentType: "image/png",
    sha256: createHash("sha256").update(bytes).digest("base64"),
    size: bytes.length,
    author: "Ada",
  });
  const [message] = await d.http.query(api.messages.list, {});
  const served = await fetch((message as { url: string }).url);
  expect(new Uint8Array(await served.arrayBuffer())).toEqual(bytes);
});

test("a scheduled send is a pending job; canceled, it never sends", async () => {
  const job = await d.http.mutation(api.messages.sendLater, { delaySeconds: 60, body: "never", author: "Ada" });
  const pending = (await d.http.query(api.admin.scheduledSends, {})).find((j) => j._id === job);
  expect(pending).toMatchObject({ state: { kind: "pending" }, args: [{ body: "never", author: "Ada" }] });
  expect(pending!.name).toMatch(/messages(\.js)?:send$/);
  await d.http.mutation(api.admin.cancelSend, { job });
  const canceled = (await d.http.query(api.admin.scheduledSends, {})).find((j) => j._id === job);
  expect(canceled?.state).toEqual({ kind: "canceled" });
  expect((await d.http.query(api.messages.list, {})).some((m) => m.body === "never")).toBe(false);
});

test("a scheduled send runs: the message arrives live, and its job ends in success", async () => {
  const bodies: string[][] = [];
  d.client().onUpdate(api.messages.list, {}, (ms) => bodies.push(ms.map((m) => m.body)));
  await until(() => bodies.length > 0, "the first result");
  const job = await d.http.mutation(api.messages.sendLater, { delaySeconds: 0.05, body: "later", author: "Ada" });
  await until(() => bodies.at(-1)?.includes("later"), "the scheduled message");
  // The job's state, live as well: `_scheduled_functions` is a table a query can subscribe to.
  const states: string[] = [];
  d.client().onUpdate(api.admin.scheduledSends, {}, (jobs) =>
    states.push(jobs.find((j) => j._id === job)?.state.kind ?? "none"),
  );
  await until(() => states.at(-1) === "success", "the job's success");
});

test("the front end typechecks and builds", async () => {
  await build(DIR);
});

// The file-storage example end to end (STUDY-90): upload a file to a generated URL, save its id in a message,
// and read it back from the URL the list gives.
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

test("an uploaded image shows up live, with a URL serving the same bytes", async () => {
  let latest: { author: string; format: string; body: string; url?: string | null }[] | undefined;
  d.client().onUpdate(api.messages.list, {}, (r) => {
    latest = r;
  });
  await until(() => latest, "the first result");
  await d.http.mutation(api.messages.sendMessage, { body: "look at this", author: "Ada" });
  const bytes = new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10, 1, 2, 3, 255]);
  const uploadUrl = await d.http.mutation(api.messages.generateUploadUrl, {});
  const response = await fetch(uploadUrl, { method: "POST", headers: { "Content-Type": "image/png" }, body: bytes });
  expect(response.status).toBe(200);
  const { storageId } = (await response.json()) as { storageId: string };
  await d.http.mutation(api.messages.sendImage, { storageId: storageId as never, author: "Ada" });
  const both = await until(() => latest?.length === 2 && latest, "both messages");
  expect(both.map((m) => [m.format, m.author])).toEqual([
    ["text", "Ada"],
    ["image", "Ada"],
  ]);
  expect(both[0]!.url).toBeUndefined();
  const served = await fetch(both[1]!.url!);
  expect(served.status).toBe(200);
  expect(served.headers.get("content-type")).toBe("image/png");
  expect(new Uint8Array(await served.arrayBuffer())).toEqual(bytes);
});

test("sendImage takes a storage id only", async () => {
  await expect(
    d.http.mutation(api.messages.sendImage, { storageId: "not-an-id" as never, author: "Ada" }),
  ).rejects.toThrow();
});

test("the front end typechecks and builds", async () => {
  await build(DIR);
});

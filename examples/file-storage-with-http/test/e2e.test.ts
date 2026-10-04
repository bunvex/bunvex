// The file-storage-over-HTTP example end to end (STUDY-90): an image POSTed to an HTTP action is stored and
// posted, served back by another, and the browser's CORS preflight answers with the configured origin.
import { afterAll, beforeAll, expect, test } from "bun:test";
import { resolve } from "node:path";
import { build, type Deployment, deploy, until } from "bunvex-examples-harness";
import { api } from "../bunvex/_generated/api.js";

const DIR = resolve(import.meta.dir, "..");
const ORIGIN = "http://localhost:5173";
let d: Deployment;
beforeAll(async () => {
  d = await deploy(DIR, { env: { CLIENT_ORIGIN: ORIGIN } });
});
afterAll(() => d?.stop());

test("an image sent through the HTTP action shows up live and is served back", async () => {
  let latest: { author: string; body: string; format: string }[] | undefined;
  d.client().onUpdate(api.messages.list, {}, (r) => {
    latest = r;
  });
  await until(() => latest, "the first result");
  const bytes = new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10, 4, 5, 6, 255]);
  const r = await fetch(`${d.siteUrl}/sendImage?author=Ada`, {
    method: "POST",
    headers: { "Content-Type": "image/png", Origin: ORIGIN },
    body: bytes,
  });
  expect(r.status).toBe(200);
  expect(r.headers.get("access-control-allow-origin")).toBe(ORIGIN);
  expect(r.headers.get("vary")).toContain("origin");
  const [message] = await until(() => latest?.length === 1 && latest, "the image message");
  expect([message!.author, message!.format]).toEqual(["Ada", "image"]);
  const served = await fetch(`${d.siteUrl}/getImage?storageId=${message!.body}`);
  expect(served.status).toBe(200);
  expect(served.headers.get("content-type")).toBe("image/png");
  expect(new Uint8Array(await served.arrayBuffer())).toEqual(bytes);
});

test("the CORS preflight answers with the configured origin; a plain OPTIONS gets no CORS headers", async () => {
  const preflight = await fetch(`${d.siteUrl}/sendImage`, {
    method: "OPTIONS",
    headers: {
      Origin: ORIGIN,
      "Access-Control-Request-Method": "POST",
      "Access-Control-Request-Headers": "Content-Type",
    },
  });
  expect(preflight.status).toBe(200);
  expect(preflight.headers.get("access-control-allow-origin")).toBe(ORIGIN);
  expect(preflight.headers.get("access-control-allow-methods")).toBe("POST");
  expect(preflight.headers.get("access-control-allow-headers")).toBe("Content-Type, Digest");
  const plain = await fetch(`${d.siteUrl}/sendImage`, { method: "OPTIONS" });
  expect(plain.headers.get("access-control-allow-origin")).toBeNull();
});

test("sendImage without an author is a 400, and stores nothing", async () => {
  const before = (await d.http.query(api.messages.list, {})).length;
  const r = await fetch(`${d.siteUrl}/sendImage`, { method: "POST", body: new Uint8Array([1]) });
  expect(r.status).toBe(400);
  expect(await r.text()).toBe("The author query parameter is required");
  expect(await d.http.query(api.messages.list, {})).toHaveLength(before);
});

test("the front end typechecks and builds", async () => {
  await build(DIR);
});

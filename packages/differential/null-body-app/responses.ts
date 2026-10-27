// The app of test/null-body-status.test.ts: a Response built with each status and body, what it gives.
import { actionGeneric, queryGeneric } from "convex/server";

const BODIES: Record<string, () => unknown> = {
  string: () => "x",
  empty: () => "",
  number: () => 0,
  bytes: () => new Uint8Array(1),
  buffer: () => new ArrayBuffer(0),
  blob: () => new Blob(["x"]),
  search: () => new URLSearchParams("a=1"),
  form: () => new FormData(),
  stream: () => new ReadableStream(),
  null: () => null,
  undefined: () => undefined,
};

function outcomes() {
  const out: Record<string, string> = {};
  for (const status of [200, 204, 205, 206, 304])
    for (const [kind, body] of Object.entries(BODIES)) {
      try {
        out[`${status} ${kind}`] = `ok ${new Response(body() as BodyInit, { status }).status}`;
      } catch (e) {
        out[`${status} ${kind}`] = `${(e as Error).name}: ${(e as Error).message}`;
      }
    }
  try {
    out.json = `ok ${Response.json({ a: 1 }, { status: 204 }).status}`;
  } catch (e) {
    out.json = `${(e as Error).name}: ${(e as Error).message}`;
  }
  // A status out of range fails before the body is looked at.
  try {
    out.range = `ok ${new Response("x", { status: 100 }).status}`;
  } catch (e) {
    out.range = (e as Error).name;
  }
  return out;
}

export const q = queryGeneric(async () => outcomes());
export const a = actionGeneric(async () => outcomes());

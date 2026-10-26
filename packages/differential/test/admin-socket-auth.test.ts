// An admin's `Authenticate` on the sync socket (STUDY-188 R5), on Convex's backend (the oracle) and on bunvex's: a
// refused key (`AuthError`, an update attempted) and acting identities that are not one (a `FatalError` "Received
// Invalid JSON on websocket: …", read before the key). The frames each side sends after `Connect` are compared.
// Local only: skipped, with a note, when Convex's backend is not there (scripts/download-convex-backend.sh, or
// CONVEX_BACKEND_BIN).
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { type Backend, ORACLE_BIN, startAll, startBunvex, startConvex } from "../harness/backends.ts";

const ready = existsSync(ORACLE_BIN);
if (!ready) console.warn(`admin-socket-auth: skipped, no Convex backend at ${ORACLE_BIN} (set CONVEX_BACKEND_BIN)`);

let convex: Backend;
let bunvex: Backend;

/** The frames (pings left out) a backend sends for `Connect`, then an admin `Authenticate`, within a second. */
async function frames(b: Backend, key: string, impersonating: string | null): Promise<unknown[]> {
  const ws = new WebSocket(`${b.url.replace(/^http/, "ws")}/api/1.46.0/sync`);
  const got: unknown[] = [];
  ws.onmessage = (m) => got.push(JSON.parse(String(m.data)));
  const closed = new Promise((r) => (ws.onclose = r));
  await new Promise((r) => (ws.onopen = r));
  ws.send(
    JSON.stringify({
      type: "Connect",
      sessionId: crypto.randomUUID(),
      connectionCount: 0,
      lastCloseReason: null,
      clientTs: 0,
    }),
  );
  const acting = impersonating === null ? "" : `,"impersonating":${impersonating}`;
  ws.send(`{"type":"Authenticate","tokenType":"Admin","value":${JSON.stringify(key)},"baseVersion":0${acting}}`);
  await Promise.race([closed, Bun.sleep(1000)]);
  ws.close();
  return got
    .filter((m) => (m as { type: string }).type !== "Ping")
    .map((m) => {
      // A transition's timestamps and clock skew are each backend's own.
      const t = m as { type: string; endVersion?: { identity: number } };
      return t.type === "Transition" ? { type: "Transition", identity: t.endVersion?.identity } : m;
    });
}

const CASES: [label: string, goodKey: boolean, impersonating: string | null][] = [
  ["a wrong key", false, null],
  ["a wrong key, a good identity", false, '{"issuer":"i","subject":"s"}'],
  ["a good key, {}", true, "{}"],
  ["a good key, only a subject", true, '{"subject":"s"}'],
  ["a good key, a string", true, '"x"'],
  ["a good key, a number issuer", true, '{"issuer":1,"subject":"s"}'],
  ["a good key, an array", true, "[1]"],
  ["a good key, a boolean", true, "true"],
  ["a good key, a float", true, "1.5"],
  ["a good key, a string emailVerified", true, '{"issuer":"i","subject":"s","emailVerified":"yes"}'],
  ["a good key, a map name", true, '{"issuer":"i","subject":"s","name":{}}'],
  ["a good key, an escaped string", true, '"a\\"b\\n\\u0001\\u00a0\\u0301"'],
  ["a wrong key, {}", false, "{}"],
  ["a wrong key, a string", false, '"x"'],
  ["a good key, a null tokenIdentifier", true, '{"tokenIdentifier":null,"issuer":"i","subject":"s","x":1}'],
  ["a good key, null", true, "null"],
];

describe.skipIf(!ready)("an admin's Authenticate on the sync socket, on Convex and on bunvex", () => {
  beforeAll(async () => {
    [convex, bunvex] = await startAll([startConvex(), startBunvex()]);
  }, 240_000);
  afterAll(async () => {
    await convex?.stop();
    await bunvex?.stop();
  });

  for (const [label, goodKey, impersonating] of CASES)
    test(label, async () => {
      const [c, b] = await Promise.all(
        [convex, bunvex].map((x) => frames(x, goodKey ? x.adminKey : "bad", impersonating)),
      );
      expect(b).toEqual(c);
    });
});

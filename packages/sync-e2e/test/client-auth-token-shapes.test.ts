// What the client does with a token it cannot schedule a refresh for (STUDY-65 G-C1), as Convex's
// `react/ConvexAuthState.test.tsx` and `authentication_manager.ts` `scheduleTokenRefetch`: once the server confirms
// a fresh token, a token that is not a JWT, one without `iat` / `exp`, or one that lives 2 s or less is logged as
// an error and no refetch is scheduled; a leeway longer than the token's life refetches at once, with a warning.
// Differential: the official base client (the oracle) and BaseBunvexClient against a sync server the test scripts.
import { afterEach, describe, expect, test } from "bun:test";
import { BaseBunvexClient } from "@bunvex/client";
import { v1 } from "@bunvex/protocol";
import { BaseConvexClient } from "convex/browser";

type Fetcher = (args: { forceRefreshToken: boolean }) => Promise<string | null>;
type AnyBaseClient = { setAuth(f: Fetcher, onChange: (a: boolean) => void): void; close(): Promise<void> };
type Lines = { error: string[]; warn: string[] };
const logger = (lines: Lines) => ({
  logVerbose() {},
  log() {},
  warn: (...a: unknown[]) => lines.warn.push(a.join(" ")),
  error: (...a: unknown[]) => lines.error.push(a.join(" ")),
});
const clients: [string, (address: string, lines: Lines) => AnyBaseClient][] = [
  [
    "official client",
    (address, lines) =>
      new BaseConvexClient(address, () => {}, {
        unsavedChangesWarning: false,
        logger: logger(lines),
        authRefreshTokenLeewaySeconds: 10,
      }) as unknown as AnyBaseClient,
  ],
  [
    "BaseBunvexClient",
    (address, lines) =>
      new BaseBunvexClient(address, () => {}, {
        unsavedChangesWarning: false,
        logger: logger(lines),
        authRefreshTokenLeewaySeconds: 10,
      }) as unknown as AnyBaseClient,
  ],
];

/** A sync server that confirms every Authenticate it gets. */
function confirmingServer() {
  const conns: { ws: Bun.ServerWebSocket<unknown>; identity: number; ts: bigint }[] = [];
  const server = Bun.serve({
    port: 0,
    fetch(req, srv) {
      if (srv.upgrade(req)) return;
      return new Response("not a socket", { status: 400 });
    },
    websocket: {
      open(ws) {
        conns.push({ ws, identity: 0, ts: 0n });
      },
      message(ws, data) {
        const m = JSON.parse(String(data)) as { type: string };
        if (m.type !== "Authenticate") return;
        const c = conns.find((x) => x.ws === ws)!;
        const start = { querySet: 0, identity: c.identity, ts: c.ts };
        c.identity++;
        c.ts++;
        ws.send(
          v1.encodeServerMessage({
            type: "Transition",
            startVersion: start,
            endVersion: { querySet: 0, identity: c.identity, ts: c.ts },
            modifications: [],
          }),
        );
      },
    },
  });
  return { address: `http://127.0.0.1:${server.port}`, stop: () => server.stop(true) };
}

const b64 = (o: object) => Buffer.from(JSON.stringify(o)).toString("base64url");
const jwt = (claims: object, n: number) => `${b64({ alg: "HS256", typ: "JWT" })}.${b64(claims)}.${b64({ n })}`;
const now = () => Math.floor(Date.now() / 1000);

const cleanup: (() => unknown)[] = [];
afterEach(async () => {
  for (const f of cleanup.splice(0).reverse()) await f();
});

const cases: [string, (n: number) => string, Partial<Lines>, number][] = [
  [
    "a token that is not a JWT",
    (n) => `foo${n}`,
    { error: ["Auth token is not a valid JWT, cannot refetch the token"] },
    2,
  ],
  [
    "a JWT without iat and exp",
    (n) => jwt({ sub: "u" }, n),
    { error: ["Auth token does not have required fields, cannot refetch the token"] },
    2,
  ],
  [
    "a JWT that lives 2 seconds",
    (n) => jwt({ iat: now(), exp: now() + 2 }, n),
    { error: ["Auth token does not live long enough, cannot refetch the token"] },
    2,
  ],
  [
    "a JWT that lives less than the leeway",
    (n) => jwt({ iat: now(), exp: now() + 5 }, n),
    { warn: ["Refetching auth token immediately, configured leeway 10s is larger than the token's lifetime 5s"] },
    3,
  ],
];

for (const [name, make] of clients)
  describe(name, () => {
    for (const [what, token, expected, fetchesAtLeast] of cases)
      test(`${what} (G-C1)`, async () => {
        const server = confirmingServer();
        cleanup.push(server.stop);
        const lines: Lines = { error: [], warn: [] };
        const client = make(server.address, lines);
        cleanup.push(() => client.close());
        let n = 0;
        client.setAuth(
          async () => token(n++),
          () => {},
        );
        // The cached token, its confirmation, the fresh one, its confirmation; then the schedule (or not).
        for (let i = 0; i < 400 && n < fetchesAtLeast; i++) await Bun.sleep(5);
        await Bun.sleep(150);
        expect(lines.error).toEqual(expected.error ?? []);
        expect(lines.warn.slice(0, (expected.warn ?? []).length)).toEqual(expected.warn ?? []);
        if (fetchesAtLeast === 2) expect(n).toBe(2);
        else expect(n).toBeGreaterThanOrEqual(fetchesAtLeast);
      });
  });

// Rooms and presence scopes through the bunvex client, against a real server (AD-42, STUDY-164 §3.5-3.6).
import { afterEach, describe, expect, test } from "bun:test";
import { anyApi, BunvexClient } from "@bunvex/client";
import { startServer, until } from "./harness.ts";
import { startIssuer } from "./issuer.ts";

const api = anyApi;
const cleanup: (() => unknown)[] = [];
afterEach(async () => {
  for (const f of cleanup.splice(0).reverse()) await f();
});

type Presence = { x: number };
type Events = { wave: { from: string } };

async function setup(serverOptions: Parameters<typeof startServer>[0] = {}) {
  const h = await startServer(serverOptions);
  cleanup.push(h.stop);
  const warnings: unknown[][] = [];
  const logger = { logVerbose() {}, log() {}, error() {}, warn: (...a: unknown[]) => warnings.push(a) };
  /** Every socket the clients opened, to drop one the way a network does. */
  const sockets = new Map<BunvexClient, WebSocket[]>();
  const client = () => {
    const mine: WebSocket[] = [];
    class Tracked extends WebSocket {
      constructor(...a: ConstructorParameters<typeof WebSocket>) {
        super(...a);
        mine.push(this);
      }
    }
    const c = new BunvexClient(h.url, {
      logger,
      webSocketConstructor: Tracked as unknown as typeof WebSocket,
      webSocket: { defaultInitialBackoffMs: 20, maxBackoffMs: 100 },
    });
    sockets.set(c, mine);
    cleanup.push(() => c.close());
    return c;
  };
  return { h, client, warnings, sockets };
}

const doc = (id = "a") => [api.rooms.doc as never, { id }] as const;

/** Every value `others()` has had, as the handle's subscribers saw it. */
function watch<T>(handle: { subscribe(cb: () => void): () => void; others(): T[] }) {
  const seen: T[][] = [handle.others()];
  handle.subscribe(() => seen.push(handle.others()));
  return seen;
}

describe("joinRoom", () => {
  test("A and B join the same room: each sees the other, and A.setPresence reaches B", async () => {
    const { client } = await setup();
    const a = client().client.joinRoom<{ id: string }, Presence, Events>(...doc());
    const b = client().client.joinRoom<{ id: string }, Presence, Events>(...doc());
    await until(() => a.status === "joined" && b.status === "joined", "both joined");
    await until(() => a.others().length === 1 && b.others().length === 1, "each sees the other");
    expect(a.others()[0]!.memberId).toBe(b.self!);
    expect(b.others()[0]!.memberId).toBe(a.self!);
    expect(a.canPublish).toBe(true);
    a.setPresence({ x: 3 });
    expect(a.myPresence()).toEqual({ x: 3 });
    await until(() => b.others()[0]?.presence?.x === 3, "A's presence at B");
  });

  test("presence with a bigint and bytes round-trips", async () => {
    const { client } = await setup();
    const a = client().client.joinRoom<{ id: string }, { n: bigint; b: ArrayBuffer }, Events>(...doc());
    const b = client().client.joinRoom<{ id: string }, { n: bigint; b: ArrayBuffer }, Events>(...doc());
    await until(() => b.status === "joined", "joined");
    a.setPresence({ n: 5n, b: new Uint8Array([1, 2, 3]).buffer });
    const got = await until(() => b.others()[0]?.presence, "presence");
    expect(got?.n).toBe(5n);
    expect(new Uint8Array(got?.b as ArrayBuffer)).toEqual(new Uint8Array([1, 2, 3]));
  });

  test("B.on('wave') receives A.broadcast('wave'); A's own handler does not fire", async () => {
    const { client } = await setup();
    const a = client().client.joinRoom<{ id: string }, Presence, Events>(...doc());
    const b = client().client.joinRoom<{ id: string }, Presence, Events>(...doc());
    const atA: unknown[] = [];
    const atB: [string | null, unknown][] = [];
    a.on("wave", (_f, d) => atA.push(d));
    b.on("wave", (f, d) => atB.push([f, d]));
    await until(() => a.others().length === 1 && b.others().length === 1, "both in");
    a.broadcast("wave", { from: "a" });
    await until(() => atB.length === 1, "the event at B");
    expect(atB).toEqual([[a.self, { from: "a" }]]);
    await Bun.sleep(100);
    expect(atA).toEqual([]);
  });

  test("two joinRoom with the same args are one member; leaving one keeps A, leaving the second ends it", async () => {
    const { client } = await setup();
    const ca = client();
    const a1 = ca.client.joinRoom<{ id: string }, Presence, Events>(...doc());
    const a2 = ca.client.joinRoom<{ id: string }, Presence, Events>(...doc());
    const b = client().client.joinRoom<{ id: string }, Presence, Events>(...doc());
    await until(() => b.others().length === 1, "B sees A");
    await Bun.sleep(100);
    expect(b.others()).toHaveLength(1); // one member, not two
    a1.leave();
    await Bun.sleep(150);
    expect(b.others()).toHaveLength(1);
    a2.leave();
    await until(() => b.others().length === 0, "B sees A leave");
  });

  test("the server restarts: the client reconnects, rejoins, and B sees A with A's last presence", async () => {
    const { h, client } = await setup();
    const a = client().client.joinRoom<{ id: string }, Presence, Events>(...doc());
    const b = client().client.joinRoom<{ id: string }, Presence, Events>(...doc());
    await until(() => a.others().length === 1 && b.others().length === 1, "both in");
    a.setPresence({ x: 42 });
    await until(() => b.others()[0]?.presence?.x === 42, "presence at B");
    const before = a.self;
    h.restart();
    await until(() => a.status === "joining" || b.status === "joining" || a.self !== before, "the drop");
    await until(
      () =>
        a.status === "joined" && b.status === "joined" && a.others().length === 1 && b.others()[0]?.presence?.x === 42,
      "B sees A again with its presence",
    );
    expect(a.others()[0]?.memberId).toBe(b.self!);
  });

  test("a socket drop and reconnect within the grace: B sees no leave, and A keeps its member", async () => {
    const { client, sockets } = await setup();
    const ca = client();
    const a = ca.client.joinRoom<{ id: string }, Presence, Events>(...doc());
    const b = client().client.joinRoom<{ id: string }, Presence, Events>(...doc());
    await until(() => a.others().length === 1 && b.others().length === 1, "both in");
    a.setPresence({ x: 9 });
    await until(() => b.others()[0]?.presence?.x === 9, "presence at B");
    const seen = watch(b);
    const self = a.self;
    const opened = sockets.get(ca)!.length;
    sockets.get(ca)!.at(-1)!.close(); // the connection drops
    await until(() => sockets.get(ca)!.length > opened, "A reconnecting");
    await until(() => a.status === "joined", "A joined again");
    await Bun.sleep(150);
    expect(a.self).toBe(self);
    expect(seen.every((o) => o.length === 1)).toBe(true);
    expect(b.others()[0]?.presence).toEqual({ x: 9 });
  });

  test("a join the server refuses sets status 'error' with the code, and is not retried", async () => {
    const { client } = await setup();
    const c = client();
    const room = c.client.joinRoom(api.rooms.locked as never, {});
    await until(() => room.status === "error", "the error");
    expect(room.error?.code).toBe("no_access");
    await Bun.sleep(150);
    expect(room.status).toBe("error");
    expect(room.error?.code).toBe("no_access");
  });
});

describe("joinPresence", () => {
  test("two clients of the same user are one entry in B's others()", async () => {
    const issuer = await startIssuer({ cacheControl: "max-age=600" });
    cleanup.push(issuer.stop);
    const { client } = await setup({ auth: { providers: [{ domain: issuer.url, applicationID: "app" }] } });
    const signedIn = async (sub: string) => {
      const c = client();
      let ok = false;
      c.setAuth(
        async () => issuer.sign({ sub }),
        (a) => {
          ok = a;
        },
      );
      await until(() => ok, `${sub} signed in`);
      return c;
    };
    const [a1, a2, b] = [await signedIn("ada"), await signedIn("ada"), await signedIn("bob")];
    const pa1 = a1.client.joinPresence<{ team: string }, { status: string }>(api.rooms.online as never, { team: "t" });
    const pa2 = a2.client.joinPresence<{ team: string }, { status: string }>(api.rooms.online as never, { team: "t" });
    const pb = b.client.joinPresence<{ team: string }, { status: string }>(api.rooms.online as never, { team: "t" });
    pa1.setState({ status: "busy" });
    await until(() => pb.status === "joined" && pa1.status === "joined" && pa2.status === "joined", "joined");
    await until(() => pb.others().length === 1 && pb.others()[0]?.state?.status === "busy", "ada at B");
    await Bun.sleep(100);
    expect(pb.others()).toHaveLength(1);
    expect(pb.others()[0]!.userId).toContain("ada");
    expect(pb.count()).toBe(2); // ada and bob
    expect(pa1.others().map((o) => o.userId)).toEqual([expect.stringContaining("bob")]);
    expect(pa1.count()).toBe(2);
    pb.setIdle(true);
    pb.setState({ status: "away" });
    await until(() => pa1.others()[0]?.idle === true, "bob idle at ada");
  });
});

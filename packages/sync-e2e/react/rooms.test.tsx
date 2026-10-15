// `useRoom` and `usePresence` against a real bunvex server (AD-42, STUDY-164 §3.5): members seen across two
// clients, render scope of the sub-hooks, joins keyed by client and args, StrictMode, idle.
import { afterEach, describe, expect, spyOn, test } from "bun:test";
import { anyApi, type RoomReference } from "@bunvex/client";
import { BunvexProvider, BunvexReactClient, usePresence, useRoom } from "@bunvex/react";
import { act, render, screen, waitFor, within } from "@testing-library/react";
import { type ReactNode, StrictMode, useState } from "react";
import { startServer, until } from "../test/harness.ts";
import { startIssuer } from "../test/issuer.ts";

const api = anyApi;
const BunWebSocket = (globalThis as { BunWebSocket?: typeof WebSocket }).BunWebSocket!;
const BunFetch = (globalThis as { BunFetch?: typeof fetch }).BunFetch!;
const cleanup: (() => unknown)[] = [];
afterEach(async () => {
  for (const f of cleanup.splice(0).reverse()) await f();
});

type Pos = { x: number };
type Events = { wave: { from: string } };
const docRef = api.rooms.doc as unknown as RoomReference<"room", { id: string }, Pos, Events>;
const onlineRef = api.rooms.online as unknown as RoomReference<"presence", { team: string }, { status: string }>;

const newClient = (url: string) => {
  const client = new BunvexReactClient(url, {
    logger: false,
    webSocketConstructor: BunWebSocket,
    unsavedChangesWarning: false,
    webSocket: { defaultInitialBackoffMs: 20, maxBackoffMs: 100 },
  });
  cleanup.push(() => client.close());
  return client;
};

/** A server (a one second reconnect grace) and a way to make clients of it. */
async function setup(opts: Parameters<typeof startServer>[0] = {}) {
  const prior = process.env.ROOM_RECONNECT_GRACE_SECS;
  process.env.ROOM_RECONNECT_GRACE_SECS = "1";
  const h = await startServer(opts);
  if (prior === undefined) delete process.env.ROOM_RECONNECT_GRACE_SECS;
  else process.env.ROOM_RECONNECT_GRACE_SECS = prior;
  cleanup.push(h.stop);
  const client = () => newClient(h.url);
  const mount = (c: BunvexReactClient, ui: ReactNode) => render(<BunvexProvider client={c}>{ui}</BunvexProvider>);
  return { h, client, mount };
}

function Cursors({ id = "a", setter }: { id?: string; setter?: { current: ((p: Pos) => void) | null } }) {
  const room = useRoom(docRef, { id });
  const others = room.useOthers();
  const [, setMine] = room.useMyPresence();
  if (setter) setter.current = setMine;
  return (
    <ul data-testid="cursors">
      {others.map((o) => (
        <li key={o.memberId}>{`x:${o.presence?.x}`}</li>
      ))}
    </ul>
  );
}

describe("useRoom", () => {
  test("two trees (two clients): A's useMyPresence setter reaches B's useOthers", async () => {
    const { client, mount } = await setup();
    const set = { current: null as ((p: Pos) => void) | null };
    mount(client(), <Cursors setter={set} />);
    const b = mount(client(), <Cursors />);
    await waitFor(() => expect(b.getAllByRole("listitem")).toHaveLength(1)); // B sees A joined
    expect(b.getByText("x:undefined")).toBeTruthy(); // joined, no presence yet
    act(() => set.current!({ x: 3 }));
    await b.findByText("x:3");
  });

  test("useMyPresence returns this member's own presence", async () => {
    const { client, mount } = await setup();
    let seen = null as Pos | null;
    let setMine!: (p: Pos) => void;
    function Me() {
      const room = useRoom(docRef, { id: "a" });
      const [mine, set] = room.useMyPresence();
      seen = mine;
      setMine = set;
      return null;
    }
    mount(client(), <Me />);
    expect(seen).toBeNull();
    act(() => setMine({ x: 9 }));
    expect(seen).toEqual({ x: 9 });
  });

  test("status goes joining then joined; a refused room is an error with its code", async () => {
    const { client, mount } = await setup();
    function Status({ locked }: { locked?: boolean }) {
      const room = useRoom(
        (locked ? api.rooms.locked : docRef) as unknown as typeof docRef,
        locked ? ({} as never) : { id: "a" },
      );
      return (
        <p>
          {room.status}:{room.error?.code ?? "-"}
        </p>
      );
    }
    mount(client(), <Status />);
    expect(screen.getByText("joining:-")).toBeTruthy();
    await screen.findByText("joined:-");
    const locked = mount(client(), <Status locked />);
    await locked.findByText(/^error:\w+/);
  });

  test("a component that only uses useEvent does not re-render when presence changes, and gets the events", async () => {
    const { client, mount } = await setup();
    let renders = 0;
    const got: unknown[] = [];
    let status = "";
    function Listener() {
      renders++;
      const room = useRoom(docRef, { id: "a" });
      status = room.status;
      room.useEvent("wave", (from, data) => got.push([from !== null, data]));
      return null;
    }
    mount(client(), <Listener />);
    await until(() => status === "joined", "joined");
    // The other tree: joins, sends many presences and an event.
    const set = { current: null as ((p: Pos) => void) | null };
    let wave!: (d: { from: string }) => void;
    function Sender() {
      const room = useRoom(docRef, { id: "a" });
      const [, setMine] = room.useMyPresence();
      set.current = setMine;
      wave = room.useBroadcast("wave");
      return null;
    }
    mount(client(), <Sender />);
    await Bun.sleep(150);
    const before = renders;
    for (let i = 0; i < 5; i++) {
      act(() => set.current!({ x: i }));
      await Bun.sleep(60);
    }
    act(() => wave({ from: "b" }));
    await until(() => got.length === 1, "the event");
    expect(got).toEqual([[true, { from: "b" }]]);
    expect(renders).toBe(before);
  });

  test("changing args leaves the old room and joins the new one; one frame never shows a's members under b", async () => {
    const { client, mount } = await setup();
    // Z holds one member in each room, with a distinct presence.
    const z = client();
    const za = z.sync.joinRoom(docRef, { id: "a" });
    const zb = z.sync.joinRoom(docRef, { id: "b" });
    za.setPresence({ x: 1 });
    zb.setPresence({ x: 2 });
    const renders: string[] = [];
    let setId!: (id: string) => void;
    function Switch() {
      const [id, set] = useState("a");
      setId = set;
      const room = useRoom(docRef, { id });
      const others = room.useOthers();
      renders.push(`${id}:${others.map((o) => o.presence?.x).join(",")}`);
      return <p>{`${id}=${others.map((o) => o.presence?.x).join(",")}`}</p>;
    }
    const a = client();
    mount(a, <Switch />);
    await screen.findByText("a=1");
    // A's member in room a is seen by Z.
    await until(() => za.others().length === 1, "Z sees A in a");
    act(() => setId("b"));
    await screen.findByText("b=2");
    expect(renders.filter((r) => r.startsWith("b:")).some((r) => r.includes("1"))).toBe(false);
    await until(() => za.others().length === 0, "A left a");
    await until(() => zb.others().length === 1, "A joined b");
  });

  test("switching the client shows nothing of the previous client's room", async () => {
    const s1 = await setup();
    const s2 = await setup();
    const z = s1.client().sync.joinRoom(docRef, { id: "a" });
    z.setPresence({ x: 1 });
    const c1 = s1.client();
    const c2 = s2.client();
    const renders: string[] = [];
    let swap!: () => void;
    function Inner() {
      const room = useRoom(docRef, { id: "a" });
      const others = room.useOthers();
      renders.push(others.map((o) => o.presence?.x).join(","));
      return <p>{`seen=${others.map((o) => o.presence?.x).join(",")}`}</p>;
    }
    function Outer() {
      const [second, setSecond] = useState(false);
      swap = () => setSecond(true);
      return (
        <BunvexProvider client={second ? c2 : c1}>
          <Inner />
        </BunvexProvider>
      );
    }
    render(<Outer />);
    await screen.findByText("seen=1");
    const upTo = renders.length;
    act(() => swap());
    await Bun.sleep(150);
    expect(renders.slice(upTo).some((r) => r.includes("1"))).toBe(false);
    expect(screen.getByText("seen=")).toBeTruthy();
  });

  test('"skip" joins nothing, and a later real args joins', async () => {
    const { client, mount } = await setup();
    const z = client().sync.joinRoom(docRef, { id: "a" });
    let setArgs!: (a: { id: string } | "skip") => void;
    let status = "";
    function Maybe() {
      const [args, set] = useState<{ id: string } | "skip">("skip");
      setArgs = set;
      const room = useRoom(docRef, args);
      status = room.status;
      return null;
    }
    mount(client(), <Maybe />);
    await until(() => z.status === "joined", "Z joined");
    await Bun.sleep(200);
    expect(z.others()).toHaveLength(0);
    expect(status).toBe("joining");
    act(() => setArgs({ id: "a" }));
    await until(() => z.others().length === 1, "joined for real");
    expect(status).toBe("joined");
    act(() => setArgs("skip"));
    await until(() => z.others().length === 0, "left again");
  });

  test("unmount leaves: the other tree sees the member leave", async () => {
    const { client, mount } = await setup();
    const a = mount(client(), <Cursors />);
    const b = mount(client(), <Cursors />);
    await waitFor(() => expect(b.queryAllByRole("listitem")).toHaveLength(1));
    a.unmount();
    await waitFor(() => expect(b.queryAllByRole("listitem")).toHaveLength(0), { timeout: 4000 });
  });

  test("two components with useRoom on the same room: one's setter updates the other's useMyPresence", async () => {
    const { client, mount } = await setup();
    let setFirst!: (p: Pos) => void;
    function First() {
      const room = useRoom(docRef, { id: "a" });
      setFirst = room.useMyPresence()[1];
      return null;
    }
    function Second() {
      const room = useRoom(docRef, { id: "a" });
      const [mine] = room.useMyPresence();
      return <p>{`second=${mine?.x ?? "-"} ${room.status}`}</p>;
    }
    mount(
      client(),
      <>
        <First />
        <Second />
      </>,
    );
    await screen.findByText("second=- joined");
    act(() => setFirst({ x: 4 }));
    await screen.findByText("second=4 joined");
  });

  test("the same args in another key order are the same room: no leave, no new join", async () => {
    let joins = 0;
    let leaves = 0;
    const handle = {
      status: "joining",
      error: null,
      others: () => [],
      myPresence: () => null,
      subscribe: () => () => {},
      on: () => () => {},
      leave: () => leaves++,
    };
    const fake = {
      addOnTransitionHandler() {},
      joinRoom: () => {
        joins++;
        return handle;
      },
    };
    const c = new BunvexReactClient("http://127.0.0.1:1", {
      logger: false,
      baseClient: fake as never,
    });
    function Keyed({ args }: { args: { a: number; b: number } }) {
      useRoom(docRef as never, args as never);
      return null;
    }
    const view = render(
      <BunvexProvider client={c}>
        <Keyed args={{ a: 1, b: 2 }} />
      </BunvexProvider>,
    );
    expect(joins).toBe(1);
    view.rerender(
      <BunvexProvider client={c}>
        <Keyed args={{ b: 2, a: 1 }} />
      </BunvexProvider>,
    );
    expect(joins).toBe(1);
    expect(leaves).toBe(0);
  });

  test("StrictMode (mount, unmount, mount) leaves exactly one member; unmounting ends it", async () => {
    const { client } = await setup();
    const z = client().sync.joinRoom(docRef, { id: "a" });
    const c = client();
    const view = render(
      <StrictMode>
        <BunvexProvider client={c}>
          <Cursors />
        </BunvexProvider>
      </StrictMode>,
    );
    await until(() => z.others().length === 1, "A in");
    await Bun.sleep(300);
    expect(z.others()).toHaveLength(1);
    view.unmount();
    await until(() => z.others().length === 0, "A out");
  });
});

async function authed() {
  const issuer = await startIssuer({ cacheControl: "max-age=600" });
  cleanup.push(issuer.stop);
  const env = await setup({ authFetch: BunFetch, auth: { providers: [{ domain: issuer.url, applicationID: "app" }] } });
  const signedIn = async (sub: string) => {
    const c = env.client();
    let ok = false;
    c.sync.setAuth(
      async () => issuer.sign({ sub }),
      (a) => {
        ok = a;
      },
    );
    await until(() => ok, `${sub} signed in`);
    return c;
  };
  return { ...env, signedIn };
}

describe("usePresence", () => {
  function Who({ idleMs, onState }: { idleMs?: number; onState?: (s: (v: { status: string }) => void) => void }) {
    const p = usePresence(onlineRef, { team: "t" }, idleMs === undefined ? undefined : { idleMs });
    onState?.(p.setMyState);
    return (
      <div>
        <p data-testid="count">count {p.count}</p>
        <p data-testid="me">me {p.me?.status ?? "-"}</p>
        <p data-testid="self-idle">{p.isIdle ? "self-idle" : "self-active"}</p>
        {p.others.map((o) => (
          <p key={o.userId}>{`${o.state?.status ?? "-"}:${o.idle ? "idle" : "active"}`}</p>
        ))}
      </div>
    );
  }

  test("others, count and me", async () => {
    const { signedIn } = await authed();
    const [ca, cb] = [await signedIn("ada"), await signedIn("bob")];
    let setA!: (v: { status: string }) => void;
    const a = render(
      <BunvexProvider client={ca}>
        <Who onState={(s) => (setA = s)} />
      </BunvexProvider>,
    );
    const b = render(
      <BunvexProvider client={cb}>
        <Who />
      </BunvexProvider>,
    );
    await b.findByText("count 2");
    act(() => setA({ status: "busy" }));
    expect(within(a.container).getByTestId("me").textContent).toBe("me busy");
    await b.findByText("busy:active");
  });

  test("idleMs 50 with no input for 60 ms: the other tree sees idle; a keydown makes it active again", async () => {
    const { signedIn } = await authed();
    const [ca, cb] = [await signedIn("ada"), await signedIn("bob")];
    let setA!: (v: { status: string }) => void;
    const a = render(
      <BunvexProvider client={ca}>
        <Who idleMs={50} onState={(s) => (setA = s)} />
      </BunvexProvider>,
    );
    // B records every idle flag it renders for the other user.
    const seen: boolean[] = [];
    function Watcher() {
      const p = usePresence(onlineRef, { team: "t" });
      const idle = p.others[0]?.state ? p.others[0].idle : undefined;
      if (idle !== undefined) seen.push(idle);
      return null;
    }
    render(
      <BunvexProvider client={cb}>
        <Watcher />
      </BunvexProvider>,
    );
    act(() => setA({ status: "here" }));
    await until(() => seen.includes(true), "idle at B");
    expect(within(a.container).getByTestId("self-idle").textContent).toBe("self-idle");
    const mark = seen.length;
    act(() => {
      window.dispatchEvent(new window.KeyboardEvent("keydown", { key: "a" }));
    });
    await until(() => seen.slice(mark).includes(false), "active again at B");
    await until(() => seen.slice(mark).includes(true), "idle once more after 50 ms");
  });

  test("without a window (React Native): no crash, idle never set, a single warning", async () => {
    const { signedIn } = await authed();
    const [ca, cb] = [await signedIn("ada"), await signedIn("bob")];
    const warn = spyOn(console, "warn").mockImplementation(() => {});
    // React needs a window to render; "no window" is one that cannot take listeners.
    const win = window as { addEventListener?: unknown };
    const realAdd = win.addEventListener;
    try {
      let setA!: (v: { status: string }) => void;
      win.addEventListener = undefined;
      const a = render(
        <BunvexProvider client={ca}>
          <Who idleMs={20} onState={(s) => (setA = s)} />
        </BunvexProvider>,
      );
      render(
        <BunvexProvider client={ca}>
          <Who idleMs={20} />
        </BunvexProvider>,
      );
      win.addEventListener = realAdd;
      const b = render(
        <BunvexProvider client={cb}>
          <Who />
        </BunvexProvider>,
      );
      act(() => setA({ status: "here" }));
      await b.findByText("here:active");
      await Bun.sleep(150);
      expect(b.getByText("here:active")).toBeTruthy();
      expect(within(a.container).getByTestId("self-idle").textContent).toBe("self-active");
      const idleWarnings = warn.mock.calls.filter((c) => String(c[0]).includes("idle detection needs a window"));
      expect(idleWarnings).toHaveLength(1);
    } finally {
      win.addEventListener = realAdd;
      warn.mockRestore();
    }
  });

  test("two components on the same scope: one's setMyState shows as `me` in both", async () => {
    const { signedIn } = await authed();
    const ca = await signedIn("ada");
    let set!: (v: { status: string }) => void;
    function Picker() {
      set = usePresence(onlineRef, { team: "t" }).setMyState;
      return null;
    }
    function Badge() {
      return <p>{`badge=${usePresence(onlineRef, { team: "t" }).me?.status ?? "-"}`}</p>;
    }
    render(
      <BunvexProvider client={ca}>
        <Picker />
        <Badge />
      </BunvexProvider>,
    );
    await screen.findByText("badge=-");
    act(() => set({ status: "busy" }));
    await screen.findByText("badge=busy");
  });

  test("a remount while another component keeps the membership still shows `me`", async () => {
    const { signedIn } = await authed();
    const ca = await signedIn("ada");
    let set!: (v: { status: string }) => void;
    function Keeper() {
      set = usePresence(onlineRef, { team: "t" }).setMyState;
      return null;
    }
    function Badge() {
      return <p>{`badge=${usePresence(onlineRef, { team: "t" }).me?.status ?? "-"}`}</p>;
    }
    function App({ badge }: { badge: boolean }) {
      return (
        <BunvexProvider client={ca}>
          <Keeper />
          {badge ? <Badge /> : null}
        </BunvexProvider>
      );
    }
    const view = render(<App badge />);
    await screen.findByText("badge=-");
    act(() => set({ status: "busy" }));
    await screen.findByText("badge=busy");
    view.rerender(<App badge={false} />);
    view.rerender(<App badge />);
    await screen.findByText("badge=busy");
  });

  test("changing idleMs while idle: the other tree sees the user active again, not stuck idle", async () => {
    const { signedIn } = await authed();
    const [ca, cb] = [await signedIn("ada"), await signedIn("bob")];
    let setA!: (v: { status: string }) => void;
    function A({ idleMs }: { idleMs: number }) {
      setA = usePresence(onlineRef, { team: "t" }, { idleMs }).setMyState;
      return null;
    }
    const seen: boolean[] = [];
    function Watcher() {
      const p = usePresence(onlineRef, { team: "t" });
      if (p.others[0]?.state) seen.push(p.others[0].idle);
      return null;
    }
    const view = render(
      <BunvexProvider client={ca}>
        <A idleMs={50} />
      </BunvexProvider>,
    );
    render(
      <BunvexProvider client={cb}>
        <Watcher />
      </BunvexProvider>,
    );
    act(() => setA({ status: "here" }));
    await until(() => seen.at(-1) === true, "idle at B");
    view.rerender(
      <BunvexProvider client={ca}>
        <A idleMs={60_000} />
      </BunvexProvider>,
    );
    await until(() => seen.at(-1) === false, "active again at B");
  });

  test('"skip" joins nothing', async () => {
    const { signedIn } = await authed();
    const ca = await signedIn("ada");
    const cb = await signedIn("bob");
    const z = cb.sync.joinPresence(onlineRef, { team: "t" });
    function Skipped() {
      const p = usePresence(onlineRef, "skip");
      return <p>{`${p.status}:${p.count}`}</p>;
    }
    render(
      <BunvexProvider client={ca}>
        <Skipped />
      </BunvexProvider>,
    );
    await until(() => z.status === "joined", "Z joined");
    await Bun.sleep(200);
    expect(z.count()).toBe(1);
    expect(screen.getByText("joining:0")).toBeTruthy();
  });
});

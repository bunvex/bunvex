// `setDefaultWebSocketConstructor` (STUDY-151 §5), as Convex's `simple_client.ts`: a client uses the default
// only when its options name no constructor and there is no global WebSocket.
import { afterEach, expect, test } from "bun:test";
import { BunvexClient, setDefaultWebSocketConstructor } from "../src/index.ts";

/** A socket that records its URL and never opens. */
const made: string[] = [];
const fakeSocket = (tag: string) =>
  class {
    onopen = null;
    onmessage = null;
    onclose = null;
    onerror = null;
    readyState = 0;
    constructor(readonly url: string) {
      made.push(tag);
    }
    send() {}
    close() {}
  } as unknown as typeof WebSocket;

const globalWebSocket = globalThis.WebSocket;
const clients: BunvexClient[] = [];
afterEach(async () => {
  // A socket that never opens: the client is left to close in the background.
  for (const c of clients.splice(0)) void c.close().catch(() => {});
  globalThis.WebSocket = globalWebSocket;
  made.length = 0;
});
const client = (options: ConstructorParameters<typeof BunvexClient>[1] = {}) => {
  const c = new BunvexClient("http://127.0.0.1:1", { logger: false, ...options });
  clients.push(c);
  return c;
};

test("without a global WebSocket and none in the options: the default", () => {
  setDefaultWebSocketConstructor(fakeSocket("default"));
  // @ts-expect-error: a runtime without WebSocket (older Node)
  delete globalThis.WebSocket;
  client();
  expect(made[0]).toBe("default");
});

test("the options' constructor wins over the default", () => {
  setDefaultWebSocketConstructor(fakeSocket("default"));
  // @ts-expect-error: a runtime without WebSocket (older Node)
  delete globalThis.WebSocket;
  client({ webSocketConstructor: fakeSocket("option") });
  expect(made[0]).toBe("option");
});

test("a global WebSocket wins over the default", () => {
  setDefaultWebSocketConstructor(fakeSocket("default"));
  globalThis.WebSocket = fakeSocket("global");
  client();
  expect(made[0]).toBe("global");
});

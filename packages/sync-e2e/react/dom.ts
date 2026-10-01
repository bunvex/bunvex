// The DOM for the React tests, preloaded (`bun test --preload`) in their own process, so happy-dom's globals
// never reach the other tests. Bun's own WebSocket, Response and fetch are kept aside first: the client must
// use Bun's WebSocket, and in-process servers (the token issuer, token verification) Bun's Response and fetch.
import { afterEach } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";

(globalThis as { BunWebSocket?: typeof WebSocket }).BunWebSocket = globalThis.WebSocket;
(globalThis as { BunResponse?: typeof Response }).BunResponse = globalThis.Response;
(globalThis as { BunFetch?: typeof fetch }).BunFetch = globalThis.fetch;
GlobalRegistrator.register({ url: "http://localhost/" });

const { cleanup } = await import("@testing-library/react");
afterEach(() => cleanup());

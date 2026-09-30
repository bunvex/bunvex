// The DOM for the React tests, preloaded (`bun test --preload`) in their own process, so happy-dom's globals
// never reach the other tests. Bun's own WebSocket is kept aside first: the client must use it, not
// happy-dom's.
import { afterEach } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";

(globalThis as { BunWebSocket?: typeof WebSocket }).BunWebSocket = globalThis.WebSocket;
GlobalRegistrator.register({ url: "http://localhost/" });

const { cleanup } = await import("@testing-library/react");
afterEach(() => cleanup());

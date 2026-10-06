// The test preload (test-loopback.ts): a test server is never given a port another listener holds on
// 127.0.0.1, so a test's request to 127.0.0.1 always reaches its own server.
import { expect, test } from "bun:test";

test("a server started without a hostname listens on 127.0.0.1", () => {
  const s = Bun.serve({ port: 0, fetch: () => new Response("mine") });
  try {
    expect(s.hostname).toBe("127.0.0.1");
  } finally {
    s.stop(true);
  }
});

test("it cannot take a port a stranger holds on 127.0.0.1 (a wildcard listener could, and be shadowed)", async () => {
  const stranger = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: () => new Response(null, { status: 400 }) });
  try {
    // What the macOS kernel does with port 0 now and then: a port another process holds on 127.0.0.1.
    expect(() => Bun.serve({ port: stranger.port, fetch: () => new Response("mine") })).toThrow();
    // An explicit hostname is kept.
    const wildcard = Bun.serve({ hostname: "0.0.0.0", port: 0, fetch: () => new Response("mine") });
    expect(wildcard.hostname).not.toBe("127.0.0.1");
    wildcard.stop(true);
  } finally {
    stranger.stop(true);
  }
});

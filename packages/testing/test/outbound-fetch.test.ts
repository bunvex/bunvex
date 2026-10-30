// `bunvexTest({ outboundFetch })` (AD-48): what answers the requests a test deployment's actions send with `fetch`,
// in place of the network. The action's own rules still apply around it: each request reaches the handler as it would
// go out (the app's headers, the default `User-Agent`, the body), a redirect is followed one request at a time, a
// thrown error is the action's `TypeError`, and a scheme an action may not reach never reaches the handler. Under the
// function sandbox too, where the request is made in the host.
import { afterEach, describe, expect, setDefaultTimeout, test } from "bun:test";
import { join } from "node:path";
import { anyApi } from "@bunvex/server";
import { bunvexTest, type TestBunvex } from "../src/index.ts";

setDefaultTimeout(30_000);

const APP = join(import.meta.dir, "fixtures", "outbound");
const api = anyApi;
const open: TestBunvex[] = [];
afterEach(async () => {
  for (const t of open.splice(0)) await t.close();
});

type Seen = { method: string; url: string; headers: Record<string, string>; body: string };
/** A deployment whose actions' requests are answered by `answer`, each request recorded. */
function deployment(answer: (r: Request) => Response | Promise<Response>) {
  const seen: Seen[] = [];
  const t = bunvexTest({
    cwd: APP,
    outboundFetch: async (r: Request) => {
      seen.push({
        method: r.method,
        url: r.url,
        headers: Object.fromEntries(r.headers),
        body: await r.clone().text(),
      });
      return answer(r);
    },
  });
  open.push(t);
  return { t, seen };
}

for (const sandbox of [undefined, "process"] as const) {
  describe(`outboundFetch${sandbox ? " under the function sandbox" : ""}`, () => {
    const withSandbox = async <T>(f: () => Promise<T>) => {
      const saved = [process.env.BUNVEX_FUNCTION_SANDBOX, process.env.BUNVEX_FUNCTION_SANDBOX_ISOLATION];
      if (sandbox) {
        process.env.BUNVEX_FUNCTION_SANDBOX = sandbox;
        process.env.BUNVEX_FUNCTION_SANDBOX_ISOLATION = "none";
      }
      try {
        return await f();
      } finally {
        for (const [k, v] of [
          ["BUNVEX_FUNCTION_SANDBOX", saved[0]],
          ["BUNVEX_FUNCTION_SANDBOX_ISOLATION", saved[1]],
        ] as const) {
          if (v === undefined) delete process.env[k];
          else process.env[k] = v;
        }
      }
    };

    test("answers the action's request as it goes out: method, URL, the app's headers, User-Agent, body", async () => {
      const { t, seen } = deployment(() => new Response("hello", { status: 201 }));
      const r = await withSandbox(() =>
        t.action(api.calls.call, { url: "https://api.example.com/v1/things?x=1", method: "POST", body: "payload" }),
      );
      expect(r).toEqual({
        status: 201,
        text: "hello",
        redirected: false,
        url: "https://api.example.com/v1/things?x=1",
      });
      expect(seen).toHaveLength(1);
      expect(seen[0]).toMatchObject({ method: "POST", url: "https://api.example.com/v1/things?x=1", body: "payload" });
      expect(seen[0]!.headers["x-app"]).toBe("outbound");
      expect(seen[0]!.headers["user-agent"]).toBe("Bunvex/1.0");
    });

    test("a redirect is followed one request at a time, each reaching the handler", async () => {
      const { t, seen } = deployment((r) =>
        r.url.endsWith("/old")
          ? new Response(null, { status: 302, headers: { location: "https://api.example.com/new" } })
          : new Response("moved here"),
      );
      const r = await withSandbox(() => t.action(api.calls.call, { url: "https://api.example.com/old" }));
      expect(r).toEqual({ status: 200, text: "moved here", redirected: true, url: "https://api.example.com/new" });
      expect(seen.map((s) => s.url)).toEqual(["https://api.example.com/old", "https://api.example.com/new"]);
    });

    test("a handler that throws is the action's failed fetch; another scheme never reaches the handler", async () => {
      const { t, seen } = deployment(() => {
        throw new Error("connection refused");
      });
      const failed = (await withSandbox(() => t.action(api.calls.call, { url: "https://down.example.com/" }))) as {
        error: string;
      };
      expect(failed.error).toStartWith("TypeError: ");
      const file = (await withSandbox(() => t.action(api.calls.call, { url: "file:///etc/hosts" }))) as {
        error: string;
      };
      expect(file.error).toStartWith("TypeError: ");
      expect(seen.map((s) => s.url)).toEqual(["https://down.example.com/"]);
    });
  });
}

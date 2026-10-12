// The sign-in's verifier, as Convex's `checkDeploymentInfo` (STUDY-149 §1.4): its request, its 3 tries 500 ms
// apart, the 404 rule and what a 2xx body gives; and the operations' mapping.
import { describe, expect, test } from "bun:test";
import { OPERATIONS } from "@bunvex/dashboard/data-source";
import {
  CHECK_RETRY_DELAY_MS,
  CHECK_TRIES,
  capabilitiesOf,
  createAdminKeyVerifier,
  INVALID_CREDENTIALS,
} from "../src/credentials.ts";

type Answer = Response | Error;

/** A `fetch` that answers from a script and records what it was asked. */
function scripted(answers: Answer[]) {
  const asked: { url: string; init: RequestInit | undefined; at: number }[] = [];
  const fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    asked.push({ url: String(input), init, at: performance.now() });
    const a = answers.shift() ?? new Response("", { status: 500 });
    if (a instanceof Error) throw a;
    return a;
  }) as typeof globalThis.fetch;
  return { fetch, asked };
}

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status });

describe("createAdminKeyVerifier", () => {
  test("asks check_admin_key with the key under bunvex's scheme and the dashboard's client header", async () => {
    const { fetch, asked } = scripted([json({ success: true, allowedOps: ["ViewData"], isReadOnly: true })]);
    const check = await createAdminKeyVerifier({ fetch }).verify("http://127.0.0.1:3210/", "local|abc");
    expect(check).toEqual({ ok: true, allowedOps: ["ViewData"], isReadOnly: true });
    expect(asked).toHaveLength(1);
    expect(asked[0]!.url).toBe("http://127.0.0.1:3210/api/check_admin_key");
    expect(asked[0]!.init?.method).toBe("GET");
    expect(asked[0]!.init?.headers).toEqual({
      "Content-Type": "application/json",
      Authorization: "Bunvex local|abc",
      "Bunvex-Client": "dashboard-0.0.0",
    });
  });

  test("Convex's defaults: 3 tries, 500 ms apart", () => {
    expect([CHECK_TRIES, CHECK_RETRY_DELAY_MS]).toEqual([3, 500]);
  });

  test("a refusal, a server error or a network error is tried again; the third failure refuses", async () => {
    const { fetch, asked } = scripted([new Response("", { status: 401 }), new TypeError("offline"), json({}, 503)]);
    const check = await createAdminKeyVerifier({ fetch, retryDelayMs: 20 }).verify("http://x", "k");
    expect(check).toEqual({ ok: false, error: INVALID_CREDENTIALS });
    expect(asked).toHaveLength(3);
    // each retry waits the delay
    expect(asked[1]!.at - asked[0]!.at).toBeGreaterThanOrEqual(15);
    expect(asked[2]!.at - asked[1]!.at).toBeGreaterThanOrEqual(15);
  });

  test("a success on the last try is a success", async () => {
    const { fetch, asked } = scripted([new TypeError("offline"), json({}, 500), json({ allowedOps: [] })]);
    expect(await createAdminKeyVerifier({ fetch, retryDelayMs: 1 }).verify("http://x", "k")).toEqual({
      ok: true,
      allowedOps: [],
      isReadOnly: false,
    });
    expect(asked).toHaveLength(3);
  });

  test("a 404 (no such route) allows every operation, at once", async () => {
    const { fetch, asked } = scripted([new Response("Not found", { status: 404 })]);
    expect(await createAdminKeyVerifier({ fetch }).verify("http://x", "k")).toEqual({
      ok: true,
      allowedOps: [],
      isReadOnly: false,
    });
    expect(asked).toHaveLength(1);
  });

  test("a 2xx that is not JSON, or without the fields, allows every operation", async () => {
    for (const r of [new Response("ok"), json({ success: true })]) {
      const { fetch } = scripted([r]);
      expect(await createAdminKeyVerifier({ fetch }).verify("http://x", "k")).toEqual({
        ok: true,
        allowedOps: [],
        isReadOnly: false,
      });
    }
  });
});

describe("capabilitiesOf", () => {
  test("no operations listed means every one", () => {
    expect(capabilitiesOf({ allowedOps: [], isReadOnly: false }, OPERATIONS)).toEqual({
      operations: [...OPERATIONS],
      readOnly: false,
    });
  });

  test("the server's names map to the dashboard's; unknown ones are dropped, duplicates merged", () => {
    const caps = capabilitiesOf(
      {
        allowedOps: ["ViewData", "RunInternalQueries", "RunTestQuery", "UnpauseDeployment", "Deploy"],
        isReadOnly: true,
      },
      OPERATIONS,
    );
    expect(caps).toEqual({ operations: ["viewData", "runFunctions", "resumeDeployment"], readOnly: true });
  });
});

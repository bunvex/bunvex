// Upstream's client test (`src/client/index.test.ts` of get-convex/resend 0.2.10, STUDY-200 §1.13), ported: the
// `Resend` client on an app that installs the package by its name (fixtures/app), mounted as `resend` and
// `customResend`; an email sent, batched, answered by Resend (`outboundFetch`, AD-48, where upstream stubs the global
// `fetch`), then delivered by an event, which runs the app's `onEmailEvent`. Upstream builds its app with convex-test's
// `defineTestApp`, which `@bunvex/testing` has not (DV-546); the app is pushed instead.
//
// Then the rest of the client: its defaults and checks, the positional overload, `sendEmailManually`, `cancelEmail`,
// `get`, the webhook route end to end (a Svix signature made here with WebCrypto), and Convex Auth's two ways of
// calling `lib.sendEmail` (STUDY-200 §1.15): directly, and by a handle the app gives a sibling component.
// biome-ignore-all lint/suspicious/noExplicitAny: the app's api is untyped
import { afterEach, describe, expect, setDefaultTimeout, test } from "bun:test";
import { join } from "node:path";
import { anyApi, componentsGeneric } from "@bunvex/server";
import { bunvexTest, type TestBunvex } from "@bunvex/testing";
import { type EmailEvent, type EmailId, Resend, type ResendComponent } from "../src/client/index.ts";

setDefaultTimeout(30_000);

const APP = join(import.meta.dir, "fixtures", "app");
const internal = anyApi as any;
const components = componentsGeneric() as unknown as Record<"resend" | "customResend", ResendComponent>;
const SECRET = `whsec_${btoa("a webhook secret of the tests' own")}`;

const open: TestBunvex[] = [];
afterEach(async () => {
  for (const d of open.splice(0)) await d.close();
});

type Seen = { url: string; method: string; headers: Record<string, string>; body: any };
function setup(answer?: (r: Request) => Response | Promise<Response>) {
  const seen: Seen[] = [];
  const t = bunvexTest({
    cwd: APP,
    env: { RESEND_WEBHOOK_SECRET: SECRET },
    outboundFetch: async (r: Request) => {
      seen.push({
        url: r.url,
        method: r.method,
        headers: Object.fromEntries(r.headers),
        body: JSON.parse(await r.clone().text()),
      });
      return answer ? answer(r) : Response.json({ data: [{ id: "test-resend-id" }] });
    },
  });
  open.push(t);
  return { t, seen };
}
const drain = (t: TestBunvex) => t.finishAllScheduledFunctions(undefined, 1000);

/** Svix's signature of a message, computed here with WebCrypto: base64(HMAC-SHA256(key, `${id}.${ts}.${body}`)). */
async function svixSign(secret: string, id: string, timestamp: number, body: string): Promise<string> {
  const raw = Uint8Array.from(atob(secret.replace(/^whsec_/, "")), (c) => c.charCodeAt(0));
  const key = await crypto.subtle.importKey("raw", raw, { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const mac = new Uint8Array(
    await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(`${id}.${timestamp}.${body}`)),
  );
  return `v1,${btoa(String.fromCharCode(...mac))}`;
}

describe("Resend test registration", () => {
  for (const name of ["resend", "customResend"] as const) {
    test(`sends queued emails and runs callbacks with component name ${name}`, async () => {
      const { t, seen } = setup();
      const component = components[name];
      const resend = new Resend(component, {
        apiKey: "test-api-key",
        onEmailEvent: internal.callbacks.onEmailEvent,
      });
      const emailId = await t.mutation((ctx: any) =>
        resend.sendEmail(ctx, {
          from: "sender@example.com",
          to: "delivered@resend.dev",
          subject: "Test email",
          text: "Hello from bunvex-test",
        }),
      );
      expect(await t.query((ctx: any) => resend.status(ctx, emailId))).toMatchObject({ status: "waiting" });

      await drain(t);

      expect(await t.query((ctx: any) => resend.get(ctx, emailId))).toMatchObject({
        status: "sent",
        resendId: "test-resend-id",
      });
      expect(seen).toHaveLength(1);
      expect(seen[0]).toMatchObject({ url: "https://api.resend.com/emails/batch", method: "POST" });

      const event: EmailEvent = {
        type: "email.delivered",
        created_at: new Date(t.now()).toISOString(),
        data: {
          created_at: new Date(t.now()).toISOString(),
          email_id: "test-resend-id",
          from: "sender@example.com",
          to: ["delivered@resend.dev"],
          subject: "Test email",
        },
      };
      await t.mutation(component.lib.handleEmailEvent, { event });
      await drain(t);

      expect(await t.query((ctx: any) => resend.status(ctx, emailId))).toMatchObject({ status: "delivered" });
      const events = await t.run((ctx: any) => ctx.db.query("events").collect());
      expect(events).toHaveLength(1);
      expect(events[0]).toMatchObject({ id: emailId, event });
    });
  }
});

describe("the client", () => {
  test("defaults: test mode on, 30 s backoff, 5 attempts, the key and secret from the environment", () => {
    const saved = [process.env.RESEND_API_KEY, process.env.RESEND_WEBHOOK_SECRET];
    process.env.RESEND_API_KEY = "re_env";
    process.env.RESEND_WEBHOOK_SECRET = "whsec_env";
    try {
      expect(new Resend(components.resend).config).toEqual({
        apiKey: "re_env",
        webhookSecret: "whsec_env",
        initialBackoffMs: 30000,
        retryAttempts: 5,
        testMode: true,
      });
      delete process.env.RESEND_API_KEY;
      delete process.env.RESEND_WEBHOOK_SECRET;
      const bare = new Resend(components.resend, { testMode: false, onEmailEvent: null });
      expect(bare.config).toMatchObject({ apiKey: "", webhookSecret: "", testMode: false });
      expect(bare.onEmailEvent).toBeUndefined();
    } finally {
      for (const [k, v] of [
        ["RESEND_API_KEY", saved[0]],
        ["RESEND_WEBHOOK_SECRET", saved[1]],
      ] as const) {
        if (v === undefined) delete process.env[k];
        else process.env[k] = v;
      }
    }
  });

  test("sendEmail refuses without an API key; test mode refuses other addresses; the positional form sends", async () => {
    const { t } = setup();
    const noKey = new Resend(components.resend, { apiKey: "" });
    await expect(
      t.mutation((ctx: any) =>
        noKey.sendEmail(ctx, { from: "a@x.com", to: "delivered@resend.dev", subject: "s", text: "t" }),
      ),
    ).rejects.toThrow("API key is not set");

    const resend = new Resend(components.resend, { apiKey: "k" });
    await expect(
      t.mutation((ctx: any) =>
        resend.sendEmail(ctx, { from: "a@x.com", to: "someone@example.com", subject: "s", text: "t" }),
      ),
    ).rejects.toThrow(
      "Test mode is enabled, but email address is not a valid resend test address. Did you want to set testMode: false in your ResendOptions?",
    );

    const id = await t.mutation((ctx: any) =>
      resend.sendEmail(
        ctx,
        "a@x.com",
        "delivered@resend.dev",
        "Subject",
        "<b>hi</b>",
        "hi",
        ["r@x.com"],
        [{ name: "X-T", value: "1" }],
      ),
    );
    expect(await t.query((ctx: any) => resend.get(ctx, id))).toMatchObject({
      from: "a@x.com",
      to: ["delivered@resend.dev"],
      subject: "Subject",
      html: "<b>hi</b>",
      text: "hi",
      replyTo: ["r@x.com"],
      headers: [{ name: "X-T", value: "1" }],
      status: "waiting",
    });
  });

  test("an extra key is passed on and refused by the component's validator", async () => {
    const { t } = setup();
    const resend = new Resend(components.resend, { apiKey: "k" });
    await expect(
      t.mutation((ctx: any) =>
        resend.sendEmail(ctx, {
          from: "a@x.com",
          to: "delivered@resend.dev",
          subject: "s",
          text: "t",
          attachments: [{ filename: "a.txt" }],
        } as any),
      ),
    ).rejects.toThrow("attachments");
  });

  test("works from an action too; get returns the row's fields, decoded bodies and createdAt", async () => {
    const { t } = setup();
    const resend = new Resend(components.resend, { apiKey: "k", testMode: false });
    const id = (await t.action((ctx: any) =>
      resend.sendEmail(ctx, {
        from: "a@x.com",
        to: ["x@example.com", "y@example.com"],
        cc: "c@example.com",
        bcc: ["b@example.com"],
        subject: "s",
        html: "<p>é</p>",
        idempotencyKey: "k1",
      }),
    )) as EmailId;
    const email = (await t.query((ctx: any) => resend.get(ctx, id))) as any;
    expect(email).toMatchObject({
      to: ["x@example.com", "y@example.com"],
      cc: ["c@example.com"],
      bcc: ["b@example.com"],
      html: "<p>é</p>",
      idempotencyKey: "k1",
      status: "waiting",
      complained: false,
      opened: false,
      bounced: false,
      failed: false,
      deliveryDelayed: false,
      clicked: false,
      finalizedAt: Number.MAX_SAFE_INTEGER,
    });
    expect(typeof email.segment).toBe("number");
    expect(typeof email.createdAt).toBe("number");
    expect(email.text).toBeUndefined();
    expect(email._id).toBeUndefined();
    expect(await t.query((ctx: any) => resend.get(ctx, "nope" as EmailId)).catch((e) => String(e))).toContain(
      "emailId",
    );
  });

  test("cancelEmail cancels a waiting email, then refuses: it was already sent", async () => {
    const { t } = setup();
    const resend = new Resend(components.resend, { apiKey: "k" });
    const id = await t.mutation((ctx: any) =>
      resend.sendEmail(ctx, { from: "a@x.com", to: "delivered@resend.dev", subject: "s", text: "t" }),
    );
    await t.mutation((ctx: any) => resend.cancelEmail(ctx, id));
    expect(await t.query((ctx: any) => resend.status(ctx, id))).toEqual({
      status: "cancelled",
      errorMessage: null,
      bounced: false,
      complained: false,
      failed: false,
      deliveryDelayed: false,
      opened: false,
      clicked: false,
    });
    await expect(t.mutation((ctx: any) => resend.cancelEmail(ctx, id))).rejects.toThrow("Email has already been sent");
  });

  test("sendEmailManually: sent with Resend's id, or failed with the callback's error (rethrown)", async () => {
    const { t, seen } = setup();
    const resend = new Resend(components.resend);
    let given = "";
    const sent = await t.action((ctx: any) =>
      resend.sendEmailManually(
        ctx,
        { from: "a@x.com", to: "someone@example.com", cc: "c@x.com", subject: "s" },
        async (id) => {
          given = id;
          return "re_manual";
        },
      ),
    );
    expect(given).toBe(sent);
    expect(await t.query((ctx: any) => resend.get(ctx, sent))).toMatchObject({
      status: "sent",
      resendId: "re_manual",
      to: ["someone@example.com"],
      cc: ["c@x.com"],
      segment: Number.POSITIVE_INFINITY,
      finalizedAt: Number.MAX_SAFE_INTEGER,
    });

    const failure = Object.assign(new Error("smtp down"), { resendId: "re_partial" });
    let failedId = "" as EmailId;
    await expect(
      t.action((ctx: any) =>
        resend.sendEmailManually(ctx, { from: "a@x.com", to: "z@x.com", subject: "s" }, async (id) => {
          failedId = id;
          throw failure;
        }),
      ),
    ).rejects.toThrow("smtp down");
    const failed = (await t.query((ctx: any) => resend.get(ctx, failedId))) as any;
    expect(failed).toMatchObject({ status: "failed", errorMessage: "smtp down", resendId: "re_partial" });
    expect(failed.finalizedAt).toBeLessThan(Number.MAX_SAFE_INTEGER);
    // A thrown non-Error is recorded by its text.
    let plainId = "" as EmailId;
    await expect(
      t.action((ctx: any) =>
        resend.sendEmailManually(ctx, { from: "a@x.com", to: "z@x.com", subject: "s" }, async (id) => {
          plainId = id;
          throw "just a string";
        }),
      ),
    ).rejects.toThrow();
    expect(await t.query((ctx: any) => resend.get(ctx, plainId))).toMatchObject({
      status: "failed",
      errorMessage: "just a string",
    });
    // Nothing went to Resend's batch API: the manual path sends with the app's own code.
    expect(seen).toEqual([]);
  });
});

describe("the webhook route", () => {
  async function sentEmail(t: TestBunvex) {
    const resend = new Resend(components.resend, { apiKey: "k", onEmailEvent: internal.callbacks.onEmailEvent });
    const id = await t.mutation((ctx: any) =>
      resend.sendEmail(ctx, { from: "a@x.com", to: "delivered@resend.dev", subject: "s", text: "t" }),
    );
    await drain(t);
    return { resend, id };
  }
  const deliveredBody = (t: TestBunvex) =>
    JSON.stringify({
      type: "email.delivered",
      created_at: new Date(t.now()).toISOString(),
      data: {
        created_at: new Date(t.now()).toISOString(),
        email_id: "test-resend-id",
        from: "a@x.com",
        to: ["delivered@resend.dev"],
        subject: "s",
        a_future_field: 1,
      },
    });
  async function post(t: TestBunvex, body: string, headers: Record<string, string>) {
    return t.fetch("/resend-webhook", { method: "POST", body, headers });
  }

  test("a signed event: 201 with no body, the status moves, the callback gets the parsed event", async () => {
    const { t } = setup();
    const { resend, id } = await sentEmail(t);
    const body = deliveredBody(t);
    // An action (an HTTP action too) reads the real clock, not the test's virtual one.
    const ts = Math.floor(Date.now() / 1000);
    const signature = await svixSign(SECRET, "msg_1", ts, body);
    const r = await post(t, body, {
      "svix-id": "msg_1",
      "svix-timestamp": String(ts),
      // Several signatures, space-separated: another version's and a wrong one are skipped.
      "svix-signature": `v2,abc v1,AAAA ${signature}`,
    });
    expect(r.status).toBe(201);
    expect(await r.text()).toBe("");
    await drain(t);
    expect(await t.query((ctx: any) => resend.status(ctx, id))).toMatchObject({ status: "delivered" });
    const events = (await t.run((ctx: any) => ctx.db.query("events").collect())) as any[];
    expect(events).toHaveLength(1);
    expect(events[0].event.data.a_future_field).toBeUndefined();
  });

  test("a refused signature, stale or future timestamp, missing headers or bad JSON is a 500", async () => {
    const { t } = setup();
    const { resend, id } = await sentEmail(t);
    const body = deliveredBody(t);
    // The HTTP action reads the real clock; ±310 s stays outside the 300 s tolerance if a second passes meanwhile (the
    // exact edges are checked in webhook.test.ts).
    const now = Math.floor(Date.now() / 1000);
    const cases: [string, Record<string, string>, string?][] = [
      ["no headers", {}],
      ["wrong signature", { "svix-id": "m", "svix-timestamp": String(now), "svix-signature": "v1,AAAA" }],
      [
        "too old",
        {
          "svix-id": "m",
          "svix-timestamp": String(now - 310),
          "svix-signature": await svixSign(SECRET, "m", now - 310, body),
        },
      ],
      [
        "too new",
        {
          "svix-id": "m",
          "svix-timestamp": String(now + 310),
          "svix-signature": await svixSign(SECRET, "m", now + 310, body),
        },
      ],
      ["not a number", { "svix-id": "m", "svix-timestamp": "soon", "svix-signature": "v1,AAAA" }],
      [
        "webhook-* headers are not read",
        {
          "webhook-id": "m",
          "webhook-timestamp": String(now),
          "webhook-signature": await svixSign(SECRET, "m", now, body),
        },
      ],
      [
        "bad JSON",
        { "svix-id": "m", "svix-timestamp": String(now), "svix-signature": await svixSign(SECRET, "m", now, "{") },
        "{",
      ],
    ];
    for (const [what, headers, other] of cases) {
      const r = await post(t, other ?? body, headers);
      expect([what, r.status]).toEqual([what, 500]);
    }
    // Near the edge of the tolerance, accepted.
    const edge = await post(t, body, {
      "svix-id": "m",
      "svix-timestamp": String(now - 290),
      "svix-signature": await svixSign(SECRET, "m", now - 290, body),
    });
    expect(edge.status).toBe(201);
    await drain(t);
    expect(await t.query((ctx: any) => resend.status(ctx, id))).toMatchObject({ status: "delivered" });
  });

  test("without a secret the route throws: a 500", async () => {
    const { t } = setup();
    await t.setEnv("RESEND_WEBHOOK_SECRET", null);
    const r = await post(t, "{}", {});
    expect(r.status).toBe(500);
  });
});

describe("Convex Auth's calls", () => {
  test("directly, and by a handle the app gives a sibling component; testMode false is honoured", async () => {
    const { t, seen } = setup();
    const direct = (await t.mutation(internal.auth.notify, { to: "someone@example.com" })) as string;
    const viaSibling = (await t.mutation(internal.auth.sendViaSibling, { to: "other@example.com" })) as string;
    expect(typeof direct).toBe("string");
    expect(typeof viaSibling).toBe("string");
    expect(viaSibling).not.toBe(direct);
    const resend = new Resend(components.resend);
    expect(await t.query((ctx: any) => resend.get(ctx, viaSibling as EmailId))).toMatchObject({
      from: "auth@example.com",
      to: ["other@example.com"],
      subject: "Your code",
      text: "Your code is 123456",
      status: "waiting",
    });
    await drain(t);
    expect(seen).toHaveLength(1);
    expect(seen[0]!.headers.authorization).toBe("Bearer re_auth");
    expect(seen[0]!.body.map((e: any) => e.to)).toEqual([["someone@example.com"], ["other@example.com"]]);
  });
});

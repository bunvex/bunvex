// The sending path (STUDY-200 §1.6–§1.8), which upstream does not test: the batcher's timing, its two-segment lag and
// 100-email cut, the rate limit between batch calls, the request to Resend (URL, method, headers, Idempotency-Key,
// body), which statuses are permanent, the retries and `onEmailComplete`'s three outcomes, and cancelation. Resend is
// answered by `outboundFetch` (AD-48), where upstream stubs the global `fetch`.
// biome-ignore-all lint/suspicious/noExplicitAny: the inline functions' ctx is untyped
import { describe, expect, setDefaultTimeout, test } from "bun:test";
import type { Doc, Id } from "../src/component/_generated/dataModel.ts";
import {
  all,
  api,
  getEmail,
  insertTestEmail,
  options,
  plainEmail,
  resendOk,
  SECOND,
  setupTest,
  setupTestLastOptions,
} from "./helpers.ts";

setDefaultTimeout(30_000);

type Seen = { at: number; method: string; url: string; headers: Record<string, string>; body: any };

/** A deployment whose Resend answers with `answer`, each request recorded with the virtual time it was made at. */
function withResend(answer: (r: Request, n: number) => Response | Promise<Response> = (r) => okFor(r)) {
  const seen: Seen[] = [];
  const t = setupTest({
    outboundFetch: async (r) => {
      const text = await r.clone().text();
      seen.push({
        at: t.now(),
        method: r.method,
        url: r.url,
        headers: Object.fromEntries(r.headers),
        body: text ? JSON.parse(text) : null,
      });
      return answer(r, seen.length);
    },
  });
  return { t, seen };
}

/** A success for every email of the request, ids `re_<n>`. */
async function okFor(r: Request, first = 1) {
  const body = (await r.clone().json()) as unknown[];
  return resendOk(body.length, first);
}

const drain = (t: ReturnType<typeof setupTest>) => t.finishAllScheduledFunctions(undefined, 1000);
const send = (t: ReturnType<typeof setupTest>, overrides: Record<string, unknown> = {}): Promise<Id<"emails">> =>
  t.mutation(api.lib.sendEmail, plainEmail(overrides));

/** A `waiting` email in `segment`, inserted directly. */
const waitingIn = (t: ReturnType<typeof setupTest>, segment: number) =>
  insertTestEmail(t, {
    from: "a@resend.dev",
    to: ["delivered@resend.dev"],
    subject: "s",
    replyTo: [],
    status: "waiting",
    complained: false,
    opened: false,
    segment,
    finalizedAt: Number.MAX_SAFE_INTEGER,
  });

/** A `queued` email, as `makeBatch` leaves one, with an HTML body. */
const queuedEmail = (t: ReturnType<typeof setupTest>, fields: Partial<Doc<"emails">> = {}) =>
  t.run(async (ctx: any) => {
    const html = await ctx.db.insert("content", {
      content: new TextEncoder().encode("<p>hi</p>").buffer,
      mimeType: "text/html",
    });
    return (await ctx.db.insert("emails", {
      from: "a@resend.dev",
      to: ["delivered@resend.dev"],
      subject: "s",
      html,
      replyTo: [],
      status: "queued",
      complained: false,
      opened: false,
      segment: 1,
      finalizedAt: Number.MAX_SAFE_INTEGER,
      ...fields,
    })) as Id<"emails">;
  });

describe("the request to Resend", () => {
  test("one POST to the batch URL, with the key, JSON, the first id as Idempotency-Key, and Convex's body", async () => {
    const { t, seen } = withResend();
    const first = await send(t, {
      options: options({ apiKey: "re_secret" }),
      cc: ["bounced@resend.dev"],
      bcc: ["complained+x@resend.dev"],
      replyTo: ["reply@x.com"],
      headers: [
        { name: "X-A", value: "1" },
        { name: "X-B", value: "2" },
        { name: "X-A", value: "3" },
      ],
      text: "plain",
    });
    const second = await send(t, {
      options: options({ apiKey: "re_secret" }),
      subject: undefined,
      html: undefined,
      template: { id: "tpl", variables: { NAME: "Ada", N: 3 } },
    });
    const third = await send(t, {
      options: options({ apiKey: "re_secret" }),
      subject: "with subject",
      html: undefined,
      template: { id: "tpl2" },
    });
    await drain(t);

    expect(seen).toHaveLength(1);
    const [request] = seen as [Seen];
    expect(request.method).toBe("POST");
    expect(request.url).toBe("https://api.resend.com/emails/batch");
    expect(request.headers.authorization).toBe("Bearer re_secret");
    expect(request.headers["content-type"]).toBe("application/json");
    expect(request.headers["idempotency-key"]).toBe(first);
    expect(request.headers["user-agent"]).toBe("Bunvex/1.0");
    expect(request.body).toEqual([
      {
        from: "test@resend.dev",
        to: ["delivered@resend.dev"],
        bcc: ["complained+x@resend.dev"],
        cc: ["bounced@resend.dev"],
        reply_to: ["reply@x.com"],
        headers: { "X-A": "3", "X-B": "2" },
        subject: "Test",
        html: "<p>Test</p>",
        text: "plain",
      },
      // No subject with a template unless one is given; `reply_to` is always sent.
      {
        from: "test@resend.dev",
        to: ["delivered@resend.dev"],
        reply_to: [],
        template: { id: "tpl", variables: { NAME: "Ada", N: 3 } },
      },
      {
        from: "test@resend.dev",
        to: ["delivered@resend.dev"],
        reply_to: [],
        template: { id: "tpl2" },
        subject: "with subject",
      },
    ]);
    // Key order as Convex's: from, to, bcc, cc, reply_to, headers, then the content.
    expect(Object.keys(request.body[0])).toEqual([
      "from",
      "to",
      "bcc",
      "cc",
      "reply_to",
      "headers",
      "subject",
      "html",
      "text",
    ]);

    for (const [id, resendId] of [
      [first, "re_1"],
      [second, "re_2"],
      [third, "re_3"],
    ] as const) {
      expect(await getEmail(t, id)).toMatchObject({ status: "sent", resendId });
    }
  });

  test("the batch uses the last sender's options: lastOptions is global, last writer wins", async () => {
    const { t, seen } = withResend();
    await send(t, { options: options({ apiKey: "first-key" }) });
    await send(t, { options: options({ apiKey: "second-key" }) });
    expect((await all(t, "lastOptions")).map((r) => r.options.apiKey)).toEqual(["second-key"]);
    await drain(t);
    expect(seen.map((s) => s.headers.authorization)).toEqual(["Bearer second-key"]);
  });

  test("the Idempotency-Key is the first id as enqueued, even when that email was cancelled since", async () => {
    const { t, seen } = withResend();
    await setupTestLastOptions(t);
    const a = await queuedEmail(t);
    const b = await queuedEmail(t);
    await t.mutation(api.lib.cancelEmail, { emailId: a });
    const result = await t.action(api.lib.callResendAPIWithBatch, { apiKey: "k", emails: [a, b] });
    expect(result).toEqual({ emailIds: [b], resendIds: ["re_1"] });
    expect(seen[0]?.headers["idempotency-key"]).toBe(a);
    expect(seen[0]?.body).toHaveLength(1);
  });
});

describe("the batcher", () => {
  test("the first email goes out about a second after the batcher idles, and the batcher idles again", async () => {
    const { t, seen } = withResend();
    const start = t.now();
    const id = await send(t);
    expect(await getEmail(t, id)).toMatchObject({ status: "waiting", segment: Math.floor(start / 125) });
    const runs = await all(t, "nextBatchRun");
    expect(runs).toHaveLength(1);
    await drain(t);
    expect(seen).toHaveLength(1);
    // A second for the batcher, then the batch call's reservation in the 600 ms window (plus jitter).
    expect(seen[0]!.at - start).toBeGreaterThanOrEqual(1000);
    expect(seen[0]!.at - start).toBeLessThan(1000 + 600 + 100 + 1000);
    expect(await all(t, "nextBatchRun")).toEqual([]);
  });

  test("takes only emails at least two segments older than its own (125 ms each)", async () => {
    const { t } = withResend();
    await setupTestLastOptions(t);
    const S = 1_000_000;
    const older = await waitingIn(t, S - 2);
    const recent = await waitingIn(t, S - 1);
    const current = await waitingIn(t, S);
    await t.mutation(api.lib.makeBatch, { reloop: false, segment: S });
    expect((await getEmail(t, older._id))?.status).toBe("queued");
    expect((await getEmail(t, recent._id))?.status).toBe("waiting");
    expect((await getEmail(t, current._id))?.status).toBe("waiting");
  });

  test("cuts batches at 100 emails; a short batch on a reloop waits a second; calls are 600 ms apart", async () => {
    const { t, seen } = withResend(async (r, n) => okFor(r, n * 1000));
    await t.mutation(api.lib.sendEmail, plainEmail());
    // 149 more in the same transaction-free way: each its own send, all in the first segment's range.
    for (let i = 0; i < 149; i++) await send(t);
    const ids = (await all<Doc<"emails">>(t, "emails")).map((e) => e._id);
    expect(ids).toHaveLength(150);
    await drain(t);
    expect(seen.map((s) => s.body.length)).toEqual([100, 50]);
    expect(seen[1]!.at - seen[0]!.at).toBeGreaterThanOrEqual(600);
    const emails = await all<Doc<"emails">>(t, "emails");
    expect(emails.every((e) => e.status === "sent")).toBe(true);
    expect(new Set(emails.map((e) => e.resendId)).size).toBe(150);
  });

  test("a waiting email cancelled before its batch is never sent; the batcher idles", async () => {
    const { t, seen } = withResend();
    const id = await send(t);
    await t.mutation(api.lib.cancelEmail, { emailId: id });
    await drain(t);
    expect(seen).toEqual([]);
    expect(await getEmail(t, id)).toMatchObject({ status: "cancelled" });
    expect(await all(t, "nextBatchRun")).toEqual([]);
  });

  test("an email cancelled while queued leaves the batch; a batch left empty sends nothing", async () => {
    const { t, seen } = withResend();
    await setupTestLastOptions(t);
    const id = await queuedEmail(t);
    await t.mutation(api.lib.cancelEmail, { emailId: id });
    expect(await t.action(api.lib.callResendAPIWithBatch, { apiKey: "k", emails: [id] })).toBeNull();
    expect(seen).toEqual([]);
  });
});

describe("Resend's answers", () => {
  const PERMANENT = [
    400, 401, 403, 404, 405, 406, 407, 408, 410, 411, 413, 414, 415, 416, 418, 421, 422, 426, 427, 428, 431,
  ];
  const RETRIED = [402, 409, 412, 417, 423, 424, 425, 429, 451, 500, 501, 502, 503, 504];

  test("a permanent status fails the batch's queued emails at once; any other is thrown, to be retried", async () => {
    let status = 0;
    const { t } = withResend(() => new Response(`body ${status}`, { status, statusText: `Text ${status}` }));
    await setupTestLastOptions(t);
    for (const code of [...PERMANENT, ...RETRIED]) {
      status = code;
      if (code === 407) continue;
      const id = await queuedEmail(t);
      const call = t.action(api.lib.callResendAPIWithBatch, { apiKey: "k", emails: [id] });
      if (PERMANENT.includes(code)) {
        expect([code, await call]).toEqual([code, null]);
        expect([code, await getEmail(t, id)]).toMatchObject([
          code,
          { status: "failed", errorMessage: `Resend API error: ${code} Text ${code} body ${code}` },
        ]);
        expect((await getEmail(t, id))!.finalizedAt).toBeLessThan(Number.MAX_SAFE_INTEGER);
      } else {
        await expect(call).rejects.toThrow(`Resend API error: body ${code}`);
        expect([code, (await getEmail(t, id))?.status]).toEqual([code, "queued"]);
      }
    }
  });

  test("a 407 never reaches the component: the platform's fetch refuses it, as Convex's does, so it is retried", async () => {
    const { t } = withResend(() => new Response("proxy", { status: 407, statusText: "Proxy Authentication Required" }));
    await setupTestLastOptions(t);
    const id = await queuedEmail(t);
    const error = await t.action(api.lib.callResendAPIWithBatch, { apiKey: "k", emails: [id] }).catch((e) => e);
    expect(String(error)).toContain("https://api.resend.com/emails/batch");
    expect(String(error)).not.toContain("Resend API error");
    expect((await getEmail(t, id))?.status).toBe("queued");
  });

  test("a permanent failure marks only the emails still queued", async () => {
    const { t } = withResend(() => new Response("nope", { status: 422, statusText: "Unprocessable Entity" }));
    await setupTestLastOptions(t);
    const queued = await queuedEmail(t);
    const sent = await queuedEmail(t, { status: "sent", resendId: "re_x" });
    await t.action(api.lib.callResendAPIWithBatch, { apiKey: "k", emails: [queued, sent] });
    expect((await getEmail(t, queued))?.status).toBe("failed");
    expect((await getEmail(t, sent))?.status).toBe("sent");
  });

  test("an OK without data is thrown and retried", async () => {
    const { t } = withResend(() => Response.json({ object: "x" }));
    await setupTestLastOptions(t);
    const id = await queuedEmail(t);
    await expect(t.action(api.lib.callResendAPIWithBatch, { apiKey: "k", emails: [id] })).rejects.toThrow(
      "Resend API error: No data returned",
    );
  });

  test("retryAttempts counts every attempt: 3 tries, then the emails fail with the pool's error", async () => {
    const { t, seen } = withResend(() => new Response("busy", { status: 503, statusText: "Service Unavailable" }));
    const id = await send(t, { options: options({ retryAttempts: 3, initialBackoffMs: 10 * SECOND }) });
    await drain(t);
    expect(seen).toHaveLength(3);
    // Backoff 10 s × 2^(n-1) × (0.5 to 1.5).
    expect(seen[1]!.at - seen[0]!.at).toBeGreaterThanOrEqual(5 * SECOND);
    expect(seen[2]!.at - seen[1]!.at).toBeGreaterThanOrEqual(10 * SECOND);
    const email = (await getEmail(t, id))!;
    expect(email.status).toBe("failed");
    expect(email.errorMessage).toContain("Resend API error: busy");
    expect(email.finalizedAt).toBeLessThan(Number.MAX_SAFE_INTEGER);
  });

  test("retryAttempts 0 is a single try; a failed request (network) is retried like an error status", async () => {
    let calls = 0;
    const { t, seen } = withResend(async (r) => {
      calls++;
      if (calls === 1) throw new Error("connection reset");
      return okFor(r);
    });
    const once = await send(t, { options: options({ retryAttempts: 0 }) });
    await drain(t);
    expect(seen).toHaveLength(1);
    expect((await getEmail(t, once))?.status).toBe("failed");
    expect((await getEmail(t, once))?.errorMessage).toContain("TypeError");

    const twice = await send(t, { options: options({ retryAttempts: 2, initialBackoffMs: 100 }) });
    await drain(t);
    expect(seen).toHaveLength(2);
    expect((await getEmail(t, twice))?.status).toBe("sent");
  });

  test("onEmailComplete: success writes sent and Resend's id even over a late cancel; canceled cancels the queued", async () => {
    const { t } = withResend();
    await setupTestLastOptions(t);
    const late = await queuedEmail(t, { status: "cancelled" });
    const queued = await queuedEmail(t);
    const done = await queuedEmail(t, { status: "sent" });
    await t.mutation(api.lib.onEmailComplete, {
      workId: "w1",
      context: { emailIds: [late] },
      result: { kind: "success", returnValue: { emailIds: [late], resendIds: ["re_late"] } },
    });
    expect(await getEmail(t, late)).toMatchObject({ status: "sent", resendId: "re_late" });
    await t.mutation(api.lib.onEmailComplete, {
      workId: "w2",
      context: { emailIds: [queued, done] },
      result: { kind: "canceled" },
    });
    expect(await getEmail(t, queued)).toMatchObject({
      status: "cancelled",
      errorMessage: "Resend API batch job was cancelled",
    });
    expect((await getEmail(t, done))?.status).toBe("sent");
    // A null success (nothing sent) changes nothing.
    await t.mutation(api.lib.onEmailComplete, {
      workId: "w3",
      context: { emailIds: [done] },
      result: { kind: "success", returnValue: null },
    });
    expect((await getEmail(t, done))?.status).toBe("sent");
  });
});

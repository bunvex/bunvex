// Webhook events applied (STUDY-200 §1.4, §1.9, §2.3): the rank rule for every event type from every status, which
// events finalize, the flags each sets (on a cancelled email too), the `deliveryEvents` rows (repeats included), and
// the app's `onEmailEvent`, run for every valid event with a known email, with the parsed event.
// biome-ignore-all lint/suspicious/noExplicitAny: the inline functions' ctx is untyped
import { describe, expect, setDefaultTimeout, test } from "bun:test";
import { createFunctionHandle } from "@bunvex/server";
import type { Doc } from "../src/component/_generated/dataModel.ts";
import type { EventEventTypes, Status } from "../src/component/shared.ts";
import {
  all,
  api,
  createTestEventOfType,
  createTestRuntimeConfig,
  getEmail,
  insertTestSentEmail,
  setupTest,
  setupTestLastOptions,
} from "./helpers.ts";

setDefaultTimeout(30_000);

const STATUSES: Status[] = [
  "waiting",
  "queued",
  "sent",
  "delivery_delayed",
  "delivered",
  "bounced",
  "failed",
  "cancelled",
];
const EVENTS: EventEventTypes[] = [
  "email.sent",
  "email.delivered",
  "email.delivery_delayed",
  "email.complained",
  "email.bounced",
  "email.opened",
  "email.clicked",
  "email.failed",
];
const NOT_FINAL = Number.MAX_SAFE_INTEGER;

// The status after each event, from each status (columns in STATUSES' order): a status moves only up the rank
// waiting < queued < sent < delivery_delayed < delivered < bounced = failed; cancelled never moves.
const AFTER: Record<EventEventTypes, Status[]> = {
  "email.sent": STATUSES,
  "email.opened": STATUSES,
  "email.clicked": STATUSES,
  "email.complained": STATUSES,
  "email.delivery_delayed": [
    "delivery_delayed",
    "delivery_delayed",
    "delivery_delayed",
    "delivery_delayed",
    "delivered",
    "bounced",
    "failed",
    "cancelled",
  ],
  "email.delivered": [
    "delivered",
    "delivered",
    "delivered",
    "delivered",
    "delivered",
    "bounced",
    "failed",
    "cancelled",
  ],
  "email.bounced": ["bounced", "bounced", "bounced", "bounced", "bounced", "bounced", "failed", "cancelled"],
  "email.failed": ["failed", "failed", "failed", "failed", "failed", "bounced", "failed", "cancelled"],
};

/** The flag each event sets, if any. */
const FLAG: Partial<Record<EventEventTypes, keyof Doc<"emails">>> = {
  "email.opened": "opened",
  "email.clicked": "clicked",
  "email.complained": "complained",
  "email.bounced": "bounced",
  "email.failed": "failed",
  "email.delivery_delayed": "deliveryDelayed",
};

describe("the rank rule", () => {
  test("every event type from every status: the status, the flag, finalizedAt, one deliveryEvents row each", async () => {
    const t = setupTest();
    await setupTestLastOptions(t);
    const rows: { status: Status; type: EventEventTypes; email: Doc<"emails"> }[] = [];
    for (const status of STATUSES)
      for (const type of EVENTS)
        rows.push({ status, type, email: await insertTestSentEmail(t, { status, resendId: `${status}/${type}` }) });

    const now = t.now();
    for (const { status, type } of rows) {
      await t.mutation(api.lib.handleEmailEvent, {
        event: createTestEventOfType(type, { data: { email_id: `${status}/${type}` } } as never),
      });
    }

    for (const { status, type, email } of rows) {
      const after = (await getEmail(t, email._id))!;
      const expected = AFTER[type][STATUSES.indexOf(status)];
      expect([status, type, after.status]).toEqual([status, type, expected]);
      const flag = FLAG[type];
      // Flags change even on a cancelled email.
      if (flag) expect([status, type, after[flag]]).toEqual([status, type, true]);
      const moved = expected !== status;
      const finalizes =
        (moved && ["delivered", "bounced", "failed"].includes(expected as string)) || type === "email.complained";
      if (finalizes) {
        expect(after.finalizedAt).toBeGreaterThanOrEqual(now);
        expect(after.finalizedAt).toBeLessThan(now + 60_000);
      } else expect([status, type, after.finalizedAt]).toEqual([status, type, NOT_FINAL]);
      // A bounce writes its message even when the status stays.
      expect([status, type, after.errorMessage]).toEqual([
        status,
        type,
        type === "email.bounced" ? "The email bounced due to invalid recipient" : undefined,
      ]);
    }
    const events = await all<Doc<"deliveryEvents">>(t, "deliveryEvents");
    expect(events).toHaveLength(rows.length);
    expect(
      events.filter((e) => e.eventType === "email.failed").every((e) => e.message === "SMTP server rejected the email"),
    ).toBe(true);
    expect(
      events
        .filter((e) => e.message !== undefined)
        .map((e) => e.eventType)
        .sort(),
    ).toEqual([...Array(8).fill("email.bounced"), ...Array(8).fill("email.failed")].sort());
  });

  test("complained finalizes only an email not final yet; a repeated event changes nothing but is recorded", async () => {
    const t = setupTest();
    await setupTestLastOptions(t);
    const final = await insertTestSentEmail(t, { status: "delivered", finalizedAt: 1234 });
    await t.mutation(api.lib.handleEmailEvent, { event: createTestEventOfType("email.complained") });
    expect(await getEmail(t, final._id)).toMatchObject({ complained: true, finalizedAt: 1234, status: "delivered" });
    const before = await getEmail(t, final._id);
    await t.mutation(api.lib.handleEmailEvent, { event: createTestEventOfType("email.complained") });
    expect(await getEmail(t, final._id)).toEqual(before);
    expect(await all(t, "deliveryEvents")).toHaveLength(2);
  });

  test("a second bounce on a bounced email changes nothing; a bounce after failed sets the flag and the message", async () => {
    const t = setupTest();
    await setupTestLastOptions(t);
    const failed = await insertTestSentEmail(t, {
      status: "failed",
      failed: true,
      errorMessage: "earlier",
      finalizedAt: 7,
    });
    await t.mutation(api.lib.handleEmailEvent, { event: createTestEventOfType("email.bounced") });
    expect(await getEmail(t, failed._id)).toMatchObject({
      status: "failed",
      bounced: true,
      errorMessage: "The email bounced due to invalid recipient",
      finalizedAt: 7,
    });
    const before = await getEmail(t, failed._id);
    await t.mutation(api.lib.handleEmailEvent, {
      event: createTestEventOfType("email.bounced", {
        data: { bounce: { message: "other", subType: "x", type: "y" } },
      } as never),
    });
    expect(await getEmail(t, failed._id)).toEqual(before);
  });
});

describe("the onEmailEvent callback", () => {
  test("runs for every valid event of a known email, repeats and no-change ones included, with the parsed event", async () => {
    const t = setupTest();
    const fnHandle = (await t.mutation(() => createFunctionHandle(api.testing.onEmailEvent))) as string;
    await setupTestLastOptions(t, { options: { ...createTestRuntimeConfig(), onEmailEvent: { fnHandle } } });
    const email = await insertTestSentEmail(t);
    const sent = createTestEventOfType("email.sent");
    const withExtra = { ...sent, data: { ...sent.data, unknown_field: 1 }, also_unknown: true };
    await t.mutation(api.lib.handleEmailEvent, { event: withExtra });
    await t.mutation(api.lib.handleEmailEvent, { event: sent });
    await t.mutation(api.lib.handleEmailEvent, { event: createTestEventOfType("email.delivered") });
    // Unknown email, invalid event: no callback.
    await t.mutation(api.lib.handleEmailEvent, {
      event: createTestEventOfType("email.delivered", { data: { email_id: "unknown" } } as never),
    });
    await t.mutation(api.lib.handleEmailEvent, { event: { type: "contact.created", created_at: "x", data: {} } });
    await t.finishAllScheduledFunctions(undefined, 1000);
    const received = (await t.mutation(api.testing.events, {})) as { id: string; event: any }[];
    // The pool runs them up to 4 at once, in no set order.
    expect(received.map((r) => [r.id, r.event.type]).sort()).toEqual([
      [email._id, "email.delivered"],
      [email._id, "email.sent"],
      [email._id, "email.sent"],
    ]);
    expect(received.filter((r) => r.event.type === "email.sent").map((r) => r.event)).toEqual([sent, sent]);
  });

  test("none without lastOptions (an app that only sends by hand), or without onEmailEvent in them", async () => {
    const t = setupTest();
    const manual = (await t.mutation(api.lib.createManualEmail, {
      from: "a@x.com",
      to: "b@x.com",
      subject: "s",
    })) as Doc<"emails">["_id"];
    await t.mutation(api.lib.updateManualEmail, { emailId: manual, status: "sent", resendId: "test-resend-id-123" });
    await t.mutation(api.lib.handleEmailEvent, { event: createTestEventOfType("email.delivered") });
    expect((await getEmail(t, manual))?.status).toBe("delivered");
    await setupTestLastOptions(t);
    await t.mutation(api.lib.handleEmailEvent, { event: createTestEventOfType("email.opened") });
    await t.finishAllScheduledFunctions(undefined, 1000);
    expect(await t.mutation(api.testing.events, {})).toEqual([]);
  });

  test("the last sender's options decide: a send without onEmailEvent silences the callback (Convex Auth's case)", async () => {
    const t = setupTest();
    const fnHandle = (await t.mutation(() => createFunctionHandle(api.testing.onEmailEvent))) as string;
    const email = { from: "a@x.com", to: ["delivered@resend.dev"], subject: "s", text: "t" };
    await t.mutation(api.lib.sendEmail, {
      ...email,
      options: { ...createTestRuntimeConfig(), onEmailEvent: { fnHandle } },
    });
    expect((await all(t, "lastOptions"))[0].options.onEmailEvent).toEqual({ fnHandle });
    await t.mutation(api.lib.sendEmail, { ...email, options: createTestRuntimeConfig() });
    expect((await all(t, "lastOptions"))[0].options.onEmailEvent).toBeUndefined();
    await insertTestSentEmail(t);
    await t.mutation(api.lib.handleEmailEvent, { event: createTestEventOfType("email.delivered") });
    await t.mutation(api.lib.cancelEmail, { emailId: (await all<Doc<"emails">>(t, "emails"))[0]!._id });
    await t.finishAllScheduledFunctions(undefined, 1000);
    expect(await t.mutation(api.testing.events, {})).toEqual([]);
  });
});

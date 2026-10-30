// Upstream's component tests (`src/component/lib.test.ts` of get-convex/resend 0.2.10, STUDY-200 §1.13), ported to
// `@bunvex/testing`: `handleEmailEvent` for each event type and five malformed inputs, the event validator's parse,
// `sendEmail` with templates and with an `idempotencyKey`, and `createManualEmail`'s `cc`/`bcc`. The component's
// functions run pushed as an app's (fixtures/standalone).
// biome-ignore-all lint/suspicious/noExplicitAny: the inline functions' ctx is untyped
import { beforeEach, describe, expect, it, setDefaultTimeout } from "bun:test";
import type { Doc, Id } from "../src/component/_generated/dataModel.ts";
import { type EmailEvent, vEmailEvent } from "../src/component/shared.ts";
import { attemptToParse } from "../src/component/utils.ts";
import {
  api,
  createTestEventOfType,
  getEmail,
  insertTestSentEmail,
  setupTest,
  setupTestLastOptions,
  type Tester,
} from "./helpers.ts";

// Each test pushes its own deployment first, which takes longer than bun's 5 s default on a busy machine.
setDefaultTimeout(30_000);

describe("handleEmailEvent", () => {
  let t: Tester;
  let event: EmailEvent;
  let email: Doc<"emails">;

  beforeEach(async () => {
    t = setupTest();
    event = createTestEventOfType("email.delivered");
    await setupTestLastOptions(t);
    email = await insertTestSentEmail(t);
  });

  const exec = async (e: EmailEvent | unknown = event) => {
    await t.mutation(api.lib.handleEmailEvent, { event: e });
  };
  const current = async () => {
    const row = await getEmail(t, email._id);
    if (!row) throw new Error("Email not found");
    return row;
  };
  const eventsOf = (eventType?: string) =>
    t.run((ctx: any) =>
      ctx.db
        .query("deliveryEvents")
        .withIndex("by_emailId_eventType", (q: any) =>
          eventType ? q.eq("emailId", email._id).eq("eventType", eventType) : q.eq("emailId", email._id),
        )
        .collect(),
    ) as Promise<Doc<"deliveryEvents">[]>;

  it("updates email for delivered event", async () => {
    expect(email.status).toBe("sent");
    await exec();
    const updated = await current();
    expect(updated.status).toBe("delivered");
    expect(updated.finalizedAt).toBeLessThan(Number.MAX_SAFE_INTEGER);
    expect(updated.finalizedAt).toBeGreaterThan(t.now() - 10000);
    const events = await eventsOf("email.delivered");
    expect(events.length).toBe(1);
    expect(events[0]?.eventType).toBe("email.delivered");
    expect(events[0]?.resendId).toBe("test-resend-id-123");
  });

  it("updates email for complained event", async () => {
    event = createTestEventOfType("email.complained");
    await exec();
    const updated = await current();
    expect(updated.status).toBe("sent");
    expect(updated.complained).toBe(true);
    const events = await eventsOf();
    expect(events.length).toBe(1);
    expect(events[0]?.eventType).toBe("email.complained");
  });

  it("updates email for bounced event", async () => {
    event = createTestEventOfType("email.bounced");
    await exec();
    const updated = await current();
    expect(updated.status).toBe("bounced");
    expect(updated.finalizedAt).toBeLessThan(Number.MAX_SAFE_INTEGER);
    expect(updated.finalizedAt).toBeGreaterThan(t.now() - 10000);
    expect(updated.errorMessage).toBe("The email bounced due to invalid recipient");
    const events = await eventsOf("email.bounced");
    expect(events.length).toBe(1);
    expect(events[0]?.eventType).toBe("email.bounced");
    expect(events[0]?.message).toBe("The email bounced due to invalid recipient");
  });

  it("updates email for delivery_delayed event", async () => {
    event = createTestEventOfType("email.delivery_delayed");
    await exec();
    const updated = await current();
    expect(updated.status).toBe("delivery_delayed");
    expect(updated.finalizedAt).toBe(Number.MAX_SAFE_INTEGER);
  });

  it("updates email for opened event", async () => {
    expect(email.opened).toBe(false);
    event = createTestEventOfType("email.opened");
    await exec();
    const updated = await current();
    expect(updated.status).toBe("sent");
    expect(updated.opened).toBe(true);
  });

  it("does not update email for sent event", async () => {
    event = createTestEventOfType("email.sent");
    await exec();
    const updated = await current();
    expect(updated.status).toBe("sent");
    expect(updated.finalizedAt).toBe(Number.MAX_SAFE_INTEGER);
    expect(updated.complained).toBe(false);
    expect(updated.opened).toBe(false);
  });

  it("updates email for clicked event", async () => {
    event = createTestEventOfType("email.clicked");
    await exec();
    const updated = await current();
    expect(updated.status).toBe("sent");
    expect(updated.finalizedAt).toBe(Number.MAX_SAFE_INTEGER);
    expect(updated.clicked).toBe(true);
    expect(updated.complained).toBe(false);
    expect(updated.opened).toBe(false);
  });

  it("updates email for failed event and changes status", async () => {
    event = createTestEventOfType("email.failed");
    await exec();
    const updated = await current();
    expect(updated.status).toBe("failed");
    expect(updated.failed).toBe(true);
    expect(updated.finalizedAt).toBeLessThan(Number.MAX_SAFE_INTEGER);
    expect(updated.complained).toBe(false);
    expect(updated.opened).toBe(false);
  });

  const unchanged = async () => {
    const updated = await current();
    expect(updated.status).toBe("sent");
    expect(updated.finalizedAt).toBe(Number.MAX_SAFE_INTEGER);
    expect(updated.complained).toBe(false);
    expect(updated.opened).toBe(false);
  };

  it("gracefully handles invalid event structure - missing type", async () => {
    await exec({
      created_at: "2024-01-01T00:00:00Z",
      data: {
        email_id: "test-resend-id-123",
        from: "test@example.com",
        to: "recipient@example.com",
        subject: "Test Email",
      },
    });
    await unchanged();
  });

  it("gracefully handles invalid event structure - missing data", async () => {
    await exec({ type: "email.delivered", created_at: "2024-01-01T00:00:00Z" });
    await unchanged();
  });

  it("gracefully handles completely invalid event", async () => {
    await exec("not an object");
    await unchanged();
  });

  it("gracefully handles null event", async () => {
    await exec(null);
    await unchanged();
  });

  it("gracefully handles empty object event", async () => {
    await exec({});
    await unchanged();
  });
});

describe("vEmailEvent parsing", () => {
  it("keeps message_id but strips unknown fields", () => {
    const sent = createTestEventOfType("email.sent");
    const raw = { ...sent, data: { ...sent.data, some_future_resend_field: "should be stripped" } };
    const result = attemptToParse(vEmailEvent, raw as unknown);
    if (result.kind !== "success") throw new Error(String(result.error));
    expect(result.data.data.message_id).toBe("<test-message-id@example.com>");
    expect("some_future_resend_field" in result.data.data).toBe(false);
  });
});

const baseOptions = { apiKey: "test-key", initialBackoffMs: 1000, retryAttempts: 3, testMode: true };

describe("sendEmail with templates", () => {
  let t: Tester;
  beforeEach(async () => {
    t = setupTest();
    await setupTestLastOptions(t);
  });

  it("should accept template-based email", async () => {
    const emailId: Id<"emails"> = await t.mutation(api.lib.sendEmail, {
      options: baseOptions,
      from: "test@resend.dev",
      to: ["delivered@resend.dev"],
      template: { id: "order-confirmation", variables: { PRODUCT: "Vintage Macintosh", PRICE: 499 } },
    });
    const email = (await getEmail(t, emailId)) as Doc<"emails">;
    expect(email.template?.id).toBe("order-confirmation");
    expect(email.template?.variables).toEqual({ PRODUCT: "Vintage Macintosh", PRICE: 499 });
    expect(email.subject).toBeUndefined();
    expect(email.html).toBeUndefined();
    expect(email.text).toBeUndefined();
    expect(email.status).toBe("waiting");
  });

  it("should reject email with both template and html/text", async () => {
    await expect(
      t.mutation(api.lib.sendEmail, {
        options: baseOptions,
        from: "test@resend.dev",
        to: ["delivered@resend.dev"],
        subject: "Test",
        html: "<p>Test</p>",
        template: { id: "order-confirmation", variables: { PRODUCT: "Test" } },
      }),
    ).rejects.toThrow("Cannot provide both html/text and template");
  });

  it("should accept template email with optional subject", async () => {
    const emailId: Id<"emails"> = await t.mutation(api.lib.sendEmail, {
      options: baseOptions,
      from: "test@resend.dev",
      to: ["delivered@resend.dev"],
      subject: "Custom Subject Override",
      template: { id: "order-confirmation", variables: { PRODUCT: "Test" } },
    });
    const email = (await getEmail(t, emailId)) as Doc<"emails">;
    expect(email.template?.id).toBe("order-confirmation");
    expect(email.template?.variables).toEqual({ PRODUCT: "Test" });
    expect(email.subject).toBe("Custom Subject Override");
    expect(email.status).toBe("waiting");
  });

  it("should reject email without content or template", async () => {
    await expect(
      t.mutation(api.lib.sendEmail, { options: baseOptions, from: "test@resend.dev", to: ["delivered@resend.dev"] }),
    ).rejects.toThrow("Either html/text or template must be provided");
  });

  it("should reject traditional email without subject", async () => {
    await expect(
      t.mutation(api.lib.sendEmail, {
        options: baseOptions,
        from: "test@resend.dev",
        to: ["delivered@resend.dev"],
        html: "<p>Test</p>",
      }),
    ).rejects.toThrow("Subject is required when not using a template");
  });
});

describe("sendEmail with idempotencyKey", () => {
  let t: Tester;
  beforeEach(async () => {
    t = setupTest();
    await setupTestLastOptions(t);
  });

  const send = (idempotencyKey?: string): Promise<Id<"emails">> =>
    t.mutation(api.lib.sendEmail, {
      options: baseOptions,
      from: "test@resend.dev",
      to: ["delivered@resend.dev"],
      subject: "Test",
      html: "<p>Test</p>",
      idempotencyKey,
    });
  const count = async () => ((await t.run((ctx: any) => ctx.db.query("emails").collect())) as unknown[]).length;

  it("persists the idempotencyKey on the email", async () => {
    const emailId = await send("trigger-123");
    expect((await getEmail(t, emailId))?.idempotencyKey).toBe("trigger-123");
  });

  it("returns the existing email id on a duplicate enqueue", async () => {
    const first = await send("trigger-123");
    const second = await send("trigger-123");
    expect(second).toBe(first);
    expect(await count()).toBe(1);
  });

  it("enqueues separate emails for distinct keys", async () => {
    const first = await send("trigger-a");
    const second = await send("trigger-b");
    expect(second).not.toBe(first);
    expect(await count()).toBe(2);
  });

  it("does not dedupe when no key is provided", async () => {
    const first = await send();
    const second = await send();
    expect(second).not.toBe(first);
    expect(await count()).toBe(2);
  });
});

describe("createManualEmail", () => {
  it("persists cc and bcc recipients", async () => {
    const t = setupTest();
    const emailId: Id<"emails"> = await t.mutation(api.lib.createManualEmail, {
      from: "test@resend.dev",
      to: "delivered@resend.dev",
      cc: "cc@resend.dev",
      bcc: ["bcc@resend.dev"],
      subject: "Manual email",
    });
    const email = (await getEmail(t, emailId)) as Doc<"emails">;
    expect(email.to).toEqual(["delivered@resend.dev"]);
    expect(email.cc).toEqual(["cc@resend.dev"]);
    expect(email.bcc).toEqual(["bcc@resend.dev"]);
  });
});

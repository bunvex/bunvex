// Every message and log line of STUDY-200 §1.12, word for word: what the client and the component throw (plain
// errors, as Convex's), and what they log at which level (read from the console, which a deployed function's console
// reaches). The ones the other files already check are named there: the sendEmail and Svix refusals (lib.test.ts,
// client.test.ts, webhook.test.ts), `Resend API error: …` (send.test.ts) and `Cleaned up <n> emails` (cleanup.test.ts).
// biome-ignore-all lint/suspicious/noExplicitAny: the inline functions' ctx is untyped
import { describe, expect, setDefaultTimeout, test } from "bun:test";
import { componentsGeneric } from "@bunvex/server";
import { Resend, type ResendComponent } from "../src/client/index.ts";
import type { Id } from "../src/component/_generated/dataModel.ts";
import {
  api,
  captureLogs,
  createTestEventOfType,
  getEmail,
  insertTestSentEmail,
  options,
  plainEmail,
  setupTest,
  setupTestLastOptions,
} from "./helpers.ts";

setDefaultTimeout(30_000);

const TEST_MODE =
  "Test mode is enabled, but email address is not a valid resend test address. Did you want to set testMode: false in your ResendOptions?";

describe("thrown", () => {
  test("Webhook secret is not set (before the request is read)", async () => {
    const resend = new Resend(componentsGeneric().resend as unknown as ResendComponent, { webhookSecret: "" });
    let read = false;
    const text = async () => {
      read = true;
      return "{}";
    };
    const req = { text, headers: new Headers() } as unknown as Request;
    await expect(resend.handleResendEventWebhook({} as any, req)).rejects.toThrow("Webhook secret is not set");
    expect(read).toBe(false);
  });

  test("the test-mode refusal covers to, cc and bcc, not from or replyTo; a known idempotencyKey skips every check", async () => {
    const t = setupTest();
    await setupTestLastOptions(t);
    for (const field of [
      { to: ["x@example.com"] },
      { cc: ["x@example.com"] },
      { bcc: ["delivered@resend.dev", "x@y.z"] },
    ]) {
      await expect(t.mutation(api.lib.sendEmail, plainEmail(field))).rejects.toThrow(TEST_MODE);
    }
    await t.mutation(api.lib.sendEmail, plainEmail({ from: "anyone@example.com", replyTo: ["anyone@example.com"] }));
    await t.mutation(api.lib.sendEmail, plainEmail({ to: ["x@example.com"], options: options({ testMode: false }) }));
    const first = await t.mutation(api.lib.sendEmail, plainEmail({ idempotencyKey: "k" }));
    await t.mutation(api.lib.cancelEmail, { emailId: first });
    // Invalid addresses, no content: the earlier (cancelled) email's id all the same.
    expect(
      await t.mutation(api.lib.sendEmail, { options: options(), from: "a", to: ["nobody@x.com"], idempotencyKey: "k" }),
    ).toBe(first);
  });

  test("the content checks come after test mode; an empty body counts as content", async () => {
    const t = setupTest();
    await expect(
      t.mutation(api.lib.sendEmail, { options: options(), from: "a", to: ["x@x.com"], subject: "s" }),
    ).rejects.toThrow(TEST_MODE);
    await expect(
      t.mutation(api.lib.sendEmail, {
        options: options(),
        from: "a",
        to: ["delivered@resend.dev"],
        text: "x",
        template: { id: "t" },
      }),
    ).rejects.toThrow("Cannot provide both html/text and template");
    expect(
      typeof (await t.mutation(api.lib.sendEmail, {
        options: options(),
        from: "a",
        to: ["delivered@resend.dev"],
        subject: "s",
        text: "",
      })),
    ).toBe("string");
  });

  test("cancelEmail: Email not found; Email has already been sent", async () => {
    const t = setupTest();
    await setupTestLastOptions(t);
    const sent = await insertTestSentEmail(t);
    await expect(t.mutation(api.lib.cancelEmail, { emailId: sent._id })).rejects.toThrow("Email has already been sent");
    await t.run((ctx: any) => ctx.db.delete("emails", sent._id));
    await expect(t.mutation(api.lib.cancelEmail, { emailId: sent._id })).rejects.toThrow("Email not found");
  });

  test("makeBatch: No last options found -- invariant; No batch run found -- invariant", async () => {
    const t = setupTest();
    await expect(t.mutation(api.lib.makeBatch, { reloop: false, segment: 1 })).rejects.toThrow(
      "No last options found -- invariant",
    );
    await setupTestLastOptions(t);
    // Nothing waits and no run is recorded: idling finds no row to delete.
    await expect(t.mutation(api.lib.makeBatch, { reloop: false, segment: 1 })).rejects.toThrow(
      "No batch run found -- invariant",
    );
  });

  test("getAllContentByIds: Content not found -- invariant; getEmailByResendId: Email not found for resendId", async () => {
    const t = setupTest();
    const id = await t.run(async (ctx: any) => {
      const c = await ctx.db.insert("content", { content: new ArrayBuffer(0), mimeType: "text/plain" });
      await ctx.db.delete("content", c);
      return c;
    });
    await expect(t.query(api.lib.getAllContentByIds, { contentIds: [id] })).rejects.toThrow(
      "Content not found -- invariant",
    );
    await expect(t.query(api.lib.getEmailByResendId, { resendId: "nope" })).rejects.toThrow(
      "Email not found for resendId",
    );
    await insertTestSentEmail(t, { resendId: "here" });
    expect(await t.query(api.lib.getEmailByResendId, { resendId: "here" })).toMatchObject({ resendId: "here" });
  });
});

describe("logged", () => {
  test("log: Making a batch of <n> emails; No emails to send in batch. All were cancelled or failed.", async () => {
    const t = setupTest({ outboundFetch: () => Response.json({ data: [{ id: "re_1" }, { id: "re_2" }] }) });
    await setupTestLastOptions(t);
    await t.mutation(api.lib.sendEmail, plainEmail());
    const b = (await t.mutation(api.lib.sendEmail, plainEmail())) as Id<"emails">;
    const { lines } = await captureLogs(async () => {
      await t.finishAllScheduledFunctions(undefined, 1000);
      // A batch whose emails were all cancelled meanwhile.
      await t.run((ctx: any) => ctx.db.patch("emails", b, { status: "cancelled" }));
      await t.action(api.lib.callResendAPIWithBatch, { apiKey: "k", emails: [b] });
    });
    expect(lines).toContain("log: Making a batch of 2 emails");
    expect(lines).toContain("log: No emails to send in batch. All were cancelled or failed.");
  });

  test("error: the permanent failure, as one JSON line", async () => {
    const t = setupTest({ outboundFetch: () => new Response("bad key", { status: 401, statusText: "Unauthorized" }) });
    await setupTestLastOptions(t);
    const id = (await t.mutation(api.lib.sendEmail, plainEmail())) as Id<"emails">;
    const { lines } = await captureLogs(() => t.finishAllScheduledFunctions(undefined, 1000));
    const errorMessage = "Resend API error: 401 Unauthorized bad key";
    expect(lines).toContain(
      `error: ${JSON.stringify({ status: "permanent_failure", httpStatus: 401, httpStatusText: "Unauthorized", errorMessage, emailIds: [id] })}`,
    );
    expect(await getEmail(t, id)).toMatchObject({ status: "failed", errorMessage });
  });

  test("warn: an invalid event, with the doubled 'to'; info: an unknown resendId", async () => {
    const t = setupTest();
    await setupTestLastOptions(t);
    const { lines } = await captureLogs(async () => {
      await t.mutation(api.lib.handleEmailEvent, { event: { type: "domain.created", created_at: "x", data: {} } });
      await t.mutation(api.lib.handleEmailEvent, {
        event: createTestEventOfType("email.opened", { data: { email_id: "re_unknown" } } as never),
      });
    });
    const warn = lines.find((l) => l.startsWith("warn: "));
    expect(warn).toStartWith(
      "warn: Invalid email event received. You might want to to exclude this event from your Resend webhook settings in the Resend dashboard. ",
    );
    expect(warn).toEndWith(".");
    expect(lines).toContain("info: Email not found for resendId: re_unknown, ignoring...");
  });
});

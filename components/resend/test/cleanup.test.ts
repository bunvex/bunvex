// The cleanups past one page (STUDY-200 §1.11), the manual emails' `Infinity` segment in index ranges (§3.2's second
// platform check), and the reads: `get` and `getStatus` on old rows, missing rows and missing bodies.
// biome-ignore-all lint/suspicious/noExplicitAny: the inline functions' ctx is untyped
import { describe, expect, setDefaultTimeout, test } from "bun:test";
import type { Doc, Id } from "../src/component/_generated/dataModel.ts";
import {
  all,
  api,
  captureLogs,
  DAY,
  getEmail,
  insertTestSentEmail,
  setupTest,
  setupTestLastOptions,
} from "./helpers.ts";

setDefaultTimeout(60_000);

const baseRow = {
  from: "a@x.com",
  to: ["b@x.com"],
  subject: "s",
  replyTo: [],
  complained: false,
  opened: false,
  segment: 1,
};

/** `n` emails with a body and a delivery event each, inserted in one transaction. */
const seed = (t: ReturnType<typeof setupTest>, n: number, fields: Partial<Doc<"emails">>) =>
  t.run(async (ctx: any) => {
    for (let i = 0; i < n; i++) {
      const text = await ctx.db.insert("content", {
        content: new TextEncoder().encode("x").buffer,
        mimeType: "text/plain",
      });
      const emailId = await ctx.db.insert("emails", {
        ...baseRow,
        status: "delivered",
        finalizedAt: Number.MAX_SAFE_INTEGER,
        text,
        resendId: `r${i}`,
        ...fields,
      });
      await ctx.db.insert("deliveryEvents", {
        emailId,
        resendId: `r${i}`,
        eventType: "email.delivered",
        createdAt: "2024-01-01T00:00:00Z",
      });
    }
  });

const counts = async (t: ReturnType<typeof setupTest>) => ({
  emails: (await all(t, "emails")).length,
  content: (await all(t, "content")).length,
  deliveryEvents: (await all(t, "deliveryEvents")).length,
});

describe("cleanupOldEmails", () => {
  test("removes finalized emails older than 7 days with their bodies and events, 100 a page, going on while full", async () => {
    const t = setupTest();
    const old = t.now() - 8 * DAY;
    await seed(t, 250, { finalizedAt: old });
    await seed(t, 3, { finalizedAt: t.now() - 6 * DAY });
    await seed(t, 4, { status: "sent" });
    await seed(t, 2, { status: "delivery_delayed" });
    const { lines } = await captureLogs(async () => {
      await t.mutation(api.lib.cleanupOldEmails, {});
      expect((await counts(t)).emails).toBe(159);
      await t.finishAllScheduledFunctions(undefined, 100);
    });
    expect(await counts(t)).toEqual({ emails: 9, content: 9, deliveryEvents: 9 });
    expect(lines.filter((l) => l.includes("Cleaned up"))).toEqual([
      "log: Cleaned up 100 emails",
      "log: Cleaned up 100 emails",
      "log: Cleaned up 50 emails",
    ]);
    // With an age, the 6-day-old ones go too; never the unfinalized.
    await t.mutation(api.lib.cleanupOldEmails, { olderThan: DAY });
    expect((await all<Doc<"emails">>(t, "emails")).map((e) => e.status).sort()).toEqual([
      "delivery_delayed",
      "delivery_delayed",
      "sent",
      "sent",
      "sent",
      "sent",
    ]);
  });

  test("nothing to remove: no log, nothing scheduled", async () => {
    const t = setupTest();
    await setupTestLastOptions(t);
    const { lines } = await captureLogs(() => t.mutation(api.lib.cleanupOldEmails, {}));
    expect(lines.filter((l) => l.includes("Cleaned up"))).toEqual([]);
  });
});

describe("cleanupAbandonedEmails", () => {
  test("removes emails created more than 30 days ago whatever their status, 500 a page, going on while full", async () => {
    const t = setupTest();
    await seed(t, 600, { status: "waiting" });
    await seed(t, 500, { status: "queued" });
    await seed(t, 5, { status: "sent" });
    await t.advanceTime(31 * DAY);
    await seed(t, 7, { status: "waiting" });
    const { lines } = await captureLogs(async () => {
      await t.mutation(api.lib.cleanupAbandonedEmails, {});
      await t.finishAllScheduledFunctions(undefined, 100);
    });
    expect(await counts(t)).toEqual({ emails: 7, content: 7, deliveryEvents: 7 });
    expect(lines.filter((l) => l.includes("Cleaned up"))).toEqual([
      "log: Cleaned up 500 emails",
      "log: Cleaned up 500 emails",
      "log: Cleaned up 105 emails",
    ]);
    await t.advanceTime(2 * DAY);
    await t.mutation(api.lib.cleanupAbandonedEmails, { olderThan: DAY });
    expect((await counts(t)).emails).toBe(0);
  });
});

describe("Infinity in an index range", () => {
  test("a manual email's segment is Infinity: outside every finite range, inside ranges that reach Infinity", async () => {
    const t = setupTest();
    const manual = (await t.mutation(api.lib.createManualEmail, {
      from: "a@x.com",
      to: ["b@x.com"],
      subject: "s",
    })) as Id<"emails">;
    expect((await getEmail(t, manual))?.segment).toBe(Number.POSITIVE_INFINITY);
    // A waiting row at Infinity and one at -Infinity, beside finite ones.
    const ids = await t.run(async (ctx: any) => ({
      inf: await ctx.db.insert("emails", { ...baseRow, status: "waiting", segment: Infinity, finalizedAt: 0 }),
      negInf: await ctx.db.insert("emails", { ...baseRow, status: "waiting", segment: -Infinity, finalizedAt: 0 }),
      big: await ctx.db.insert("emails", { ...baseRow, status: "waiting", segment: Number.MAX_VALUE, finalizedAt: 0 }),
      one: await ctx.db.insert("emails", { ...baseRow, status: "waiting", segment: 1, finalizedAt: 0 }),
    }));
    const range = (build: (q: any) => any) =>
      t.run(async (ctx: any) =>
        (await ctx.db.query("emails").withIndex("by_status_segment", build).collect()).map((e: any) => e._id),
      ) as Promise<string[]>;
    expect(await range((q) => q.eq("status", "queued").gt("segment", 1e300))).toEqual([manual]);
    expect(await range((q) => q.eq("status", "queued").lte("segment", Infinity))).toEqual([manual]);
    expect(await range((q) => q.eq("status", "queued").lt("segment", Infinity))).toEqual([]);
    expect(await range((q) => q.eq("status", "queued").eq("segment", Infinity))).toEqual([manual]);
    expect(await range((q) => q.eq("status", "waiting"))).toEqual([ids.negInf, ids.one, ids.big, ids.inf]);
    expect(await range((q) => q.eq("status", "waiting").lte("segment", 1e9))).toEqual([ids.negInf, ids.one]);
    expect(await range((q) => q.eq("status", "waiting").gte("segment", -Infinity).lt("segment", Infinity))).toEqual([
      ids.negInf,
      ids.one,
      ids.big,
    ]);
    expect(await range((q) => q.eq("status", "waiting").gt("segment", Number.MAX_VALUE))).toEqual([ids.inf]);
    // The batcher's range: a waiting row at Infinity is never batched; a finite one is.
    await setupTestLastOptions(t);
    await t.mutation(api.lib.makeBatch, { reloop: false, segment: 1e12 });
    expect((await getEmail(t, ids.inf))?.status).toBe("waiting");
    expect((await getEmail(t, ids.one))?.status).toBe("queued");
  });
});

describe("the reads", () => {
  test("get: a missing body decodes to an empty string; an old row's string `to` comes back as an array", async () => {
    const t = setupTest();
    const email = await insertTestSentEmail(t, { to: "old@x.com" as never });
    const withBody = await t.run(async (ctx: any) => {
      const html = await ctx.db.insert("content", {
        content: new TextEncoder().encode("<p/>").buffer,
        mimeType: "text/html",
      });
      const id = await ctx.db.insert("emails", { ...baseRow, status: "sent", html, finalizedAt: 1 });
      await ctx.db.delete("content", html);
      return id;
    });
    expect(await t.query(api.lib.get, { emailId: email._id })).toMatchObject({ to: ["old@x.com"] });
    expect(await t.query(api.lib.get, { emailId: withBody })).toMatchObject({ html: "" });
  });

  test("getStatus: older rows' missing flags read false; a removed email reads null", async () => {
    const t = setupTest();
    const id = await t.run((ctx: any) =>
      ctx.db.insert("emails", { ...baseRow, status: "sent", finalizedAt: Number.MAX_SAFE_INTEGER }),
    );
    expect(await t.query(api.lib.getStatus, { emailId: id })).toEqual({
      status: "sent",
      errorMessage: null,
      bounced: false,
      complained: false,
      failed: false,
      deliveryDelayed: false,
      opened: false,
      clicked: false,
    });
    await t.run((ctx: any) => ctx.db.delete("emails", id));
    expect(await t.query(api.lib.getStatus, { emailId: id })).toBeNull();
    expect(await t.query(api.lib.get, { emailId: id })).toBeNull();
  });

  test("updateManualEmail: an absent resendId or errorMessage removes the stored one; failed and cancelled finalize", async () => {
    const t = setupTest();
    const id = (await t.mutation(api.lib.createManualEmail, {
      from: "a@x.com",
      to: "b@x.com",
      subject: "s",
    })) as Id<"emails">;
    await t.mutation(api.lib.updateManualEmail, { emailId: id, status: "sent", resendId: "re_1", errorMessage: "e" });
    expect(await getEmail(t, id)).toMatchObject({
      resendId: "re_1",
      errorMessage: "e",
      finalizedAt: Number.MAX_SAFE_INTEGER,
    });
    await t.mutation(api.lib.updateManualEmail, { emailId: id, status: "delivered" });
    const row = (await getEmail(t, id))!;
    expect(row.resendId).toBeUndefined();
    expect(row.errorMessage).toBeUndefined();
    expect(row.finalizedAt).toBe(Number.MAX_SAFE_INTEGER);
    await t.mutation(api.lib.updateManualEmail, { emailId: id, status: "cancelled" });
    expect((await getEmail(t, id))!.finalizedAt).toBeLessThan(Number.MAX_SAFE_INTEGER);
  });
});

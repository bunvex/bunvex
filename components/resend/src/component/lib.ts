// The component's functions (STUDY-200 §1.5–§1.11), with the paths, arguments, results, constants, messages and log
// lines of Convex's resend 0.2.10 (`src/component/lib.ts`):
//
// - `sendEmail` stores an email as `waiting` and makes sure the batcher runs; `makeBatch` takes up to 100 emails
//   asked for at least two 125 ms segments ago, marks them `queued` and hands them to `emailWorkpool`, spaced by a
//   600 ms fixed window on `rateLimiter`; `callResendAPIWithBatch` posts them to Resend's batch API and
//   `onEmailComplete` records the outcome;
// - `createManualEmail` / `updateManualEmail` keep the record of an email the app sends itself;
// - `handleEmailEvent` applies a Resend webhook event, moving the status only up its rank, and enqueues the app's
//   `onEmailEvent` on `callbackWorkpool`;
// - `cancelEmail`, `getStatus`, `get` and the two cleanups.
//
// The quirks of §2.3 are kept (R-6): `lastOptions` is global and last-writer-wins, the Idempotency-Key is the first
// id of the batch as enqueued, a permanent HTTP failure is a successful job, a `sent` written by `onEmailComplete`
// overwrites a late cancel, flags change on cancelled emails.
import { omit } from "@bunvex/helpers";
import { parse } from "@bunvex/helpers/validators";
import { RateLimiter } from "@bunvex/rate-limiter";
import type { FunctionReference } from "@bunvex/server";
import { v } from "@bunvex/values";
import { Workpool } from "@bunvex/workpool";
import { api, components, internal } from "./_generated/api";
import type { Doc, Id } from "./_generated/dataModel";
import {
  type ActionCtx,
  internalAction,
  internalMutation,
  internalQuery,
  type MutationCtx,
  mutation,
  query,
} from "./_generated/server";
import schema from "./schema";
import {
  ACCEPTED_EVENT_TYPES,
  type EmailEvent,
  type RuntimeConfig,
  vEmailEvent,
  vOptions,
  vStatus,
  vTemplate,
} from "./shared";
import { assertExhaustive, attemptToParse, isDeepEqual, isTestEmail } from "./utils";

/** The width of a send-request segment. */
const SEGMENT_MS = 125;
/** How long the batcher waits after idling, or after a short batch. */
const BASE_BATCH_DELAY = 1000;
/** The most emails in one call to Resend's batch API (its maximum). */
const BATCH_SIZE = 100;
const EMAIL_POOL_SIZE = 4;
const CALLBACK_POOL_SIZE = 4;
/** One batch call per this many ms across the deployment: half of Resend's stated limit. */
const RESEND_ONE_CALL_EVERY_MS = 600;
/** The most jitter added to a rate-limited batch's delay. */
const FIXED_WINDOW_DELAY = 100;
const DAY = 24 * 60 * 60 * 1000;
/** `cleanupOldEmails`'s default age. */
const FINALIZED_EMAIL_RETENTION_MS = 7 * DAY;
/** `cleanupAbandonedEmails`'s default age. */
const ABANDONED_EMAIL_RETENTION_MS = 30 * DAY;
/** `finalizedAt` of an email not final yet. */
const FINALIZED_EPOCH = Number.MAX_SAFE_INTEGER;
const CLEANUP_OLD_PAGE = 100;
const CLEANUP_ABANDONED_PAGE = 500;
const RESEND_BATCH_URL = "https://api.resend.com/emails/batch";

// The HTTP statuses a batch call does not retry (Convex's `PERMANENT_ERROR_CODES`). Left out, so retried: 402, 409,
// 412, 417, 423–425, 429, 451 and every 5xx.
const PERMANENT_ERROR_CODES = new Set([
  400, 401, 403, 404, 405, 406, 407, 408, 410, 411, 413, 414, 415, 416, 418, 421, 422, 426, 427, 428, 431,
]);

/** The segment `now` falls in. */
const segmentOf = (now: number) => Math.floor(now / SEGMENT_MS);

const emailPool = new Workpool(components.emailWorkpool, { maxParallelism: EMAIL_POOL_SIZE });
const callbackPool = new Workpool(components.callbackWorkpool, { maxParallelism: CALLBACK_POOL_SIZE });
const resendApiLimit = new RateLimiter(components.rateLimiter, {
  resendApi: { kind: "fixed window", period: RESEND_ONE_CALL_EVERY_MS, rate: 1 },
});

const vHeaders = v.array(v.object({ name: v.string(), value: v.string() }));
const vBatchReturns = v.union(
  v.null(),
  v.object({ emailIds: v.array(v.id("emails")), resendIds: v.array(v.string()) }),
);

type Email = Doc<"emails">;
type EmailStatus = Email["status"];

/** Remove up to a page of finalized emails older than `olderThan` (7 days by default), and go on while pages are full. */
export const cleanupOldEmails = mutation({
  args: { olderThan: v.optional(v.number()) },
  returns: v.null(),
  handler: async (ctx, args) => {
    const olderThan = args.olderThan ?? FINALIZED_EMAIL_RETENTION_MS;
    const cutoff = Date.now() - olderThan;
    const page = await ctx.db
      .query("emails")
      .withIndex("by_finalizedAt", (q) => q.lt("finalizedAt", cutoff))
      .take(CLEANUP_OLD_PAGE);
    await removeEmails(ctx, page);
    if (page.length === CLEANUP_OLD_PAGE) {
      await ctx.scheduler.runAfter(0, api.lib.cleanupOldEmails, { olderThan });
    }
    return null;
  },
});

/** Remove up to a page of emails created more than `olderThan` ago (30 days by default), whatever their status. */
export const cleanupAbandonedEmails = mutation({
  args: { olderThan: v.optional(v.number()) },
  returns: v.null(),
  handler: async (ctx, args) => {
    const olderThan = args.olderThan ?? ABANDONED_EMAIL_RETENTION_MS;
    const cutoff = Date.now() - olderThan;
    const page = await ctx.db
      .query("emails")
      .withIndex("by_creation_time", (q) => q.lt("_creationTime", cutoff))
      .take(CLEANUP_ABANDONED_PAGE);
    await removeEmails(ctx, page);
    if (page.length === CLEANUP_ABANDONED_PAGE) {
      await ctx.scheduler.runAfter(0, api.lib.cleanupAbandonedEmails, { olderThan });
    }
    return null;
  },
});

/** Delete each email with its bodies and its delivery events; log how many when any. */
async function removeEmails(ctx: MutationCtx, emails: Email[]) {
  for (const email of emails) {
    await ctx.db.delete("emails", email._id);
    if (email.text) await ctx.db.delete("content", email.text);
    if (email.html) await ctx.db.delete("content", email.html);
    const events = await ctx.db
      .query("deliveryEvents")
      .withIndex("by_emailId_eventType", (q) => q.eq("emailId", email._id))
      .collect();
    for (const event of events) await ctx.db.delete("deliveryEvents", event._id);
  }
  if (emails.length > 0) console.log(`Cleaned up ${emails.length} emails`);
}

/** Queue an email: it is stored as `waiting` and goes out in the next batch. */
export const sendEmail = mutation({
  args: {
    options: vOptions,
    from: v.string(),
    to: v.array(v.string()),
    cc: v.optional(v.array(v.string())),
    bcc: v.optional(v.array(v.string())),
    subject: v.optional(v.string()),
    html: v.optional(v.string()),
    text: v.optional(v.string()),
    template: v.optional(vTemplate),
    replyTo: v.optional(v.array(v.string())),
    headers: v.optional(vHeaders),
    idempotencyKey: v.optional(v.string()),
  },
  returns: v.id("emails"),
  handler: async (ctx, args) => {
    // A known key returns its email before any other check, whatever that email became.
    if (args.idempotencyKey !== undefined) {
      const key = args.idempotencyKey;
      const known = await ctx.db
        .query("emails")
        .withIndex("by_idempotencyKey", (q) => q.eq("idempotencyKey", key))
        .first();
      if (known) return known._id;
    }

    if (args.options.testMode) {
      const recipients = [...args.to, ...(args.cc ?? []), ...(args.bcc ?? [])];
      if (recipients.some((address) => !isTestEmail(address))) {
        throw new Error(
          "Test mode is enabled, but email address is not a valid resend test address. Did you want to set testMode: false in your ResendOptions?",
        );
      }
    }

    const hasBody = args.html !== undefined || args.text !== undefined;
    const hasTemplate = args.template?.id !== undefined;
    if (!hasBody && !hasTemplate) throw new Error("Either html/text or template must be provided");
    if (hasBody && hasTemplate) throw new Error("Cannot provide both html/text and template");
    if (!hasTemplate && args.subject === undefined) throw new Error("Subject is required when not using a template");

    // The bodies live in `content`, so a batch reads only the emails' small rows until it builds its request.
    const html = args.html === undefined ? undefined : await storeBody(ctx, args.html, "text/html");
    const text = args.text === undefined ? undefined : await storeBody(ctx, args.text, "text/plain");

    const emailId = await ctx.db.insert("emails", {
      from: args.from,
      to: args.to,
      cc: args.cc,
      bcc: args.bcc,
      subject: args.subject,
      html,
      text,
      template: args.template,
      headers: args.headers,
      idempotencyKey: args.idempotencyKey,
      segment: segmentOf(Date.now()),
      status: "waiting",
      bounced: false,
      complained: false,
      failed: false,
      deliveryDelayed: false,
      opened: false,
      clicked: false,
      replyTo: args.replyTo ?? [],
      finalizedAt: FINALIZED_EPOCH,
    });
    await ensureBatcher(ctx, args.options);
    return emailId;
  },
});

function storeBody(ctx: MutationCtx, body: string, mimeType: string): Promise<Id<"content">> {
  return ctx.db.insert("content", { content: new TextEncoder().encode(body).buffer as ArrayBuffer, mimeType });
}

/** Keep the sender's options as the last ones, and start the batcher unless it runs. */
async function ensureBatcher(ctx: MutationCtx, options: RuntimeConfig) {
  const stored = await ctx.db.query("lastOptions").unique();
  if (stored === null) await ctx.db.insert("lastOptions", { options });
  else if (!isDeepEqual(stored.options, options)) await ctx.db.replace("lastOptions", stored._id, { options });

  if ((await ctx.db.query("nextBatchRun").unique()) !== null) return;
  const runId = await ctx.scheduler.runAfter(BASE_BATCH_DELAY, internal.lib.makeBatch, {
    reloop: false,
    segment: segmentOf(Date.now() + BASE_BATCH_DELAY),
  });
  await ctx.db.insert("nextBatchRun", { runId });
}

const toArray = (value: string | string[] | undefined) =>
  value === undefined ? undefined : Array.isArray(value) ? value : [value];

/** Record an email the app sends itself: `queued`, in no segment's range (`Infinity`). */
export const createManualEmail = mutation({
  args: {
    from: v.string(),
    to: v.union(v.array(v.string()), v.string()),
    cc: v.optional(v.union(v.array(v.string()), v.string())),
    bcc: v.optional(v.union(v.array(v.string()), v.string())),
    subject: v.string(),
    replyTo: v.optional(v.array(v.string())),
    headers: v.optional(vHeaders),
  },
  returns: v.id("emails"),
  handler: (ctx, args) =>
    ctx.db.insert("emails", {
      from: args.from,
      to: toArray(args.to) as string[],
      cc: toArray(args.cc),
      bcc: toArray(args.bcc),
      subject: args.subject,
      headers: args.headers,
      segment: Number.POSITIVE_INFINITY,
      status: "queued",
      bounced: false,
      complained: false,
      failed: false,
      deliveryDelayed: false,
      opened: false,
      clicked: false,
      replyTo: args.replyTo ?? [],
      finalizedAt: FINALIZED_EPOCH,
    }),
});

/** Record how an email the app sent itself went: its status, and Resend's id or the error. */
export const updateManualEmail = mutation({
  args: {
    emailId: v.id("emails"),
    status: vStatus,
    resendId: v.optional(v.string()),
    errorMessage: v.optional(v.string()),
  },
  returns: v.null(),
  handler: async (ctx, args) => {
    const final = args.status === "failed" || args.status === "cancelled";
    // An absent `resendId` or `errorMessage` removes the stored one.
    await ctx.db.patch("emails", args.emailId, {
      status: args.status,
      resendId: args.resendId,
      errorMessage: args.errorMessage,
      ...(final ? { finalizedAt: Date.now() } : {}),
    });
    return null;
  },
});

/** Cancel an email not sent yet (`waiting` or `queued`); a batch that holds it leaves it out. */
export const cancelEmail = mutation({
  args: { emailId: v.id("emails") },
  returns: v.null(),
  handler: async (ctx, args) => {
    const email = await ctx.db.get("emails", args.emailId);
    if (!email) throw new Error("Email not found");
    if (email.status !== "waiting" && email.status !== "queued") throw new Error("Email has already been sent");
    await ctx.db.patch("emails", args.emailId, { status: "cancelled", finalizedAt: Date.now() });
    return null;
  },
});

/** An email's status and flags, or null. */
export const getStatus = query({
  args: { emailId: v.id("emails") },
  returns: v.union(
    v.object({
      status: vStatus,
      errorMessage: v.union(v.string(), v.null()),
      bounced: v.boolean(),
      complained: v.boolean(),
      failed: v.boolean(),
      deliveryDelayed: v.boolean(),
      opened: v.boolean(),
      clicked: v.boolean(),
    }),
    v.null(),
  ),
  handler: async (ctx, args) => {
    const email = await ctx.db.get("emails", args.emailId);
    if (!email) return null;
    return {
      status: email.status,
      errorMessage: email.errorMessage ?? null,
      bounced: email.bounced ?? false,
      complained: email.complained,
      failed: email.failed ?? false,
      deliveryDelayed: email.deliveryDelayed ?? false,
      opened: email.opened,
      clicked: email.clicked ?? false,
    };
  },
});

/** A whole email, its bodies decoded, or null. */
export const get = query({
  args: { emailId: v.id("emails") },
  returns: v.union(
    v.object({
      ...omit(schema.tables.emails.validator.fields, ["html", "text"]),
      createdAt: v.number(),
      html: v.optional(v.string()),
      text: v.optional(v.string()),
      to: v.array(v.string()),
    }),
    v.null(),
  ),
  handler: async (ctx, args) => {
    const email = await ctx.db.get("emails", args.emailId);
    if (!email) return null;
    // A body whose row is gone decodes to "".
    const decode = async (id: Id<"content"> | undefined) =>
      id ? new TextDecoder().decode((await ctx.db.get("content", id))?.content) : undefined;
    const html = await decode(email.html);
    const text = await decode(email.text);
    return {
      ...omit(email, ["html", "text", "_id", "_creationTime"]),
      createdAt: email._creationTime,
      html,
      text,
      to: Array.isArray(email.to) ? email.to : [email.to],
    };
  },
});

/**
 * The batcher: one batch of up to 100 emails asked for by `segment - 2`, handed to the email pool, then again at once;
 * a short batch on a reloop, or none, waits a second (or idles when nothing waits).
 */
export const makeBatch = internalMutation({
  args: { reloop: v.boolean(), segment: v.number() },
  returns: v.null(),
  handler: async (ctx, args) => {
    const stored = await ctx.db.query("lastOptions").unique();
    if (!stored) throw new Error("No last options found -- invariant");
    const { options } = stored;

    // Two segments of slack, so the batch does not contend with the emails being inserted now.
    const last = args.segment - 2;
    const batch = await ctx.db
      .query("emails")
      .withIndex("by_status_segment", (q) => q.eq("status", "waiting").lte("segment", last))
      .take(BATCH_SIZE);

    if (batch.length === 0 || (args.reloop && batch.length < BATCH_SIZE)) {
      await rescheduleOrIdle(ctx, batch.length > 0);
      return null;
    }

    console.log(`Making a batch of ${batch.length} emails`);
    const emailIds = batch.map((email) => email._id);
    for (const id of emailIds) await ctx.db.patch("emails", id, { status: "queued" });

    const runAfter = await rateLimitDelay(ctx);
    await emailPool.enqueueAction(
      ctx,
      internal.lib.callResendAPIWithBatch,
      { apiKey: options.apiKey, emails: emailIds },
      {
        retry: { maxAttempts: options.retryAttempts, initialBackoffMs: options.initialBackoffMs, base: 2 },
        runAfter,
        context: { emailIds },
        onComplete: internal.lib.onEmailComplete,
      },
    );
    await ctx.scheduler.runAfter(0, internal.lib.makeBatch, { reloop: true, segment: args.segment });
    return null;
  },
});

/** Run the batcher again in a second if any email waits (`waiting` known), else stop it. */
async function rescheduleOrIdle(ctx: MutationCtx, waiting: boolean) {
  const anyWaiting =
    waiting ||
    (await ctx.db
      .query("emails")
      .withIndex("by_status_segment", (q) => q.eq("status", "waiting"))
      .first()) !== null;
  if (anyWaiting) {
    await ctx.scheduler.runAfter(BASE_BATCH_DELAY, internal.lib.makeBatch, {
      reloop: false,
      segment: segmentOf(Date.now() + BASE_BATCH_DELAY),
    });
    return;
  }
  const running = await ctx.db.query("nextBatchRun").unique();
  if (!running) throw new Error("No batch run found -- invariant");
  await ctx.db.delete("nextBatchRun", running._id);
}

/** How long a new batch call waits: its reservation in the fixed window, plus up to 100 ms of jitter, or 0. */
async function rateLimitDelay(ctx: MutationCtx): Promise<number> {
  const { retryAfter } = await resendApiLimit.limit(ctx, "resendApi", { reserve: true });
  const jitter = Math.random() * FIXED_WINDOW_DELAY;
  return retryAfter ? retryAfter + jitter : 0;
}

/** Send one batch to Resend: the emails still `queued`, with the first enqueued id as the Idempotency-Key. */
export const callResendAPIWithBatch = internalAction({
  args: { apiKey: v.string(), emails: v.array(v.id("emails")) },
  returns: vBatchReturns,
  handler: async (ctx, args) => {
    const request = await buildBatchRequest(ctx, args.emails);
    if (request === null) {
      console.log("No emails to send in batch. All were cancelled or failed.");
      return null;
    }
    const response = await fetch(RESEND_BATCH_URL, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${args.apiKey}`,
        "Content-Type": "application/json",
        "Idempotency-Key": String(args.emails[0]),
      },
      body: request.body,
    });

    if (response.ok) {
      const json = (await response.json()) as { data?: { id: string }[] };
      if (!json.data) throw new Error("Resend API error: No data returned");
      return { emailIds: request.emailIds, resendIds: json.data.map((sent) => sent.id) };
    }
    if (!PERMANENT_ERROR_CODES.has(response.status)) {
      // Retried by the pool.
      throw new Error(`Resend API error: ${await response.text()}`);
    }
    const errorMessage = `Resend API error: ${response.status} ${response.statusText} ${await response.text()}`;
    console.error(
      JSON.stringify({
        status: "permanent_failure",
        httpStatus: response.status,
        httpStatusText: response.statusText,
        errorMessage,
        emailIds: args.emails,
      }),
    );
    await ctx.runMutation(internal.lib.markEmailsFailed, { emailIds: args.emails, errorMessage });
    // The job succeeds: nothing to retry.
    return null;
  },
});

/** The request body for the emails among `ids` still `queued`, and their ids; null when none is. */
async function buildBatchRequest(
  ctx: ActionCtx,
  ids: Id<"emails">[],
): Promise<{ emailIds: Id<"emails">[]; body: string } | null> {
  const found = await ctx.runQuery(internal.lib.getEmailsByIds, { emailIds: ids });
  const emails = (found as Email[]).filter((email) => email.status === "queued");
  if (emails.length === 0) return null;

  const bodyIds = emails.flatMap((email) => [email.html, email.text]).filter((id) => id !== undefined);
  const bodies = new Map(
    (await ctx.runQuery(internal.lib.getAllContentByIds, { contentIds: bodyIds })).map((row) => [row.id, row.content]),
  );

  const payload = emails.map((email) => {
    const entry: Record<string, unknown> = {
      from: email.from,
      to: Array.isArray(email.to) ? email.to : [email.to],
      bcc: email.bcc,
      cc: email.cc,
      reply_to: email.replyTo ? email.replyTo : undefined,
      // A repeated name keeps its last value.
      headers: email.headers ? Object.fromEntries(email.headers.map(({ name, value }) => [name, value])) : undefined,
    };
    if (email.template) {
      entry.template = email.template;
      if (email.subject) entry.subject = email.subject;
    } else {
      entry.subject = email.subject;
      entry.html = email.html ? bodies.get(email.html) : undefined;
      entry.text = email.text ? bodies.get(email.text) : undefined;
    }
    return entry;
  });
  return { emailIds: emails.map((email) => email._id), body: JSON.stringify(payload) };
}

/** Mark the emails among `emailIds` still `queued` as `failed`, with `errorMessage`. */
export const markEmailsFailed = internalMutation({
  args: { emailIds: v.array(v.id("emails")), errorMessage: v.string() },
  returns: v.null(),
  handler: async (ctx, args) => {
    await failQueued(ctx, args.emailIds, args.errorMessage);
    return null;
  },
});

async function failQueued(ctx: MutationCtx, emailIds: Id<"emails">[], errorMessage: string) {
  await Promise.all(
    emailIds.map(async (id) => {
      const email = await ctx.db.get("emails", id);
      if (email?.status !== "queued") return;
      await ctx.db.patch("emails", id, { status: "failed", errorMessage, finalizedAt: Date.now() });
    }),
  );
}

/** A batch job's end: its emails `sent` with Resend's ids, or `failed` / `cancelled` if still `queued`. */
export const onEmailComplete = emailPool.defineOnComplete({
  context: v.object({ emailIds: v.array(v.id("emails")) }),
  handler: async (ctx, { context, result }) => {
    switch (result.kind) {
      case "success": {
        const sent = parse(vBatchReturns, result.returnValue);
        if (sent === null) return;
        // Unconditional: a cancel made after the request was built is overwritten.
        await Promise.all(
          sent.emailIds.map((id, i) => ctx.db.patch("emails", id, { status: "sent", resendId: sent.resendIds[i] })),
        );
        return;
      }
      case "failed":
        await failQueued(ctx, context.emailIds, result.error);
        return;
      case "canceled":
        await Promise.all(
          context.emailIds.map(async (id) => {
            const email = await ctx.db.get("emails", id);
            if (email?.status !== "queued") return;
            await ctx.db.patch("emails", id, {
              status: "cancelled",
              errorMessage: "Resend API batch job was cancelled",
              finalizedAt: Date.now(),
            });
          }),
        );
    }
  },
});

/** The bodies of `contentIds`, decoded. */
export const getAllContentByIds = internalQuery({
  args: { contentIds: v.array(v.id("content")) },
  returns: v.array(v.object({ id: v.id("content"), content: v.string() })),
  handler: async (ctx, args) => {
    const rows = await Promise.all(args.contentIds.map((id) => ctx.db.get("content", id)));
    return rows.map((row) => {
      if (!row) throw new Error("Content not found -- invariant");
      return { id: row._id, content: new TextDecoder().decode(row.content) };
    });
  },
});

/** The emails of `emailIds` that still exist. */
export const getEmailsByIds = internalQuery({
  args: { emailIds: v.array(v.id("emails")) },
  handler: async (ctx, args) => {
    // An email cancelled long ago may have been cleaned up.
    const emails = await Promise.all(args.emailIds.map((id) => ctx.db.get("emails", id)));
    return emails.filter((email) => email !== null);
  },
});

/** The email Resend knows as `resendId` (nothing calls it). */
export const getEmailByResendId = internalQuery({
  args: { resendId: v.string() },
  handler: async (ctx, args) => {
    const email = await ctx.db
      .query("emails")
      .withIndex("by_resendId", (q) => q.eq("resendId", args.resendId))
      .unique();
    if (!email) throw new Error("Email not found for resendId");
    return email;
  },
});

// A status moves only up this rank (Convex's `computeEmailUpdateFromEvent`); `bounced` and `failed` share a rank, and
// a cancelled email never moves.
const STATUS_RANK: Record<EmailStatus, number> = {
  waiting: 0,
  queued: 1,
  sent: 2,
  delivery_delayed: 3,
  delivered: 4,
  bounced: 5,
  failed: 5,
  cancelled: 100,
};

/** Whether an event may move `email` to `next`. */
const outranks = (email: Email, next: EmailStatus) =>
  email.status !== "cancelled" && STATUS_RANK[next] > STATUS_RANK[email.status];

/** What `event` changes on `email`, or null when nothing changes. */
function applyEvent(email: Email, event: EmailEvent): Partial<Email> | null {
  switch (event.type) {
    case "email.sent":
      // The status was set when the batch call returned.
      return null;
    case "email.clicked":
      return email.clicked ? null : { clicked: true };
    case "email.opened":
      return email.opened ? null : { opened: true };
    case "email.complained":
      if (email.complained) return null;
      return {
        complained: true,
        finalizedAt: email.finalizedAt === FINALIZED_EPOCH ? Date.now() : email.finalizedAt,
      };
    case "email.delivered":
      return outranks(email, "delivered") ? { status: "delivered", finalizedAt: Date.now() } : null;
    case "email.delivery_delayed": {
      const moves = outranks(email, "delivery_delayed");
      if (!moves && email.deliveryDelayed) return null;
      return moves ? { deliveryDelayed: true, status: "delivery_delayed" } : { deliveryDelayed: true };
    }
    case "email.failed": {
      const moves = outranks(email, "failed");
      if (!moves && email.failed) return null;
      return moves ? { failed: true, status: "failed", finalizedAt: Date.now() } : { failed: true };
    }
    case "email.bounced": {
      const moves = outranks(email, "bounced");
      if (!moves && email.bounced) return null;
      const flags = { bounced: true, errorMessage: event.data.bounce?.message };
      return moves ? { ...flags, status: "bounced", finalizedAt: Date.now() } : flags;
    }
    default:
      return assertExhaustive(event);
  }
}

/** Apply a Resend webhook event (any value: an invalid one is logged and dropped) and run the app's callback. */
export const handleEmailEvent = mutation({
  args: { event: v.any() },
  returns: v.null(),
  handler: async (ctx, args) => {
    const parsed = attemptToParse(vEmailEvent, args.event);
    if (parsed.kind === "error") {
      // The doubled "to" is Convex's text.
      console.warn(
        `Invalid email event received. You might want to to exclude this event from your Resend webhook settings in the Resend dashboard. ${parsed.error}.`,
      );
      return null;
    }
    const event = parsed.data;
    const resendId = event.data.email_id;
    const email = await ctx.db
      .query("emails")
      .withIndex("by_resendId", (q) => q.eq("resendId", resendId))
      .unique();
    if (!email) {
      console.info(`Email not found for resendId: ${resendId}, ignoring...`);
      return null;
    }

    if ((ACCEPTED_EVENT_TYPES as readonly string[]).includes(event.type)) {
      const message =
        event.type === "email.bounced"
          ? event.data.bounce?.message
          : event.type === "email.failed"
            ? event.data.failed?.reason
            : undefined;
      await ctx.db.insert("deliveryEvents", {
        emailId: email._id,
        resendId,
        eventType: event.type,
        createdAt: event.created_at,
        ...(message === undefined ? {} : { message }),
      });
    }

    const change = applyEvent(email, event);
    if (change) {
      const { _id, _creationTime, ...fields } = email;
      await ctx.db.replace("emails", _id, { ...fields, ...change });
    }

    await runCallback(ctx, email._id, event);
    return null;
  },
});

/** Enqueue the last sender's `onEmailEvent`, if any, with the email's id and the parsed event. */
async function runCallback(ctx: MutationCtx, id: Id<"emails">, event: EmailEvent) {
  // None when the app only sends by hand.
  const stored = await ctx.db.query("lastOptions").unique();
  const callback = stored?.options.onEmailEvent;
  if (!callback) return;
  await callbackPool.enqueueMutation(
    ctx,
    // A handle string; the pool uses it as it is.
    callback.fnHandle as unknown as FunctionReference<"mutation", "internal", { id: Id<"emails">; event: EmailEvent }>,
    { id, event },
  );
}

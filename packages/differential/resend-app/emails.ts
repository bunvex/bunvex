// The calls the test makes on both backends. Nothing here reaches Resend: every email that `sendEmail` queues is
// canceled in the same mutation, before its batch runs, and the manual path supplies its own Resend id.
import { Resend, vOnEmailEventArgs } from "@convex-dev/resend";
import { internalMutationGeneric, mutationGeneric, queryGeneric } from "convex/server";
import { v } from "convex/values";
import { components, internal } from "./_generated/api";

export const WEBHOOK_SECRET = "whsec_MfKQ9r8GKYqrTwjUPD8ILPZIo2LaLaSw";

export const resend: Resend = new Resend(components.resend, {
  apiKey: "re_not_a_real_key",
  webhookSecret: WEBHOOK_SECRET,
  onEmailEvent: internal.emails.onEvent,
});

const message = (e: unknown) => String((e as Error).message).split("\n")[0];
const fields = (doc: Record<string, unknown> | null) => {
  if (!doc) return null;
  const { _id, _creationTime, createdAt, finalizedAt, segment, ...rest } = doc as Record<string, unknown>;
  // Times are each backend's own clock: kept only where they are a sentinel (never finalized, a manual email).
  return {
    ...rest,
    createdAt: typeof createdAt,
    finalizedAt: finalizedAt === Number.MAX_SAFE_INTEGER ? "never" : typeof finalizedAt,
    segment: segment === Number.POSITIVE_INFINITY ? "Infinity" : typeof segment,
  };
};

/** Queue an email with `options`, then cancel it at once: its status before and after, or the refusal. */
export const sendAndCancel = mutationGeneric({
  args: { options: v.any(), testMode: v.optional(v.boolean()) },
  handler: async (ctx, { options, testMode }) => {
    const client =
      testMode === undefined ? resend : new Resend(components.resend, { apiKey: "re_not_a_real_key", testMode });
    let id: string;
    try {
      id = await client.sendEmail(ctx, options);
    } catch (e) {
      return { error: message(e) };
    }
    const queued = await client.status(ctx, id as never);
    await client.cancelEmail(ctx, id as never);
    return {
      queued,
      canceled: await client.status(ctx, id as never),
      email: fields((await client.get(ctx, id as never)) as never),
    };
  },
});

/** The same idempotency key twice: the same id, once canceled. */
export const dedupe = mutationGeneric({
  args: {},
  handler: async (ctx) => {
    const options = {
      from: "a@example.com",
      to: "delivered@resend.dev",
      subject: "s",
      text: "t",
      idempotencyKey: "k-1",
    };
    const first = await resend.sendEmail(ctx, options);
    const second = await resend.sendEmail(ctx, { ...options, subject: "other" });
    await resend.cancelEmail(ctx, first);
    return { same: first === second };
  },
});

/** An email sent by the app itself, recorded with the Resend id it got: its id. */
export const manual = mutationGeneric({
  args: { resendId: v.string() },
  handler: async (ctx, { resendId }) =>
    resend.sendEmailManually(
      ctx,
      { from: "a@example.com", to: "b@example.com", subject: "manual" },
      async () => resendId,
    ),
});

export const email = queryGeneric({
  args: { id: v.string() },
  handler: async (ctx, { id }) => ({
    status: await resend.status(ctx, id as never),
    email: fields((await resend.get(ctx, id as never)) as never),
  }),
});

export const onEvent = internalMutationGeneric({
  args: vOnEmailEventArgs,
  handler: async (ctx, { id, event }) => {
    await ctx.db.insert("events", { id, type: event.type, event });
  },
});

export const events = queryGeneric({
  args: {},
  handler: async (ctx) => (await ctx.db.query("events").collect()).map((e) => ({ type: e.type, event: e.event })),
});

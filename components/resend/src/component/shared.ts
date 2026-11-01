// The validators and types the component and its client share (STUDY-200 §1.4, §1.10), with the names and shapes of
// Convex's resend 0.2.10 (`src/component/shared.ts`): an email's status, a template, the runtime options each send
// carries, and the webhook events Resend posts. The event validators accept only these eight types; `parse` (from
// `@bunvex/helpers`) strips the fields they do not declare.

import { literals } from "@bunvex/helpers/validators";
import type { GenericActionCtx, GenericDataModel, GenericMutationCtx, GenericQueryCtx } from "@bunvex/server";
import { type Infer, type PropertyValidators, v } from "@bunvex/values";

/** The `onEmailEvent` option as stored: the app's mutation, by handle. */
export const onEmailEvent = v.object({ fnHandle: v.string() });

/** An email's status. */
export const vStatus = v.union(
  v.literal("waiting"),
  v.literal("queued"),
  v.literal("cancelled"),
  v.literal("sent"),
  v.literal("delivered"),
  v.literal("delivery_delayed"),
  v.literal("bounced"),
  v.literal("failed"),
);
/** An email's status: `waiting`, `queued`, `cancelled`, `sent`, `delivered`, `delivery_delayed`, `bounced`, `failed`. */
export type Status = Infer<typeof vStatus>;

/** A Resend template: its id and the values of its variables. */
export const vTemplate = v.object({
  id: v.string(),
  variables: v.optional(v.record(v.string(), v.union(v.string(), v.number()))),
});
/** A Resend template: its id and the values of its variables. */
export type Template = Infer<typeof vTemplate>;

/** The options each send carries to the component: the last sender's are the ones the batches use. */
export const vOptions = v.object({
  initialBackoffMs: v.number(),
  retryAttempts: v.number(),
  apiKey: v.string(),
  testMode: v.boolean(),
  onEmailEvent: v.optional(onEmailEvent),
});
/** The options each send carries to the component. */
export type RuntimeConfig = Infer<typeof vOptions>;

const addresses = v.union(v.string(), v.array(v.string()));
const nameValue = v.object({ name: v.string(), value: v.string() });

/** The fields every email event's `data` has. */
const eventData = {
  broadcast_id: v.optional(v.string()),
  created_at: v.string(),
  email_id: v.string(),
  from: addresses,
  to: addresses,
  cc: v.optional(addresses),
  bcc: v.optional(addresses),
  reply_to: v.optional(addresses),
  // The message's RFC Message-ID header, as Resend forwards it.
  message_id: v.optional(v.string()),
  headers: v.optional(v.array(nameValue)),
  subject: v.string(),
  tags: v.optional(v.union(v.record(v.string(), v.string()), v.array(nameValue))),
};

/** An event of `type` whose `data` adds `extra` to the common fields. */
const eventOf = <T extends string, E extends PropertyValidators>(type: T, extra: E) =>
  v.object({ type: v.literal(type), created_at: v.string(), data: v.object({ ...eventData, ...extra }) });

/** A webhook event from Resend about one email, with the fields this component reads. */
export const vEmailEvent = v.union(
  eventOf("email.sent", {}),
  eventOf("email.delivered", {}),
  eventOf("email.delivery_delayed", {}),
  eventOf("email.complained", {}),
  eventOf("email.bounced", {
    bounce: v.object({ message: v.string(), subType: v.string(), type: v.string() }),
  }),
  eventOf("email.opened", {
    open: v.object({ ipAddress: v.string(), timestamp: v.string(), userAgent: v.string() }),
  }),
  eventOf("email.clicked", {
    click: v.object({ ipAddress: v.string(), link: v.string(), timestamp: v.string(), userAgent: v.string() }),
  }),
  eventOf("email.failed", { failed: v.object({ reason: v.string() }) }),
);

/** The event types the component records, in Convex's order. */
export const ACCEPTED_EVENT_TYPES = [
  "email.sent",
  "email.delivered",
  "email.bounced",
  "email.complained",
  "email.failed",
  "email.delivery_delayed",
  "email.opened",
  "email.clicked",
] as const;

/** One of the accepted event types. */
export const vEventType = v.union(literals(...ACCEPTED_EVENT_TYPES));

/** A webhook event from Resend about one email. */
export type EmailEvent = Infer<typeof vEmailEvent>;
/** The type of an email event. */
export type EventEventTypes = EmailEvent["type"];
/** The email event of type `T`. */
export type EventEventOfType<T extends EventEventTypes> = Extract<EmailEvent, { type: T }>;

/** What the client needs of a query's context. */
export type QueryCtx = Pick<GenericQueryCtx<GenericDataModel>, "runQuery">;
/** What the client needs of a mutation's context. */
export type MutationCtx = Pick<GenericMutationCtx<GenericDataModel>, "runQuery" | "runMutation">;
/** What the client needs of an action's context. */
export type ActionCtx = Pick<GenericActionCtx<GenericDataModel>, "runQuery" | "runMutation" | "runAction">;
